// Appraise → Semantic caching: the CACHE-KEY MODEL leaderboard.
//
// Answers one question — which embedding model should incoming questions be keyed
// under? — by measurement rather than argument. Every candidate is scored on the
// SAME pooled pair set, each gets its OWN τ at the same precision target, and
// they're ranked by the recall that τ achieves.
//
// The only section that isn't about a threshold's VALUE: it changes WHICH SPACE a
// config's threshold is read from.
//
// THE PAIR SET IT SCORES IS NOT ITS OWN. It used to be generated here, which made
// this panel the owner of an asset the probe also draws on; the bank is its own
// section now (PairBankPanel) and this one only reads it. What is left is two
// actions:
//   1. Run sweep — embedding-only, cached, so re-runs are nearly free.
//   2. Apply     — writes the per-config override. Refuses an uncalibrated target
//      space unless explicitly confirmed.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Tooltip } from "@/app/components/Tooltip";
import { apiFetch } from "@/lib/http/client";
// The SAME function the server picks τ with (lib/rag/calibrationCurve.ts —
// import-free precisely so it can be bundled here). Re-running it on the curve
// the sweep already sent is what makes the target a slider instead of a setting
// on another page: no re-sweep, no request, and the number on screen is
// arithmetically the number that would be applied.
import {
  selectFromCurve,
  TARGET_SLIDER,
  type Attainability,
} from "@/lib/rag/calibrationCurve";
import type { LeaderboardRow, SweepResult } from "@/lib/rag/keyModelSweep";
// The published sweep arrives with its curves PACKED as [sim, n, accepts] —
// phase 1.5 of docs/demo-cache-lab-plan.md. Precision and recall are exactly
// accepts/n and accepts/totalAccepts, so they are divided back here rather than
// stored, on the same operands and therefore bit-for-bit.
import { unpackSweep, type PublishedSweep } from "@/lib/rag/publishedSweepCore";
// TYPE-ONLY — the read side (lib/rag/cacheEconomics.ts) imports the DB client.
// The arithmetic lives in the core, which is import-free for exactly this reason.
import type { CacheEconomics } from "@/lib/rag/cacheEconomicsCore";

import { SC_CHANGED } from "./events";
import { PayoffReadout } from "./PayoffReadout";
import {
  BTN,
  BTN_PRIMARY,
  DEMO_NOTE,
  NOTE_AMBER,
  Panel,
  TABLE_HEAD,
  TABLE_WRAP,
  WarnDot,
} from "./Panel";

const ABOUT =
  "Which embedding model incoming questions are keyed under for the cache " +
  "match — independent of the model a config retrieves with. The cache-key " +
  "vector never touches a vector table, and question↔question matching is a " +
  "different task from question↔document retrieval.\n\n" +
  "Models are ranked by RECALL AT THE PRECISION TARGET: each gets its own τ " +
  "(the lowest threshold still meeting the accept target), then is scored on " +
  "how many servable pairs that τ actually catches. Holding precision equal is " +
  "what makes models comparable — raw cosine scales differ between spaces.";

const TARGET_ABOUT =
  "The precision every model's τ is held to, so their recall numbers are " +
  "comparable. It's a PER-CONFIG setting, stored by the button beside this " +
  "slider — but this page isn't scoped to a config tab, so the target shown " +
  "(and written) belongs to the config named here, which is the Default config " +
  "unless you arrived with one selected.\n\n" +
  "Dragging alone changes nothing: it re-reads the table at a precision you're " +
  "considering. Only the button stores it.\n\n" +
  "Raising it picks a stricter τ that serves less; lowering it serves more and " +
  "admits more wrong answers. Note a high target needs a big judged set to be " +
  "reachable at all: clearing 99% while carrying r false positives takes a " +
  "serve set of 100r, so on a small set 99% means “zero false positives”.";

const pct = (n: number | null) =>
  n === null ? "—" : `${(n * 100).toFixed(1)}%`;
const num = (n: number | null) => (n === null ? "—" : n.toFixed(4));

// A row read AT A GIVEN TARGET. The sweep ships each model's whole curve, so every
// number below is re-derived on the client and the server's own
// threshold/recall/precision fields go unused.
//
// `kind` is the distinction the table turns on:
//   at-target        met the target; these are the comparable numbers.
//   best-attainable  missed it — showing the best operating point it DOES reach,
//                    which is not comparable to an at-target row and must never be
//                    rendered as though it were.
//   none             nothing to show: model unavailable, errored, or no prefix ever
//                    reached minSamples. "No data" and "data, but short of target"
//                    are different answers and look different.
type RowKind = "at-target" | "best-attainable" | "none";

type DerivedRow = {
  row: LeaderboardRow;
  kind: RowKind;
  threshold: number | null;
  precision: number | null;
  recall: number | null;
  attainability: Attainability | null;
};

function deriveRow(
  row: LeaderboardRow,
  target: number,
  minSamples: number,
): DerivedRow {
  const cal = row.calibration;
  const none = (attainability: Attainability | null): DerivedRow => ({
    row,
    kind: "none",
    threshold: null,
    precision: null,
    recall: null,
    attainability,
  });
  if (!cal || cal.curve.length === 0) return none(cal?.attainability ?? null);

  const sel = selectFromCurve(cal.curve, target, minSamples);
  if (sel.recommended !== null) {
    return {
      row,
      kind: "at-target",
      threshold: sel.recommended,
      precision: sel.precisionAtRecommended,
      recall: sel.coverageAtRecommended,
      attainability: sel.attainability,
    };
  }

  // Missed the target — fall back to the best prefix it actually reaches, so
  // the row still says something. No eligible prefix at all (never hit
  // minSamples) genuinely has nothing to report.
  const at = sel.attainability;
  if (at.bestRateAt === null) return none(at);
  // A one-class pair set is unscored, NOT best-attainable. Its best prefix reads
  // 100% precision, which as a leaderboard row is a claim that this model never
  // makes a false hit — when the truth is that nothing in the sample could have
  // been one. Worse than saying nothing.
  if (at.blocker === "one-class-sample") return none(at);
  return {
    row,
    kind: "best-attainable",
    threshold: at.bestRateAt.sim,
    precision: at.bestRate,
    recall: at.coverageAtBest,
    attainability: at,
  };
}

// Ranking, in blocks. At-target rows first, best-attainable after, unscored last.
// The blocks are the point: one recall column across all of them would compare
// numbers measured at DIFFERENT precisions. A 90%-recall row that only manages 60%
// precision is not beating an 80%-recall row that held 99%.
//
// The two blocks then sort by DIFFERENT keys, for the same reason:
//   at-target        by recall — they all met the same precision, so recall is the
//                    objective and the only thing left to compare.
//   best-attainable  by PRECISION — nobody met the target, so the question is "who
//                    came closest", and their recalls sit at precisions that differ
//                    from row to row. Sorting these by recall reads as a ranking and
//                    isn't one.
const KIND_ORDER: Record<RowKind, number> = {
  "at-target": 0,
  "best-attainable": 1,
  none: 2,
};

function rankDerived(rows: DerivedRow[]): DerivedRow[] {
  return [...rows].sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    const key = a.kind === "best-attainable" ? "precision" : "recall";
    return (
      (b[key] ?? -1) - (a[key] ?? -1) || (b.row.auc ?? -1) - (a.row.auc ?? -1)
    );
  });
}

// Why no model produced a τ — the whole diagnosis, as tooltip prose.
//
// Built as a STRING rather than JSX because it now lives on a hover dot, and
// deliberately kept in three paragraphs: what happened, what to do about it, and
// the caveat on reading these numbers at all. "Too few pairs" and "the target is
// out of reach on this set" have opposite fixes — generate more vs lower the
// target — which is the entire reason this text exists instead of a bare dash.
function noThresholdReason(
  sweep: SweepResult,
  target: number,
  tooFewPairs: boolean,
  closestModel: string | undefined,
  at: Attainability | null | undefined,
): string {
  if (tooFewPairs) {
    return (
      `No model produced a τ: ${sweep.pairs.total} pairs never fills a serve set of ` +
      `${sweep.minSamples}, the minimum calibration needs, so ${pct(target)} was never ` +
      "actually tested.\n\nGenerate more pairs — until then only AUC is meaningful, and it's " +
      "the tiebreak, not the objective."
    );
  }

  const paras: string[] = [];
  let headline = `No model reached ${pct(target)} precision on any serve set of ${sweep.minSamples}+ pairs.`;

  if (closestModel && at && at.bestRateAt) {
    const fp =
      at.rejectsInBest > 0
        ? ` (${at.rejectsInBest} false ${at.rejectsInBest === 1 ? "positive" : "positives"})`
        : "";
    headline += ` Closest was ${closestModel} at ${pct(at.bestRate)} over ${at.bestRateAt.n} pairs${fp}.`;
    paras.push(headline);
    paras.push(
      at.requiredN !== null
        ? `Clearing ${pct(target)} while carrying ${at.rejectsInBest} needs a serve set ` +
            `of ${at.requiredN} — so at this size the target means “zero false ` +
            "positives”. Either grow the pair set past that, or drag the target lower — the " +
            "table re-reads instantly at whatever precision you pick."
        : `At a ${pct(target)} target no serve set size forgives a single false ` +
            "positive, so only a perfectly clean prefix can ever produce a τ. Drag the target " +
            "lower to see where these models actually land.",
    );
  } else {
    paras.push(headline);
  }

  paras.push(
    "The pair set is also harder than real traffic — every negative was written to sit right " +
      "next to its origin question — so read these as a floor rather than as what the cache " +
      "would actually do.",
  );

  return paras.join("\n\n");
}

type Status = {
  keyModel: string;
  override: string | null;
  globalDefault: string;
  threshold: { space: string; threshold: number; source: string };
  candidates: {
    id: string;
    space: string;
    dimension: number;
    provider: string;
  }[];
  // The traffic census and realized per-hit saving for the space `threshold`
  // names, for the payoff readout beside the slider. Optional: it rides this GET
  // rather than having a route of its own, and a response predating it (or from
  // a deployment ahead of its reads) simply leaves the readout off.
  economics?: CacheEconomics | null;
};

// THE DEMO'S SENTENCES, handed down from the page rather than imported here.
// lib/demo/policy is `import "server-only"` and this is a Client Component, so
// the boundary is the page's (app/appraise/semantic-cache/page.tsx) — the same
// crossing app/appraise/models/page.tsx makes for the replay's two notes.
//
// PRESENT ONLY FOR A GUEST. One sentence now rather than six: the pair set's four
// left with the bank, and the page-level "which half is live" line is rendered by
// the page, which is whose statement it always was.
export type DemoNotes = {
  sweep: string; // the leaderboard was measured on the operator's account
};

// NO `configs` PROP ANY MORE: the only per-config thing this panel held was the
// pair gap, and that left with the bank. The sweep pools every config's pairs and
// the precision target is resolved by the route, so there is nothing here to scope.
export function KeyModelPanel({ notes }: { notes?: DemoNotes }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<"config" | "all">("config");
  // Set when apply was REFUSED for an uncalibrated space (409). The switch is
  // re-offered explicitly with the fallback named, never retried silently.
  const [blocked, setBlocked] = useState<{
    space: string;
    fallbackThreshold: number;
  } | null>(null);
  const [busy, setBusy] = useState<
    null | "sweep" | "apply" | "backfill" | "target"
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The precision the table is being READ at. Null = the config's stored target,
  // which is what a fresh sweep always opens on. Dragging it is a LENS — it
  // re-derives what's displayed and writes nothing; the stored acceptTarget is
  // only moved by the explicit "Set as …'s target" button below it.
  const [targetOverride, setTargetOverride] = useState<number | null>(null);
  // The id THIS client named for the in-flight sweep, so it can be cancelled
  // while the request is still open — the sweep is a plain POST, so the id has
  // to travel outbound (see the route). Null whenever no sweep is running.
  const [sweepRunId, setSweepRunId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Whether the leaderboard on screen was BANKED rather than computed here
  // (phases 1 and 2). It drives one note, and it is tracked separately from
  // `notes` because the two answer different questions: `notes` says "this is the
  // demo", this says "these particular rows are a replay". A build published
  // without a sweep row leaves a guest with notes and no table, and must not
  // claim a published measurement it does not have.
  const [sweepPublished, setSweepPublished] = useState(false);
  // Whether a sweep this account COMPUTED is on screen. A ref because load()
  // reads it from a callback that deliberately does not depend on the sweep, and
  // because nothing renders off it — it only decides whether the published row
  // may seed the table underneath.
  const ownSweep = useRef(false);
  const load = useCallback(() => {
    // NOT scoped to the picker: the sweep pools every config's pairs into one
    // set, so a configId here would suggest a leaderboard that narrows with it.
    apiFetch("/api/semantic-cache/key-model")
      .then((r) => r.json())
      .then((d: Status & { publishedSweep?: PublishedSweep | null; error?: string }) => {
        if (d.error) return;
        setStatus(d);
        // THE PUBLISHED SWEEP — a guest's whole §4, arriving with the status
        // rather than from a button they may not press (phase 1 of
        // docs/demo-cache-lab-plan.md). The route sends it to guests only, so
        // this is null for an ordinary account and the panel opens empty as it
        // always has.
        //
        // Seeded only when nothing is there. load() re-runs on every SC_CHANGED,
        // and a result the visitor produced — or one a later phase reveals
        // progressively — must never be replaced by the banked one underneath it.
        //
        // The ref, not the `sweep` state, is what "nothing is there" is read
        // from: load() is a useCallback that must not re-create on every sweep,
        // so the state it closes over is stale by definition. The ref is written
        // in the same tick the result lands.
        if (d.publishedSweep && !ownSweep.current) {
          setSweep(unpackSweep(d.publishedSweep));
          // These particular rows are a replay. Set here and cleared only by a
          // sweep the visitor's own account actually computed.
          setSweepPublished(true);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(SC_CHANGED, load);
    return () => window.removeEventListener(SC_CHANGED, load);
  }, [load]);

  // POST helper: one place for the busy flag, the error/note reset, and the
  // 409 refusal, so every action can't drift on how it reports.
  const post = async (
    kind: NonNullable<typeof busy>,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown> | null> => {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json().catch(() => null)) as
        | (Record<string, unknown> & {
            error?: string;
            uncalibratedSpace?: { space: string; fallbackThreshold: number };
          })
        | null;
      if (!res.ok || d?.error) {
        if (res.status === 409 && d?.uncalibratedSpace)
          setBlocked(d.uncalibratedSpace);
        setError(d?.error ?? `Request failed (${res.status}).`);
        return null;
      }
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const runSweep = async () => {
    // On a cold cache this is ~an hour of sequential embedding, so it must be
    // stoppable. Cancelling keeps every vector already embedded — they're
    // banked as they go — and returns the models scored so far.
    const runId = crypto.randomUUID();
    setSweepRunId(runId);
    setCancelling(false);
    const d = await post("sweep", "/api/semantic-cache/key-model", {
      action: "sweep",
      runId,
    }).finally(() => {
      setSweepRunId(null);
      setCancelling(false);
    });
    if (!d) return;
    // A GUEST'S CLICK REPLAYS RATHER THAN RUNS (phase 2). The route answers
    // `{ published: true, sweep }` with the curves PACKED, so this is not a
    // SweepResult and must be unpacked before anything reads a curve — and the
    // table it fills has to say where the numbers came from, which is what
    // `sweepPublished` carries to the note below.
    if ("published" in d) {
      setSweep(unpackSweep(d.sweep as PublishedSweep));
      setSweepPublished(true);
    } else {
      setSweep(d as unknown as SweepResult);
      setSweepPublished(false);
      // This account computed what is on screen, so load() must stop seeding the
      // banked rows over the top of it on the next SC_CHANGED.
      ownSweep.current = true;
    }
    // A fresh sweep always opens at the config's stored target — an exploratory
    // position carried over from the last one would silently reinterpret new
    // numbers.
    setTargetOverride(null);
  };

  // Cooperative: this flips a flag the sweep's loops read between embeddings, so
  // the run stops at its next checkpoint and RETURNS — the partial leaderboard
  // arrives through the still-open request. Deliberately not an abort of the
  // fetch, which would throw that result away.
  const cancelSweep = async () => {
    if (!sweepRunId) return;
    setCancelling(true);
    try {
      await apiFetch("/api/eval/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: sweepRunId }),
      });
    } catch {
      // The run is server-side either way; the button re-enables when it lands.
      setCancelling(false);
    }
  };

  const apply = async () => {
    if (!selected) return;
    const d = await post("apply", "/api/semantic-cache/key-model", {
      action: "apply",
      keyModel: selected,
      scope,
      force: blocked !== null,
    });
    if (!d) return;
    setBlocked(null);
    setNote(`Applied ${selected} to ${d.updated} config(s).`);
    setStatus(d.keyModel as Status);
    window.dispatchEvent(new Event(SC_CHANGED));
  };

  // Write the dragged position back as the config's STORED calibration target, which
  // is what the shadow-judge sweep and this leaderboard read on their next run.
  //
  // It lives here, next to the slider, because this is where the number is chosen:
  // you drag until the table shows a τ you'd accept. It is NOT the apply box below —
  // that writes which model a config keys under, and the two must not read as
  // variations of one action, hence the wording.
  //
  // Not scoped by tab: Appraise sits outside /c/[configId], so apiFetch sends no
  // configId and the write lands on the same config the sweep resolved its target
  // from — the one named in the button.
  const saveTarget = async () => {
    if (!sweep || targetOverride === null) return;
    setBusy("target");
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch("/api/batch", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ semanticCache: { acceptTarget: targetOverride } }),
      });
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(d?.error ?? `Request failed (${res.status}).`);
        return;
      }
      // The sweep result carries the target it was read at, so patch it locally
      // rather than re-sweeping: the curves are unchanged, only whose number
      // this now is has changed.
      setSweep({
        ...sweep,
        target: targetOverride,
        targetSource: { ...sweep.targetSource, target: targetOverride, source: "config" },
      });
      setTargetOverride(null);
      setNote(
        `${sweep.targetSource.configLabel} now calibrates at ${pct(targetOverride)}. ` +
          "This governs which τ gets recommended, not what the cache serves at.",
      );
      window.dispatchEvent(new Event(SC_CHANGED));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(null);
    }
  };

  const backfill = async () => {
    const d = await post("backfill", "/api/semantic-cache/key-model", {
      action: "backfill",
    });
    if (!d) return;
    setNote(
      Number(d.candidates) === 0
        ? `Nothing to re-key — every cached question already has a ${d.keyModel} vector.`
        : `Re-keyed ${d.inserted} of ${d.candidates} cached questions` +
            (Number(d.failed) > 0 ? `; ${d.failed} failed to embed.` : "."),
    );
  };

  // The precision the table is being read at, and whether that's the config's
  // own setting or somewhere you've dragged to.
  const target = targetOverride ?? sweep?.target ?? 0;
  const exploring =
    sweep !== null &&
    targetOverride !== null &&
    targetOverride !== sweep.target;

  // Every row, re-read at that target. Recomputed only when the target moves —
  // selectFromCurve walks each model's whole curve, and this runs on every
  // slider tick.
  const derived = useMemo(
    () =>
      sweep
        ? rankDerived(
            sweep.rows.map((r) => deriveRow(r, target, sweep.minSamples)),
          )
        : [],
    [sweep, target],
  );

  // NO MODEL PRODUCED A τ, which silently demotes the whole table to an AUC
  // ranking (see the sort in keyModelSweep) — so it has to say WHY. The reason
  // comes from the attainability report rather than being guessed from the pair
  // count: "too few pairs" and "the target is out of reach on this set" are the
  // difference between get-more-data and lower-the-target, and only the sweep
  // knows which prefix it actually got to consider.
  // The row for the model this config ACTUALLY keys on, re-read at the dragged
  // target — the anchor for the payoff readout. Undefined when the sweep did not
  // score it (a cancelled run, or a model dropped from the candidate list), in
  // which case the readout simply doesn't render.
  const live = derived.find((d) => d.row.model === status?.keyModel);

  const scored = derived.filter((d) => d.attainability !== null);
  const noThresholds =
    derived.length > 0 && !derived.some((d) => d.kind === "at-target");
  // No eligible prefix ANYWHERE means the set never reached minSamples — the
  // target was never even tested, so pointing at it would be misleading. A
  // one-class set is excluded because its problem is the opposite one: it has
  // pairs to spare, they just carry a single label, and "add more pairs" is the
  // wrong instruction when what's missing is a second class.
  const tooFewPairs =
    scored.length > 0 &&
    scored.every(
      (d) =>
        d.attainability!.blocker !== "target-unreachable" &&
        d.attainability!.blocker !== "one-class-sample",
    );
  // The closest any model got, and what the target would have cost it. Ranked by
  // achieved precision: this is the "you asked for 99%, the best model managed
  // 68% over 22 pairs, and 99% with those 7 rejects needs n ≥ 700" line.
  const closest = scored
    .filter((d) => d.attainability!.bestRate !== null)
    .sort((a, b) => b.attainability!.bestRate! - a.attainability!.bestRate!)[0];

  return (
    <Panel
      title="Cache key model"
      about={ABOUT}
      subtitle="Which space a config reads its threshold FROM — not what it serves at."
      action={
        status && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Keys under <span className="font-mono">{status.keyModel}</span>
            {status.override === null ? " (global default)" : " (override)"} ·
            space <span className="font-mono">{status.threshold.space}</span>{" "}
            serves at{" "}
            <span className="tabular-nums">
              {status.threshold.threshold.toFixed(3)}
            </span>{" "}
            ({status.threshold.source})
          </p>
        )
      }
      footer={
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-400">Apply</span>
            <span className="font-mono text-zinc-600 dark:text-zinc-300">
              {selected ?? "select a row"}
            </span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as "config" | "all")}
              aria-label="Apply scope"
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <option value="config">to this config</option>
              <option value="all">to every config</option>
            </select>
            <button
              type="button"
              onClick={apply}
              disabled={busy !== null || !selected}
              className={BTN_PRIMARY}
            >
              {busy === "apply"
                ? "Applying…"
                : blocked
                  ? "Apply anyway"
                  : "Apply"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
            <Tooltip
              align="right"
              text={
                "Writes the per-config override. The true global default is " +
                "config.semanticCache.keyModel in code — “every config” is how you " +
                "move it without a deploy."
              }
            >
              <span className="underline decoration-dotted underline-offset-2">
                writes an override
              </span>
            </Tooltip>
            <button
              type="button"
              className="underline underline-offset-2 cursor-pointer hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-zinc-200"
              onClick={backfill}
              disabled={busy !== null}
              title="Re-embed this config's already-cached questions under the current key model, so they stay matchable after a switch."
            >
              {busy === "backfill" ? "Re-keying…" : "Re-key cached questions"}
            </button>
          </div>
        </>
      }
    >
      {/* --- the sweep ------------------------------------------------------ */}
      {/* What it scores lives in the Pair bank section, not here: this panel
          READS that set. The counts under a completed sweep say which set it
          actually got (`sweep.pairs`), which is the honest place for them —
          those are the pairs the leaderboard was measured on, not whatever the
          bank holds now. */}
      <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN}
            onClick={runSweep}
            disabled={busy !== null}
          >
            {/* NOTHING IS SCORED IN THE DEMO, so nothing may say it is. The
                click fetches a row the operator's account measured; a spinner
                reading "Scoring…" would be the panel claiming the spend the
                whole phase exists to avoid. */}
            {busy === "sweep"
              ? notes
                ? "Fetching…"
                : "Scoring…"
              : notes
                ? "Show the published sweep"
                : sweep
                  ? "Re-run sweep"
                  : "Run sweep"}
          </button>
          {busy === "sweep" && sweepRunId && (
            <button
              type="button"
              className={BTN}
              onClick={cancelSweep}
              disabled={cancelling}
              title="Stops at the next embedding and returns what's been scored so far. Vectors already bought stay cached, so resuming is cheap."
            >
              {cancelling ? "Stopping…" : "Cancel"}
            </button>
          )}
          <span className="text-xs text-zinc-400">
            {notes
              ? // Neither half of the sentence beside it is true here: nothing is
                // sequential, nothing is embedded, and there is no hour to wait.
                "Replays the published measurement — nothing is embedded."
              : busy === "sweep"
                ? // The first run on a cold cache is the expensive one in
                  // WALL-CLOCK, not money, and saying so is what stops it being
                  // killed half-way for a third time.
                  "Sequential over models — the first run on a cold cache takes ~an hour. Cancelling keeps everything embedded so far."
                : "Embedding-only — no LLM calls, and cached, so re-runs are nearly free."}
          </span>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {note && (
        <p className="text-xs text-green-700 dark:text-green-400">{note}</p>
      )}

      {blocked && (
        <div className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p>
            <span className="font-mono">{blocked.space}</span> has no calibrated
            threshold — configs moved there would serve at{" "}
            <span className="tabular-nums">
              {blocked.fallbackThreshold.toFixed(3)}
            </span>{" "}
            (the default). Calibrate it in the Threshold section, or apply again
            to confirm.
          </p>
        </div>
      )}

      {sweep && (
        <div className="flex flex-col gap-2">
          {/* A cancelled sweep's rows are real — each model is scored
              independently on the same pair set — but the RANKING is over
              whoever got scored, so it must not read as the whole field. */}
          {sweep.cancelled && (
            <p className={NOTE_AMBER}>
              Sweep cancelled — {sweep.rows.filter((r) => r.calibration !== null).length}{" "}
              of {sweep.rows.length} models scored. The rows below are
              comparable with each other, but this is not the full leaderboard.
              Re-running resumes cheaply: every vector already embedded is
              cached.
            </p>
          )}

          {/* WHERE THESE ROWS CAME FROM, above the numbers rather than below
              them. Gated on `sweepPublished`, not on `notes`: a build published
              without a sweep row leaves a guest with the sentences and no table,
              and this must never claim a measurement that was not banked. */}
          {sweepPublished && notes && (
            <p className={DEMO_NOTE}>{notes.sweep}</p>
          )}

          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {sweep.pairs.total} pairs ({sweep.pairs.shadow} shadow /{" "}
            {sweep.pairs.generated} generated · {sweep.pairs.same} same /{" "}
            {sweep.pairs.different} different)
          </p>

          {/* The target as a DIAL, not a fact. Every model's full curve came
              down with the sweep, so dragging this re-picks τ for all of them
              with the same function the server uses — no re-sweep, no request,
              no embedding spend. Comparability is untouched: wherever the slider
              sits, every model is still being held to the SAME precision. */}
          {/* A COLUMN since phase 4: the dial on the first row, and under it what
              that dial costs. They are one control — the readout is the only
              thing on the page that says what a precision target BUYS — so they
              share a box rather than sitting as two. */}
          <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Tooltip align="left" text={TARGET_ABOUT}>
                <span className="text-xs text-zinc-500 underline decoration-dotted underline-offset-2 dark:text-zinc-400">
                  Precision held at
                </span>
              </Tooltip>
              <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                {pct(target)}
              </span>
              {/* Bounds from the shared constant, not literals: the published
                  sweep's curves are thinned to exactly the positions this input
                  can produce (lib/rag/publishedSweep), so a widened range or a
                  finer step here would silently start reading positions those
                  curves were never thinned for. */}
              <input
                type="range"
                min={TARGET_SLIDER.min}
                max={TARGET_SLIDER.max}
                step={TARGET_SLIDER.step}
                value={target * 100}
                onChange={(e) => setTargetOverride(Number(e.target.value) / 100)}
                aria-label="Precision target"
                className="h-1 w-48 min-w-32 max-w-full cursor-pointer accent-zinc-900 dark:accent-zinc-100"
              />
              {/* An explored number must never be mistaken for the config's
                  setting — this is a lens, and nothing here writes. */}
              {exploring ? (
                <span className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                  exploring —{" "}
                  <span className="font-mono">
                    {sweep.targetSource.configLabel}
                  </span>{" "}
                  is set to{" "}
                  <span className="tabular-nums">{pct(sweep.target)}</span>
                  <button
                    type="button"
                    onClick={() => setTargetOverride(null)}
                    className="underline underline-offset-2 cursor-pointer hover:text-zinc-800 dark:hover:text-zinc-200"
                  >
                    reset
                  </button>
                  {/* Named at length on purpose. The apply box at the foot of this
                      panel writes a KEY MODEL, and a bare "Apply" a few hundred
                      pixels away would read as a variation of it — so this one
                      says whose setting it moves and what that setting governs. */}
                  <button
                    type="button"
                    onClick={saveTarget}
                    disabled={busy !== null}
                    title={
                      "Stores this precision as the calibration target for " +
                      `${sweep.targetSource.configLabel}. It governs which τ the sweeps ` +
                      "RECOMMEND — not the cosine the cache serves at, which is the " +
                      "threshold applied in the Threshold section."
                    }
                    className="underline underline-offset-2 cursor-pointer hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-zinc-200"
                  >
                    {busy === "target"
                      ? "Setting…"
                      : `set as ${sweep.targetSource.configLabel}'s calibration target`}
                  </button>
                </span>
              ) : (
                <span className="text-[11px] text-zinc-400">
                  from{" "}
                  <span className="font-mono">
                    {sweep.targetSource.configLabel}
                  </span>
                  {sweep.targetSource.source === "config"
                    ? " (override)"
                    : " (global default)"}{" "}
                  · drag to re-read the table
                </span>
              )}
            </div>

            {/* THE BUSINESS AXIS (phase 4 of docs/semantic-cache-page-plan.md).
                Read through the config's LIVE key model, not the table's top
                row: the census is real traffic, and this account's traffic only
                exists in the space it is actually served from — a hit rate
                quoted for some other model's space would be a projection onto
                questions that space has never seen. */}
            {status?.economics && live && (
              <PayoffReadout
                econ={status.economics}
                tau={live.threshold}
                keyModel={status.keyModel}
                atTarget={live.kind === "at-target"}
              />
            )}
          </div>

          {/* No model clears the target. The table still fills in — with each
              model's best ATTAINABLE operating point — so this explains what
              those starred numbers are rather than what a blank means. As a
              glyph, because it's a paragraph you read once and then scroll past
              on every visit. */}
          {noThresholds && (
            <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <WarnDot
                text={noThresholdReason(
                  sweep,
                  target,
                  tooFewPairs,
                  closest?.row.model,
                  closest?.attainability,
                )}
              />
              No model reaches {pct(target)} — showing best attainable, marked ✳
            </p>
          )}

          <div className={TABLE_WRAP}>
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className={TABLE_HEAD}>
                <tr>
                  <th className="py-2 pl-4 pr-3 font-medium">Model</th>
                  <th className="py-2 pr-3 font-medium">Space</th>
                  <th className="py-2 pr-3 text-right font-medium">
                    <Tooltip
                      align="left"
                      text="This model's cache threshold: the lowest similarity that still meets the precision target. Solved for, not chosen — and specific to this space, so never copy it to another model."
                    >
                      <span className="underline decoration-dotted underline-offset-2">
                        τ
                      </span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">
                    <Tooltip
                      align="left"
                      text="Of every pair that SHOULD hit the cache, the share this τ actually serves. What you miss costs savings, not correctness."
                    >
                      <span className="underline decoration-dotted underline-offset-2">
                        Recall@τ
                      </span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">
                    <Tooltip
                      align="left"
                      text="Of the pairs this τ serves, the share served correctly. Only serving a DIFFERENT pair lowers it — same pairs left unserved cost nothing here (that's recall)."
                    >
                      <span className="underline decoration-dotted underline-offset-2">
                        Precision
                      </span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">
                    <Tooltip
                      align="left"
                      text="P(a random same pair outranks a random different pair). Scale-free, so it's the tiebreak — but it grades the whole ranking, and a cache only serves from the top."
                    >
                      <span className="underline decoration-dotted underline-offset-2">
                        AUC
                      </span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">Pairs</th>
                  <th className="py-2 pr-4 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {derived.map((d) => (
                  <Row
                    key={d.row.model}
                    derived={d}
                    current={status?.keyModel === d.row.model}
                    selected={selected === d.row.model}
                    onSelect={() => {
                      setSelected(d.row.model);
                      setBlocked(null);
                      setNote(null);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {derived.some((d) => d.kind === "best-attainable") && (
            <p className="text-[11px] text-zinc-400">
              ✳ best attainable — this model never reaches {pct(target)} on a
              serve set of {sweep.minSamples}+, so its best operating point is
              shown instead. Not comparable with an at-target row, and sorted
              below them.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

function Row({
  derived,
  current,
  selected,
  onSelect,
}: {
  derived: DerivedRow;
  current: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { row, kind } = derived;
  // An unavailable or errored model keeps its row — a missing row reads as "it
  // scored badly", which is a different and wrong claim.
  const dim = !row.available || row.error !== null;
  // Best-attainable numbers are real measurements, but they were NOT taken at
  // the target, so they can't wear the same weight as a row that met it. Muted
  // and starred: legible, never mistakable for a comparable figure.
  const fallback = kind === "best-attainable";
  const mark = fallback ? "✳" : "";
  return (
    <tr
      onClick={row.available && !row.error ? onSelect : undefined}
      className={
        (selected ? "bg-zinc-100 dark:bg-zinc-800 " : "") +
        (dim
          ? "opacity-50 "
          : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900 ")
      }
    >
      <td className="py-1.5 pl-4 pr-3 font-mono text-xs">
        {row.model}
        {current && (
          <span className="ml-1.5 rounded bg-zinc-200 px-1 text-[10px] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
            current
          </span>
        )}
      </td>
      <td className="py-1.5 pr-3 font-mono text-xs text-zinc-500">
        {row.space}
      </td>
      <td
        className={`py-1.5 pr-3 text-right tabular-nums ${fallback ? "text-zinc-400" : ""}`}
      >
        {num(derived.threshold)}
        {mark}
      </td>
      <td
        className={
          "py-1.5 pr-3 text-right tabular-nums " +
          (fallback
            ? "text-zinc-400"
            : derived.recall !== null
              ? "font-medium text-black dark:text-zinc-50"
              : "")
        }
      >
        {pct(derived.recall)}
        {mark}
      </td>
      <td
        className={`py-1.5 pr-3 text-right tabular-nums ${fallback ? "text-zinc-400" : "text-zinc-500"}`}
      >
        {pct(derived.precision)}
        {mark}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-zinc-500">
        {row.auc === null ? "—" : row.auc.toFixed(3)}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-zinc-500">
        {row.pairsScored}
      </td>
      <td className="py-1.5 pr-4 text-xs text-zinc-400">
        {row.error ?? row.reason ?? ""}
      </td>
    </tr>
  );
}
