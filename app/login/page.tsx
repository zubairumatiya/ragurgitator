// Sign-in page. Public — proxy.ts lets /login through unauthenticated and
// bounces already-signed-in visitors away, so this never renders for a user who
// has a session.
import { signIn } from "@/app/auth/actions";
import { AuthForm } from "@/app/components/AuthForm";
import { demoEnabled } from "@/lib/demo/config";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  // Async in Next 16 — searchParams is a Promise.
  searchParams: Promise<{ next?: string; error?: string; deleted?: string }>;
}) {
  const { next, error, deleted } = await searchParams;
  return (
    <AuthForm
      mode="signin"
      action={signIn}
      next={next}
      initialError={error}
      // Set by deleteAccount() on its way out, so the last thing a departing
      // user sees confirms the deletion actually happened.
      initialNotice={deleted ? "Your account and all of its keys have been deleted." : undefined}
      demoAvailable={demoEnabled()}
    />
  );
}
