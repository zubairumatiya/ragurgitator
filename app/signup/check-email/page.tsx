// Where signUp lands once Supabase has accepted the account and sent a confirmation
// link. Public — proxy.ts lets /signup/* through, which matters because the user has
// no session yet and won't get one until they click the link in their inbox.
//
// The copy is deliberately conditional ("if that address is new"): Supabase returns
// an identical response for an address that is already registered, precisely to keep
// signup from confirming who has an account. A flat "we sent you an email" would
// leak exactly what the server worked to hide.
import Link from "next/link";

import { Wordmark } from "@/app/components/Logo";

export const metadata = { title: "Check your email" };

export default async function CheckEmailPage({
  searchParams,
}: {
  // Async in Next 16 — searchParams is a Promise.
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6">
      <Wordmark size={46} textClassName="text-xl" className="mb-7" />
      <h1 className="mb-1 text-lg font-medium">Check your email</h1>

      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        If{" "}
        {email ? (
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {email}
          </span>
        ) : (
          "that address"
        )}{" "}
        is new here, a confirmation link is on its way. Click it to finish
        setting up your account.
      </p>

      <p className="mb-6 text-xs text-zinc-500">
        The link expires in 24 hours. Nothing in your inbox? Check spam before
        trying again.
      </p>

      <p className="text-xs text-zinc-500">
        Already confirmed?{" "}
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
