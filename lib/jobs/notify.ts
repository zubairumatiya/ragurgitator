// "You can close the tab, we'll email you" — the half that keeps the promise.
//
// One mail per job, when it reaches a terminal status. The `email_sent` flag on
// the row is what makes that once-only: a janitor sweep that re-examines a
// finished job must not mail it again.
import { escapeHtml, mailShell, sendMail } from "@/lib/notify/email";
import { jobsBaseUrl } from "@/lib/http/jobSecret";
import { JOB_LABELS, JOB_UNITS, type BackgroundJob } from "@/lib/jobs/types";

function pluralize(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

function duration(job: BackgroundJob): string {
  if (!job.startedAt || !job.finishedAt) return "";
  const ms = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "under a minute";
  return pluralize(mins, "minute");
}

// The headline line, per outcome. A cancelled job is NOT a failure and must not
// read like one: the work it did finish was kept (cancellation commits partial
// work by design), so the mail says how much rather than apologizing.
function headline(job: BackgroundJob): string {
  const label = JOB_LABELS[job.kind];
  const unit = JOB_UNITS[job.kind];
  const did = pluralize(job.doneUnits, unit);
  switch (job.status) {
    case "succeeded":
      // "Finished with 12 of 89 units failed" is a different sentence from
      // "finished", and the mail is the only place most of these jobs are ever
      // read (0066). Reported in the headline rather than a footnote because a
      // sweep with holes in it is a result the user has to act on.
      if (job.failedUnits > 0) {
        return `<strong>${label}</strong> finished in ${duration(job)}, but ` +
          `${job.failedUnits.toLocaleString()} of ${did} failed and were skipped.`;
      }
      return `<strong>${label}</strong> finished — ${did} processed in ${duration(job)}.`;
    case "cancelled":
      return `<strong>${label}</strong> was cancelled. The ${did} it had already ` +
        `processed were kept.`;
    default:
      return `<strong>${label}</strong> stopped with an error after ${did}.`;
  }
}

// Display names for the metrics a step may report. A key with no entry is printed
// as-is, so a new job kind gets a readable mail without touching this file — the
// map only exists to spell the three that would otherwise arrive as "ndcg".
const RESULT_LABELS: Record<string, string> = {
  recall: "Recall@k",
  mrr: "MRR",
  ndcg: "nDCG",
};

// Whatever the step chose to put in `result`. Rates are rendered as percentages
// because that is how the dashboard shows them; a raw 0.9782608695652174 in an
// email is a number nobody reads.
function resultLines(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  return Object.entries(result as Record<string, unknown>)
    .filter(([, v]) => v !== null && (typeof v === "number" || typeof v === "string"))
    .map(([k, v]) => {
      const label = escapeHtml(RESULT_LABELS[k] ?? k);
      const shown =
        typeof v === "number" && v >= 0 && v <= 1 ? `${(v * 100).toFixed(1)}%` : String(v);
      return `${label}: <strong>${escapeHtml(shown)}</strong>`;
    });
}

export function jobMail(job: BackgroundJob, to: string) {
  const label = JOB_LABELS[job.kind];
  const verb =
    job.status === "succeeded" ? "is done" : job.status === "cancelled" ? "was cancelled" : "failed";
  const link = `${jobsBaseUrl()}/c/${job.configId}/eval`;
  const lines = [
    headline(job),
    `Config: <em>${escapeHtml(job.configLabel)}</em>`,
    ...resultLines(job.result),
    job.error ? `Error: ${escapeHtml(job.error)}` : "",
    // The breadcrumb the aborted-transaction case never had: one example of what
    // went wrong, kept on the row rather than in a stream nobody was reading.
    job.lastUnitError ? `Last failure: ${escapeHtml(job.lastUnitError)}` : "",
    `<a href="${link}">Open the eval dashboard</a>`,
  ].filter(Boolean);
  return {
    to,
    subject: `Your ${label.toLowerCase()} ${verb}`,
    html: mailShell(lines, `Job ${job.id} · ${job.status}`),
  };
}

export async function sendJobCompletionEmail(job: BackgroundJob, to: string): Promise<boolean> {
  if (job.emailSent) return false;
  return sendMail(jobMail(job, to));
}
