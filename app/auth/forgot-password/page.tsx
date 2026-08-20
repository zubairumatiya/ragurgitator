// Request-a-reset-link page.
//
// Public without a proxy change: PUBLIC_PREFIXES in proxy.ts contains "/auth", so
// everything under it is already reachable signed out — which is the whole reason
// these pages live here rather than at /forgot-password.
//
// NO SIGNED-IN BOUNCE, deliberately, unlike /login and /signup (proxy.ts). Being
// signed in somewhere does not mean you remember your password: a session on this
// laptop plus no idea what the password is, is an ordinary situation, and /account's
// change-password form is no use in it because that form asks for the current one.
// Sending a signed-in visitor to /account would close the only door that works —
// and would strand anyone whose recovery-intent cookie expired mid-reset, since
// /auth/reset sends them HERE to start over.
import { ForgotPasswordForm } from "@/app/components/ForgotPasswordForm";

export const metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage({
  searchParams,
}: {
  // Async in Next 16 — searchParams is a Promise.
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return <ForgotPasswordForm initialError={error} />;
}
