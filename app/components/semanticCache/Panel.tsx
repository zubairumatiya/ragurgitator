// ---------------------------------------------------------------------------
// The section frame every panel on Appraise → Semantic caching wears.
//
// It exists because the four panels used to each invent their own chrome — one
// unboxed with a rule underneath, one bare, one a bordered card with its own
// padding, one relying on the page to draw a rule above it. Four treatments for
// four peers made the page read as a pile of widgets rather than one calibration
// workflow, and the panels' shared parts (heading, "?" dot, an action row) drifted
// apart in spacing every time one was edited.
//
// So the frame is one component and the panels only supply content:
//   • `step`    — the panel's place in the working order (cheapest evidence
//                 first; see the page). The numbers are the whole reason the
//                 order is legible on screen instead of only in a code comment.
//   • `title` / `about`    — heading + the "?" tooltip.
//   • `subtitle`          — one line on what the panel COSTS to use, which is
//                 what actually decides whether you reach for it now.
//   • `action`  — a status/scope control that belongs on the heading row.
//   • `footer`  — a WRITE control. Both panels that write (the threshold apply
//                 box and the key-model apply row) put it here, so "the thing
//                 that changes what's live" is always in the same place: a tinted
//                 strip flush with the card's bottom edge.
//
// No state and no hooks, so it renders in a Server Component (the page frame) and
// inside the self-fetching Client Components alike.
// ---------------------------------------------------------------------------
import type { ReactNode } from "react";

import { InfoDot } from "@/app/components/InfoDot";
import { Tooltip } from "@/app/components/Tooltip";

// Bleeds to the card's edges: the card owns the padding (p-4), so a full-width
// strip has to pull back out of it (-mx-4) and re-apply its own inset. Matching
// the card's radius on the bottom corners keeps it from squaring off the card.
const FOOTER =
  "-mx-4 -mb-4 mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-b-xl border-t border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40";

export function Panel({
  step,
  title,
  about,
  subtitle,
  action,
  footer,
  children,
}: {
  step: number;
  title: string;
  about: string;
  subtitle?: string;
  action?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      {/* items-start, not items-center: the heading block is two lines tall once
          it has a subtitle, and a centred action would float against neither. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {step}
            </span>
            {title}
            <InfoDot text={about} />
          </h2>
          {/* Indented to the title, clearing the step badge, so the two lines
              read as one heading block. */}
          {subtitle && (
            <p className="pl-7 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
          )}
        </div>
        {action}
      </div>

      {children}

      {footer && <div className={FOOTER}>{footer}</div>}
    </section>
  );
}

// Shared control skin, so a button in one panel is the same button in the next.
// These were four near-identical string literals across the panels, each with its
// own drift (one had cursor-pointer, one didn't).
export const BTN =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 cursor-pointer transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

export const SELECT =
  "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";

// The primary (writes-something) button. Both apply controls use it.
export const BTN_PRIMARY =
  "rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-black";

// An amber advisory: why a number is missing, or why one is unsafe. Every panel
// had its own copy of this and they disagreed on radius.
export const NOTE_AMBER =
  "rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";

// InfoDot's amber sibling: same affordance, but it marks something WRONG rather
// than something worth knowing, so it draws the eye instead of receding.
//
// Use it where the explanation is long but the reader only needs it once — a
// paragraph that explains a table's empty column is five lines of prose sitting
// permanently above four lines of table, and it reads as an error banner every
// time you open the page. The "!" keeps the signal ("this is why") at a glyph's
// cost and parks the reasoning on hover.
//
// Color is never the only channel: the glyph itself says "!", and it's paired
// with a short text label at every call site.
export function WarnDot({ text, align = "left" }: { text: string; align?: "center" | "left" | "right" }) {
  return (
    <Tooltip text={text} align={align}>
      <span
        aria-label={text}
        role="img"
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-amber-500 text-[9px] font-semibold leading-none text-amber-600 transition-colors hover:bg-amber-500 hover:text-white dark:border-amber-500 dark:text-amber-400 dark:hover:bg-amber-500 dark:hover:text-black"
      >
        !
      </span>
    </Tooltip>
  );
}

// A borderless table, for use INSIDE a card: the card already draws the box, so
// the table separates rows with hairlines and bleeds to the card's edges rather
// than drawing a second border just inside the first.
export const TABLE_WRAP = "-mx-4 overflow-x-auto";
export const TABLE_HEAD =
  "border-y border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400";
