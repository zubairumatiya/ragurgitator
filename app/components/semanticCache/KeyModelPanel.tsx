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

import { InfoDot } from "@/app/components/InfoDot";
import { Tooltip } from "@/app/components/Tooltip";
import { apiFetch } from "@/lib/http/client";
import type { LeaderboardRow, SweepResult } from "@/lib/rag/keyModelSweep";
import type { PairStats } from "@/lib/rag/semanticCachePairs";

import { SC_CHANGED } from "./events";

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

const btn =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 cursor-pointer transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
const num = (n: number | null) => (n === null ? "—" : n.toFixed(4));

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
    const d = await post("pairs", "/api/semantic-cache/pairs", {});
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
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Cache key model
          <InfoDot text={ABOUT} />
        </h2>
        {status && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            This config keys under <span className="font-mono">{status.keyModel}</span>
            {status.override === null ? " (global default)" : " (override)"} · space{" "}
            <span className="font-mono">{status.threshold.space}</span> serves at{" "}
            <span className="tabular-nums">{status.threshold.threshold.toFixed(3)}</span> (
            {status.threshold.source})
          </p>
        )}
      </div>

      {/* --- the pair set ---------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Tooltip align="left" text={PAIRS_ABOUT}>
          <span className="text-zinc-500 underline decoration-dotted underline-offset-2 dark:text-zinc-400">
            Eval pairs
          </span>
        </Tooltip>
        <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
          {pairs ? `${pairs.total} generated (${pairs.same} same / ${pairs.different} different)` : "—"}
        </span>
        {pairs && pairs.questionsRemaining > 0 && (
          <span className="text-zinc-400">
            · {pairs.questionsRemaining} eval question
            {pairs.questionsRemaining === 1 ? "" : "s"} with none yet
          </span>
        )}
        <button
          type="button"
          className={btn}
          onClick={generate}
          disabled={busy !== null || (pairs !== null && pairs.questionsRemaining === 0)}
        >
          {busy === "pairs" ? "Generating…" : "Generate pairs"}
        </button>
      </div>

      {noNegatives && (
        <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
          Every generated pair is labeled &ldquo;same&rdquo;. Without hard negatives the sweep
          can&apos;t separate models — they&apos;ll all look equally good.
        </p>
      )}

      {/* --- the sweep ------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={runSweep} disabled={busy !== null}>
          {busy === "sweep" ? "Scoring…" : sweep ? "Re-run sweep" : "Run sweep"}
        </button>
        <span className="text-xs text-zinc-400">
          Embedding-only — no LLM calls, and cached, so re-runs are nearly free.
        </span>
      </div>

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

          {noThresholds && (
            <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              {tooFewPairs ? (
                <>
                  No model produced a τ: {sweep.pairs.total} pairs never fills a serve set of{" "}
                  {sweep.minSamples}, the minimum calibration needs, so {pct(sweep.target)} was
                  never actually tested. Generate more pairs — until then only AUC is meaningful,
                  and it&apos;s the tiebreak, not the objective.
                </>
              ) : (
                <>
                  No model reached {pct(sweep.target)} precision on any serve set of{" "}
                  {sweep.minSamples}+ pairs.
                  {closestAt && (
                    <>
                      {" "}
                      Closest was <span className="font-mono">{closest.model}</span> at{" "}
                      <span className="tabular-nums">{pct(closestAt.bestRate)}</span> over{" "}
                      {closestAt.bestRateAt!.n} pairs
                      {closestAt.rejectsInBest > 0 && (
                        <>
                          {" "}
                          ({closestAt.rejectsInBest} false{" "}
                          {closestAt.rejectsInBest === 1 ? "positive" : "positives"})
                        </>
                      )}
                      .
                      {closestAt.requiredN !== null ? (
                        <>
                          {" "}
                          Clearing {pct(sweep.target)} while carrying{" "}
                          {closestAt.rejectsInBest} needs a serve set of{" "}
                          <span className="tabular-nums">{closestAt.requiredN}</span> — so at this
                          size the target means &ldquo;zero false positives&rdquo;. Either grow
                          the pair set past that, or lower the target for{" "}
                          <span className="font-mono">{sweep.targetSource.configLabel}</span> in
                          Settings → Savings.
                        </>
                      ) : (
                        <>
                          {" "}
                          At a {pct(sweep.target)} target no serve set size forgives a single
                          false positive, so only a perfectly clean prefix can ever produce a τ.
                          Lower the target for{" "}
                          <span className="font-mono">{sweep.targetSource.configLabel}</span> in
                          Settings → Savings.
                        </>
                      )}
                    </>
                  )}{" "}
                  The pair set is also harder than real traffic — every negative was written to
                  sit right next to its origin question — so read these as a floor rather than as
                  what the cache would actually do.
                </>
              )}
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">Model</th>
                  <th className="py-1 pr-3 font-medium">Space</th>
                  <th className="py-1 pr-3 text-right font-medium">τ</th>
                  <th className="py-1 pr-3 text-right font-medium">
                    <Tooltip
                      align="left"
                      text="Share of servable pairs this model's τ actually catches. The objective."
                    >
                      <span className="underline decoration-dotted underline-offset-2">
                        Recall@τ
                      </span>
                    </Tooltip>
                  </th>
                  <th className="py-1 pr-3 text-right font-medium">Precision</th>
                  <th className="py-1 pr-3 text-right font-medium">
                    <Tooltip
                      align="left"
                      text="P(a random same pair outranks a random different pair). Scale-free, so it's the tiebreak — but it grades the whole ranking, and a cache only serves from the top."
                    >
                      <span className="underline decoration-dotted underline-offset-2">AUC</span>
                    </Tooltip>
                  </th>
                  <th className="py-1 pr-3 text-right font-medium">Pairs</th>
                  <th className="py-1 font-medium" />
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

      {/* --- apply / backfill ------------------------------------------------ */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
        <button type="button" className={btn} onClick={backfill} disabled={busy !== null}>
          {busy === "backfill" ? "Re-keying…" : "Re-key cached questions"}
        </button>
        <span className="text-xs text-zinc-400">Apply</span>
        <span className="font-mono text-xs text-zinc-600 dark:text-zinc-300">
          {selected ?? "select a row"}
        </span>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "config" | "all")}
          aria-label="Apply scope"
          className="rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
        >
          <option value="config">to this config</option>
          <option value="all">to every config</option>
        </select>
        <button
          type="button"
          onClick={apply}
          disabled={busy !== null || !selected}
          className="rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-black"
        >
          {busy === "apply" ? "Applying…" : blocked ? "Apply anyway" : "Apply"}
        </button>
      </div>
      <p className="text-right text-[11px] text-zinc-400">
        Writes the per-config override. The true global default is{" "}
        <span className="font-mono">config.semanticCache.keyModel</span> in code — &ldquo;every
        config&rdquo; is how you move it without a deploy.
      </p>
    </section>
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
      <td className="py-1.5 pr-3 font-mono text-xs">
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
      <td className="py-1.5 text-xs text-zinc-400">{row.error ?? row.reason ?? ""}</td>
    </tr>
  );
}
