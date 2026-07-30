// ---------------------------------------------------------------------------
// Appraise → Semantic caching: the CACHE-KEY MODEL leaderboard (Phase 3 of
// docs/semantic-cache-key-model-plan.md).
//
// Answers one question — which embedding model should incoming questions be
// keyed under? — by measurement rather than argument. Every candidate is scored
// on the SAME pooled pair set, each gets its OWN τ at the same precision target,
// and they're ranked by the recall that τ achieves.
//
// Last panel on the page, and the only one that isn't about a threshold: it
// changes WHICH SPACE a config's threshold is read from, so it belongs after
// you've seen the spaces and what they serve at.
//
// Three actions, in the order you'd use them:
//   1. Generate pairs — the one-off LLM cost the sweep is built on. Without
//      hard negatives every model scores ~the same and the table says nothing.
//   2. Run sweep      — embedding-only, cached, so re-runs are nearly free.
//   3. Apply          — writes the per-config override (or all configs). Refuses
//      an uncalibrated target space unless explicitly confirmed.
// ---------------------------------------------------------------------------
"use client";

import { useCallback, useEffect, useState } from "react";

import { Tooltip } from "@/app/components/Tooltip";
import { config } from "@/lib/config";
import { apiFetch } from "@/lib/http/client";
import type { LeaderboardRow, SweepResult } from "@/lib/rag/keyModelSweep";
import type { PairStats } from "@/lib/rag/semanticCachePairs";

import { SC_CHANGED } from "./events";
import { BTN, BTN_PRIMARY, NOTE_AMBER, Panel, TABLE_HEAD, TABLE_WRAP, WarnDot } from "./Panel";

const ABOUT =
  "Which embedding model incoming questions are keyed under for the cache " +
  "match — independent of the model a config retrieves with. The cache-key " +
  "vector never touches a vector table, and question↔question matching is a " +
  "different task from question↔document retrieval.\n\n" +
  "Models are ranked by RECALL AT THE PRECISION TARGET: each gets its own τ " +
  "(the lowest threshold still meeting the accept target), then is scored on " +
  "how many servable pairs that τ actually catches. Holding precision equal is " +
  "what makes models comparable — raw cosine scales differ between spaces.";

const PAIRS_ABOUT =
  "The eval set the sweep scores. Two sources, pooled:\n\n" +
  "Shadow — judged verdicts from real would-hit traffic. Free (already paid " +
  "for), but CENSORED: a pair only got logged if it cleared the shadow floor " +
  "under the model in use at the time, so a candidate's false positives are " +
  "under-counted.\n\n" +
  "Generated — paraphrases and HARD NEGATIVES written from your eval " +
  "questions. Hard negatives are the point: random distinct questions are " +
  "separated near-perfectly by every model and grade nothing.";

const TARGET_ABOUT =
  "The precision every model's τ is held to, so their recall numbers are " +
  "comparable. It's a PER-CONFIG setting (Settings → Savings), but this page " +
  "isn't scoped to a config tab — so the target shown is the one belonging to " +
  "the config named here, which is the Default config unless you arrived with " +
  "one selected.\n\n" +
  "Raising it picks a stricter τ that serves less; lowering it serves more and " +
  "admits more wrong answers. Note a high target needs a big judged set to be " +
  "reachable at all: clearing 99% while carrying r false positives takes a " +
  "serve set of 100r, so on a small set 99% means “zero false positives”.";

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
const num = (n: number | null) => (n === null ? "—" : n.toFixed(4));

// What one origin question costs and yields, so the generate control can price
// itself before it's clicked. Read from config rather than hard-coded, or the
// estimate silently lies the day the counts are tuned.
const PER_Q = config.semanticCache.keyModelSweep.pairsPerQuestion;
const PAIRS_PER_QUESTION = PER_Q.paraphrase + PER_Q.hardNegative;
// The inline path's own ceiling (GEN_MAX_LIMIT in semanticCachePairs): a bigger
// ask is silently clamped there, so the slider must not offer one.
const GEN_MAX = 200;
// Its default, and a sane starting position — a run you can watch finish.
const GEN_DEFAULT = 25;

// The sweep's own account of why the target was out of reach, dug out of the
// closest model's calibration.
type Attainability = NonNullable<LeaderboardRow["calibration"]>["attainability"];

// Why no model produced a τ — the whole diagnosis, as tooltip prose.
//
// Built as a STRING rather than JSX because it now lives on a hover dot, and
// deliberately kept in three paragraphs: what happened, what to do about it, and
// the caveat on reading these numbers at all. "Too few pairs" and "the target is
// out of reach on this set" have opposite fixes — generate more vs lower the
// target — which is the entire reason this text exists instead of a bare dash.
function noThresholdReason(
  sweep: SweepResult,
  tooFewPairs: boolean,
  closest: LeaderboardRow | undefined,
  at: Attainability | undefined,
): string {
  if (tooFewPairs) {
    return (
      `No model produced a τ: ${sweep.pairs.total} pairs never fills a serve set of ` +
      `${sweep.minSamples}, the minimum calibration needs, so ${pct(sweep.target)} was never ` +
      "actually tested.\n\nGenerate more pairs — until then only AUC is meaningful, and it's " +
      "the tiebreak, not the objective."
    );
  }

  const paras: string[] = [];
  let headline =
    `No model reached ${pct(sweep.target)} precision on any serve set of ` +
    `${sweep.minSamples}+ pairs.`;

  if (closest && at) {
    const fp =
      at.rejectsInBest > 0
        ? ` (${at.rejectsInBest} false ${at.rejectsInBest === 1 ? "positive" : "positives"})`
        : "";
    headline +=
      ` Closest was ${closest.model} at ${pct(at.bestRate)} over ${at.bestRateAt!.n} pairs${fp}.`;
    paras.push(headline);
    paras.push(
      at.requiredN !== null
        ? `Clearing ${pct(sweep.target)} while carrying ${at.rejectsInBest} needs a serve set ` +
          `of ${at.requiredN} — so at this size the target means “zero false ` +
          "positives”. Either grow the pair set past that, or lower the target for " +
          `${sweep.targetSource.configLabel} in Settings → Savings.`
        : `At a ${pct(sweep.target)} target no serve set size forgives a single false ` +
          "positive, so only a perfectly clean prefix can ever produce a τ. Lower the target " +
          `for ${sweep.targetSource.configLabel} in Settings → Savings.`,
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
  candidates: { id: string; space: string; dimension: number; provider: string }[];
};

export function KeyModelPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [pairs, setPairs] = useState<PairStats | null>(null);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<"config" | "all">("config");
  // Set when apply was REFUSED for an uncalibrated space (409). The switch is
  // re-offered explicitly with the fallback named, never retried silently.
  const [blocked, setBlocked] = useState<{ space: string; fallbackThreshold: number } | null>(null);
  const [busy, setBusy] = useState<null | "sweep" | "pairs" | "apply" | "backfill">(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // How many origin questions the next generate run covers. Null = untouched, so
  // the default tracks the gap as it shrinks instead of being pinned by an
  // effect the moment the stats first land.
  const [genLimit, setGenLimit] = useState<number | null>(null);

  // The generate control's range and current position. Capped at the gap (asking
  // for more questions than exist just generates the gap) and at the inline
  // path's own ceiling, so the slider can never promise a run the server will
  // silently trim.
  const genMax = Math.min(pairs?.questionsRemaining ?? 0, GEN_MAX);
  const genQuestions = Math.max(1, Math.min(genLimit ?? GEN_DEFAULT, genMax || 1));

  const load = useCallback(() => {
    apiFetch("/api/semantic-cache/key-model")
      .then((r) => r.json())
      .then((d: Status & { error?: string }) => {
        if (!d.error) setStatus(d);
      })
      .catch(() => {});
    apiFetch("/api/semantic-cache/pairs")
      .then((r) => r.json())
      .then((d: PairStats & { error?: string }) => {
        if (!d.error) setPairs(d);
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
        if (res.status === 409 && d?.uncalibratedSpace) setBlocked(d.uncalibratedSpace);
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
    const d = await post("sweep", "/api/semantic-cache/key-model", { action: "sweep" });
    if (d) setSweep(d as unknown as SweepResult);
  };

  const generate = async () => {
    // Explicit every time. The route's own default is 25 questions, so the
    // unlimited-looking button used to quietly do a fraction of the gap and
    // report a number that looked like a failure.
    const d = await post("pairs", "/api/semantic-cache/pairs", { limit: genQuestions });
    if (!d) return;
    if (d.mode === "batch") {
      setNote(
        d.job
          ? "Submitted a batch — pairs land when it completes (Batch API panel tracks it)."
          : String(d.reason ?? "Nothing to generate."),
      );
    } else {
      setNote(
        `Generated ${d.pairsInserted} pair(s) from ${d.questionsProcessed} question(s)` +
          (Number(d.skipped) > 0 ? `; ${d.skipped} skipped.` : "."),
      );
      if (d.stats) setPairs(d.stats as PairStats);
    }
    load();
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

  const backfill = async () => {
    const d = await post("backfill", "/api/semantic-cache/key-model", { action: "backfill" });
    if (!d) return;
    setNote(
      Number(d.candidates) === 0
        ? `Nothing to re-key — every cached question already has a ${d.keyModel} vector.`
        : `Re-keyed ${d.inserted} of ${d.candidates} cached questions` +
          (Number(d.failed) > 0 ? `; ${d.failed} failed to embed.` : "."),
    );
  };

  // Hard negatives are what makes the table mean anything — a set that's all
  // 'same' grades every model identically at the top of its ranking.
  const noNegatives = pairs !== null && pairs.total > 0 && pairs.different === 0;
  // NO MODEL PRODUCED A τ, which silently demotes the whole table to an AUC
  // ranking (see the sort in keyModelSweep) — so it has to say WHY. The reason
  // comes from the sweep's own attainability report rather than being guessed
  // from the pair count: "too few pairs" and "the target is out of reach on this
  // set" are the difference between get-more-data and lower-the-target, and only
  // the sweep knows which prefix it actually got to consider.
  const noThresholds = sweep !== null && sweep.rows.every((r) => r.threshold === null);
  const scoredRows = sweep?.rows.filter((r) => r.calibration !== null) ?? [];
  // No eligible prefix ANYWHERE means the set never reached minSamples — the
  // target was never even tested, so pointing at it would be misleading.
  const tooFewPairs =
    scoredRows.length > 0 &&
    scoredRows.every((r) => r.calibration!.attainability.blocker !== "target-unreachable");
  // The closest any model got, and what the target would have cost it. Ranked by
  // achieved precision: this is the "you asked for 99%, the best model managed
  // 95% over 20 pairs, and 99% with that one reject needs n ≥ 100" line.
  const closest = scoredRows
    .filter((r) => r.calibration!.attainability.bestRate !== null)
    .sort((a, b) => b.calibration!.attainability.bestRate! - a.calibration!.attainability.bestRate!)[0];
  const closestAt = closest?.calibration!.attainability;

  return (
    <Panel
      step={4}
      title="Cache key model"
      about={ABOUT}
      subtitle="Which space a config reads its threshold FROM — not what it serves at."
      action={
        status && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Keys under <span className="font-mono">{status.keyModel}</span>
            {status.override === null ? " (global default)" : " (override)"} · space{" "}
            <span className="font-mono">{status.threshold.space}</span> serves at{" "}
            <span className="tabular-nums">{status.threshold.threshold.toFixed(3)}</span> (
            {status.threshold.source})
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
              {busy === "apply" ? "Applying…" : blocked ? "Apply anyway" : "Apply"}
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
      {/* --- the pair set ---------------------------------------------------- */}
      {/* The set and the control that grows it, in one bordered block: the two
          used to be loose rows floating between the heading and the table, which
          read as page furniture rather than as this panel's inputs. */}
      <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
          <Tooltip align="left" text={PAIRS_ABOUT}>
            <span className="text-zinc-500 underline decoration-dotted underline-offset-2 dark:text-zinc-400">
              Eval pairs
            </span>
          </Tooltip>
          <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
            {pairs
              ? `${pairs.total} generated (${pairs.same} same / ${pairs.different} different)`
              : "—"}
          </span>
          {pairs && pairs.questionsRemaining > 0 && (
            <span className="text-zinc-400">
              · {pairs.questionsRemaining} eval question
              {pairs.questionsRemaining === 1 ? "" : "s"} with none yet
            </span>
          )}
        </div>

        {/* How MANY questions the next run covers. Generation is the only paid
            step here, and it's per-question, so the size of the ask is a real
            decision — one button that took the route's invisible default meant
            the spend was neither chosen nor visible. */}
        {genMax > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <input
              type="range"
              min={1}
              max={genMax}
              value={genQuestions}
              onChange={(e) => setGenLimit(Number(e.target.value))}
              aria-label="Questions to generate pairs for"
              disabled={busy !== null}
              className="h-1 w-40 min-w-32 max-w-full cursor-pointer accent-zinc-900 dark:accent-zinc-100"
            />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                {genQuestions}
              </span>{" "}
              question{genQuestions === 1 ? "" : "s"} → ~
              <span className="tabular-nums">{genQuestions * PAIRS_PER_QUESTION}</span> pairs
            </span>
            <div className="flex gap-1">
              {/* The two ends of the range are the answers you actually want —
                  dragging a slider to its own maximum is a fiddle. */}
              <button
                type="button"
                className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500 cursor-pointer hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                onClick={() => setGenLimit(Math.min(GEN_DEFAULT, genMax))}
              >
                {Math.min(GEN_DEFAULT, genMax)}
              </button>
              <button
                type="button"
                className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500 cursor-pointer hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                onClick={() => setGenLimit(genMax)}
              >
                all {genMax}
              </button>
            </div>
            <button
              type="button"
              className={BTN}
              onClick={generate}
              disabled={busy !== null}
            >
              {busy === "pairs" ? "Generating…" : "Generate pairs"}
            </button>
          </div>
        )}
        {/* The generate control is gated on knowing the gap, so say so rather
            than rendering nothing — an empty space where a button was reads as
            "the feature is gone", not "the count hasn't arrived". */}
        {pairs === null && <p className="text-xs text-zinc-400">Loading pair stats…</p>}
        {pairs !== null && pairs.questionsRemaining === 0 && (
          <p className="text-xs text-zinc-400">
            Every eval question already has pairs — add eval questions to grow the set.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <button type="button" className={BTN} onClick={runSweep} disabled={busy !== null}>
            {busy === "sweep" ? "Scoring…" : sweep ? "Re-run sweep" : "Run sweep"}
          </button>
          <span className="text-xs text-zinc-400">
            Embedding-only — no LLM calls, and cached, so re-runs are nearly free.
          </span>
        </div>
      </div>

      {noNegatives && (
        <p className={NOTE_AMBER}>
          Every generated pair is labeled &ldquo;same&rdquo;. Without hard negatives the sweep
          can&apos;t separate models — they&apos;ll all look equally good.
        </p>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {note && <p className="text-xs text-green-700 dark:text-green-400">{note}</p>}

      {blocked && (
        <div className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p>
            <span className="font-mono">{blocked.space}</span> has no calibrated threshold —
            configs moved there would serve at{" "}
            <span className="tabular-nums">{blocked.fallbackThreshold.toFixed(3)}</span> (the
            default). Calibrate it above, or apply again to confirm.
          </p>
        </div>
      )}

      {sweep && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {sweep.pairs.total} pairs ({sweep.pairs.shadow} shadow / {sweep.pairs.generated}{" "}
            generated · {sweep.pairs.same} same / {sweep.pairs.different} different) · precision
            held at <span className="tabular-nums">{pct(sweep.target)}</span>{" "}
            <Tooltip align="left" text={TARGET_ABOUT}>
              <span className="text-zinc-400 underline decoration-dotted underline-offset-2">
                from{" "}
                <span className="font-mono">{sweep.targetSource.configLabel}</span>
                {sweep.targetSource.source === "config" ? " (override)" : " (global default)"}
              </span>
            </Tooltip>
          </p>

          {/* The τ / Recall@τ / Precision columns are ALL derived from τ, so
              when no model produces one the table shows three dashed columns and
              nothing on the page says why. This says why — as a glyph, because
              the explanation is a paragraph you read once and then have to scroll
              past on every visit. */}
          {noThresholds && (
            <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <WarnDot text={noThresholdReason(sweep, tooFewPairs, closest, closestAt)} />
              No τ at {pct(sweep.target)} — τ, Recall@τ and Precision are blank below
            </p>
          )}

          <div className={TABLE_WRAP}>
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className={TABLE_HEAD}>
                <tr>
                  <th className="py-2 pl-4 pr-3 font-medium">Model</th>
                  <th className="py-2 pr-3 font-medium">Space</th>
                  <th className="py-2 pr-3 text-right font-medium">τ</th>
                  <th className="py-2 pr-3 text-right font-medium">
                    <Tooltip
                      align="left"
                      text="Share of servable pairs this model's τ actually catches. The objective."
                    >
                      <span className="underline decoration-dotted underline-offset-2">
                        Recall@τ
                      </span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">Precision</th>
                  <th className="py-2 pr-3 text-right font-medium">
                    <Tooltip
                      align="left"
                      text="P(a random same pair outranks a random different pair). Scale-free, so it's the tiebreak — but it grades the whole ranking, and a cache only serves from the top."
                    >
                      <span className="underline decoration-dotted underline-offset-2">AUC</span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">Pairs</th>
                  <th className="py-2 pr-4 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {sweep.rows.map((r) => (
                  <Row
                    key={r.model}
                    row={r}
                    current={status?.keyModel === r.model}
                    selected={selected === r.model}
                    onSelect={() => {
                      setSelected(r.model);
                      setBlocked(null);
                      setNote(null);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </Panel>
  );
}

function Row({
  row,
  current,
  selected,
  onSelect,
}: {
  row: LeaderboardRow;
  current: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  // An unavailable or errored model keeps its row — a missing row reads as "it
  // scored badly", which is a different and wrong claim.
  const dim = !row.available || row.error !== null;
  return (
    <tr
      onClick={row.available && !row.error ? onSelect : undefined}
      className={
        (selected ? "bg-zinc-100 dark:bg-zinc-800 " : "") +
        (dim ? "opacity-50 " : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900 ")
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
      <td className="py-1.5 pr-3 font-mono text-xs text-zinc-500">{row.space}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{num(row.threshold)}</td>
      <td
        className={
          "py-1.5 pr-3 text-right tabular-nums " +
          (row.recallAtThreshold !== null ? "font-medium text-black dark:text-zinc-50" : "")
        }
      >
        {pct(row.recallAtThreshold)}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-zinc-500">
        {pct(row.precisionAtThreshold)}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-zinc-500">
        {row.auc === null ? "—" : row.auc.toFixed(3)}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-zinc-500">{row.pairsScored}</td>
      <td className="py-1.5 pr-4 text-xs text-zinc-400">{row.error ?? row.reason ?? ""}</td>
    </tr>
  );
}
