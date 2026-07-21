// ---------------------------------------------------------------------------
// NOTIFY — "we'll email you when it's done", the real half.
//
// In-app notification is DERIVED, not stored: the status panel treats any
// terminal-but-unacknowledged job as a toast/badge (batch_jobs.acknowledged),
// so there's no separate notifications table. This module owns only the EMAIL
// side, via Resend, and is strictly best-effort:
//   • no RESEND_API_KEY or no recipient → returns false, never throws;
//   • a send failure is logged and swallowed — a batch must never fail because
//     the email didn't go out.
//
// Recipient is BATCH_NOTIFY_EMAIL (a single address until real user accounts
// land — see the plan doc). Sender is BATCH_NOTIFY_FROM, defaulting to Resend's
// shared onboarding sender so it works before a domain is verified.
// ---------------------------------------------------------------------------
import { Resend } from "resend";
import { JOB_LABELS, type BatchJob } from "@/lib/batch/types";

let _resend: Resend | null | undefined;
function client(): Resend | null {
  if (_resend !== undefined) return _resend;
  const key = process.env.RESEND_API_KEY;
  _resend = key ? new Resend(key) : null;
  return _resend;
}

function recipient(): string | null {
  return process.env.BATCH_NOTIFY_EMAIL?.trim() || null;
}
function sender(): string {
  return process.env.BATCH_NOTIFY_FROM?.trim() || "RAG batch <onboarding@resend.dev>";
}

// Is real email even possible right now? Surfaced to the UI so the settings copy
// can honestly say "we'll email you" vs "we'll notify you here".
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && recipient());
}

function body(job: BatchJob): { subject: string; html: string } {
  const label = JOB_LABELS[job.kind];
  const failed = job.status === "failed" || job.status === "expired";
  const canceled = job.status === "canceled";
  const verb = failed ? "failed" : canceled ? "was canceled" : "is done";
  const subject = `Your ${label} batch ${verb}`;
  const line = failed
    ? `The batch ended in an error: ${job.error ?? "unknown error"}.`
    : canceled
      ? `You canceled this batch. ${job.appliedCount} result(s) were still applied.`
      : `${job.appliedCount} of ${job.requestCount} result(s) were applied` +
        (job.erroredCount > 0 ? `, ${job.erroredCount} errored.` : ".");
  const html =
    `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">` +
    `<p><strong>${label}</strong> — config <em>${escapeHtml(job.configLabel)}</em></p>` +
    `<p>${escapeHtml(line)}</p>` +
    `<p style="color:#71717a;font-size:12px">Batch ${job.id} · ${job.provider} · ${job.status}</p>` +
    `</div>`;
  return { subject, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// Send the completion (or failure) email. Returns whether one actually went out.
export async function sendCompletionEmail(job: BatchJob): Promise<boolean> {
  const c = client();
  const to = recipient();
  if (!c || !to) return false;
  const { subject, html } = body(job);
  try {
    await c.emails.send({ from: sender(), to, subject, html });
    return true;
  } catch (e) {
    console.warn(`[batch:notify] email send failed for ${job.id}: ${String(e)}`);
    return false;
  }
}
