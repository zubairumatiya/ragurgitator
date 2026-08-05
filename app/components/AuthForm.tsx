// ---------------------------------------------------------------------------
// UI: the shared sign-in / sign-up form (Client Component).
//
// One component for both modes — the fields, validation surface, and error
// rendering are identical and only the action, copy and cross-link differ.
// Splitting them would duplicate the accessibility wiring for no benefit.
//
// State comes from React 19's useActionState, so the submitting state and the
// server's error string arrive without any fetch/loading plumbing here. Styling
// mirrors the zinc palette used across the app.
// ---------------------------------------------------------------------------
"use client";

import Link from "next/link";
import { useActionState } from "react";

import type { AuthState } from "@/app/auth/actions";

type Mode = "signin" | "signup";

const COPY = {
  signin: {
    title: "Sign in",
    submit: "Sign in",
    pending: "Signing in…",
    altPrompt: "Don't have an account?",
    altHref: "/signup",
    altLabel: "Sign up",
    autoComplete: "current-password",
    // Sign-in must not advertise the rules — they describe the shape of stored
    // passwords, and older accounts may predate them anyway.
    passwordHint: null,
  },
  signup: {
    title: "Create an account",
    submit: "Sign up",
    pending: "Creating account…",
    altPrompt: "Already have an account?",
    altHref: "/login",
    altLabel: "Sign in",
    autoComplete: "new-password",
    // Stated up front rather than discovered by rejection. Mirrors NewPassword
    // in app/auth/actions.ts — keep the two in sync.
    passwordHint: "At least 8 characters, including a letter and a number.",
  },
} as const;

const FIELD =
  "w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:focus:border-zinc-500";

export function AuthForm({
  mode,
  action,
  next,
  initialError,
  initialNotice,
}: {
  mode: Mode;
  action: (prev: AuthState, formData: FormData) => Promise<AuthState>;
  next?: string;
  // Seeded from ?error= — how /auth/callback reports an expired or already-used
  // confirmation link, since it can only communicate by redirecting here.
  initialError?: string;
  // Neutral counterpart, for outcomes that aren't failures — currently just
  // "your account was deleted". Kept OUT of action state: it describes how the
  // user arrived, not what the last submit did, so it must not survive one.
  initialNotice?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    error: initialError,
  });
  const copy = COPY[mode];

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-lg font-medium">{copy.title}</h1>

      {initialNotice ? (
        <p role="status" className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          {initialNotice}
        </p>
      ) : null}
      <p className="mb-6 text-xs text-zinc-500">
        {mode === "signup"
          ? "You'll add your own provider API keys after signing in."
          : "Ragurgitator"}
      </p>

      <form action={formAction} className="flex flex-col gap-3">
        {/* Carried through the form so the server action can bounce the user
            back to wherever proxy.ts intercepted them. Validated server-side
            (safeNext) — a hidden field is caller-controlled input. */}
        {next ? <input type="hidden" name="next" value={next} /> : null}

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Email
          </span>
          {/* defaultValue, not value: the field stays uncontrolled so the
              password never has to live in React state alongside it. React 19
              resets the form after every action, and a reset restores inputs to
              their defaultValue — so echoing the submitted address back through
              action state is what stops a failed sign-in from wiping it. */}
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

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Password
          </span>
          <input
            name="password"
            type="password"
            required
            minLength={mode === "signup" ? 8 : undefined}
            maxLength={mode === "signup" ? 72 : undefined}
            autoComplete={copy.autoComplete}
            aria-describedby={copy.passwordHint ? "password-hint" : undefined}
            className={FIELD}
          />
          {copy.passwordHint ? (
            <span id="password-hint" className="text-xs text-zinc-500">
              {copy.passwordHint}
            </span>
          ) : null}
        </label>

        {state.error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="mt-1 cursor-pointer rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:cursor-default disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {pending ? copy.pending : copy.submit}
        </button>
      </form>

      <p className="mt-6 text-xs text-zinc-500">
        {copy.altPrompt}{" "}
        <Link
          href={copy.altHref}
          className="text-zinc-600 underline decoration-dotted underline-offset-2 dark:text-zinc-400"
        >
          {copy.altLabel}
        </Link>
      </p>
    </div>
  );
}
