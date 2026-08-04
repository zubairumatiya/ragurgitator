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

function config(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. " +
        "Copy them from the Supabase dashboard (Project Settings → API) into .env.local.",
    );
  }
  return { url, anonKey };
}

// The anon key is PUBLIC by design — it identifies the project and carries no
// authority of its own; row access is governed by the user's JWT. That's why
// these are NEXT_PUBLIC_ and why shipping them to the browser is correct.
export function browserSupabase() {
  const { url, anonKey } = config();
  return createBrowserClient(url, anonKey);
}

export async function serverSupabase() {
  const { url, anonKey } = config();
  const cookieStore = await cookies(); // async in Next 16

  return createServerClient(url, anonKey, {
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
  const { url, anonKey } = config();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        onCookiesSet(cookiesToSet);
      },
    },
  });
}
