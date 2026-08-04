// Sign-in page. Public — proxy.ts lets /login through unauthenticated and
// bounces already-signed-in visitors away, so this never renders for a user who
// has a session.
import { signIn } from "@/app/auth/actions";
import { AuthForm } from "@/app/components/AuthForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  // Async in Next 16 — searchParams is a Promise.
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return <AuthForm mode="signin" action={signIn} next={next} initialError={error} />;
}
