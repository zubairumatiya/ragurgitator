// UI: the bordered section every block on /account sits in.
//
// It exists to end a specific bug in that page's hierarchy: sections used to be
// separated by nothing but a top margin, so the ONLY bordered box on the page was
// "Delete account" — which read as the page announcing that destroying your
// account was the main event. Giving every section the same box makes the red one
// a variant rather than the only thing with any weight.
//
// It also settles the heading level. The page used `h2 text-sm font-medium` while
// the MCP card used `h3 text-xs uppercase tracking-wide` for peers of those same
// headings; both are here now, as `title` (h2) and the SubHeading below (h3), so
// the two cannot drift apart again.
//
// Server-safe: no hooks, no handlers. `info` is a plain string handed to InfoDot,
// which is where the long-form copy goes.
import type { ReactNode } from "react";

import { InfoDot } from "@/app/components/InfoDot";

export function SectionCard({
  title,
  info,
  action,
  tone = "default",
  children,
}: {
  title: string;
  // Long-form explanation, parked in the heading's "?" rather than printed under
  // it. Anything the user must see before acting belongs in `children`, not here.
  info?: string;
  // Right-aligned slot on the heading row — a link or control ABOUT the section,
  // never the section's primary action.
  action?: ReactNode;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  const danger = tone === "danger";

  return (
    <section
      className={`rounded-lg border p-5 ${
        danger
          ? "border-red-200 bg-white dark:border-red-900/50 dark:bg-zinc-950"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <h2
          className={`flex items-center gap-2 text-sm font-semibold ${
            danger ? "text-red-700 dark:text-red-400" : ""
          }`}
        >
          {title}
          {/* align="left" so a bubble opened from a heading grows into the card
              rather than off its left edge. */}
          {info ? <InfoDot text={info} align="left" /> : null}
        </h2>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

// The one-line orientation under a heading. Deliberately singular: the section it
// was written for had four paragraphs here, and the rule that replaced them is
// that whatever survives on screen has to be the sentence you would keep if you
// could only keep one. The rest goes in `info`.
export function SectionIntro({ children }: { children: ReactNode }) {
  return <p className="mt-1 max-w-prose text-xs text-zinc-500">{children}</p>;
}

// Peer headings INSIDE a card (the MCP card's "Connected agents", "Write access").
// Visually subordinate to SectionCard's h2 and semantically an h3, which is the
// pairing the old page kept getting backwards.
export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">{children}</h3>
  );
}

// A state you can read without parsing a sentence: "Set" / "Not set" / "On" /
// "Off". `tone` carries the meaning for anyone who cannot use the colour, since
// the words differ too — the colour is never the only signal.
export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive";
}) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        tone === "positive"
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
          : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
      }`}
    >
      {children}
    </span>
  );
}
