// EMAIL TRANSPORT — the one place Resend is constructed and the one place a send
// is allowed to fail quietly.
//
// Extracted from lib/batch/notify.ts when background jobs needed the same
// "we'll email you when it's done" promise. The bodies stay with their features
// (lib/batch/notify.ts, lib/jobs/notify.ts); only the wire lives here.
//
// STRICTLY BEST-EFFORT, and that is a contract, not an accident: no API key, no
// recipient, or a provider outage all return false rather than throwing. A batch
// that took twenty minutes must not be reported as failed because the mail didn't
// go out.
//
// THE RECIPIENT IS THE OWNER, NOT AN ENV VAR. BATCH_NOTIFY_EMAIL was fine when the
// app had one user; with accounts, mailing every user's job results to whatever
// address happened to be in the deployment's env is a data leak with a friendly
// face. It survives only as a development override, and only when it is the signed
// -in user's own address is that override ever the same thing as correct.
import { Resend } from "resend";

let _resend: Resend | null | undefined;

function client(): Resend | null {
  if (_resend !== undefined) return _resend;
  const key = process.env.RESEND_API_KEY;
  _resend = key ? new Resend(key) : null;
  return _resend;
}

function sender(): string {
  return process.env.BATCH_NOTIFY_FROM?.trim() || "RAG <onboarding@resend.dev>";
}

// Can real email go out at all? Surfaced to the UI so the "run in background"
// copy can honestly say "we'll email you" rather than promising a mail that has
// nowhere to come from.
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

// Development override, deliberately opt-in: point every notification at one
// mailbox while testing. Ignored in production, where the only correct recipient
// is the row's owner.
function overrideRecipient(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  return process.env.BATCH_NOTIFY_EMAIL?.trim() || null;
}

export type Mail = { to: string | null; subject: string; html: string };

// Returns whether a mail actually went out. Callers use that to decide whether to
// stamp their `email_sent` flag, so a false must never be a silent success.
export async function sendMail(mail: Mail): Promise<boolean> {
  const c = client();
  const to = overrideRecipient() ?? mail.to;
  if (!c || !to) return false;
  try {
    await c.emails.send({ from: sender(), to, subject: mail.subject, html: mail.html });
    return true;
  } catch (e) {
    console.warn(`[notify] email send failed: ${String(e)}`);
    return false;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

// Shared shell so batch mail and job mail look like the same product rather than
// two features that both happened to reach for Resend.
export function mailShell(lines: string[], footer: string): string {
  return (
    `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">` +
    lines.map((l) => `<p>${l}</p>`).join("") +
    `<p style="color:#71717a;font-size:12px">${footer}</p>` +
    `</div>`
  );
}
