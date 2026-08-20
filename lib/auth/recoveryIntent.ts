// The marker that says "this session arrived through the mailbox".
//
// WHY THIS EXISTS AT ALL. /auth/reset sets a new password without asking for the
// old one — that is the whole point of a recovery link. But /auth/reset is public
// by prefix (proxy.ts PUBLIC_PREFIXES contains "/auth"), so its only other gate
// would be "the visitor has a session". That is not enough: an ORDINARY signed-in
// session would then satisfy it, and anyone holding a hijacked session could walk
// to /auth/reset and take the account over without ever knowing the password. It
// would quietly undo the current-password requirement that changePassword enforces
// three lines away.
//
// So possession of a session is separated from proof of mailbox access. Only
// /auth/callback sets this cookie, and only after verifyOtp has actually spent a
// type=recovery token; setNewPassword clears it on the way out, so a link buys
// exactly one password change.
//
// It is a bearer marker, not a secret: it says nothing an attacker could not
// already know, and it is useless without the session cookie it sits beside. The
// security is that it cannot be OBTAINED without receiving the mail.
import type { NextResponse } from "next/server";

export const RECOVERY_COOKIE = "sb-recovery-intent";

// Long enough to choose a password, short enough that a shared or borrowed
// browser does not stay armed. The recovery session itself outlives this on
// purpose — expiry here means "pick a password now or ask for a fresh link",
// not "you have been signed out".
const MAX_AGE_SECONDS = 15 * 60;

// path is deliberately NOT scoped to /auth/reset. The cookie has to be readable by
// the Server Action that consumes it, and a Server Action POSTs to the page's own
// URL only in the simple case — Next may route it elsewhere, and a cookie the
// action cannot see would fail the flow at the last step for no security gain.
export function setRecoveryIntent(response: NextResponse): void {
  response.cookies.set(RECOVERY_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}
