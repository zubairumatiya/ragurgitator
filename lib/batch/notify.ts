// NOTIFY — "we'll email you when it's done" for PROVIDER BATCHES.
//
// Only the body lives here now; the wire (Resend, the best-effort contract, the
// recipient rule) moved to lib/notify/email.ts when background jobs needed the same
// promise. Two copies of "construct a Resend client and swallow failures" is how
// the two would have drifted.
//
// In-app notification is DERIVED, not stored: the status panel treats any
// terminal-but-unacknowledged job as a toast/badge (batch_jobs.acknowledged), so
// there is no notifications table.
//
// THE RECIPIENT IS THE JOB'S OWNER. It used to be a single BATCH_NOTIFY_EMAIL for
// the whole deployment, which was fine when the app had one user and is a data leak
// with accounts — one person's results, mailed to whatever address the deployment
// happened to hold. That variable is now a development-only override
// (lib/notify/email.ts).
import { emailConfigured, escapeHtml, mailShell, sendMail } from "@/lib/notify/email";
import { JOB_LABELS, type BatchJob } from "@/lib/batch/types";

export { emailConfigured };

function body(job: BatchJob): { subject: string; html: string } {
  const label = JOB_LABELS[job.kind];
  const failed = job.status === "failed" || job.status === "expired";
  const cancelled = job.status === "cancelled";
  const verb = failed ? "failed" : cancelled ? "was cancelled" : "is done";
  const subject = `Your ${label} batch ${verb}`;
  const line = failed
    ? `The batch ended in an error: ${job.error ?? "unknown error"}.`
    : cancelled
      ? `You cancelled this batch. ${job.appliedCount} result(s) were still applied.`
      : `${job.appliedCount} of ${job.requestCount} result(s) were applied` +
        (job.erroredCount > 0 ? `, ${job.erroredCount} errored.` : ".");
  const html = mailShell(
    [`<strong>${label}</strong> — config <em>${escapeHtml(job.configLabel)}</em>`, escapeHtml(line)],
    `Batch ${job.id} · ${job.provider} · ${job.status}`,
  );
  return { subject, html };
}

// Send the completion (or failure) email. Returns whether one actually went out.
// `to` is the job owner's address, resolved by the caller — this module never
// decides who a batch belongs to.
export async function sendCompletionEmail(job: BatchJob, to: string | null): Promise<boolean> {
  const { subject, html } = body(job);
  return sendMail({ to, subject, html });
}
