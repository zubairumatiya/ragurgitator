// Bridge between the HTTP layer and the request scopes. Every route handler runs
// its work inside one of the two wrappers here, which do three things in order:
// authenticate, enter the user scope, and (for the config-scoped variant) resolve
// and enter the active config.
//
// THIS IS THE AUTHENTICATION BOUNDARY FOR /api. proxy.ts deliberately does not
// redirect API routes — a fetch() that follows a 307 to /login and parses the HTML
// as JSON produces an error with nothing to do with the actual problem — so route
// handlers must return their own 401. Putting that in the wrapper every route
// already used means it cannot be forgotten one route at a time, which is how 53
// of 54 routes ended up unauthenticated before Phase 2.
//
// configId travels in via a `configId` query param or `x-config-id` header.
// resolveRequestConfig also verifies the config belongs to the session user, so an
// unowned id resolves to a clean 404 rather than someone else's tab.
//
// Both wrappers also OWN THE DETACHED QUEUE (lib/detached.ts): they install it and
// hand Next's `after` the flush that drains it once the response is out. after() is
// called BEFORE withUser, so the async context it binds carries no transaction
// handle — that ordering is load-bearing, not incidental.
//
// They own the key-usage buffer too (lib/auth/keyUsageStore.ts), nested INSIDE the
// detached queue: the buffer's drain hands its one multi-row insert to that queue,
// so a request's provider calls become a single statement written after the
// response rather than N statements written during it.
import { after } from "next/server";

import { requireUserForApi, unauthorizedJson } from "@/lib/auth/dal";
import { withUser } from "@/lib/auth/userScope";
import { withKeyUsageBuffer } from "@/lib/auth/keyUsageStore";
import { withDetachedQueue } from "@/lib/detached";
import { missingKeyResponse } from "@/lib/http/missingKeyServer";
import { UnknownConfigError, resolveRequestConfig, withConfig } from "@/lib/rag/activeConfig";

// A MISSING PROVIDER KEY BELONGS HERE for the same reason the 401 does: under
// strict BYOK every user hits it on their first run, and handling it one route at a
// time is how it would be missed in the routes nobody thought about. Anything else
// rethrows untouched.
//
// NDJSON routes do NOT come through here — their `run` callback owns its errors by
// contract and emits streamError() instead, which builds the same payload.
//
// EXPORTED for lib/http/mcpScope.ts, the third scope entry point, which needs the
// identical behaviour. Sharing rather than copying is the point: two copies is how
// the "one place it cannot be forgotten" claim above stops being true. Nothing but
// a scope wrapper should be calling it.
export async function catchingMissingKey<T>(fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (err) {
    const response = missingKeyResponse(err);
    if (response) return response;
    throw err;
  }
}

// Authenticate, then run `fn` inside the user scope AND the active-config scope.
// The union return type is what forces call sites to keep returning the wrapper's
// result directly — a route that ignored it would drop the 401 on the floor.
export async function withRequestConfig<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<T | Response> {
  const user = await requireUserForApi();
  if (!user) return unauthorizedJson();

  return withDetachedQueue(user, after, () =>
    withKeyUsageBuffer(() =>
      withUser(user, async () => {
        let cfg;
        try {
          cfg = await resolveRequestConfig(request);
        } catch (err) {
          // 404, not 500 and not 403: a config that doesn't exist and a config
          // owned by someone else must look identical from outside, or the status
          // code itself confirms which ids are real.
          if (err instanceof UnknownConfigError) {
            return Response.json({ error: "Config not found." }, { status: 404 });
          }
          throw err;
        }
        return withConfig(cfg, () => catchingMissingKey(fn));
      }),
    ),
  );
}

// Authenticate and enter the user scope only. For the handful of routes that are
// genuinely not config-scoped (corpus management, batch jobs, the global
// semantic-cache thresholds) — they still need an owner to filter by, but there
// is no config to resolve and inventing one would make the fallback to the
// user's oldest config look meaningful when it isn't.
export async function withRequestUser<T>(fn: () => Promise<T>): Promise<T | Response> {
  const user = await requireUserForApi();
  if (!user) return unauthorizedJson();
  return withDetachedQueue(user, after, () =>
    withKeyUsageBuffer(() => withUser(user, () => catchingMissingKey(fn))),
  );
}
