// Appraise → Semantic caching: collision-floor calibration. Pick a config, compute
// the eval-bank collision floor for its vector-space, and review the safe band.
// Pure arithmetic server-side — no LLM calls, available immediately, which is why
// it's the first panel and where a threshold starts.
//
// The last report per config is SAVED (0037), so this panel loads it on mount and
// whenever the config picker changes instead of re-running a sweep whose inputs
// haven't moved. A saved report is displayed and broadcast exactly like a fresh one
// — the only difference is the "Computed …" stamp and a stale hint when the
// config's labeled-question count has moved since.
//
// The FIRST config's saved report arrives as a prop, read during the page's server
// render. It used to be fetched here, behind a second fetch for the config list —
// two round trips deep, so opening the tab painted an empty panel and then popped
// the numbers in.
//
// READ-ONLY as far as thresholds go: the saved report is a display cache. The
// recommendation is broadcast to ApplyThresholdPanel, which sits in this panel's
// footer and owns every write.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Tooltip } from "@/app/components/Tooltip";
import { apiFetch } from "@/lib/http/client";
import type { CollisionFloorState } from "@/lib/rag/collisionFloorStore";
import type { ConfigSummary } from "@/lib/rag/configStore";
import type { CollisionFloorReport } from "@/lib/rag/semanticCacheCalibration";

import { emitRecommendation } from "./events";
import { BTN, NOTE_AMBER, Panel, SELECT } from "./Panel";

const ABOUT =
  "From a config's labeled eval questions: the highest cosine between two " +
  "questions with DIFFERENT ground-truth chunks is the floor — the closest two " +
  "genuinely-different questions ever land. The threshold must sit above it.\n\n" +
  "The recommendation adds a small margin and stays below the nearest " +
  "same-answer pair, so it catches paraphrases with no false hit on the eval bank.";

const num = (n: number | null) => (n === null ? "—" : n.toFixed(4));
// Date AND time: a floor can be recomputed several times in one sitting, so the
// day alone wouldn't tell you which run you're looking at (cf. fmtDate in
// ThresholdsPanel, where calibrations are days apart).
const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

// What both verbs return: the report plus the stamp and the live labeled-question
// count the staleness hint compares against.
type FloorResponse = {
  report?: CollisionFloorReport | null;
  computedAt?: string | null;
  questionsNow?: number | null;
  error?: string;
};

// Offer the recommendation upward; the apply panel decides what to do with it.
// Shared by the fresh-compute and load-saved paths so a restored report carries
// exactly the same provenance into semantic_cache_thresholds.notes.
function offer(report: CollisionFloorReport): void {
  if (report.recommended === null) return;
  emitRecommendation({
    value: report.recommended,
    space: report.space,
    origin: "Collision floor",
    notes: `collision-floor (${report.embeddingModel}) floor=${num(report.floor)}`,
    sampleSize: report.distinctPairs + report.sameAnswerPairs,
  });
}

// A report (fresh or restored) STAMPED with the config it describes: when it was
// computed and how many labeled questions that config has now travel with it, so
// a slow response can never paint one config's floor under another's name.
type Loaded = {
  configId: string;
  report: CollisionFloorReport;
  computedAt: string | null;
  questionsNow: number | null;
};

// What the server already read, for the config this panel opens on. A null
// `report` is a real answer — nothing computed yet for that config — and
// suppresses the mount fetch exactly like a restored report does; only a preload
// the server couldn't do at all (`preload` itself null) falls back to fetching.
export type CollisionFloorPreload = CollisionFloorState & { configId: string };

// `configs` and `preload` come from the page's server render — see the header
// note. `action` is the apply control, rendered in this section's FOOTER: the
// recommendation computed here is what you'd apply, so the control sits directly
// under it, and reading order becomes numbers → band → apply. (It used to be
// crammed onto the heading row, above the numbers it applies, where it had to
// stay heading-height and stack its status lines into a narrow right-aligned
// column.)
export function CollisionFloorPanel({
  configs,
  preload,
  action,
}: {
  configs: ConfigSummary[];
  preload: CollisionFloorPreload | null;
  action?: ReactNode;
}) {
  const [configId, setConfigId] = useState(preload?.configId ?? configs[0]?.id ?? "");
  // Stamped rather than cleared on switch: nothing is set synchronously in an
  // effect (which would cascade renders), and rendering simply ignores a report
  // belonging to a config that is no longer selected.
  const [loaded, setLoaded] = useState<Loaded | null>(
    preload?.report
      ? {
          configId: preload.configId,
          report: preload.report,
          computedAt: preload.computedAt,
          questionsNow: preload.questionsNow,
        }
      : null,
  );
  const [error, setError] = useState<{ configId: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The server's read. In a ref rather than an effect dep so the effect below
  // still keys on configId alone, and cleared the first time the picker moves
  // elsewhere: coming BACK then re-fetches, because the floor may have been
  // recomputed since the page was rendered.
  const fromServer = useRef(preload);

  // Restore the saved report on mount and on every config switch, so coming back
  // to this page shows the last floor instead of an empty panel. `live` drops a
  // response that lands after the picker has moved on.
  useEffect(() => {
    if (!configId) return;

    const pre = fromServer.current;
    if (pre && pre.configId === configId) {
      // Already painted from the server render — fetching would only repaint
      // identical numbers. The recommendation still has to be offered, since
      // that used to ride the fetch response. Safe here: effects run
      // child-first, and ApplyThresholdPanel (the `action` slot below) is a
      // descendant, so it is already listening. Idempotent, so re-running this
      // effect (StrictMode's double-invoke in dev) costs nothing.
      if (pre.report) offer(pre.report);
      return;
    }
    fromServer.current = null;

    let live = true;
    apiFetch(`/api/semantic-cache/collision-floor?configId=${encodeURIComponent(configId)}`)
      .then((r) => r.json())
      .then((d: FloorResponse) => {
        if (!live) return;
        if (d.error) return setError({ configId, message: d.error });
        // No saved report is the normal empty state (nothing computed yet, or
        // migration 0037 not applied) — not an error, just an empty panel.
        if (!d.report) return;
        setLoaded({
          configId,
          report: d.report,
          computedAt: d.computedAt ?? null,
          questionsNow: d.questionsNow ?? null,
        });
        offer(d.report);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [configId]);

  const compute = () => {
    if (!configId) return;
    setBusy(true);
    setError(null);
    setLoaded(null);
    apiFetch(`/api/semantic-cache/collision-floor?configId=${encodeURIComponent(configId)}`, {
      method: "POST",
    })
      .then((r) => r.json())
      .then((d: FloorResponse) => {
        if (d.error) return setError({ configId, message: d.error });
        if (!d.report) return;
        setLoaded({
          configId,
          report: d.report,
          computedAt: d.computedAt ?? null,
          questionsNow: d.questionsNow ?? null,
        });
        offer(d.report);
      })
      .catch((e) => setError({ configId, message: String(e) }))
      .finally(() => setBusy(false));
  };

  // Only ever show state belonging to the config currently in the picker.
  const view = loaded?.configId === configId ? loaded : null;
  const report = view?.report ?? null;
  const errorMessage = error?.configId === configId ? error.message : null;

  // The bank moved under the saved report: its pair counts describe a set of
  // questions the config no longer has. The numbers stay on screen (they're
  // still the last real measurement) with a nudge to re-run. Unknown count →
  // no hint, never a false alarm.
  const stale =
    view !== null &&
    view.questionsNow !== null &&
    view.questionsNow !== view.report.questionsTotal;

  return (
    <Panel
      step={1}
      title="Collision floor"
      about={ABOUT}
      subtitle="Free — arithmetic over the eval bank. Start here."
      // The scope picker and its one verb ride the heading row: they say WHICH
      // config the numbers below describe, so they belong with the title rather
      // than in a control row that pushes the numbers down the screen.
      action={
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={configId}
            onChange={(e) => setConfigId(e.target.value)}
            aria-label="Config"
            className={SELECT}
          >
            {configs.length === 0 && <option value="">No configs</option>}
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} · {c.baseModel}
              </option>
            ))}
          </select>
          <button type="button" className={BTN} onClick={compute} disabled={busy || !configId}>
            {busy ? "Computing…" : report ? "Recompute" : "Compute"}
          </button>
        </div>
      }
      footer={action}
    >
      {errorMessage && <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>}

      {report && (
        <div className="flex flex-col gap-3">
          {/* The three numbers that ARE the answer, in the order they constrain
              each other: the floor is the hard lower bound, τ is what to serve
              at, the nearest same-answer pair is the ceiling worth staying under.
              The provenance counts follow as one meta line — they qualify the
              measurement rather than being the measurement. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Tile label="Collision floor" value={num(report.floor)} hint="hard lower bound" />
            <Tile
              label="Recommended τ"
              value={num(report.recommended)}
              hint="floor + margin"
              accent={report.recommended !== null}
            />
            <Tile
              label="Nearest same-answer"
              value={num(report.sameAnswerMin)}
              hint="above this, paraphrases are missed"
            />
          </div>

          <SafeBand
            floor={report.floor}
            recommended={report.recommended}
            sameAnswerMin={report.sameAnswerMin}
          />

          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <Meta label="Space" value={report.space} mono />
            <Meta
              label="Questions"
              value={`${report.questionsUsed}/${report.questionsTotal}`}
            />
            <Meta label="Distinct pairs" value={String(report.distinctPairs)} />
            <Meta label="Same-answer pairs" value={String(report.sameAnswerPairs)} />
            <Meta label="Same-answer median" value={num(report.sameAnswerMedian)} />
            {view?.computedAt && (
              <span className="flex items-center gap-2">
                {/* The stamp is now in the SERVER-rendered markup (the preload),
                    and toLocaleString() reads the formatting host's locale +
                    timezone — so a browser configured differently from the node
                    process would otherwise trip a hydration text mismatch on
                    this one node. */}
                <span suppressHydrationWarning>Computed {fmtWhen(view.computedAt)}</span>
                {stale && (
                  <Tooltip
                    align="right"
                    text={
                      `This config had ${view.report.questionsTotal} labeled question` +
                      `${view.report.questionsTotal === 1 ? "" : "s"} when the floor was ` +
                      `computed and has ${view.questionsNow} now. The pairs above were ` +
                      "measured against the old bank — recompute to calibrate against " +
                      "the questions the config actually has."
                    }
                  >
                    <span className="shrink-0 font-medium text-amber-600 dark:text-amber-400">
                      ↻ eval bank changed
                    </span>
                  </Tooltip>
                )}
              </span>
            )}
          </div>

          {report.overlap && (
            <p className={NOTE_AMBER}>
              No fully-safe band: a distinct-question pair is closer than a same-answer
              pair. The recommendation stays just above the floor (catches fewer
              paraphrases) to keep zero false hits on the eval bank.
            </p>
          )}
          {report.recommended === null && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Not enough labeled questions with cached embeddings to calibrate this
              space — score more eval questions on this config first.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

// The band on a line. The three tiles above give the numbers; this gives the one
// thing three numbers side by side don't — how much ROOM there is between the floor
// and the nearest same-answer pair, and where τ sits inside it. A wide band means
// the threshold is a comfortable choice; a hair-thin one means the eval bank barely
// separates same from different, and τ is a coin-flip.
//
// Positional, so it's HTML rather than SVG: percentage offsets on a track keep the
// labels as real text at real sizes (an SVG stretched to the container's width
// distorts any text in it), and there's no viewBox to keep in sync.
function SafeBand({
  floor,
  recommended,
  sameAnswerMin,
}: {
  floor: number | null;
  recommended: number | null;
  sameAnswerMin: number | null;
}) {
  // Needs both edges to have a band to draw at all.
  if (floor === null || sameAnswerMin === null) return null;

  // The domain covers every value present, padded so an end marker isn't half
  // off the track. A degenerate span (every value equal) would divide by zero.
  const values = [floor, sameAnswerMin, ...(recommended === null ? [] : [recommended])];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  if (span <= 0) return null;
  const pad = span * 0.18;
  const pct = (v: number) => ((v - (lo - pad)) / (span + 2 * pad)) * 100;

  // Overlapping (floor above the nearest same-answer pair) means there is no
  // band; the amber note above says so, and drawing a negative-width fill here
  // would claim otherwise.
  const hasBand = sameAnswerMin > floor;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-6">
        {/* axis: hairline, solid, recessive */}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-zinc-200 dark:bg-zinc-800" />

        {hasBand && (
          <div
            className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm bg-emerald-500/15 dark:bg-emerald-400/20"
            style={{ left: `${pct(floor)}%`, width: `${pct(sameAnswerMin) - pct(floor)}%` }}
          />
        )}

        {/* The two bounds: plain gray uprights, context for the one mark that
            matters. */}
        <Bound at={pct(floor)} />
        <Bound at={pct(sameAnswerMin)} />

        {recommended !== null && (
          // 2px surface ring so the dot stays legible where it lands on top of a
          // bound (a τ sitting right at the floor is the overlap case, and the
          // two marks then coincide exactly).
          <div
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-600 ring-2 ring-white dark:bg-emerald-400 dark:ring-zinc-950"
            style={{ left: `${pct(recommended)}%` }}
          />
        )}
      </div>

      {/* Two marks with two meanings, so identity is named in text and never
          carried by the color alone. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-emerald-500/25 dark:bg-emerald-400/30" />
          {hasBand ? "safe band" : "no safe band"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-600 dark:bg-emerald-400" />
          recommended τ
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-px bg-zinc-400" />
          floor / nearest same-answer
        </span>
      </div>
    </div>
  );
}

function Bound({ at }: { at: number }) {
  return (
    <div
      className="absolute top-1/2 h-3.5 w-px -translate-x-1/2 -translate-y-1/2 bg-zinc-400 dark:bg-zinc-500"
      style={{ left: `${at}%` }}
    />
  );
}

// A stat tile: label, value, and one line on what the number MEANS — these are
// three cosines that look alike and constrain each other differently.
function Tile({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2 ${
        accent
          ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      {/* Ink, not the accent hue: the tinted tile carries the emphasis, so the
          number stays at full contrast instead of wearing a mid-green that
          fights the surface in one theme or the other. */}
      <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
        {value}
      </span>
      <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{hint}</span>
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-zinc-400 dark:text-zinc-500">{label}</span>
      <span className={mono ? "font-mono text-[11px]" : "tabular-nums"}>{value}</span>
    </span>
  );
}
