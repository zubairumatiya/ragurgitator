// Appraise → Semantic caching: the WOULD-HIT QUEUE. Per vector-space, the matches
// the cache would have served, waiting on a verdict — did the stored answer
// acceptably answer the new question? Verdicts come from an LLM pass (bulk, then a
// boundary re-judge) or from the Accept/Reject buttons on a row; either way they are
// the same choice about the same queue, and they are taken on demand, never inline.
//
// The section is named for the QUEUE and not for the judge: "shadow judge" named the
// agent, and the thing on screen is the evidence — hypothetical hits nobody actually
// received. Its verdicts are then swept into a recommended τ.
//
// It needs real would-hit traffic to have accrued and costs judge tokens to run, so
// it refines a threshold the collision floor already put in the right neighbourhood.
//
// Judging writes VERDICTS, never a threshold: the swept recommendation is broadcast
// to ApplyThresholdPanel, which owns every threshold write.
"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { config } from "@/lib/config";
import { apiFetch } from "@/lib/http/client";
import type {
  CalibrationReport,
  JudgeRunResult,
  ShadowEvent,
  ShadowSpace,
} from "@/lib/rag/semanticCacheCalibration";

import { emitRecommendation, SC_CHANGED } from "./events";
import { BTN, Panel, SELECT, WarnDot } from "./Panel";

// Deliberately does NOT name the target: it's a per-config setting now
// (batch_savings.semanticCache.acceptTarget), so a number baked in here would be
// wrong for any config holding an override. The live value — and whose it is —
// travels on the report and is rendered beside the τ readout.
const ABOUT =
  "Judge recorded would-hit events — does the stored answer acceptably answer " +
  "the new question? — then sweep the labels for the lowest threshold whose " +
  "served set still keeps acceptance at or above the precision target.\n\n" +
  "Events are judged on demand, not as they arrive.";

const pctOf = (n: number) => `${(n * 100).toFixed(1)}%`;

const MODELS = config.semanticCache.judgeModelOptions;

// PINNED TO REAL TRAFFIC. There used to be a "Swept over" picker offering probe
// rows and both pooled as well, and both of those are now read off the Cache key
// model table instead: its sweep pools the generated pairs with EVERY judged
// shadow row, traffic and probe alike (keyModelSweep.ts:106), so it is the same
// measurement over a strictly larger set, per model, with recall and AUC beside
// it. The one thing it structurally cannot give is a TRAFFIC-ONLY number —
// pooling is its method — and traffic-only is the only τ the apply box may take.
// So that is what this panel is for, and it no longer offers the two views
// something else does better.
const ORIGIN = "traffic" as const;


// What the swept population is called mid-sentence. Every count the sweep reports
// is scoped to rows at or above the shadow floor, while the space picker on the
// heading row counts every judged row in the space — so a sentence quoting a
// sweep count and read against that picker looks like a contradiction unless it
// says which set it is counting.
const POPULATION = "real-traffic";

export function ShadowJudgePanel() {
  const [spaces, setSpaces] = useState<ShadowSpace[]>([]);
  const [space, setSpace] = useState("");
  const [events, setEvents] = useState<ShadowEvent[]>([]);
  const [curve, setCurve] = useState<CalibrationReport | null>(null);
  const [bulkModel, setBulkModel] = useState<string>(config.semanticCache.judgeBulkModel);
  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight action
  const [lastRun, setLastRun] = useState<JudgeRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSpaces = useCallback((keep?: string) => {
    return apiFetch("/api/semantic-cache/shadow")
      .then((r) => r.json())
      .then((d) => {
        const list: ShadowSpace[] = d.spaces ?? [];
        setSpaces(list);
        const next = keep && list.some((s) => s.space === keep) ? keep : list[0]?.space ?? "";
        setSpace(next);
        return next;
      })
      .catch((e) => {
        setError(String(e));
        return "";
      });
  }, []);

  // Only ever sets state from async callbacks (never synchronously in the effect
  // body) so it's safe to call straight from an effect.
  const loadSpaceData = useCallback((s: string) => {
    apiFetch(`/api/semantic-cache/shadow?space=${encodeURIComponent(s)}&filter=unjudged&limit=50`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .catch((e) => setError(String(e)));
    apiFetch(
      `/api/semantic-cache/shadow/calibration?space=${encodeURIComponent(s)}&origin=${ORIGIN}`,
    )
      .then((r) => r.json())
      .then((d) => {
        const report: CalibrationReport | null = d.report ?? null;
        setCurve(report);
        // Offer the swept τ upward. Re-emitted whenever the curve reloads (space
        // switch, fresh verdicts) so the apply box tracks what's on screen; it
        // ignores the value if the user has typed one of their own.
        //
        // A one-class sample yields no τ to offer — `selectFromCurve` suppresses it
        // and reports "one-class-sample" — so this needs no check of its own beyond
        // the null. The note below explains the absence.
        //
        // Unconditionally safe to emit NOW THAT THE PANEL IS PINNED TO TRAFFIC.
        // This used to be guarded on the origin, and that guard was load-bearing:
        // a τ swept over engineered near-misses answers "what would the threshold
        // have to be if every question were adversarial", and the apply box cannot
        // tell where a number came from. The picker is gone, so the guard moved up
        // into ORIGIN rather than being dropped.
        if (report !== null && report.recommended !== null) {
          emitRecommendation({
            value: report.recommended,
            space: s,
            origin: "Would-hit queue",
            notes: `shadow-judge n=${report.totalJudged} target=${report.target} rows=${report.origin}`,
            sampleSize: report.totalJudged,
          });
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);
  useEffect(() => {
    if (space) loadSpaceData(space);
  }, [space, loadSpaceData]);

  // Reload from the space loadSpaces actually RESOLVED, not the captured one:
  // if the kept space no longer exists it falls back to list[0], and reusing the
  // stale `space` here would then load data for a space we're no longer showing.
  const refresh = useCallback(() => {
    loadSpaces(space).then((next) => next && loadSpaceData(next));
  }, [loadSpaces, loadSpaceData, space]);

  // A ROW CAN NOW ARRIVE FROM ANOTHER PANEL. §4's single probe (phase 4 of
  // docs/demo-cache-lab-plan.md) writes an unjudged shadow row and broadcasts
  // SC_CHANGED; without this listener it tells the visitor a row is waiting in
  // this queue and the queue does not have it until a reload. Harmless on the
  // event's other senders — a threshold write is a reason to re-read the curve
  // anyway.
  useEffect(() => {
    window.addEventListener(SC_CHANGED, refresh);
    return () => window.removeEventListener(SC_CHANGED, refresh);
  }, [refresh]);

  const runJudge = (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    setError(null);
    setLastRun(null);
    apiFetch("/api/semantic-cache/shadow/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setLastRun(d.result ?? null);
          refresh();
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null));
  };

  const humanVerdict = (id: string, verdict: "accept" | "reject") => {
    setError(null);
    // Optimistically drop it from the unjudged queue.
    setEvents((prev) => prev.filter((e) => e.id !== id));
    apiFetch("/api/semantic-cache/shadow/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "human", id, verdict }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        // Refresh the curve/counts; leave the (already-trimmed) queue as is.
        loadSpaceData(space);
        loadSpaces(space);
      })
      .catch((e) => setError(String(e)));
  };

  const current = spaces.find((s) => s.space === space);
  const rec = curve?.recommended ?? null;

  return (
    <Panel
      title="Would-hit queue"
      about={ABOUT}
      subtitle="Costs judge tokens — refines a floor that's already in the right neighbourhood."
      // The space picker doubles as this panel's scope AND its progress readout
      // ("12/40 judged"), so it belongs on the heading row like the collision
      // floor's config picker.
      action={
        spaces.length > 0 ? (
          <select
            value={space}
            onChange={(e) => setSpace(e.target.value)}
            aria-label="Space"
            className={SELECT}
          >
            {spaces.map((s) => (
              <option key={s.space} value={s.space}>
                {s.space} ({s.judged}/{s.total} judged
                {s.probes > 0 ? `, ${s.probes} probe` : ""})
              </option>
            ))}
          </select>
        ) : undefined
      }
    >
      {spaces.length === 0 ? (
        <p className="text-xs text-zinc-400">
          No shadow events yet. They accrue as questions are asked against a populated
          cache (any match above the shadow-log floor is recorded).
        </p>
      ) : (
        <>
          {/* ONE JUDGING RUN. There was a second — "Refine boundary", which
              re-judged the ±0.03 band around τ with a stronger model. Good idea,
              never used: across 489 judged rows every LLM verdict on this account
              came from the bulk model, because the button needs a τ to aim at and
              one-class traffic yields none, so it sat disabled behind the origin
              picker that is also gone. It can come back when traffic has rejects
              and there is a real boundary to spend a better model on. */}
          <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`${BTN} min-w-40`}
                disabled={busy !== null || !current || current.total === current.judged}
                onClick={() =>
                  runJudge("bulk", { mode: "llm", space, model: bulkModel, limit: 100 })
                }
              >
                {busy === "bulk" ? "Judging…" : "Run judge over queue"}
              </button>
              <span className="text-xs text-zinc-400">with</span>
              <select
                value={bulkModel}
                onChange={(e) => setBulkModel(e.target.value)}
                aria-label="Bulk model"
                className={SELECT}
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            {lastRun && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {lastRun.model}: {lastRun.accepted} accept · {lastRun.rejected} reject
                {lastRun.skipped ? ` · ${lastRun.skipped} skipped` : ""}
              </p>
            )}
          </div>

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

          {/* The swept τ and everything needed to read it, in one block.
              THE CURVE THAT USED TO HEAD IT IS GONE: it drew acceptance-vs-sim
              with no y-axis, no labels and preserveAspectRatio="none", so its
              one real message — where acceptance falls off — was carried better
              by the numbers under it, and on this account's traffic it was a
              flat line at 1.0 (91 judged, 91 accepted) saying nothing at all. */}
          <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="flex items-baseline gap-2">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Recommended τ</span>
                <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                  {rec === null ? "—" : rec.toFixed(4)}
                </span>
              </span>
              {curve && (
                <span className="text-xs text-zinc-400">
                  {curve.totalJudged} judged
                  {curve.overallAcceptRate !== null
                    ? `, ${(curve.overallAcceptRate * 100).toFixed(0)}% accept`
                    : ""}
                  ; needs ≥ {curve.minSamples}
                  {/* WHAT THIS SAMPLE IS. The panel sweeps traffic and only
                      traffic, so the excluded rows are always the probes — but
                      they are still worth naming: the space picker above counts
                      them, and a reader comparing the two tallies otherwise sees
                      the panel contradicting itself. */}
                  {curve.excludedByOrigin > 0 && (
                    <>
                      {" "}
                      · real traffic only ({curve.excludedByOrigin} probe row
                      {curve.excludedByOrigin === 1 ? "" : "s"} excluded)
                    </>
                  )}
                  {/* The F5 sample of the band below the shadow floor. Shown
                      because collecting it is only worth anything if someone
                      notices it growing a servable region; it stays out of the
                      sweep because it's a fraction of its band beside a census. */}
                  {!curve.includesSubFloor && curve.subFloorJudged > 0 && (
                    <>
                      {" "}
                      · {curve.subFloorJudged} sub-floor sample row
                      {curve.subFloorJudged === 1 ? "" : "s"} excluded
                    </>
                  )}
                </span>
              )}
            </div>

            {/* WHAT THIS POPULATION IS. One line rather than the picker's three:
                a τ is not interpretable without knowing what was asked, and this
                panel now only ever sweeps one thing. */}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Questions someone actually asked — the only population a live threshold
              may be set from.
            </p>

            {/* Points at the apply box in the Threshold section's footer. The
                branch that said "not sent" is gone with the picker: everything
                this panel sweeps is now emitted. */}
            {rec !== null && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Sent to the <strong className="font-medium">Set threshold</strong> box in
                the Threshold section — nothing is live until you apply it there.
              </p>
            )}
          </div>

          {/* WHY there's no τ. Without this the panel shows a dash and nothing
              else, leaving "is my data too small or my target too strict?" to be
              worked out by hand — and those have opposite fixes. */}
          {curve && rec === null && curve.attainability.blocker !== "no-events" && (
            <NoTau curve={curve} />
          )}

          {/* THE QUEUE, in the space the calibration curve used to take. It is
              what this section is named for: every verdict above and below comes
              from these rows, and while the curve sat on top of them the panel's
              actual evidence opened below the fold. */}
          <HumanQueue events={events} onVerdict={humanVerdict} />
        </>
      )}
    </Panel>
  );
}

// WHY THERE IS NO τ: the diagnosis on the line, the mechanism behind the dot.
//
// All three of these used to be full amber paragraphs. Each was accurate and each
// was five lines of standing prose above the queue — a reader who has met the
// blocker once needs the numbers and the fix, not the derivation again, so the
// derivation moved to the dot and the numbers stayed.
function NoTau({ curve }: { curve: CalibrationReport }) {
  const { attainability: att } = curve;
  const pop = POPULATION;
  const target = pctOf(curve.target);
  // Named rather than pointed at: the target's slider is a section away, and the
  // config that owns it needn't be the one this curve was swept for.
  const targetHome = `${curve.targetSource.configLabel}'s precision target, beside the slider in Cache key model`;

  let why: string;
  let line: ReactNode;

  if (att.blocker === "below-min-samples") {
    why =
      `A τ is only offered once ${curve.minSamples} events sit at or above it, so ` +
      `${target} was never actually tested on a sample this small.`;
    line = (
      <>
        No τ yet — <span className="tabular-nums">{curve.totalJudged}</span> judged {pop}{" "}
        events never fill a serve set of {curve.minSamples}. Judge more events.
      </>
    );
  } else if (att.blocker === "one-class-sample") {
    why =
      "Precision is 100% at every threshold, so the sweep would return the lowest " +
      "similarity in the sample rather than a boundary — nothing here shows where " +
      "matches start failing." +
      // WHERE TO LOOK INSTEAD, now that this panel no longer offers the probe
      // view itself. The key model table sweeps the probe rows pooled with the
      // generated pairs, which is where precision visibly trades against recall
      // while traffic is still all accepts.
      (curve.excludedByOrigin > 0
        ? ` The ${curve.excludedByOrigin} probe rows this sweep excludes do — they are ` +
          "scored in the Cache key model table, remembering that a τ from engineered " +
          "near-misses is a worst-case bound and not this account's traffic."
        : "");
    line = (
      <>
        No τ — all <span className="tabular-nums">{curve.totalJudged}</span> judged events
        were accepted. Keep the current threshold until real rejects appear.
      </>
    );
  } else {
    // THE SERVE SET is the count that needed explaining: it is the events at or
    // above a candidate τ, a PREFIX of this curve's judged events rather than all
    // of them, so a bare "held 21" read against the space picker's tally looks
    // like the panel contradicting itself.
    why =
      `The serve set is the events at or above a candidate τ — a prefix of this ` +
      `curve's ${curve.totalJudged} judged ${pop} events, not all of them. ` +
      (att.requiredN !== null
        ? `Clearing ${target} with ${att.rejectsInBest} rejected takes ${att.requiredN} of them.`
        : `At ${target} no serve set size forgives a single reject, so only a ` +
          "perfectly clean prefix yields a τ.");
    line = (
      <>
        No τ at {target} — the best serve set held{" "}
        <span className="tabular-nums">{att.bestRateAt!.n}</span> at{" "}
        <span className="tabular-nums">{pctOf(att.bestRate!)}</span> ({att.rejectsInBest}{" "}
        rejected).{" "}
        {att.requiredN !== null ? (
          <>
            Judge more in the queue below, or lower {targetHome}.
          </>
        ) : (
          <>Lower {targetHome}.</>
        )}
      </>
    );
  }

  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
      {/* mt-0.5: the dot is a glyph on a wrapping paragraph, so it aligns to the
          first line's text rather than to the block's centre. */}
      <span className="mt-0.5 shrink-0">
        <WarnDot text={why} />
      </span>
      <span>{line}</span>
    </p>
  );
}

// The unjudged rows themselves. Wears the same bordered block as the judging
// controls and the τ readout above it — it is a peer of those, not a footnote
// under them, and the three used to sit at three different weights.
function HumanQueue({
  events,
  onVerdict,
}: {
  events: ShadowEvent[];
  onVerdict: (id: string, verdict: "accept" | "reject") => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      {/* Says "judge by hand" and not "human queue": these are the same rows the
          bulk pass reads, so naming them after the judge that happens to take
          them made the two buttons look like two different queues. */}
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Judge by hand · {events.length} unjudged
      </h3>
      {events.length === 0 && (
        <p className="text-xs text-zinc-400">Nothing unjudged in this space.</p>
      )}
      {/* Scrolls rather than growing: the queue fetches up to 50 events and each
          card carries 600 characters of answer, so an unjudged space used to run
          the page thousands of pixels past the panels below it. */}
      <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto pr-1 empty:hidden">
        {events.map((e) => (
        <div
          key={e.id}
          className="flex shrink-0 flex-col gap-2 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">
                new question · sim{" "}
                <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                  {e.sim.toFixed(4)}
                </span>
              </span>
              <span className="text-zinc-800 dark:text-zinc-200">{e.newQuery}</span>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => onVerdict(e.id, "accept")}
                className="rounded-md border border-green-300 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/30"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => onVerdict(e.id, "reject")}
                className="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
              >
                Reject
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <span className="text-xs text-zinc-400">
              would serve this answer (matched: “{e.matchedQuery}”)
            </span>
            <span className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
              {e.servedAnswer.length > 600 ? `${e.servedAnswer.slice(0, 600)}…` : e.servedAnswer}
            </span>
          </div>
        </div>
        ))}
      </div>
    </div>
  );
}
