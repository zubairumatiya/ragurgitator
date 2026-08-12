// UI: one provider's key — its state, and the form to set or replace it.
//
// The input is WRITE-ONLY by construction. It is never given a value or a
// defaultValue, so there is nothing to repopulate it from: the saved key is not
// in the DTO the server sent, and after a save the form resets to empty. The
// only thing the user ever sees about a stored key is its last four characters.
//
// There is no "edit" affordance because there is no readable value to edit —
// only REPLACE (save again) and DELETE. That mirrors what the database can
// actually do, rather than implying a round trip that cannot exist.
"use client";

import { useActionState, useEffect, useRef } from "react";

import { deleteKey, saveKey, type KeyFormState } from "@/app/account/actions";
import type { ProviderKeyDto } from "@/lib/auth/providerKeys";

const FIELD =
  "w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:focus:border-zinc-500";

const BUTTON =
  "cursor-pointer rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:cursor-default disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ProviderKeyRow({
  provider,
  label,
  role,
  saved,
}: {
  provider: string;
  label: string;
  role: string;
  // Absent when this provider has no key yet.
  saved?: ProviderKeyDto;
}) {
  const [saveState, saveAction, saving] = useActionState(saveKey, {} as KeyFormState);
  const [deleteState, deleteAction, deleting] = useActionState(deleteKey, {} as KeyFormState);
  const inputRef = useRef<HTMLInputElement>(null);

  // Belt and braces on top of React 19's post-action form reset: if a save
  // succeeds, make certain the typed key is not still sitting in the DOM.
  useEffect(() => {
    if (saveState.savedProvider === provider && inputRef.current) {
      inputRef.current.value = "";
    }
  }, [saveState, provider]);

  const error = saveState.provider === provider ? saveState.error : undefined;
  const justSaved = saveState.savedProvider === provider;

  return (
    <div className="border-t border-zinc-200 py-4 dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{label}</h3>
          <p className="text-xs text-zinc-500">{role}</p>
        </div>

        {saved ? null : (
          <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-600">Not set</span>
        )}
      </div>

      {saved ? (
        <p className="mt-1 text-xs text-zinc-500">
          Added {formatDate(saved.createdAt)}
          {saved.updatedAt !== saved.createdAt ? ` · replaced ${formatDate(saved.updatedAt)}` : ""}
          {saved.lastVerifiedAt ? " · verified" : ""}
        </p>
      ) : null}

      {/* autoComplete="off" on the FORM as well as the field: some browsers
          consult the form-level value when deciding whether to offer saved
          entries at all, and Firefox's form history keys off it directly. */}
      <form action={saveAction} autoComplete="off" className="mt-3 flex items-start gap-2">
        <input type="hidden" name="provider" value={provider} />
        <div className="flex-1">
          <label className="sr-only" htmlFor={`key-${provider}`}>
            {label} API key
          </label>
          {/* No value/defaultValue — see the header comment.

              NOTHING MAY PREFILL THIS FIELD. It takes four layers, because each
              one covers a different filler:

              autoComplete="new-password"  Chrome and Safari IGNORE "off" on a
                  password input — they treat it as a site trying to defeat a
                  password manager and fill it anyway. "new-password" is the
                  value they actually honour, because it declares the field is
                  for a value being SET, not one being recalled.
              name="apiKey"  Autofill heuristics key off the name. Anything
                  resembling "password" invites a saved credential regardless of
                  the attributes above.
              data-*-ignore  Third-party managers don't read autocomplete at
                  all: 1Password, LastPass, Bitwarden and Dashlane each look for
                  their own opt-out attribute.
              No sibling username/email input  A lone password field in a form
                  with no identity field is not shaped like a login, which is
                  what most fill heuristics are actually matching on.

              Tradeoff of "new-password": Chrome may offer to GENERATE a
              password here. Harmless — dismissing it leaves the field empty,
              whereas a silently filled saved credential would be submitted as
              though it were the user's API key. */}
          <input
            ref={inputRef}
            id={`key-${provider}`}
            name="apiKey"
            type="password"
            required
            autoComplete="new-password"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            data-form-type="other"
            // The stored key's last four, straight from last_four in the DB —
            // the only fragment that exists to show. Empty last_four means the
            // saved key was under 8 characters, where SecretKey withholds the
            // tail rather than leak a larger share of a short key.
            placeholder={
              saved
                ? saved.lastFour
                  ? `••••••••${saved.lastFour} — enter a new key to replace`
                  : "•••••••• saved — enter a new key to replace"
                : "Paste your API key"
            }
            className={`${FIELD} font-mono placeholder:font-sans`}
          />
        </div>
        <button type="submit" disabled={saving} className={BUTTON}>
          {saving ? "Checking…" : saved ? "Replace" : "Save"}
        </button>
      </form>

      {saved ? (
        <form action={deleteAction} className="mt-2">
          <input type="hidden" name="provider" value={provider} />
          <button
            type="submit"
            disabled={deleting}
            className="cursor-pointer text-xs text-red-600 underline decoration-dotted underline-offset-2 disabled:opacity-50 dark:text-red-400"
          >
            {deleting ? "Removing…" : "Remove key"}
          </button>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {justSaved && !error ? (
        <p role="status" className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Verified with {label} and saved.
        </p>
      ) : null}

      {deleteState.error ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {deleteState.error}
        </p>
      ) : null}
    </div>
  );
}
