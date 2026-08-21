// UI: "email me a reset link" (Client Component).
//
// A sibling of AuthForm rather than a third mode of it. AuthForm shares one
// component across sign-in and sign-up on the stated grounds that their FIELDS are
// identical and only copy differs; this form has no password field at all, so
// folding it in would mean gating the markup on which mode is active — exactly the
// branching that justification exists to avoid.
"use client";

import Link from "next/link";
import { useActionState } from "react";

import { requestPasswordReset } from "@/app/auth/actions";
import { BUTTON, FIELD } from "@/app/components/formStyles";
import { Wordmark } from "@/app/components/Logo";

export function ForgotPasswordForm({ initialError }: { initialError?: string }) {
  // Seeded from ?error= — /auth/callback can only talk to a page by redirecting
  // to it, and a dead reset link is reported here rather than at /login because
  // this is where the user gets a working one.
  const [state, formAction, pending] = useActionState(requestPasswordReset, {
    error: initialError,
  });

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6">
      <Wordmark size={46} textClassName="text-xl" className="mb-7" />
      <h1 className="mb-1 text-lg font-medium">Reset your password</h1>
      <p className="mb-6 text-xs text-zinc-500">
        We&rsquo;ll email you a link that lets you set a new one.
      </p>

      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Email</span>
          {/* defaultValue, matching AuthForm: the field stays uncontrolled, and
              echoing the address back through action state is what stops a
              rejected submit from wiping it. */}
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            defaultValue={state.email ?? ""}
            className={FIELD}
          />
        </label>

        {state.error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        ) : null}

        <button type="submit" disabled={pending} className={`mt-1 ${BUTTON}`}>
          {pending ? "Sending…" : "Send reset link"}
        </button>
      </form>

      <p className="mt-6 text-xs text-zinc-500">
        Remembered it?{" "}
        <Link
          href="/login"
          className="text-zinc-600 underline decoration-dotted underline-offset-2 dark:text-zinc-400"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
