// Set-a-new-password page — the far end of a recovery link.
//
// TWO gates, and the second is the one that matters. A session alone is not
// enough to reach this form: every signed-in user has one, so "has a session"
// would let anyone holding a hijacked session set a new password without knowing
// the old one. The recovery-intent cookie is what distinguishes a session that
// came through the mailbox from a session that merely exists — see
// lib/auth/recoveryIntent.ts for the full argument.
//
// Both are checked again inside setNewPassword. This check is so the user is not
// shown a form that cannot possibly work; the one in the action is the one that
// enforces anything.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/dal";
import { RECOVERY_COOKIE } from "@/lib/auth/recoveryIntent";
import { SetPasswordForm } from "@/app/components/SetPasswordForm";

export const metadata = { title: "Choose a new password" };

const NO_LINK =
  "Open the reset link from your email to set a new password. Enter your address to get one.";

export default async function ResetPage() {
  const [user, jar] = await Promise.all([getSessionUser(), cookies()]);

  if (!user || !jar.get(RECOVERY_COOKIE)) {
    redirect(`/auth/forgot-password?error=${encodeURIComponent(NO_LINK)}`);
  }

  return <SetPasswordForm />;
}
