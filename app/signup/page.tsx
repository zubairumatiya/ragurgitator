// Sign-up page. See app/login/page.tsx — same public-route handling.
import { signUp } from "@/app/auth/actions";
import { AuthForm } from "@/app/components/AuthForm";
import { demoEnabled } from "@/lib/demo/config";

export const metadata = { title: "Create an account" };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <AuthForm mode="signup" action={signUp} next={next} demoAvailable={demoEnabled()} />;
}
