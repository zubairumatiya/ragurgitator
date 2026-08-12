// UI: irreversible account deletion, gated behind typing the word DELETE.
//
// A confirm() dialog would be less code, but it is one reflexive click from a
// destroyed account and it is suppressible by the browser. Requiring the user to
// TYPE something makes the action deliberate — and the gate is enforced by the
// submit button's disabled state, not by trusting a checkbox the server can't
// see.
//
// The server does NOT re-check the typed word. It is a UX guard against
// misclicks, not a security control: the real authorization is requireUser() in
// the action, and a user is always allowed to delete their own account.
"use client";

import { useState } from "react";

import { deleteAccount } from "@/app/account/actions";

const CONFIRM_WORD = "DELETE";

export function DeleteAccountForm() {
  const [typed, setTyped] = useState("");
  const armed = typed.trim().toUpperCase() === CONFIRM_WORD;

  return (
    <form action={deleteAccount} autoComplete="off" className="mt-3 flex items-start gap-2">
      <div className="flex-1">
        <label className="sr-only" htmlFor="confirm-delete">
          Type {CONFIRM_WORD} to confirm
        </label>
        <input
          id="confirm-delete"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          // No `name`, so this never enters browser form history — that history
          // is keyed by field name, and a remembered "DELETE" offered on focus
          // would pre-arm the button this input exists to gate.
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          placeholder={`Type ${CONFIRM_WORD} to confirm`}
          className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-red-500 dark:border-zinc-700"
        />
      </div>
      <button
        type="submit"
        disabled={!armed}
        className="cursor-pointer rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-red-700 disabled:cursor-default disabled:opacity-40"
      >
        Delete account
      </button>
    </form>
  );
}
