// UI: the last step of a password reset — choose the new password.
//
// No current-password field, and that is not an oversight: the user is here
// because they cannot supply it. What stands in its place is the mail round trip,
// enforced server-side by the recovery-intent cookie (lib/auth/recoveryIntent.ts).
"use client";

import { useActionState } from "react";

import { setNewPassword, type AuthState } from "@/app/auth/actions";
import { BUTTON, FIELD } from "@/app/components/formStyles";
import { Wordmark } from "@/app/components/Logo";
import { PASSWORD_HINT } from "@/lib/auth/passwordPolicy";

export function SetPasswordForm() {
  const [state, formAction, pending] = useActionState(setNewPassword, {} as AuthState);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6">
      <Wordmark size={46} textClassName="text-xl" className="mb-7" />
      <h1 className="mb-1 text-lg font-medium">Choose a new password</h1>
      <p className="mb-6 text-xs text-zinc-500">
        Your other devices will be signed out. This one stays signed in.
      </p>

      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            New password
          </span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            maxLength={72}
            autoComplete="new-password"
            autoFocus
            aria-describedby="password-hint"
            className={FIELD}
          />
          <span id="password-hint" className="text-xs text-zinc-500">
            {PASSWORD_HINT}
          </span>
        </label>

        {state.error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        ) : null}

        <button type="submit" disabled={pending} className={`mt-1 ${BUTTON}`}>
          {pending ? "Saving…" : "Set password"}
        </button>
      </form>
    </div>
  );
}
