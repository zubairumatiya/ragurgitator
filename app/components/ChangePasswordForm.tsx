// UI: change the password from inside a live session (Client Component).
//
// Modelled on ProviderKeyRow rather than DeleteAccountForm, for the input-clearing
// it already does: both fields here are secrets, and React 19's post-action form
// reset is not something to rely on alone for a value that should not linger in
// the DOM.
"use client";

import { useActionState, useEffect, useRef } from "react";

import { changePassword, type PasswordFormState } from "@/app/account/actions";
import { BUTTON, FIELD } from "@/app/components/formStyles";
import { PASSWORD_HINT } from "@/lib/auth/passwordPolicy";

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePassword, {} as PasswordFormState);
  const formRef = useRef<HTMLFormElement>(null);

  // Belt and braces on top of the automatic reset: on success, make certain
  // neither typed password is still sitting in an input.
  useEffect(() => {
    if (state.saved) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="mt-4 flex max-w-sm flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Current password
        </span>
        <input name="current" type="password" required autoComplete="current-password" className={FIELD} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          New password
        </span>
        <input
          name="next"
          type="password"
          required
          minLength={8}
          maxLength={72}
          autoComplete="new-password"
          aria-describedby="new-password-hint"
          className={FIELD}
        />
        <span id="new-password-hint" className="text-xs text-zinc-500">
          {PASSWORD_HINT}
        </span>
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      {state.saved ? (
        <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
          Password changed. Your other devices have been signed out.
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={`self-start ${BUTTON}`}>
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
