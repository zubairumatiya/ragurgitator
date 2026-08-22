// WHO IS A GUEST — the one question the rest of the app asks about the demo.
//
// Everything else about a guest is deliberately indistinguishable from a real
// account: same RLS, same store layer, same provider-key path, same pages. This
// module is the entire seam, and it is two reads and a reaper.
//
// THE READ IS CACHED PER RENDER, like requireUser(). A page that shows the demo
// banner, gates a button and words an error message asks three times and pays
// for one indexed lookup — the same reasoning that makes "check at every call
// site" affordable in lib/auth/dal.ts.
import "server-only";

import { cache } from "react";

import { activeUserId } from "@/lib/auth/userScope";
import { privilegedSql, sql } from "@/lib/db";

export type GuestStatus = {
  isGuest: boolean;
  // When the workspace disappears. Null for a real account, and — because the
  // reaper is not instantaneous — possibly in the past for a guest whose session
  // outlived its TTL by a few minutes.
  expiresAt: string | null;
};

const NOT_A_GUEST: GuestStatus = { isGuest: false, expiresAt: null };

// Reads the CALLER'S OWN profile row through the ordinary RLS-scoped handle, so
// this cannot be turned into a question about anybody else even by accident.
export const guestStatus = cache(async (): Promise<GuestStatus> => {
  const [row] = await sql<{ is_guest: boolean; expires_at: Date | null }[]>`
    select is_guest, expires_at from user_profiles where id = ${activeUserId()}
  `;
  if (!row?.is_guest) return NOT_A_GUEST;
  return { isGuest: true, expiresAt: row.expires_at?.toISOString() ?? null };
});

// Sugar for the many call sites that only need the boolean.
export async function isGuest(): Promise<boolean> {
  return (await guestStatus()).isGuest;
}

// Is THIS user a guest, asked from outside a request scope?
//
// The one caller is the notification path (lib/notify), which runs from a job's
// scope but needs to ask about the ROW'S OWNER, who may not be the active user.
// Privileged for the same reason resolveJobOwner is: a sessionless tick has to
// find out whose mail it is about before it can enter anyone's scope.
export async function isGuestUser(userId: string): Promise<boolean> {
  const [row] = await privilegedSql<{ is_guest: boolean }[]>`
    select is_guest from user_profiles where id = ${userId}
  `;
  return Boolean(row?.is_guest);
}

// --- the reaper --------------------------------------------------------------

// DELETE FROM auth.users, AND THE DIRECTION MATTERS.
//
// The cascade runs auth.users → user_profiles → everything (0046). Deleting the
// user_profiles row instead would strand the auth.users row permanently AND
// leave the guest's cookie still validating — getSessionUser() needs only an
// email — so the guest would land in an app whose every scoped query references
// a profile that is gone.
//
// Same statement and same connection account deletion uses (app/account/
// actions.ts), for the same reason: `auth.users` is owned by supabase_auth_admin
// with DELETE granted to `postgres`, and 0051 deliberately did not re-grant that
// to rag_app.
//
// Server-side deletes: zero egress, however many guests are swept.
export async function reapExpiredGuests(): Promise<number> {
  const result = await privilegedSql`
    delete from auth.users
     where id in (
       select id from user_profiles where is_guest and expires_at < now()
     )
  `;
  return result.count ?? 0;
}

// How many guest workspaces are alive right now — the storage cap's numerator.
// Counts unexpired guests only, so a backlog the reaper has not swept yet does
// not lock new visitors out.
export async function liveGuestCount(): Promise<number> {
  const [row] = await privilegedSql<{ n: string }[]>`
    select count(*)::text as n from user_profiles
     where is_guest and expires_at > now()
  `;
  return Number(row?.n ?? 0);
}
