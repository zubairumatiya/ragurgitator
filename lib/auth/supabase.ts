// ---------------------------------------------------------------------------
// SUPABASE AUTH CLIENTS.
//
// Three call sites need a client and each needs different cookie plumbing, so
// they get three factories rather than one overloaded helper:
//
//   browserSupabase()   Client Components — reads/writes document.cookie
//   serverSupabase()    Server Components, Server Actions, Route Handlers
//   proxySupabase(req)  proxy.ts only — needs to write refreshed cookies onto
//                       an outgoing NextResponse, which next/headers can't do
//
// NOTE ON getUser() vs getSession(): only `auth.getUser()` is trustworthy on the
// server. `getSession()` decodes the cookie WITHOUT verifying its signature
// against the auth server, so anything derived from it is attacker-controllable
// — a forged cookie yields a forged session. Every server-side read in this
// codebase goes through getUser(), and lib/auth/dal.ts is the only place that
// should be calling it at all.
// ---------------------------------------------------------------------------
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// PUBLISHABLE KEY (`sb_publishable_…`) — the successor to the legacy `anon` key.
//
// Supabase replaced the JWT-based anon/service_role pair with opaque publishable
// and secret keys (github.com/orgs/supabase/discussions/29260). Both formats work
// in the same client argument today, but the legacy keys are scheduled for
// DELETION in late 2026 — so a new build targets the new format and treats the
// old one as a fallback, not the other way round.
//
// Why the new format is better here, beyond the deadline: an opaque key can be
// rotated or revoked on its own, whereas the legacy anon key is a JWT signed
// with the project's JWT secret — rotating it invalidates every other token
// signed by that secret at the same time.
// ---------------------------------------------------------------------------
function publishableKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    // Legacy projects created before the new format. Kept only for the
    // transition; drop this once the project is on sb_publishable_…
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

function config(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = publishableKey();
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set. " +
        "Copy them from the Supabase dashboard (Project Settings → API Keys) into .env.local.",
    );
  }
  return { url, key };
}

// The publishable key is PUBLIC by design — it identifies the project and
// carries no authority of its own; access is governed by the signed-in user's
// JWT. That's why these are NEXT_PUBLIC_ and why shipping them to the browser is
// correct. The SECRET key (sb_secret_…) is the one that must never appear here.
export function browserSupabase() {
  const { url, key } = config();
  return createBrowserClient(url, key);
}

export async function serverSupabase() {
  const { url, key } = config();
  const cookieStore = await cookies(); // async in Next 16

  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies during render. This is the
          // documented, expected failure: proxy.ts already refreshed the token
          // and wrote the cookies onto the response before this render began,
          // so swallowing it here loses nothing. Server Actions and Route
          // Handlers CAN set cookies, and there this branch never runs.
        }
      },
    },
  });
}

// proxy.ts variant. The response object is reassigned when Supabase rotates a
// token mid-request, so the caller passes a setter rather than a value — see the
// comment in proxy.ts for why rebuilding the response is mandatory.
export function proxySupabase(
  request: NextRequest,
  onCookiesSet: (cookiesToSet: { name: string; value: string; options?: object }[]) => NextResponse,
) {
  const { url, key } = config();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        onCookiesSet(cookiesToSet);
      },
    },
  });
}
