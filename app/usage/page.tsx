// My usage — the per-call record of everything this app did with your provider
// keys (migration 0072).
//
// Standalone (outside /c/[configId]) like Corpora, Appraise and Cache: keys are
// per-user, not per-config, so the listing spans configs and a per-config banner
// would be actively misleading. Dynamic — it reads the DB per request.
//
// THE COPY IS THE FEATURE HERE, more than the table is. A ledger written by the
// same server that holds the key cannot prove that server's own innocence, and a
// page that implied otherwise would be worse than no page. So the blurb says what
// this catches, says plainly what it does not, and points at the only use that
// actually pays: comparing these numbers against the provider's own dashboard.
import { BackToConfigs } from "@/app/components/BackToConfigs";
import { InfoDot } from "@/app/components/InfoDot";
import { UsageReport } from "@/app/components/UsageReport";
import { withPageUser } from "@/lib/auth/dal";
import { getKeyUsageReport } from "@/lib/auth/keyUsageStore";

export const dynamic = "force-dynamic";

export const metadata = { title: "API key usage" };

const ABOUT =
  "Every call this app made with one of your provider API keys: what it was " +
  "doing, which key paid, what it cost, and whether the provider accepted it. " +
  "Rejected calls are recorded too — they spend nothing, which is exactly why " +
  "nothing else here records them, and a run of them against a key you aren't " +
  "using is the clearest sign something is wrong.\n\n" +
  "READ THIS AGAINST YOUR PROVIDER'S OWN DASHBOARD. These rows are written by " +
  "the same server that decrypts your key, so they cannot vouch for that " +
  "server: whoever operates it could simply not write a row. What the ledger " +
  "does catch is a key being spent by someone else — a leaked key, a " +
  "dependency exfiltrating credentials, a loop in our code that ran away. All " +
  "of those show up as a gap between this table and the provider's records, " +
  "and the gap is the signal. Treating this page as reassurance on its own is " +
  "the one way to use it that buys you nothing.\n\n" +
  "Per-config cost lives on Appraise → Costs; this is per-key, which is a " +
  "different question with a different owner. Rows older than 90 days are " +
  "deleted, as are the oldest once an account passes 50,000 of them.";

export default async function UsagePage() {
  const report = await withPageUser(() => getKeyUsageReport());

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-6xl flex-1 flex-col gap-6 px-8 py-12">
        <BackToConfigs />

        <header className="flex flex-col gap-2">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            API key usage
            <InfoDot text={ABOUT} />
          </h1>
          <p className="max-w-prose text-sm text-zinc-500 dark:text-zinc-400">
            Everything this app did with your provider keys in the last{" "}
            {report.windowDays} days. It is written by the same server that decrypts
            your key, so its job is to be <em>compared</em> — check these figures
            against your provider&rsquo;s own usage dashboard, and treat any
            divergence as the thing worth investigating.
          </p>
        </header>

        {!report.hasData ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No calls recorded yet. Ask a question, run an eval or ingest a document
            and every provider call it makes is logged here — including the ones
            the provider rejects.
          </div>
        ) : (
          <UsageReport report={report} />
        )}
      </main>
    </div>
  );
}
