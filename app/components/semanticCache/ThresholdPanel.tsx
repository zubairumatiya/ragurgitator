// Appraise → Semantic caching: THE THRESHOLD. One home for the cosine every space
// serves at — what it is now, the hard floor it has to clear, and the box that
// changes it.
//
// It is two panels merged. "Thresholds by vector-space" (the live table) and
// "Collision floor" (the eval-bank arithmetic) sat one above the other as peers,
// which is what let three τ recommendations arrive from three places while only two
// were applicable. THE FLOOR IS NOT A PEER OF THE LIVE VALUE — it is a CONSTRAINT on
// it, so it is drawn as one: the band shows where the live τ sits between the floor
// and the nearest same-answer pair, and a verdict line says whether it clears.
//
// Pure arithmetic server-side — no LLM calls, available the moment a config has
// labeled questions.
//
// ONE FLOOR, THREE POPULATIONS. The same max-cosine-among-known-different-pairs
// arithmetic runs over the eval bank's ground-truth chunk ids, the generated pair
// bank's LLM labels, and rejected real traffic (lib/rag/floorPopulations.ts). ONLY
// THE EVAL BANK'S FLOOR IS APPLICABLE; the other two are bounds to read a live τ
// against, and only the eval path ever emits a recommendation. The selector is
// pills rather than a second dropdown ON PURPOSE — the would-hit queue's origin
// filter looks the same and its trust rule runs the other way (there, traffic is
// what you calibrate on and the synthetic probes are the bound).
//
// Every population also carries the handful of pairs nearest its floor. A floor is
// a MAX, so it rests on exactly one pair and one mislabel moves it as far as a real
// collision would — with F3 putting generated hard negatives at ~80% correct, a
// suspicious number has to be one click from its cause.
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
// The saved report is a display cache; the recommendation is broadcast to
// ApplyThresholdPanel, which sits in this section's footer and owns every write on
// the page. It moved here FROM the collision floor's footer, which is where it read
// as the floor's own apply button rather than as the page's one threshold write.
"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Tooltip } from "@/app/components/Tooltip";
import { apiFetch } from "@/lib/http/client";
import type { CollisionFloorState } from "@/lib/rag/collisionFloorStore";
import type { ConfigSummary } from "@/lib/rag/configStore";
// TYPE-ONLY, and it has to stay that way: floorPopulations imports the DB client,
// so a value import here would drag it into the client bundle. The pill copy below
// is UI text and lives here rather than being imported for the same reason.
import type { BoundFloorReport, FloorPopulation } from "@/lib/rag/floorPopulations";
import type { FloorPair } from "@/lib/rag/semanticCacheCore";
import type {
  CollisionFloorReport,
  ThresholdReport,
} from "@/lib/rag/semanticCacheCalibration";

import { emitRecommendation, SC_CHANGED } from "./events";
import { BTN, NOTE_AMBER, Panel, SELECT, TABLE_HEAD, TABLE_WRAP } from "./Panel";

const ABOUT =
  "The cosine a new question must reach against a cached one before its answer " +
  "is reused. Each embedding space is calibrated separately; a config can hold " +
  "an override that wins over its space.\n\n" +
  "THE FLOOR IS THE CONSTRAINT. From a config's labeled eval questions: the " +
  "highest cosine between two questions with DIFFERENT ground-truth chunks is " +
  "the closest two genuinely-different questions ever land, so a threshold at " +
  "or below it is known to serve wrong answers. The recommendation adds a small " +
  "margin and stays below the nearest same-answer pair, so it catches " +
  "paraphrases with no false hit on the eval bank.\n\n" +
  "The same arithmetic runs over three populations. ONLY THE EVAL BANK'S FLOOR " +
  "MAY BE APPLIED — its labels are ground-truth chunk ids. The pair bank's are " +
  "written by an LLM and the traffic one is a judge's, so both are bounds to " +
  "read against, never numbers to apply.";

// The three populations, as the selector presents them. `applicable` is the whole
// point of the control: it is the ONE floor that may move a serving threshold, and
// the rule here runs OPPOSITE to the would-hit queue's origin filter — there,
// traffic is what you calibrate on and the synthetic probes are the bound. Two
// selectors whose trust rules invert is how the wrong number gets applied, so this
// one is drawn as labelled pills rather than as a second dropdown, and each pill
// says out loud which kind it is.
const POPULATIONS: {
  id: FloorPopulation;
  label: string;
  kind: string;
  applicable: boolean;
  blurb: string;
}[] = [
  {
    id: "eval",
    label: "Eval bank",
    kind: "applicable",
    applicable: true,
    blurb:
      "Ground-truth chunk ids — nothing was asked to judge anything. The only " +
      "floor here that may be applied.",
  },
  {
    id: "pairs",
    label: "Pair bank",
    kind: "bound",
    applicable: false,
    blurb:
      "LLM-written hard negatives, engineered to sit as close as the generator " +
      "could manage. Quarantined pairs are excluded. A worst-case bound — read " +
      "it, don't apply it, and read the pairs: this is COSINE ALONE, while the " +
      "serving path also runs the entity guard, which blocks reversals and " +
      "changed numbers outright.",
  },
  {
    id: "traffic",
    label: "Real traffic",
    kind: "bound",
    applicable: false,
    blurb:
      "The highest similarity a judge ever REJECTED on real questions. The most " +
      "honest labels on the page and usually the emptiest set; it fills in as " +
      "the cache is used.",
  },
];

const num = (n: number | null) => (n === null ? "—" : n.toFixed(4));
// Date AND time for the floor: it can be recomputed several times in one sitting,
// so the day alone wouldn't tell you which run you're looking at. The table's
// calibration stamps are days apart and get the date only.
const fmtWhen = (iso: string) => new Date(iso).toLocaleString();
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

// What both verbs return: the report plus the stamp and the live labeled-question
// count the staleness hint compares against.
type FloorResponse = {
  report?: CollisionFloorReport | null;
  computedAt?: string | null;
  questionsNow?: number | null;
  error?: string;
};

// What the two bound populations return. A null `bound` is a real answer — "not
// computed yet", which is how the pair bank always starts.
type BoundResponse = { bound?: BoundFloorReport | null; error?: string };

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
// note. `action` is the apply control, rendered in this section's FOOTER: reading
// order is live table → floor it must clear → apply.
export function ThresholdPanel({
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
  // WHICH LABELS THE FLOOR IS TAKEN OVER. Opens on the eval bank: it is the saved
  // one, the applicable one, and the one the page already had.
  const [population, setPopulation] = useState<FloorPopulation>("eval");
  // The two BOUND populations' reports, stamped with the config they describe for
  // the same reason `loaded` is. Nothing is saved for them, so this is the whole
  // of their state — leaving the page drops it, which is correct: they are cheap
  // to recompute and a stale bound presented as current is worse than none.
  const [bound, setBound] = useState<{ configId: string; report: BoundFloorReport } | null>(
    null,
  );
  // WHAT EVERY SPACE SERVES AT — the live τ this section owns. Its own fetch and
  // its own error, because the two halves fail independently: a floor that cannot
  // be computed says nothing about what the cache is serving at right now, and the
  // old page rendered them as two panels precisely so neither could hide the
  // other. Keep that, minus the second card.
  const [rows, setRows] = useState<ThresholdReport[] | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  // The server's read. In a ref rather than an effect dep so the effect below
  // still keys on configId alone, and cleared the first time the picker moves
  // elsewhere: coming BACK then re-fetches, because the floor may have been
  // recomputed since the page was rendered.
  const fromServer = useRef(preload);

  // Re-pulled whenever anything writes a threshold (SC_CHANGED) — including the
  // apply control in this section's own footer.
  const loadRows = useCallback(() => {
    apiFetch("/api/semantic-cache/thresholds")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setRowsError(d.error);
        else {
          setRowsError(null);
          setRows(d.thresholds);
        }
      })
      .catch((e) => setRowsError(String(e)));
  }, []);

  useEffect(() => {
    loadRows();
    window.addEventListener(SC_CHANGED, loadRows);
    return () => window.removeEventListener(SC_CHANGED, loadRows);
  }, [loadRows]);

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

  // The two bounds, on switching to one (or moving the config under it). TRAFFIC
  // LOADS ITSELF and the PAIR BANK DOES NOT: the traffic floor is one indexed read
  // of similarities the serving path already stored, while the pair-bank floor
  // pulls banked vectors — so the expensive one waits for a deliberate press and
  // the free one is simply there.
  useEffect(() => {
    // The pair bank never auto-loads, and nothing is cleared on the way in:
    // `boundView` already refuses to render a report belonging to another config
    // or population, so a stale one is invisible rather than deleted.
    if (!configId || population !== "traffic") return;

    let live = true;
    apiFetch(
      `/api/semantic-cache/collision-floor?configId=${encodeURIComponent(configId)}&population=traffic`,
    )
      .then((r) => r.json())
      .then((d: BoundResponse) => {
        if (!live) return;
        if (d.error) return setError({ configId, message: d.error });
        if (d.bound) setBound({ configId, report: d.bound });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [configId, population]);

  const compute = () => {
    if (!configId) return;
    setBusy(true);
    setError(null);
    const url =
      `/api/semantic-cache/collision-floor?configId=${encodeURIComponent(configId)}` +
      `&population=${population}`;

    // A BOUND NEVER OFFERS A RECOMMENDATION. That is the one behavioural
    // difference between the branches, and it is why they aren't folded together:
    // an emitRecommendation reachable from this path would prefill the apply box
    // with a number the population's own label says must not be applied.
    if (population !== "eval") {
      setBound(null);
      apiFetch(url, { method: "POST" })
        .then((r) => r.json())
        .then((d: BoundResponse) => {
          if (d.error) return setError({ configId, message: d.error });
          if (d.bound) setBound({ configId, report: d.bound });
        })
        .catch((e) => setError({ configId, message: String(e) }))
        .finally(() => setBusy(false));
      return;
    }

    setLoaded(null);
    apiFetch(url, { method: "POST" })
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

  // Only ever show state belonging to the config currently in the picker — and,
  // for a bound, to the population currently selected.
  const view = population === "eval" && loaded?.configId === configId ? loaded : null;
  const report = view?.report ?? null;
  const boundView =
    bound?.configId === configId && bound.report.population === population
      ? bound.report
      : null;
  const errorMessage = error?.configId === configId ? error.message : null;
  const pop = POPULATIONS.find((p) => p.id === population)!;

  // The bank moved under the saved report: its pair counts describe a set of
  // questions the config no longer has. The numbers stay on screen (they're
  // still the last real measurement) with a nudge to re-run. Unknown count →
  // no hint, never a false alarm.
  const stale =
    view !== null &&
    view.questionsNow !== null &&
    view.questionsNow !== view.report.questionsTotal;

  // THE NUMBER THE FLOOR IS A CONSTRAINT ON: what the floor's own space serves at
  // right now. Read off the live table rather than fetched again, so the verdict
  // below can never disagree with the row above it. Undefined until the table
  // lands, or if this space has no row yet — both mean "nothing to check against"
  // and the verdict simply doesn't render.
  // Whichever population is showing, the floor is quoted in the ACTIVE CONFIG'S
  // KEY-MODEL SPACE, so all three are checked against the same row.
  const floorSpace = report?.space ?? boundView?.space ?? null;
  const liveRow = floorSpace ? rows?.find((r) => r.space === floorSpace) : undefined;
  const live = liveRow?.threshold ?? null;
  // Clears the floor, or doesn't. A threshold at or below the floor is not a
  // matter of taste: the eval bank holds two genuinely-different questions that
  // close, so that setting is known to serve at least one wrong answer.
  const shownFloor = report?.floor ?? boundView?.floor ?? null;
  const clearsFloor =
    live !== null && shownFloor !== null ? live > shownFloor : null;

  return (
    <Panel
      title="Threshold"
      about={ABOUT}
      subtitle="What every space serves at, and the floor it has to clear."
      // The picker scopes the FLOOR only — the table below is account-wide — so
      // it is labelled rather than left to look like the section's scope. It
      // rides the heading row with its one verb because that is where a scope
      // control belongs; the label is what keeps it honest.
      action={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Floor for</span>
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
            {busy ? "Computing…" : report ?? boundView ? "Recompute" : "Compute"}
          </button>
        </div>
      }
      footer={action}
    >
      {rowsError && <p className="text-xs text-red-600 dark:text-red-400">{rowsError}</p>}

      {/* --- what is live -------------------------------------------------- */}
      {/* Borderless and bled to the card's edges: the card already draws the box,
          so a bordered table inside it was a second border a few pixels in from
          the first. */}
      <div className={TABLE_WRAP}>
        <table className="w-full text-sm">
          <thead className={TABLE_HEAD}>
            <tr>
              <th className="px-4 py-2 font-medium">Space</th>
              <th className="px-4 py-2 text-right font-medium">Serves at</th>
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2 text-right font-medium">Samples</th>
              <th className="px-4 py-2 font-medium">Calibrated</th>
              <th className="px-4 py-2 text-right font-medium">Cached</th>
              <th className="px-4 py-2 text-right font-medium">Hits</th>
              <th className="px-4 py-2 text-right font-medium">Shadow</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows === null && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-xs text-zinc-400">
                  Loading…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-xs text-zinc-400">
                  No spaces yet — populate a cache, then calibrate against the floor
                  below or the would-hit queue.
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <tr key={r.space}>
                <td className="px-4 py-2 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                  {r.space}
                </td>
                {/* The one number the row exists for — everything else on it is
                    provenance, so it carries the weight. */}
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                  {r.threshold.toFixed(3)}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={
                      r.source === "calibrated"
                        ? "rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    }
                    title={r.notes ?? undefined}
                  >
                    {r.source}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.sampleSize ?? "—"}
                </td>
                <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">
                  {fmtDate(r.calibratedAt)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.cacheEntries}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.totalHits}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.shadowJudged}/{r.shadowTotal}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {errorMessage && <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>}

      {/* --- the floor, as a constraint on the above ------------------------ */}
      {/* Always rendered, even with nothing computed: the population selector
          lives in here, and a control that appears only once you have a result is
          a control nobody finds. */}
      <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        {/* PILLS, NOT A DROPDOWN — see POPULATIONS. The floor's applicable option
            is the eval bank; the would-hit queue's is real traffic. Two dropdowns
            whose trust rules invert would look interchangeable, so this one wears
            a different control and each option carries its kind as a badge. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {POPULATIONS.map((p) => {
            const on = p.id === population;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => setPopulation(p.id)}
                className={
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs cursor-pointer transition-colors " +
                  (on
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                    : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800")
                }
              >
                {p.label}
                <span
                  className={
                    "rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide " +
                    (p.applicable
                      ? on
                        ? "bg-emerald-400/20 text-emerald-300 dark:bg-emerald-600/30 dark:text-emerald-800"
                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : on
                        ? "bg-white/15 text-zinc-200 dark:bg-black/10 dark:text-zinc-700"
                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400")
                  }
                >
                  {p.kind}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {pop.blurb}
        </p>

        {/* The headline number, whichever population produced it. */}
        {shownFloor !== null && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="flex items-baseline gap-2 text-xs">
              <span className="text-zinc-500 dark:text-zinc-400">
                {pop.applicable ? "Collision floor" : "Bound"}
              </span>
              <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                {num(shownFloor)}
              </span>
              <span className="font-mono text-[11px] text-zinc-400">{floorSpace}</span>
            </span>
            {/* THE CHECK, and it is the reason this block is here rather than
                being a second recommendation: the floor's job is to say whether
                the number in the table above is allowed, and a floor that never
                names the live value leaves that comparison to be done by eye.
                The wording softens for a bound: those labels are an LLM's or a
                judge's, so "known to serve wrong answers" would be overclaiming. */}
            {clearsFloor !== null && (
              <span
                className={
                  clearsFloor
                    ? "text-xs text-zinc-500 dark:text-zinc-400"
                    : "text-xs font-medium text-amber-700 dark:text-amber-400"
                }
              >
                <span className="font-mono">{floorSpace}</span> serves at{" "}
                <span className="tabular-nums">{live!.toFixed(3)}</span>
                {clearsFloor ? (
                  <> — clear of it.</>
                ) : pop.applicable ? (
                  <>
                    , at or BELOW the floor — two different questions in the eval bank
                    land this close, so this setting serves wrong answers.
                  </>
                ) : (
                  <>
                    , at or below this bound. These labels are not ground truth — read
                    the pairs below before treating it as a false hit.
                  </>
                )}
              </span>
            )}
          </div>
        )}

        {/* --- eval bank: the applicable floor, with its safe band ---------- */}
        {report && (
          <>
            {/* Where the live value sits between the floor and the nearest
                same-answer pair, which is the one thing three numbers in a row
                cannot show. The bounds get no band: they have no ground-truth
                same-answer side, so there is no upper edge to draw. */}
            <SafeBand
              floor={report.floor}
              recommended={report.recommended}
              sameAnswerMin={report.sameAnswerMin}
              live={live}
            />

            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
              {/* The recommendation is still here and still offered upward to the
                  apply box — it just isn't a tile the size of the live value any
                  more. It is one candidate for a number the table above already
                  has, and the would-hit queue offers another. */}
              <Meta label="Recommended τ" value={num(report.recommended)} />
              <Meta label="Nearest same-answer" value={num(report.sameAnswerMin)} />
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
          </>
        )}

        {/* --- the two bounds ----------------------------------------------- */}
        {boundView && (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <Meta label="Pairs compared" value={String(boundView.comparisons)} />
            {/* Only ever a pair-bank number, and it is a DIRECTION of error, not
                a footnote: a floor is a max, so every dropped pair could only have
                raised it. The bound may be understated by exactly this many pairs
                of missing evidence. */}
            {boundView.missingVectors > 0 && (
              <Tooltip
                text={
                  `${boundView.missingVectors} pair(s) had no banked vector in ` +
                  `${boundView.embeddingModel} and were skipped. Nothing is embedded to ` +
                  "compute a floor, so this bound is taken over what the key-model sweep " +
                  "has already banked — run the sweep in this space to close the gap."
                }
              >
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  {boundView.missingVectors} without vectors
                </span>
              </Tooltip>
            )}
            <span suppressHydrationWarning>Computed {fmtWhen(boundView.computedAt)}</span>
          </div>
        )}

        {/* --- empty states, one per reason -------------------------------- */}
        {population === "eval" && !report && !busy && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            No floor computed for this config yet — press Compute. Pure arithmetic over
            the query vectors the eval bank has already banked; nothing is embedded.
          </p>
        )}
        {population === "pairs" && !boundView && !busy && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Press Compute to take the bound over this account&apos;s pair bank. It reads only
            vectors already banked in this space and embeds nothing.
          </p>
        )}
        {boundView?.floor === null && (
          <p className={NOTE_AMBER}>
            {boundView.population === "pairs"
              ? boundView.missingVectors > 0
                ? `No pair in the bank has both texts banked in ${boundView.embeddingModel}. ` +
                  "Nothing is embedded here, so run the key-model sweep over this space " +
                  "first — it banks the vectors this bound reads."
                : "No known-different pairs in the bank yet. Generate pairs above, then " +
                  "take the bound."
              : "No rejected would-hit events on real traffic in this space yet. This " +
                "floor fills in the first time a judged match is rejected — until then " +
                "the eval bank and the pair bank are the only evidence there is."}
          </p>
        )}

        {/* WHAT SETS THE FLOOR. A max rests on ONE pair, which makes it the
            statistic most fragile to a single bad label — and the F3 audit put
            generated hard negatives at ~80% correct. So the pairs nearest the
            number are one click away on every population. */}
        <FloorPairs
          pairs={report ? report.topDistinct : (boundView?.top ?? [])}
          // A restored eval report has no pairs: they aren't persisted (see
          // collisionFloorStore), so the panel says which press brings them back
          // rather than pretending the floor has no cause.
          missing={report !== null && report.floor !== null && report.topDistinct.length === 0}
        />
      </div>

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
  live,
}: {
  floor: number | null;
  recommended: number | null;
  sameAnswerMin: number | null;
  // What the space serves at NOW. The band is a constraint picture, so the value
  // being constrained has to be on it — without this the reader is asked to hold
  // a number from the table above in their head and place it by eye.
  live: number | null;
}) {
  // Needs both edges to have a band to draw at all.
  if (floor === null || sameAnswerMin === null) return null;

  // The domain covers every value present, padded so an end marker isn't half
  // off the track. A degenerate span (every value equal) would divide by zero.
  const values = [
    floor,
    sameAnswerMin,
    ...(recommended === null ? [] : [recommended]),
    // The live value is usually OUTSIDE the floor→same-answer span (0.95 against
    // a floor of 0.83), so it has to widen the domain or it would be drawn off
    // the end of the track.
    ...(live === null ? [] : [live]),
  ];
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

        {/* WHAT IS ACTUALLY SERVING, as a solid upright rather than a third dot:
            it is a different kind of fact from the two cosines the eval bank
            derived — it is the setting, and the rest of the picture exists to
            judge it. */}
        {live !== null && (
          <div
            className="absolute top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-900 ring-2 ring-white dark:bg-zinc-100 dark:ring-zinc-950"
            style={{ left: `${pct(live)}%` }}
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
        {live !== null && (
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 rounded-full bg-zinc-900 dark:bg-zinc-100" />
            serving now
          </span>
        )}
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

// THE PAIRS THE FLOOR RESTS ON, collapsed by default.
//
// A floor is a MAX, so it is decided by exactly one pair, and one mislabelled pair
// moves it as much as a real collision would. The F3 audit measured the generated
// hard negatives at ~80% correct — so "which two questions produced this number?"
// has to be answerable in one click on every population, or a suspicious floor is
// something you can only argue with.
//
// Five is a deliberate count: enough to tell an outlier standing alone from the top
// of a dense band (if #1 is 0.97 and #5 is 0.83, the floor is one pair's opinion),
// and few enough not to become a second table.
function FloorPairs({ pairs, missing }: { pairs: FloorPair[]; missing: boolean }) {
  if (missing) {
    return (
      <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
        The pairs behind this floor aren&apos;t stored with it — press Recompute to see
        which two questions set it.
      </p>
    );
  }
  if (pairs.length === 0) return null;

  return (
    <details className="group">
      <summary className="cursor-pointer text-[11px] text-zinc-500 marker:content-[''] hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
        <span className="inline-block transition-transform group-open:rotate-90">▸</span>{" "}
        What sets this floor — the {pairs.length} closest known-different pair
        {pairs.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {pairs.map((p, i) => (
          // Index-keyed: the list is a rendered snapshot of one computation, never
          // reordered or edited in place, and two pairs can legitimately carry the
          // same texts under different labels.
          <li
            key={i}
            className="flex items-start gap-3 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800"
          >
            <span className="shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">
              {p.sim.toFixed(4)}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5 text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
              <span className="break-words">{p.a}</span>
              <span className="break-words text-zinc-500 dark:text-zinc-400">{p.b}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
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
