// ---------------------------------------------------------------------------
// The account page: identity, provider keys, and account deletion.
//
// A Server Component, so the key list is read through the DAL rather than an API
// route — requireUser() is the authorization boundary and it sits right next to
// the query. listProviderKeys() returns DTOs with no ciphertext column in the
// SELECT at all, so what crosses into the client tree structurally cannot
// contain a credential.
//
// Reached by clicking the email in the sidebar footer. proxy.ts already protects
// it: only /login, /signup and /auth are public.
// ---------------------------------------------------------------------------
import { requireUser } from "@/lib/auth/dal";
import {
  listProviderKeys,
  PROVIDER_IDS,
  PROVIDER_META,
  type ProviderKeyDto,
} from "@/lib/auth/providerKeys";
import { DeleteAccountForm } from "@/app/components/DeleteAccountForm";
import { ProviderKeyRow } from "@/app/components/ProviderKeyRow";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireUser();
  const keys = await listProviderKeys(user.id);

  const byProvider = new Map<string, ProviderKeyDto>(keys.map((k) => [k.provider, k]));

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <h1 className="text-lg font-medium">Account</h1>
      <p className="mt-1 text-sm text-zinc-500">{user.email}</p>

      <section className="mt-10">
        <h2 className="text-sm font-medium">Provider API keys</h2>
        <p className="mt-1 max-w-prose text-xs text-zinc-500">
          Your keys are encrypted before they are stored, under a key that never leaves Azure Key
          Vault — a copy of the database on its own reveals nothing. Because of that, we cannot
          show a key back to you after it is saved: only its last four characters. A key you have
          lost can be replaced, never recovered.
        </p>

        <div className="mt-4">
          {PROVIDER_IDS.map((id) => (
            <ProviderKeyRow
              key={id}
              provider={id}
              label={PROVIDER_META[id].label}
              role={PROVIDER_META[id].role}
              saved={byProvider.get(id)}
            />
          ))}
        </div>
      </section>

      <section className="mt-12 rounded border border-red-200 p-4 dark:border-red-900/50">
        <h2 className="text-sm font-medium text-red-700 dark:text-red-400">Delete account</h2>
        <p className="mt-1 max-w-prose text-xs text-zinc-500">
          Permanently deletes your account and every provider key on it. This cannot be undone, and
          nothing here is recoverable afterwards — the stored keys become unopenable the moment the
          rows are gone.
        </p>
        <DeleteAccountForm />
      </section>
    </div>
  );
}
