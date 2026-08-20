// Where requestPasswordReset lands, whether or not the address has an account.
//
// The conditional copy is the point, exactly as on /signup/check-email. This page
// is reached identically for a registered address and an unknown one, so the
// wording must not imply that mail was actually sent — "if an account exists" is
// what keeps the reset form from answering the question "does this person have an
// account here?" for anyone with a list of addresses to test.
import Link from "next/link";

export const metadata = { title: "Check your email" };

export default async function ResetCheckEmailPage({
  searchParams,
}: {
  // Async in Next 16 — searchParams is a Promise.
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-lg font-medium">Check your email</h1>

      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        If there&rsquo;s an account for{" "}
        {email ? (
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{email}</span>
        ) : (
          "that address"
        )}
        , a link to set a new password is on its way.
      </p>

      <p className="mb-6 text-xs text-zinc-500">
        The link expires in an hour and works once. Open it in this browser if you can — links
        opened elsewhere sometimes can&rsquo;t finish. Nothing in your inbox? Check spam before
        trying again.
      </p>

      <p className="text-xs text-zinc-500">
        <Link
          href="/login"
          className="text-zinc-600 underline decoration-dotted underline-offset-2 dark:text-zinc-400"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
