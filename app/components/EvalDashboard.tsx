// UI: retrieval eval dashboard (/eval).
//
// Shows Recall@k, MRR@k, and nDCG for the active config, a per-document breakdown,
// the run history, and a per-question detail table with inline editing. "Score
// pending" scores only the questions without a fresh result; generating new ones is
// Bulk actions → Add.
//
// Recall@k answers "did the ground truth land in the window"; MRR@k adds "how close
// to the top" — two configs can tie on recall while one consistently ranks the
// chunk higher. The per-question rank already shows on the hit badge, so MRR only
// appears as the headline aggregate.
"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { HIGH_NDCG } from "@/lib/config";
import { apiFetch } from "@/lib/http/client";
import { noteHeadline } from "@/lib/rag/embeddingModels";
import {
  ApiErrorNotice,
  type ApiErrorBody,
} from "@/app/components/MissingKeyNotice";
import { failsBar } from "@/lib/rag/evalBar";
import type {
  ChunkOverrideInfo,
  ChunkRef,
  CorpusChunkListItem,
  EvalSummary,
  ExplainChunk,
  OverrideOutcome,
  PoolChunk,
  QuestionDetail,
  QuestionExplain,
  SavedModelTrial,
  TrialKind,
  TrialQuestionOutcome,
} from "@/lib/rag/evalStore";
import type {
  ChunkWindow,
  Difficulty,
  EvalEvent,
  GeneratedQuestionPayload,
  ModelTrialContext,
  ModelTrialResult,
} from "@/lib/rag/eval";
import { AutotunePanel } from "@/app/components/AutotunePanel";
import { ConfigChangeDialog } from "@/app/components/ConfigChangeDialog";
import { EVAL_CRITERIA_CHANGED } from "@/app/components/EvalSettings";
import { NdcgRankingPanel } from "@/app/components/NdcgRankingPanel";
import { Tooltip } from "@/app/components/Tooltip";
import type { IngestedDocument } from "@/lib/rag/vectorStore";

// Bulk actions → Add question: how many questions the run should add per chunk
// at each difficulty (the badge counts in the panel). Absent = don't generate
// that difficulty at all.
type DifficultyCounts = Partial<Record<Difficulty, number>>;

function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

// nDCG lands in [0, 1] but isn't a percentage — plain 2-decimal score.
function fmtScore(n: number | null): string {
  return n === null ? "—" : n.toFixed(2);
}

// Hover explainer for the MRR card: the reciprocal rank each position
// contributes, all the way to the metric's k — so a value like 0.50 reads as
// "the ground truth averages around rank 2", and a min-rate maps to the
// worst acceptable rank. Rows name the rank rather than showing 1/r, since the
// point is reading a score back as a position, not the arithmetic.
function mrrFractionsTitle(k: number): string {
  const rows = [];
  for (let r = 1; r <= k; r++) rows.push(`rank ${r} → ${(1 / r).toFixed(2)}`);
  return `Per-question reciprocal rank:\n${rows.join("\n")}\nbeyond ${k} → 0.00`;
}

// Continuous tint for a score in [0, 1], mixing from the miss badge's red to
// the hit badge's green in oklch (passing through amber mid-range), so a
// perfect score is the exact same green as a Recall@k hit. Consumers set the
// --mp custom property with this and reference it from the tint*Class
// arbitrary-value Tailwind classes below, so light/dark variants still apply.
function scoreTint(score: number): CSSProperties {
  const pct = Math.round(100 * Math.min(1, Math.max(0, score)));
  return { "--mp": `${pct}%` } as CSSProperties;
}

const tintBgClass =
  "bg-[color-mix(in_oklch,var(--color-red-100),var(--color-green-100)_var(--mp))] dark:bg-[color-mix(in_oklch,var(--color-red-900),var(--color-green-900)_var(--mp))]/40";
const tintTextClass =
  "text-[color-mix(in_oklch,var(--color-red-700),var(--color-green-700)_var(--mp))] dark:text-[color-mix(in_oklch,var(--color-red-400),var(--color-green-400)_var(--mp))]";

type ChunkGroup = {
  chunkId: string;
  fileName: string;
  position: number | null;
  questions: QuestionDetail[];
};

// Group questions by their labeled chunk, preserving the server's order so groups
// appear in a stable sequence.
//
// SEEDED FROM `chunks` FIRST, so every chunk under the config gets a card whether
// or not it has questions. That is what makes a freshly ingested document visible
// immediately: the card's header, its "add question" form and its "try a model"
// runner are all keyed by chunk id. Before this, a chunk was reachable only once
// something had generated a question against it, which left a new document looking
// as though it had not been ingested at all.
//
// The questions loop still creates a group when it meets a chunk that isn't in the
// list, so a question labeled to a chunk that has since been re-chunked away keeps
// rendering instead of vanishing.
function groupByChunk(
  questions: QuestionDetail[],
  chunks: ChunkRef[],
): ChunkGroup[] {
  const groups: ChunkGroup[] = [];
  const indexByChunk = new Map<string, number>();
  for (const c of chunks) {
    indexByChunk.set(c.chunkId, groups.length);
    groups.push({
      chunkId: c.chunkId,
      fileName: c.fileName,
      position: c.position,
      questions: [],
    });
  }
  for (const q of questions) {
    let i = indexByChunk.get(q.sourceChunkId);
    if (i === undefined) {
      i = groups.length;
      indexByChunk.set(q.sourceChunkId, i);
      groups.push({
        chunkId: q.sourceChunkId,
        fileName: q.fileName,
        position: q.expectedPosition,
        questions: [],
      });
    }
    groups[i].questions.push(q);
  }
  return groups;
}

// Carry the previous render's group objects forward for every chunk whose
// contents didn't change. groupByChunk rebuilds all of them from scratch, so a
// single patchQuestion mid-run handed all ~236 cards a fresh `group` prop and
// defeated their memo — one scored question re-rendered the entire list, ~164
// times a run. Questions are patched immutably, so per-question reference
// equality is the exact "did this chunk change" test. Returns `prev` itself
// when nothing moved, so `groups` is stable too.
function reuseUnchangedGroups(
  prev: ChunkGroup[],
  next: ChunkGroup[],
): ChunkGroup[] {
  const prevById = new Map(prev.map((g) => [g.chunkId, g]));
  let changed = prev.length !== next.length;
  const merged = next.map((g, i) => {
    const old = prevById.get(g.chunkId);
    if (
      old === undefined ||
      old.fileName !== g.fileName ||
      old.position !== g.position ||
      old.questions.length !== g.questions.length ||
      old.questions.some((q, j) => q !== g.questions[j])
    ) {
      changed = true;
      return g;
    }
    // Same object, different slot: the card is memo-skipped but the list order
    // moved, so the array still has to be a new one.
    if (prev[i] !== old) changed = true;
    return old;
  });
  return changed ? merged : prev;
}

// Stable empty array for chunk groups with no saved trials. A fresh `[]` literal
// per render would hand every such card a new prop and defeat its memo — which,
// with most chunks having no trials, is nearly all of them.
const NO_TRIALS: SavedModelTrial[] = [];

// Same idea for the "no summary yet" group list, so it doesn't churn.
const NO_GROUPS: ChunkGroup[] = [];

// Narrow a dashboard-wide "which row is open" id to one chunk group: the id if it
// names one of this group's questions, else null. Lets the parent hand each
// memoized card only the open-state that concerns it, so opening a drill-down
// re-renders one card instead of all of them.
function idInGroup(group: ChunkGroup, id: string | null): string | null {
  if (id === null) return null;
  return group.questions.some((q) => q.questionId === id) ? id : null;
}

// Live progress for an in-flight process/rescore run. "generate" has no recall
// yet; "score" tracks a running hit count so the panel can show recall climbing;
// "ranking" (bulk nDCG grading) tracks per-question build failures, plus — for
// the bulk LLM pass, which spends per question — how many questions the run
// declined to spend on and why.
type EvalProgress =
  | { phase: "generate"; done: number; total: number }
  | { phase: "score"; done: number; total: number; hits: number }
  | {
      phase: "ranking";
      done: number;
      total: number;
      failed: number;
      skippedNoAggregate: number;
      skippedCached: number;
    };

type RunResult = {
  // The run stopped early because Cancel was pressed. Everything below is still
  // the real, committed count — cancelling keeps partial work.
  cancelled?: boolean;
  generated: number;
  // Questions served from the question cache rather than generated — free, so
  // the notice reports them separately instead of folding them into `generated`.
  reused?: number;
  scored: number;
  recall: number | null;
  mrr: number | null;
  ndcg: number | null;
  // Bulk nDCG grading only: questions that got a new ground-truth ranking.
  graded?: number;
  // Bulk LLM nDCG only: llm_rerank rankings built as comparison candidates, and
  // the questions skipped for want of an aggregate / for an already-cached one.
  llmRanked?: number;
  skippedNoAggregate?: number;
  skippedCached?: number;
};

// Lazy-loaded "why did it miss?" detail for an expanded question.
type ExplainState =
  | { status: "loading" }
  | { status: "ready"; data: QuestionExplain }
  | { status: "error"; message: string };

export function EvalDashboard() {
  const router = useRouter();
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Bulk actions → Change base model / chunk size" edits THIS config in place
  // (or selected documents via per-chunk overrides when a document scope is
  // picked — null means the whole config).
  const [changeScope, setChangeScope] = useState<{
    docIds: string[] | null;
    docNames: string[] | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<EvalProgress | null>(null);
  // The in-flight run's id (from the stream's first line) and whether a cancel
  // has been POSTed for it. Cancellation is cooperative — the run stops at its
  // next checkpoint, so the button flips to "Cancelling…" rather than pretending
  // the run is already over.
  const [runId, setRunId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Which row is in edit mode. The draft text itself lives inside QuestionRow —
  // keeping it here re-rendered all 80 chunk cards on every keystroke.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Which question's chunk drill-down is expanded, and the per-question detail
  // we lazy-fetch on first expand (cached so re-opening is instant).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [explains, setExplains] = useState<Record<string, ExplainState>>({});
  // Mirrors of the two above, so toggleExpand can read them without listing them
  // as deps — a toggleExpand that changed identity would re-render every
  // memoized row, which is exactly what the memoization is here to prevent.
  const expandedIdRef = useRef<string | null>(null);
  const explainsRef = useRef<Record<string, ExplainState>>({});
  const putExplain = useCallback((id: string, state: ExplainState) => {
    explainsRef.current = { ...explainsRef.current, [id]: state };
    setExplains(explainsRef.current);
  }, []);

  // Which question's nDCG ranking builder is open (independent of the top-k drill-down).
  const [rankingOpenId, setRankingOpenId] = useState<string | null>(null);

  // Saved model trials for every chunk, keyed by chunk id (see the fetch below).
  // null means "not loaded yet", so the loading flag is derived rather than a
  // second piece of state that an effect would have to keep in sync.
  const [trialsByChunk, setTrialsByChunk] = useState<Record<
    string,
    SavedModelTrial[]
  > | null>(null);
  const trialsLoading = trialsByChunk === null;

  // Run history is collapsed by default — it grows over time and sits above the
  // questions table, so keep it out of the way until asked for.
  const [runsOpen, setRunsOpen] = useState(false);

  // Which chunk group has the "add a question" form open, and which difficulty
  // (if any) is generating. The form's synthetic/manual tab and its draft text
  // are local to AddQuestionForm, for the same reason as editText above.
  const [addingChunkId, setAddingChunkId] = useState<string | null>(null);
  const [genDifficulty, setGenDifficulty] = useState<Difficulty | null>(null);

  // Bump to re-fetch the summary (used after process / edit / delete / add). A
  // reload means questions/scores may have changed, so reset transient UI.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => {
    explainsRef.current = {};
    expandedIdRef.current = null;
    setExplains({});
    setExpandedId(null);
    setRankingOpenId(null);
    setAddingChunkId(null);
    setTrialsByChunk(null);
    setReloadKey((k) => k + 1);
  }, []);

  // The Settings dropdown lives in the Nav now (EvalSettings.tsx); when it
  // saves, re-pull the summary so criteria-dependent numbers refresh.
  useEffect(() => {
    const onChanged = () => setReloadKey((k) => k + 1);
    window.addEventListener(EVAL_CRITERIA_CHANGED, onChanged);
    return () => window.removeEventListener(EVAL_CRITERIA_CHANGED, onChanged);
  }, []);

  // Toggle a question's drill-down, fetching its detail the first time it opens.
  const toggleExpand = useCallback(
    (id: string) => {
      const opening = expandedIdRef.current !== id;
      expandedIdRef.current = opening ? id : null;
      setExpandedId(expandedIdRef.current);
      if (!opening || explainsRef.current[id]) return;
      putExplain(id, { status: "loading" });
      apiFetch(`/api/eval/questions/${id}/explain`)
        .then(async (res) => {
          const data = (await res.json()) as
            | QuestionExplain
            | { error: string };
          if (!res.ok || "error" in data) {
            throw new Error(
              "error" in data ? data.error : `Request failed (${res.status}).`,
            );
          }
          putExplain(id, { status: "ready", data });
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : "Failed to load.";
          putExplain(id, { status: "error", message });
        });
    },
    [putExplain],
  );

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await apiFetch("/api/eval");
        const data = (await res.json()) as EvalSummary | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in data) {
          setError(
            "error" in data ? data.error : `Request failed (${res.status}).`,
          );
          return;
        }
        setError(null);
        setSummary(data);
      } catch (err) {
        if (alive)
          setError(err instanceof Error ? err.message : "Network error.");
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  // Every chunk's saved trials in one read. ChunkExperiments used to fetch its
  // own on mount, which meant one request per chunk group — 80 of them on the
  // current corpus, and most came back empty. Owned here because the trial
  // sections mutate it (optimistic delete, and a new trial from the runner).
  useEffect(() => {
    let alive = true;
    apiFetch("/api/eval/trials")
      .then((res) => res.json())
      .then((data: { trialsByChunk?: Record<string, SavedModelTrial[]> }) => {
        if (alive) setTrialsByChunk(data.trialsByChunk ?? {});
      })
      .catch(() => {
        // best-effort: settle into "loaded, none" so the sections stop pulsing
        if (alive) setTrialsByChunk({});
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  // Re-fetch the summary in place (no transient-UI reset), so promoting/editing a
  // ground-truth ranking updates the nDCG chip + headline without collapsing the
  // open ranking panel. Used as the NdcgRankingPanel's onChange.
  const refreshSummary = useCallback(async () => {
    try {
      const res = await apiFetch("/api/eval");
      const data = (await res.json()) as EvalSummary | { error: string };
      if (res.ok && !("error" in data)) setSummary(data);
    } catch {
      // best-effort; the panel surfaces its own action errors
    }
  }, []);

  // Flip a question's badge in place as its score lands. Only patches rows that
  // are already in the table; brand-new generated questions appear on reload().
  function patchQuestion(id: string, hit: boolean, foundRank: number | null) {
    setSummary((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            questions: prev.questions.map((q) =>
              q.questionId === id
                ? {
                    ...q,
                    hit,
                    foundRank,
                    rr:
                      foundRank !== null && foundRank <= prev.mrrK
                        ? 1 / foundRank
                        : 0,
                    storedSim: null,
                    stale: false,
                    scoredAt: Date.now(),
                  }
                : q,
            ),
          },
    );
  }

  // Append a freshly generated question (unscored) as its generate event lands,
  // so bulk runs fill the table live instead of dumping everything at reload().
  // groupByChunk files it under its existing chunk group; a chunk with no
  // questions yet gets a new group at the bottom until the final reload()
  // restores document order. The scoring phase's score-result events then flip
  // its badge in place via patchQuestion, like any other row.
  function appendQuestion(g: GeneratedQuestionPayload) {
    setSummary((prev) => {
      if (
        prev === null ||
        prev.questions.some((q) => q.questionId === g.questionId)
      ) {
        return prev;
      }
      return {
        ...prev,
        total: prev.total + 1,
        questions: [
          ...prev.questions,
          {
            questionId: g.questionId,
            question: g.question,
            source: "generated",
            difficulty: g.difficulty,
            documentId: g.documentId,
            fileName: g.fileName,
            sourceChunkId: g.sourceChunkId,
            expectedPosition: g.expectedPosition,
            hit: null,
            foundRank: null,
            storedSim: null,
            retrievedIds: null,
            scoredAt: null,
            stale: false,
            editStale: false,
            rr: null,
            ndcg: null,
            ignored: false,
            // A question born this second is in neither set until the next
            // holdout draw, which happens on the next settings save.
            heldOut: false,
          },
        ],
      };
    });
  }

  // Drive a process/rescore run from its NDJSON event stream: advance the
  // progress bar, patch question badges live, and reconcile via reload() at the end.
  async function runStream(
    url: string,
    label: (r: RunResult) => string,
    body?: unknown,
  ) {
    setBusy(true);
    setNotice(null);
    setError(null);
    setProgress(null);
    setRunId(null);
    setCancelling(false);
    try {
      const res = await apiFetch(
        url,
        body === undefined
          ? { method: "POST" }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let hits = 0;
      let failed = 0;
      // Skip tallies arrive once, on ranking-start; keep them so every later
      // ranking-progress can re-render the bar without losing them.
      let skippedNoAggregate = 0;
      let skippedCached = 0;
      let final: RunResult | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as EvalEvent;
          switch (event.type) {
            case "run-started":
              // First line of every stream: the id Cancel needs to reach the
              // producer, which outlives this page (it is detached from the
              // request — see lib/http/ndjson.ts).
              setRunId(event.runId);
              break;
            case "generate-start":
              setProgress({ phase: "generate", done: 0, total: event.total });
              break;
            case "generate-progress":
              setProgress({
                phase: "generate",
                done: event.done,
                total: event.total,
              });
              if (event.question) appendQuestion(event.question);
              break;
            case "score-start":
              hits = 0;
              setProgress({
                phase: "score",
                done: 0,
                total: event.total,
                hits: 0,
              });
              break;
            case "score-result":
              if (event.hit) hits += 1;
              setProgress({
                phase: "score",
                done: event.done,
                total: event.total,
                hits,
              });
              patchQuestion(event.questionId, event.hit, event.foundRank);
              break;
            case "ranking-start":
              failed = 0;
              skippedNoAggregate = event.skippedNoAggregate ?? 0;
              skippedCached = event.skippedCached ?? 0;
              setProgress({
                phase: "ranking",
                done: 0,
                total: event.total,
                failed: 0,
                skippedNoAggregate,
                skippedCached,
              });
              break;
            case "ranking-progress":
              if (!event.ok) failed += 1;
              setProgress({
                phase: "ranking",
                done: event.done,
                total: event.total,
                failed,
                skippedNoAggregate,
                skippedCached,
              });
              break;
            case "done":
              final = {
                cancelled: event.cancelled,
                generated: event.generated,
                reused: event.reused,
                scored: event.scored,
                recall: event.recall,
                mrr: event.mrr,
                ndcg: event.ndcg,
                graded: event.graded,
                llmRanked: event.llmRanked,
                skippedNoAggregate: event.skippedNoAggregate,
                skippedCached: event.skippedCached,
              };
              break;
            case "batch-submitted":
              // Question generation was routed through the batch API (Settings →
              // Savings). Nothing landed inline; surface where to track it.
              setNotice(
                `Submitted ${event.requestCount} question${
                  event.requestCount === 1 ? "" : "s"
                } as a batch — it runs in the background. Track it under “Batches”; ` +
                  `we'll let you know when it's done.`,
              );
              return;
            case "error":
              setError(event.message);
              return;
          }
        }
      }

      if (final) {
        // A cancelled run reports what it KEPT — the transaction commits, so
        // everything generated and scored before the stop is real.
        setNotice(
          final.cancelled
            ? `Cancelled — kept ${final.generated + (final.reused ?? 0)} question(s), ` +
              `${final.scored} scored.`
            : label(final),
        );
      }
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
      setProgress(null);
      setRunId(null);
      setCancelling(false);
    }
  }

  // Ask the server to stop the in-flight run. `found: false` means it already
  // finished (or is streaming from another instance) — either way there is
  // nothing left to stop, so it is not an error worth showing.
  async function cancelRun() {
    if (!runId) return;
    setCancelling(true);
    try {
      await apiFetch("/api/eval/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
    } catch {
      // The run keeps going; the button stays as it is and the stream will say
      // what happened.
      setCancelling(false);
    }
  }

  const onProcess = () =>
    runStream(
      "/api/eval/process",
      (r) =>
        `Scored ${r.scored} question(s). ` +
        `Recall@k ${pct(r.recall)} · MRR ${fmtScore(r.mrr)} · nDCG ${fmtScore(r.ndcg)}.`,
    );

  const onRescore = (documentIds: string[] | null) =>
    runStream(
      "/api/eval/rescore",
      (r) =>
        `Re-scored ${r.scored} question(s). ` +
        `Recall@k ${pct(r.recall)} · MRR ${fmtScore(r.mrr)} · nDCG ${fmtScore(r.ndcg)}.`,
      documentIds ? { documentIds } : undefined,
    );

  // Bulk actions → Add question → {difficulty ×N} → Add: add N questions at each
  // requested difficulty to every chunk in scope (corpus-wide, or the selected
  // documents), or with `topUp` top each chunk up TO N, then score. Same NDJSON
  // stream.
  const onBulkAdd = (
    counts: DifficultyCounts,
    documentIds: string[] | null,
    topUp: boolean,
  ) => {
    const mix = (Object.entries(counts) as [Difficulty, number][])
      .map(([d, n]) => `${n}× ${d}`)
      .join(", ");
    return runStream(
      "/api/eval/bulk-generate",
      (r) =>
        `Added ${r.generated} question(s) (${mix} per chunk${
          topUp ? ", topped up" : ""
        }), scored ${r.scored}. ` +
        `Recall@k ${pct(r.recall)} · MRR ${fmtScore(r.mrr)} · nDCG ${fmtScore(r.ndcg)}.`,
      { counts, documentIds: documentIds ?? undefined, topUp },
    );
  };

  // Bulk actions → Add question → Add cached: hand every chunk in scope whatever
  // was already generated for identical chunk text, at any difficulty. Free, and
  // it generates nothing — chunks with nothing banked are simply left alone, and
  // anything a chunk already shows is skipped, so pressing it twice adds nothing.
  const onBulkAddCached = (documentIds: string[] | null) =>
    runStream(
      "/api/eval/bulk-generate",
      (r) =>
        r.reused
          ? `Added ${r.reused} cached question(s) for $0, scored ${r.scored}. ` +
            `Recall@k ${pct(r.recall)} · MRR ${fmtScore(r.mrr)} · nDCG ${fmtScore(r.ndcg)}.`
          : `No new cached questions for these chunks — nothing added, nothing spent. ` +
            `Use Add to generate them.`,
      { documentIds: documentIds ?? undefined, cachedOnly: true },
    );

  // Bulk actions → Add nDCG rankings: for every question in scope without a
  // ground truth, build the aggregate ranking and promote it (the panel's
  // builder, run corpus-wide). Same NDJSON stream. `rebuild` also refreshes
  // aggregate-truth questions and re-scores them, so ideals built before the
  // latest ingests account for the chunks that arrived since.
  const onBulkNdcg = (documentIds: string[] | null, rebuild: boolean) =>
    runStream(
      "/api/eval/bulk-ndcg",
      (r) =>
        `${rebuild ? "Rebuilt" : "Graded"} ${r.graded ?? 0} question(s), scored ${r.scored}. ` +
        `Recall@k ${pct(r.recall)} · MRR ${fmtScore(r.mrr)} · nDCG ${fmtScore(r.ndcg)}.`,
      { documentIds: documentIds ?? undefined, rebuild },
    );

  // Bulk actions → Add LLM nDCG rankings: for every question in scope that
  // already has an aggregate, ask the LLM to re-order its top-k (the panel's
  // "Re-rank top-k", run in bulk). The result is a COMPARISON candidate — the
  // notice says so, because nothing here changes nDCG until a ranking is
  // promoted to ground truth by hand. Same NDJSON stream.
  const onBulkLlmNdcg = (documentIds: string[] | null) =>
    runStream(
      "/api/eval/bulk-llm-ndcg",
      (r) => {
        const skips = [
          r.skippedNoAggregate
            ? `${r.skippedNoAggregate} skipped (no aggregate yet)`
            : null,
          r.skippedCached ? `${r.skippedCached} already cached` : null,
        ].filter(Boolean);
        return (
          `Built ${r.llmRanked ?? 0} LLM re-ranking(s)` +
          `${skips.length > 0 ? ` · ${skips.join(" · ")}` : ""}. ` +
          "They're comparison candidates — open a question to set one as ground truth."
        );
      },
      { documentIds: documentIds ?? undefined },
    );

  const saveEdit = useCallback(
    async (id: string, draft: string) => {
      const text = draft.trim();
      if (!text) return;
      setBusy(true);
      try {
        const res = await apiFetch(`/api/eval/questions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: text }),
        });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          setError(data.error ?? `Request failed (${res.status}).`);
          return;
        }
        setEditingId(null);
        reload();
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  // `uncache` also unbanks the wording from question_cache (see the route). A
  // failed uncache does NOT fail the delete — the question is gone either way —
  // but it is reported, because silently leaving it in the bank is exactly the
  // surprise ("it came back!") the checkbox exists to prevent.
  const remove = useCallback(
    async (id: string, uncache: boolean) => {
      setBusy(true);
      try {
        const res = await apiFetch(
          `/api/eval/questions/${id}${uncache ? "?uncache=1" : ""}`,
          { method: "DELETE" },
        );
        const data = (await res.json()) as {
          error?: string;
          uncached?: number;
          uncacheFailed?: boolean;
        };
        if (!res.ok) {
          setError(data.error ?? `Request failed (${res.status}).`);
          return;
        }
        setError(
          uncache && data.uncacheFailed
            ? "Question deleted, but it could not be removed from the question cache — it may return via “Add cached”."
            : null,
        );
        reload();
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  // "Ignore in rates" (§7): config-scoped, reversible; ignoring warns first
  // because it removes the question from Recall/nDCG rates + autotune targeting.
  const toggleIgnore = useCallback(
    async (q: QuestionDetail) => {
      if (
        !q.ignored &&
        !window.confirm(
          "Ignore this question in rates?\n\nManually verify it is genuinely a " +
            "distractor artifact (e.g. answerable from other legitimate chunks) " +
            "before ignoring — this removes it from your Recall/nDCG rates and " +
            "from autotune targeting. You can un-ignore it any time.",
        )
      ) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const res = await apiFetch(
          `/api/eval/questions/${q.questionId}/ignore`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ignored: !q.ignored }),
          },
        );
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          setError(data.error ?? `Request failed (${res.status}).`);
          return;
        }
        reload();
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  // Add a hand-written question to a chunk. It lands unscored; the next "Process
  // new chunks" / "Re-score all" scores it like any other.
  const addQuestion = useCallback(
    async (chunkId: string, draft: string) => {
      const text = draft.trim();
      if (!text) return;
      setBusy(true);
      setError(null);
      try {
        const res = await apiFetch("/api/eval/questions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chunkId, question: text }),
        });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          setError(data.error ?? `Request failed (${res.status}).`);
          return;
        }
        reload();
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  // Author one synthetic question for a chunk at the chosen difficulty. Like a
  // manual add it lands unscored; the next run scores it. The LLM call runs
  // server-side, so this can take a moment — the clicked button shows progress.
  const generateQuestion = useCallback(
    async (chunkId: string, difficulty: Difficulty) => {
      setBusy(true);
      setError(null);
      setGenDifficulty(difficulty);
      try {
        const res = await apiFetch("/api/eval/questions/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chunkId, difficulty }),
        });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          setError(data.error ?? `Request failed (${res.status}).`);
          return;
        }
        reload();
      } finally {
        setBusy(false);
        setGenDifficulty(null);
      }
    },
    [reload],
  );

  // Open/close callbacks for the memoized rows. Identity has to be stable or
  // every row re-renders whenever any one of them opens.
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const toggleRanking = useCallback(
    (id: string) => setRankingOpenId((cur) => (cur === id ? null : id)),
    [],
  );
  const closeRanking = useCallback(() => setRankingOpenId(null), []);
  const openAdd = useCallback(
    (chunkId: string) => setAddingChunkId(chunkId),
    [],
  );
  const closeAdd = useCallback(() => setAddingChunkId(null), []);

  // Trial edits touch one chunk's list, so the other chunks' arrays keep their
  // identity and their cards stay memo-skipped.
  const onTrialRemoved = useCallback((chunkId: string, trialId: string) => {
    setTrialsByChunk((m) => ({
      ...m,
      [chunkId]: (m?.[chunkId] ?? NO_TRIALS).filter((t) => t.id !== trialId),
    }));
  }, []);
  const onTrialSaved = useCallback(
    (chunkId: string, trial: SavedModelTrial) => {
      setTrialsByChunk((m) => ({
        ...m,
        [chunkId]: [trial, ...(m?.[chunkId] ?? NO_TRIALS)],
      }));
    },
    [],
  );

  // Group the questions by source chunk once per summary, not once per render —
  // this used to run inline in the JSX, so every keystroke re-grouped all 164
  // questions before re-rendering all 80 cards.
  // ...and reuse the previous groups for untouched chunks, so a live score
  // event re-renders the one card it landed in instead of all of them. The ref
  // write is safe under Strict Mode's double render: merging a result against
  // itself returns that same result.
  const groupsRef = useRef<ChunkGroup[]>(NO_GROUPS);
  const groups = useMemo(() => {
    const next =
      summary === null
        ? NO_GROUPS
        : groupByChunk(summary.questions, summary.chunks);
    const merged = reuseUnchangedGroups(groupsRef.current, next);
    groupsRef.current = merged;
    return merged;
  }, [summary]);

  // Disable the actions when they'd be no-ops. "Score pending" scores whatever
  // has no fresh result (new, edited, or retrieval-stale); "Re-score" re-runs
  // every labeled question. While the summary is still loading we leave them
  // enabled.
  const canProcess = summary === null || summary.pendingScoring > 0;
  const canRescore = summary === null || summary.total > 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Retrieval changed shape (a delegate/override was set or cleared) after
          some results were scored — they still count toward the rates, badged
          stale until the next full run re-scores them. Hover for the changes. */}
      {!busy && summary !== null && summary.retrievalStale > 0 && (
        <StaleBadge
          count={summary.retrievalStale}
          changes={summary.retrievalChanges}
        />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onProcess}
          disabled={busy || !canProcess}
          title={
            canProcess
              ? "Score every question that has no fresh result — new, edited, or stale after a retrieval change"
              : "Nothing pending to score"
          }
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {busy ? "Scoring…" : "Score pending"}
        </button>
        <BulkActions
          busy={busy}
          onAddDifficulty={onBulkAdd}
          onAddCached={onBulkAddCached}
          onAddNdcg={onBulkNdcg}
          onAddLlmNdcg={onBulkLlmNdcg}
          onChangeConfig={(docIds, docNames) =>
            setChangeScope({ docIds, docNames })
          }
          onRescore={onRescore}
          canRescore={canRescore}
          canAddQuestion={summary === null || summary.chunkCount > 0}
        />
        {summary && (
          <AutotunePanel
            summary={summary}
            busy={busy}
            onBusyChange={setBusy}
            onDone={reload}
          />
        )}
        {!progress && notice && (
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {notice}
          </span>
        )}
      </div>

      {changeScope && summary && (
        <ConfigChangeDialog
          config={summary.config}
          documentIds={changeScope.docIds}
          documentNames={changeScope.docNames}
          onClose={() => setChangeScope(null)}
          onDone={() => {
            // Settings/labels changed — refresh the banner and re-pull the summary.
            router.refresh();
            reload();
          }}
        />
      )}

      {progress && (
        <RunProgress
          progress={progress}
          k={summary?.k ?? 0}
          onCancel={runId ? cancelRun : undefined}
          cancelling={cancelling}
        />
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {summary === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* Headline metrics — one labeled card per eval */}
          <div className="flex flex-wrap gap-4">
            {summary.criteria.recall.enabled && (
              <Stat
                label={`Recall@${summary.recallK}`}
                value={pct(summary.recall)}
                big
                // The ticker sits in the label row so the headline number below
                // stays the config's real, whole-golden-set rate — the delta is
                // over the baselined subset and must not be read as part of it.
                badge={
                  summary.baseline && (
                    <MetricTicker
                      live={summary.baseline.liveRecall}
                      base={summary.baseline.recall}
                      unit="pp"
                      questions={summary.baseline.questions}
                      what="recall"
                    />
                  )
                }
                sub={
                  summary.criteria.recall.minRate != null
                    ? `min ${pct(summary.criteria.recall.minRate)}`
                    : undefined
                }
              />
            )}
            {summary.criteria.mrr.enabled && (
              <Tooltip text={mrrFractionsTitle(summary.mrrK)}>
                <Stat
                  label={`MRR@${summary.mrrK}`}
                  value={fmtScore(summary.mrr)}
                  big
                  badge={
                    summary.baseline && (
                      <MetricTicker
                        live={summary.baseline.liveMrr}
                        base={summary.baseline.mrr}
                        unit="score"
                        questions={summary.baseline.questions}
                        what="MRR"
                      />
                    )
                  }
                  sub={
                    summary.criteria.mrr.minRate != null
                      ? `min ${summary.criteria.mrr.minRate.toFixed(2)}`
                      : undefined
                  }
                />
              </Tooltip>
            )}
            {summary.criteria.ndcg.enabled && (
              <Stat
                label={`nDCG@${summary.ndcgK}`}
                value={fmtScore(summary.ndcg)}
                big
                badge={
                  <>
                    <NdcgStaleBadge summary={summary} />
                    {summary.baseline && (
                      <MetricTicker
                        live={summary.baseline.liveNdcg}
                        base={summary.baseline.ndcg}
                        unit="score"
                        questions={summary.baseline.questions}
                        what="nDCG"
                      />
                    )}
                  </>
                }
                sub={
                  `${summary.ndcgCovered}/${summary.total} graded` +
                  (summary.criteria.ndcg.minRate != null
                    ? ` · min ${summary.criteria.ndcg.minRate.toFixed(2)}`
                    : "")
                }
              />
            )}
            <Stat label="Questions" value={String(summary.total)} />
            <Stat label="Scored" value={String(summary.scored)} />
            <Stat label="Hits" value={String(summary.hits)} />
          </div>

          {/* Disappears the moment any question exists, added by hand or
              generated. The two cases read differently: with chunks below, the
              page is working and just has nothing scored yet; with none, there
              is genuinely nothing ingested under this config. */}
          {summary.total === 0 && (
            <p className="text-sm text-zinc-500">
              {summary.chunkCount > 0
                ? "No eval questions yet — your chunks are listed below. Add one by hand on any chunk, or pick a difficulty in Bulk actions → Add to generate them."
                : "Nothing ingested under this config yet. Add a document, and its chunks will appear here."}
            </p>
          )}

          {/* Per-document breakdown */}
          {summary.perDocument.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                By document
              </h2>
              <ul className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {summary.perDocument.map((d) => (
                  <li
                    key={d.documentId}
                    className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                  >
                    <span className="truncate font-mono">{d.fileName}</span>
                    <span className="shrink-0 text-xs text-zinc-500">
                      {d.hits}/{d.scored} ·{" "}
                      {pct(d.scored > 0 ? d.hits / d.scored : null)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Run history — collapsible; grows over time so it folds away by default. */}
          {summary.runs.length > 0 && (
            <section className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setRunsOpen((o) => !o)}
                className="flex cursor-pointer items-center gap-2 self-start text-sm font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                <span className="text-zinc-400">{runsOpen ? "▾" : "▸"}</span>
                Runs
                <span className="text-xs font-normal normal-case tracking-normal text-zinc-400">
                  ({summary.runs.length})
                </span>
              </button>
              {runsOpen && (
                <ul className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                  {summary.runs.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                    >
                      <span className="text-zinc-500">
                        {new Date(r.createdAt).toLocaleString()}
                      </span>
                      <span className="shrink-0 font-medium">
                        {pct(
                          r.questionCount > 0
                            ? r.hitCount / r.questionCount
                            : null,
                        )}
                        <span className="ml-2 text-xs font-normal text-zinc-500">
                          MRR {fmtScore(r.mrr)} · nDCG {fmtScore(r.ndcg)} · (
                          {r.hitCount}/{r.questionCount} @ k=
                          {r.k})
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* One card per chunk under the config, carrying whatever questions are
              labeled to it. Keyed off `groups` rather than `summary.questions`
              because a chunk with no questions still gets a card. */}
          {groups.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Chunks
                <span className="ml-2 text-xs font-normal normal-case tracking-normal text-zinc-400">
                  ({summary.chunkCount})
                </span>
              </h2>
              <div className="flex flex-col gap-3">
                {groups.map((group) => (
                  <ChunkGroupCard
                    key={group.chunkId}
                    group={group}
                    summary={summary}
                    busy={busy}
                    // Each "which row is open" prop is narrowed to this group, so
                    // opening a row in one card leaves the other 79 cards' props
                    // referentially equal and memo skips re-rendering them.
                    editingId={idInGroup(group, editingId)}
                    expandedId={idInGroup(group, expandedId)}
                    explain={
                      idInGroup(group, expandedId) === null
                        ? undefined
                        : explains[expandedId as string]
                    }
                    rankingOpenId={idInGroup(group, rankingOpenId)}
                    addOpen={addingChunkId === group.chunkId}
                    genDifficulty={
                      addingChunkId === group.chunkId ? genDifficulty : null
                    }
                    trials={trialsByChunk?.[group.chunkId] ?? NO_TRIALS}
                    trialsLoading={trialsLoading}
                    onTrialRemoved={onTrialRemoved}
                    onTrialSaved={onTrialSaved}
                    onStartEdit={startEdit}
                    onCancelEdit={cancelEdit}
                    onSaveEdit={saveEdit}
                    onRemove={remove}
                    onToggleIgnore={toggleIgnore}
                    onToggleExpand={toggleExpand}
                    onToggleRanking={toggleRanking}
                    onCloseRanking={closeRanking}
                    onRankingChange={refreshSummary}
                    onOpenAdd={openAdd}
                    onCloseAdd={closeAdd}
                    onAddQuestion={addQuestion}
                    onGenerate={generateQuestion}
                    onDelegateChange={reload}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// One chunk group: its header stats, its question rows, the saved-trials section
// and the add-question form. Memoized, and given only the open-state that names
// one of its own questions (see idInGroup) — so editing or expanding a row in one
// group re-renders that group alone, not all 80 of them.
const ChunkGroupCard = memo(function ChunkGroupCard({
  group,
  summary,
  busy,
  editingId,
  expandedId,
  explain,
  rankingOpenId,
  addOpen,
  genDifficulty,
  trials,
  trialsLoading,
  onTrialRemoved,
  onTrialSaved,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRemove,
  onToggleIgnore,
  onToggleExpand,
  onToggleRanking,
  onCloseRanking,
  onRankingChange,
  onOpenAdd,
  onCloseAdd,
  onAddQuestion,
  onGenerate,
  onDelegateChange,
}: {
  group: ChunkGroup;
  summary: EvalSummary;
  busy: boolean;
  editingId: string | null;
  expandedId: string | null;
  explain: ExplainState | undefined;
  rankingOpenId: string | null;
  addOpen: boolean;
  genDifficulty: Difficulty | null;
  trials: SavedModelTrial[];
  trialsLoading: boolean;
  onTrialRemoved: (chunkId: string, trialId: string) => void;
  onTrialSaved: (chunkId: string, trial: SavedModelTrial) => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, draft: string) => void;
  onRemove: (id: string, uncache: boolean) => void;
  onToggleIgnore: (q: QuestionDetail) => void;
  onToggleExpand: (id: string) => void;
  onToggleRanking: (id: string) => void;
  onCloseRanking: () => void;
  onRankingChange: () => void;
  onOpenAdd: (chunkId: string) => void;
  onCloseAdd: () => void;
  onAddQuestion: (chunkId: string, draft: string) => void;
  onGenerate: (chunkId: string, difficulty: Difficulty) => void;
  onDelegateChange: () => void;
}) {
  // Same inclusion rule as the headline rates: retrieval-stale scores still
  // count, edit-stale ones don't.
  const scored = group.questions.filter(
    (q) => q.hit !== null && !q.editStale && !q.ignored,
  );
  const hits = scored.filter((q) => q.hit === true).length;
  // Mean retrieved rank under the chunk's CURRENT retrieval (delegate or
  // baseline); a miss counts as k+1 (just past the cutoff). Lower is better —
  // the bar a trial must beat for its green title.
  const chunkAvgRank =
    scored.length > 0
      ? scored.reduce(
          (sum, q) =>
            sum +
            (q.hit && q.foundRank !== null ? q.foundRank : summary.recallK + 1),
          0,
        ) / scored.length
      : null;
  // Mean stored sim of the ground-truth chunk across this chunk's scored
  // questions — same read as a trial's "avg sim", but for the live retrieval.
  const sims = scored
    .map((q) => q.storedSim)
    .filter((s): s is number => s !== null);
  const avgSim =
    sims.length > 0 ? sims.reduce((sum, s) => sum + s, 0) / sims.length : null;
  const override = summary.overrides.find((o) => o.chunkId === group.chunkId);
  // "chunk #N" opens the chunk's text. Fetched on first open rather than carried
  // in the summary — one chunk's text is small, a whole corpus of it is not — and
  // kept once loaded so re-opening is instant. Local to the card so opening one
  // leaves the other cards' props untouched and memo skips them.
  const [peekOpen, setPeekOpen] = useState(false);
  const [peekText, setPeekText] = useState<string | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const togglePeek = useCallback(() => {
    setPeekOpen((open) => {
      if (!open && peekText === null && peekError === null) {
        apiFetch(`/api/eval/chunks/${group.chunkId}`)
          .then(async (res) => {
            const data = (await res.json()) as
              | { text: string }
              | { error: string };
            if (!res.ok || "error" in data) {
              setPeekError(
                "error" in data
                  ? data.error
                  : `Request failed (${res.status}).`,
              );
              return;
            }
            setPeekText(data.text);
          })
          .catch((err: unknown) =>
            setPeekError(
              err instanceof Error ? err.message : "Failed to load chunk.",
            ),
          );
      }
      return !open;
    });
  }, [group.chunkId, peekText, peekError]);
  // A model-kind override = this chunk's DELEGATE model: retrieval ranks it
  // there instead of the config's base model.
  const delegateModel =
    override && override.kind !== "size" ? override.model : null;

  return (
    // content-visibility lets the browser skip style, layout and paint for the
    // cards scrolled out of view — with a few hundred chunks that is nearly all
    // of them — while keeping one continuous list and find-in-page (the browser
    // reveals a skipped card when the search lands in it). `auto` on the
    // intrinsic size means the placeholder height below is only used until a
    // card has been on screen once; after that its real height is remembered.
    <div className="overflow-hidden rounded-lg border border-zinc-200 [contain-intrinsic-size:auto_320px] [content-visibility:auto] dark:border-zinc-800">
      {/* Which chunk these questions belong to */}
      <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
          {override && <OverrideBadge info={override} />}
          {/* Only "chunk #N" is the control; the file name stays plain text, so
              what lights up on hover is exactly what clicking acts on. Dotted
              underline is the standing affordance for an inline toggle here (see
              "top-k" / "nDCG" on the question rows). */}
          <span className="truncate">
            {group.fileName} ·{" "}
            <button
              type="button"
              onClick={togglePeek}
              title={peekOpen ? "Hide the chunk text" : "Show the chunk text"}
              className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              chunk #{group.position ?? "?"}
            </button>
          </span>
          {delegateModel && (
            <span
              title="Delegate model: this chunk is embedded and ranked under this model (not the config's base model). Its questions count toward config metrics under it after a re-score."
              className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
            >
              {delegateModel}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-zinc-500">
          {scored.length > 0
            ? `${hits}/${scored.length} hit${scored.length === 1 ? "" : "s"}`
            : "unscored"}
          {avgSim !== null && (
            <span className="text-zinc-400">
              {" "}
              · avg sim {avgSim.toFixed(3)}
            </span>
          )}
        </span>
      </div>

      {peekOpen && (
        <div className="border-b border-zinc-200 p-2 text-xs dark:border-zinc-800">
          {peekError !== null ? (
            <p className="text-red-600 dark:text-red-400">{peekError}</p>
          ) : peekText === null ? (
            <p className="text-zinc-500">Loading…</p>
          ) : (
            <ChunkText text={peekText} />
          )}
        </div>
      )}

      <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
        {group.questions.map((q) => (
          <QuestionRow
            key={q.questionId}
            q={q}
            criteria={summary.criteria}
            k={summary.k}
            busy={busy}
            editing={editingId === q.questionId}
            expanded={expandedId === q.questionId}
            explain={expandedId === q.questionId ? explain : undefined}
            rankingOpen={rankingOpenId === q.questionId}
            onStartEdit={onStartEdit}
            onCancelEdit={onCancelEdit}
            onSaveEdit={onSaveEdit}
            onRemove={onRemove}
            onToggleIgnore={onToggleIgnore}
            onToggleExpand={onToggleExpand}
            onToggleRanking={onToggleRanking}
            onCloseRanking={onCloseRanking}
            onRankingChange={onRankingChange}
          />
        ))}
      </ul>

      {/* Saved "Models tried" (above), add-question form, then the ephemeral
          "Try a different model" runner. */}
      <ChunkExperiments
        chunkId={group.chunkId}
        baselineModel={summary.config.baseModel}
        chunkAvgRank={chunkAvgRank}
        overrideInfo={override ?? null}
        saved={trials}
        trialsLoading={trialsLoading}
        onTrialRemoved={onTrialRemoved}
        onTrialSaved={onTrialSaved}
        onDelegateChange={onDelegateChange}
      >
        <AddQuestionForm
          chunkId={group.chunkId}
          open={addOpen}
          busy={busy}
          genDifficulty={genDifficulty}
          onOpen={onOpenAdd}
          onClose={onCloseAdd}
          onAdd={onAddQuestion}
          onGenerate={onGenerate}
        />
      </ChunkExperiments>
    </div>
  );
});

// One question row. Memoized, and it owns its own edit draft: the draft used to
// live in EvalDashboard, so every keystroke re-rendered the whole dashboard.
const QuestionRow = memo(function QuestionRow({
  q,
  criteria,
  k,
  busy,
  editing,
  expanded,
  explain,
  rankingOpen,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRemove,
  onToggleIgnore,
  onToggleExpand,
  onToggleRanking,
  onCloseRanking,
  onRankingChange,
}: {
  q: QuestionDetail;
  criteria: EvalSummary["criteria"];
  k: number;
  busy: boolean;
  editing: boolean;
  expanded: boolean;
  explain: ExplainState | undefined;
  rankingOpen: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, draft: string) => void;
  onRemove: (id: string, uncache: boolean) => void;
  onToggleIgnore: (q: QuestionDetail) => void;
  onToggleExpand: (id: string) => void;
  onToggleRanking: (id: string) => void;
  onCloseRanking: () => void;
  onRankingChange: () => void;
}) {
  const [draft, setDraft] = useState(q.question);
  // Delete confirmation, inline rather than a modal: window.confirm can't carry
  // the uncache checkbox, and an expanding row suits this dense list better than
  // new modal plumbing. Unchecked by default — uncaching throws away something
  // that was paid for.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [alsoUncache, setAlsoUncache] = useState(false);
  // Re-seed the draft from the row's current text each time editing opens, so an
  // abandoned draft never resurfaces. This is the "adjusting state when a prop
  // changes" pattern — done during render rather than in an effect, which would
  // paint the stale draft first and cost a second render.
  const [wasEditing, setWasEditing] = useState(editing);
  if (editing !== wasEditing) {
    setWasEditing(editing);
    if (editing) setDraft(q.question);
  }

  return (
    <li className="flex flex-col gap-1 px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
            autoFocus
          />
        ) : (
          <span className={q.ignored ? "flex-1 text-zinc-400" : "flex-1"}>
            {q.question}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5">
          {/* Held-out questions are ignores too, so they need their own label —
              "ignored" would read as a judgement about the question rather than
              as membership of the test set. */}
          {q.ignored && (
            <span
              title={
                q.heldOut
                  ? "Held out (test set) — excluded from the rates and from autotune, but still scored: this is where the generalization number comes from"
                  : "Ignored in rates — excluded from Recall/nDCG and autotune targeting"
              }
              className={
                q.heldOut
                  ? "rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700 dark:bg-sky-900/40 dark:text-sky-400"
                  : "rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
              }
            >
              {q.heldOut ? "holdout" : "ignored"}
            </span>
          )}
          {!q.ignored &&
            q.hit === false &&
            q.ndcg !== null &&
            q.ndcg >= HIGH_NDCG && (
              <span
                title={
                  "Possible false positive: nDCG is high but recall missed — the ground-truth chunk ranks well against its ideal but was crowded out of the top-k by other relevant chunks. Verify, then consider 'Ignore'."
                }
                className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
              >
                FP?
              </span>
            )}
          {/* Stale is its own pill so the hit/miss badge keeps its
              green/red identity. */}
          {q.stale && (
            <span
              title={
                q.editStale
                  ? "Edited since its last score — this result is for the old text and doesn't count toward the rates until re-scored"
                  : "Scored under a different override/delegate state — still counts toward the rates, re-scored next run"
              }
              className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
            >
              stale
            </span>
          )}
          <Badge hit={q.hit} rank={q.foundRank} />
          <MetricChip label="nDCG" value={q.ndcg} />
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-zinc-500">
        <span className="flex items-center gap-1.5 font-mono text-zinc-400">
          {q.source === "manual" && <span>manual</span>}
          {q.difficulty && (
            <span
              className={
                q.difficulty === "hard"
                  ? "rounded px-1 capitalize bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                  : q.difficulty === "medium"
                    ? "rounded px-1 capitalize bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                    : "rounded px-1 capitalize bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
              }
            >
              {q.difficulty}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {editing ? (
            <>
              <button
                onClick={() => onSaveEdit(q.questionId, draft)}
                disabled={busy}
                className="cursor-pointer text-zinc-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300"
              >
                Save
              </button>
              <button
                onClick={onCancelEdit}
                className="cursor-pointer hover:underline"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {/* Retrieval drill-down — only once there's a score to show */}
              {q.hit !== null && (
                <button
                  type="button"
                  onClick={() => onToggleExpand(q.questionId)}
                  title={
                    expanded
                      ? "Hide retrieval detail"
                      : "Show what retrieval returned for this question"
                  }
                  className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                >
                  top-k
                </button>
              )}
              <button
                type="button"
                onClick={() => onToggleRanking(q.questionId)}
                title={
                  rankingOpen
                    ? "Hide the nDCG ranking builder"
                    : "Build the graded ideal ranking this question's nDCG scores against"
                }
                className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                nDCG
              </button>
              {(q.ignored || failsBar(q, criteria)) && (
                <button
                  onClick={() => onToggleIgnore(q)}
                  disabled={busy}
                  title={
                    q.heldOut
                      ? "Pull this question out of the held-out test set — the next holdout draw may put it back"
                      : q.ignored
                        ? "Count this question in rates again"
                        : "Exclude this question from rates and autotune targeting (manual false-positive mode)"
                  }
                  className="cursor-pointer hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {q.ignored ? "Unignore" : "Ignore"}
                </button>
              )}
              <button
                onClick={() => onStartEdit(q.questionId)}
                className="cursor-pointer hover:underline"
              >
                Edit
              </button>
              <button
                onClick={() => {
                  setAlsoUncache(false);
                  setConfirmingDelete(true);
                }}
                disabled={busy}
                className="cursor-pointer text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400"
              >
                Delete
              </button>
            </>
          )}
        </span>
      </div>
      {confirmingDelete && (
        <div className="flex flex-col gap-1.5 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs dark:border-red-900/50 dark:bg-red-900/15">
          <span className="text-red-700 dark:text-red-300">
            Delete this question?
          </span>
          <label className="flex cursor-pointer items-start gap-1.5 text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={alsoUncache}
              onChange={(e) => setAlsoUncache(e.target.checked)}
              className="mt-0.5 cursor-pointer"
            />
            {/* The scope is wider than this config, and the copy has to say so. */}
            <span>
              Also delete from the question cache. It was generated once for this
              passage and is shared across all your configs, so removing it stops
              it returning via “Add cached” anywhere.
            </span>
          </label>
          <span className="flex items-center gap-2">
            <button
              onClick={() => {
                setConfirmingDelete(false);
                onRemove(q.questionId, alsoUncache);
              }}
              disabled={busy}
              className="cursor-pointer rounded border border-red-300 px-2 py-0.5 font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="cursor-pointer text-zinc-500 hover:underline"
            >
              Cancel
            </button>
          </span>
        </div>
      )}
      {expanded && <ExplainPanel state={explain} k={k} />}
      {rankingOpen && (
        <NdcgRankingPanel
          questionId={q.questionId}
          onChange={onRankingChange}
          onClose={onCloseRanking}
        />
      )}
    </li>
  );
});

// Add a question to a chunk — synthetic (LLM, graded) or hand-written. Owns its
// draft text and its synthetic/manual tab locally, for the same reason
// QuestionRow owns its edit draft.
function AddQuestionForm({
  chunkId,
  open,
  busy,
  genDifficulty,
  onOpen,
  onClose,
  onAdd,
  onGenerate,
}: {
  chunkId: string;
  open: boolean;
  busy: boolean;
  genDifficulty: Difficulty | null;
  onOpen: (chunkId: string) => void;
  onClose: () => void;
  onAdd: (chunkId: string, draft: string) => void;
  onGenerate: (chunkId: string, difficulty: Difficulty) => void;
}) {
  const [mode, setMode] = useState<"synthetic" | "manual">("synthetic");

  return (
    <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
      {open ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-2 text-xs">
              <ModeTab
                active={mode === "synthetic"}
                onClick={() => setMode("synthetic")}
              >
                Synthetic
              </ModeTab>
              <ModeTab
                active={mode === "manual"}
                onClick={() => setMode("manual")}
              >
                Manual
              </ModeTab>
            </div>
            <button
              onClick={onClose}
              className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              ✕
            </button>
          </div>

          {mode === "synthetic" ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-zinc-500">Generate one question at:</span>
              {(["easy", "medium", "hard"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => onGenerate(chunkId, d)}
                  disabled={busy}
                  className="cursor-pointer rounded border border-zinc-300 px-2 py-0.5 font-medium capitalize text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {genDifficulty === d ? "Generating…" : d}
                </button>
              ))}
            </div>
          ) : (
            <ManualAdd
              chunkId={chunkId}
              busy={busy}
              onAdd={onAdd}
              onClose={onClose}
            />
          )}
        </div>
      ) : (
        <button
          onClick={() => onOpen(chunkId)}
          className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
        >
          + Add a question
        </button>
      )}
    </div>
  );
}

// The manual "type a question" box. Split out so it mounts fresh each time the
// form opens — that's what keeps an abandoned draft from resurfacing, with no
// reset effect needed.
function ManualAdd({
  chunkId,
  busy,
  onAdd,
  onClose,
}: {
  chunkId: string;
  busy: boolean;
  onAdd: (chunkId: string, draft: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="flex items-center gap-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onAdd(chunkId, text);
          if (e.key === "Escape") onClose();
        }}
        placeholder="A question this chunk should answer…"
        className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
        autoFocus
      />
      <button
        onClick={() => onAdd(chunkId, text)}
        disabled={busy || !text.trim()}
        className="cursor-pointer text-xs font-medium text-zinc-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300"
      >
        Add
      </button>
    </div>
  );
}

// One hover row for the yellow-◷ tooltip, in the plan's §6.4 shape:
// "easy · recall miss #14 → hit #3", "med · MRR 0.25 → 1.00", "hard · nDCG 0.41 → 0.78".
function fmtOutcome(o: OverrideOutcome): string {
  const d = o.difficulty ?? "·";
  if (o.metric === "recall") {
    const side = (v: number | null, rank: number | null) =>
      v === null
        ? "—"
        : v >= 1
          ? `hit #${rank ?? "?"}`
          : `miss${rank ? ` #${rank}` : ""}`;
    return `${d} · recall ${side(o.beforeValue, o.beforeRank)} → ${side(o.afterValue, o.afterRank)}`;
  }
  const val = (v: number | null) => (v === null ? "—" : v.toFixed(2));
  const label = o.metric === "mrr" ? "MRR" : "nDCG";
  return `${d} · ${label} ${val(o.beforeValue)} → ${val(o.afterValue)}`;
}

// Chunk-header badges for an active per-chunk override (Phase D, §6.4): yellow
// ◷ = this chunk was re-shaped/re-modeled (hover shows the override and each
// question's before → after from the autotune run); red ❗ = its pieces don't
// cover the source chunk's full token span (part of the document dropped out of
// retrieval — guards custom-boundary overrides).
function OverrideBadge({ info }: { info: ChunkOverrideInfo }) {
  const what =
    info.kind === "model"
      ? `re-embedded under ${info.model}`
      : info.kind === "size"
        ? `re-split into ${info.pieceCount} piece(s)`
        : `re-split into ${info.pieceCount} piece(s) under ${info.model}`;
  return (
    <>
      <span className="group relative shrink-0 cursor-default">
        <span className="text-amber-500 dark:text-amber-400">◷</span>
        <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-max max-w-xs flex-col gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-left font-sans text-xs normal-case text-zinc-700 shadow-lg group-hover:flex dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <span className="font-medium">Override: {what}</span>
          {info.outcomes.length > 0 ? (
            info.outcomes.map((o, i) => (
              <span
                key={i}
                title={o.question}
                className="font-mono text-zinc-500"
              >
                {fmtOutcome(o)}
              </span>
            ))
          ) : (
            <span className="text-zinc-400">
              Applied manually (no autotune outcome recorded).
            </span>
          )}
        </span>
      </span>
      {info.hasGap && (
        <span
          title="Coverage gap: this chunk's override pieces don't span its full text — part of the document is missing from retrieval."
          className="shrink-0 text-red-600 dark:text-red-400"
        >
          ❗
        </span>
      )}
    </>
  );
}

// Bulk actions: "add question at difficulty", "re-score all", and the "change
// base model / chunk size" entries that edit THIS config in place. The scope
// dropdown at the top targets everything at the whole corpus ("All documents",
// the default) or one document — doc-scoped config changes apply as per-chunk
// overrides.
// Amber chip above the toolbar while retrieval-stale results are counting
// toward the rates (item 5): retrieval changed shape after they were scored,
// so the headline numbers are approximate until the next full run. Hover lists
// the exact override/delegate changes behind it (the 0021 change log).
function StaleBadge({
  count,
  changes,
}: {
  count: number;
  changes: { description: string; at: number }[];
}) {
  return (
    <span className="group relative inline-block self-start">
      <span className="inline-flex cursor-default items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
        <span aria-hidden>◷</span>
        {count} stale result{count === 1 ? "" : "s"} in rates
      </span>
      <span className="absolute left-0 top-full z-30 hidden pt-1 group-hover:block">
        <span className="flex w-80 flex-col gap-1.5 rounded border border-zinc-200 bg-white p-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <span className="font-medium uppercase tracking-wide text-zinc-500">
            Retrieval changed since these were scored
          </span>
          {changes.length > 0 ? (
            <span className="flex max-h-48 flex-col gap-1 overflow-auto">
              {changes.map((c, i) => (
                <span
                  key={i}
                  className="flex items-baseline justify-between gap-2 text-zinc-600 dark:text-zinc-400"
                >
                  <span>{c.description}</span>
                  <span className="shrink-0 text-zinc-400">
                    {new Date(c.at).toLocaleTimeString()}
                  </span>
                </span>
              ))}
            </span>
          ) : (
            <span className="text-zinc-500">
              An override/delegate change altered rank-fused retrieval for every
              query.
            </span>
          )}
          <span className="text-red-600 dark:text-red-400">
            Re-scoring everything takes a while — batch up several changes, then
            run Score pending once.
          </span>
        </span>
      </span>
    </span>
  );
}

function BulkActions({
  busy,
  onAddDifficulty,
  onAddCached,
  onAddNdcg,
  onAddLlmNdcg,
  onChangeConfig,
  onRescore,
  canRescore,
  canAddQuestion,
}: {
  busy: boolean;
  onAddDifficulty: (
    counts: DifficultyCounts,
    documentIds: string[] | null,
    topUp: boolean,
  ) => void;
  onAddCached: (documentIds: string[] | null) => void;
  onAddNdcg: (documentIds: string[] | null, rebuild: boolean) => void;
  onAddLlmNdcg: (documentIds: string[] | null) => void;
  onChangeConfig: (
    documentIds: string[] | null,
    documentNames: string[] | null,
  ) => void;
  onRescore: (documentIds: string[] | null) => void;
  canRescore: boolean;
  canAddQuestion: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  // "Add question": clicking a difficulty stages one more question per chunk at
  // it (badge = the count) — nothing runs until Add is clicked, so several
  // difficulties and quantities go out as ONE run.
  const [addCounts, setAddCounts] = useState<DifficultyCounts>({});
  // Off (the default) = "add N more to every chunk in scope", so a second click
  // buys N more again. On = the older fill-to-N: a chunk already holding N gets
  // nothing, which makes the run idempotent and usually much cheaper.
  const [addTopUp, setAddTopUp] = useState(false);
  // "Add nDCG rankings" section: its own collapsed block so the rebuild toggle
  // and the Run button read as deliberately as the LLM one below.
  const [ndcgOpen, setNdcgOpen] = useState(false);
  // When on, the run ALSO rebuilds already-graded (aggregate-truth) questions
  // against the current corpus and re-scores them — the exit for ideals that
  // predate later ingests. Off = the original "grade only ungraded" pass.
  const [ndcgRebuild, setNdcgRebuild] = useState(false);
  // "Add LLM nDCG rankings": its own collapsed section, so its cost warning and
  // Run button read as deliberately as the aggregate one.
  const [llmNdcgOpen, setLlmNdcgOpen] = useState(false);
  // Document scope: collapsed to an "Apply to: …" summary by default (all
  // documents). Expanding reveals a toggle list — clicking a document flips it
  // in/out of the selection and the menu STAYS open, so several can be picked.
  // Empty selection = all documents. The list is fetched on first expand.
  const [docsOpen, setDocsOpen] = useState(false);
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const [docIds, setDocIds] = useState<string[]>([]);
  const close = () => {
    setOpen(false);
    setSubOpen(false);
    setNdcgOpen(false);
    setLlmNdcgOpen(false);
    setDocsOpen(false);
    setAddCounts({});
    setAddTopUp(false);
  };

  const toggleMenu = () => setOpen((o) => !o);

  // Click = +1 question per chunk at that difficulty; shift/right-click = −1,
  // dropping the difficulty entirely at zero. Capped to match the route.
  const MAX_PER_DIFFICULTY = 10;
  const bumpDifficulty = (d: Difficulty, delta: number) =>
    setAddCounts((counts) => {
      const next = (counts[d] ?? 0) + delta;
      const updated = { ...counts };
      if (next <= 0) delete updated[d];
      else updated[d] = Math.min(next, MAX_PER_DIFFICULTY);
      return updated;
    });

  const stagedTotal = Object.values(addCounts).reduce((a, b) => a + b, 0);

  function toggleDocsSection() {
    const opening = !docsOpen;
    setDocsOpen(opening);
    if (!opening || docs !== null) return;
    apiFetch("/api/documents")
      .then((res) => res.json())
      .then((data: { documents?: IngestedDocument[] }) =>
        setDocs(data.documents ?? []),
      )
      .catch(() => setDocs([]));
  }

  const toggleDoc = (id: string) =>
    setDocIds((ids) =>
      ids.includes(id) ? ids.filter((d) => d !== id) : [...ids, id],
    );

  const scopeIds = docIds.length > 0 ? docIds : null;
  const scopeNames = scopeIds
    ? scopeIds.map(
        (id) => docs?.find((d) => d.id === id)?.fileName ?? "unknown document",
      )
    : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggleMenu}
        disabled={busy}
        title="Bulk changes across the whole corpus, or one document via the scope picker"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Bulk actions ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute left-0 top-full z-20 mt-1 w-60 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            {/* Which documents the actions below apply to — collapsed to the
                current scope by default; expand to toggle documents, none
                selected = all documents. */}
            <button
              type="button"
              onClick={toggleDocsSection}
              className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="truncate">
                Apply to:{" "}
                <span
                  className={
                    docIds.length > 0
                      ? "font-medium text-blue-700 dark:text-blue-400"
                      : undefined
                  }
                >
                  {docIds.length === 0
                    ? "All documents"
                    : `${docIds.length} document${docIds.length === 1 ? "" : "s"}`}
                </span>
              </span>
              <span className="shrink-0 text-zinc-400">
                {docsOpen ? "▾" : "▸"}
              </span>
            </button>
            {docsOpen && (
              <div className="flex flex-col gap-1 px-3 pb-1.5 text-xs text-zinc-500">
                <div className="max-h-44 overflow-auto rounded border border-zinc-200 dark:border-zinc-700">
                  {docs === null ? (
                    <span className="block animate-pulse px-2 py-1 text-zinc-400">
                      Loading documents…
                    </span>
                  ) : docs.length === 0 ? (
                    <span className="block px-2 py-1 text-zinc-400">
                      No documents ingested yet.
                    </span>
                  ) : (
                    docs.map((d) => {
                      const selected = docIds.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => toggleDoc(d.id)}
                          className={`flex w-full cursor-pointer items-center justify-between gap-2 border-l-2 px-2 py-1 text-left ${
                            selected
                              ? "border-blue-500 bg-blue-50 font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                              : "border-transparent text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                          }`}
                        >
                          <span className="truncate">{d.fileName}</span>
                          {selected && <span className="shrink-0">✓</span>}
                        </button>
                      );
                    })
                  )}
                </div>
                {docIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setDocIds([])}
                    className="cursor-pointer self-end text-zinc-400 underline hover:no-underline"
                  >
                    clear — use all documents
                  </button>
                )}
              </div>
            )}
            <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
            <button
              type="button"
              onClick={() => setSubOpen((s) => !s)}
              disabled={!canAddQuestion}
              title={
                canAddQuestion
                  ? undefined
                  : "No chunks yet — ingest a document first"
              }
              className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Add question{" "}
              <span className="flex items-center gap-1.5">
                {/* The staged total stays visible when the section is collapsed,
                    so a queued run can't be forgotten behind a ▸. */}
                {stagedTotal > 0 && !subOpen && (
                  <span className="rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold leading-4 text-white">
                    {stagedTotal}
                  </span>
                )}
                <span className="text-zinc-400">{subOpen ? "▾" : "▸"}</span>
              </span>
            </button>
            {subOpen && (
              <div className="flex flex-col gap-1.5 px-3 pb-1.5 pt-0.5 text-xs">
                {/* Click a difficulty as many times as you want questions per
                    chunk — the badge counts the clicks. Nothing generates until
                    Add, so several difficulties go out as one run. */}
                <div className="flex gap-1">
                  {(["easy", "medium", "hard"] as const).map((d) => {
                    const count = addCounts[d] ?? 0;
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={(e) => bumpDifficulty(d, e.shiftKey ? -1 : 1)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          bumpDifficulty(d, -1);
                        }}
                        title={`Click to add one more ${d} question per chunk; shift-click (or right-click) to remove one`}
                        className={`relative cursor-pointer rounded border px-2 py-0.5 text-xs font-medium capitalize ${
                          count > 0
                            ? "border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                            : "border-zinc-300 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        }`}
                      >
                        {d}
                        {count > 0 && (
                          <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-blue-600 px-1 text-[10px] font-semibold leading-4 text-white">
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <span className="text-zinc-500">
                  {stagedTotal === 0
                    ? "Click a difficulty once per question you want."
                    : `${addTopUp ? "Tops every chunk in scope up to" : "Adds to every chunk in scope"} ${(
                        ["easy", "medium", "hard"] as const
                      )
                        .filter((d) => addCounts[d])
                        .map((d) => `${addCounts[d]} ${d}`)
                        .join(" · ")}.`}
                </span>
                {/* The mode switch for the badges above. Default OFF = every
                    chunk in scope gets N more, so the run costs N × chunks and
                    clicking twice buys twice. Ticking it restores fill-to-N,
                    which skips chunks already there — cheaper, and idempotent. */}
                <label
                  className="flex cursor-pointer items-start gap-1.5 text-zinc-500"
                  title="Only add what a chunk is missing — chunks already at N get nothing. Off, every chunk in scope gets N more however many it already has."
                >
                  <input
                    type="checkbox"
                    checked={addTopUp}
                    onChange={(e) => setAddTopUp(e.target.checked)}
                    className="mt-0.5 cursor-pointer"
                  />
                  <span>
                    Top up{" "}
                    <span className="text-zinc-400">
                      (only add what a chunk is missing — chunks already at N get
                      nothing)
                    </span>
                  </span>
                </label>
                {/* The cost the badges don't show: without Top up this is a flat
                    N per chunk, so a corpus-wide Add is priced by the corpus. */}
                {stagedTotal > 0 && !addTopUp && (
                  <span className="text-amber-700 dark:text-amber-500">
                    Every chunk in scope is generated for — {stagedTotal}{" "}
                    question{stagedTotal === 1 ? "" : "s"} per chunk, including
                    chunks that already have some.
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={stagedTotal === 0}
                    onClick={() => {
                      const counts = addCounts;
                      const topUp = addTopUp;
                      close();
                      onAddDifficulty(counts, scopeIds, topUp);
                    }}
                    className="cursor-pointer rounded bg-black px-2 py-0.5 font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
                  >
                    Add
                  </button>
                  {/* The free half of Add, and deliberately NOT tied to the
                      badges: it takes every question already generated for an
                      identical chunk (any difficulty, any config, same model),
                      since a banked question costs nothing whatever difficulty it
                      is. Generates nothing — what isn't banked, Add buys. */}
                  <button
                    type="button"
                    title="Add every question already generated for identical chunks from all configs at any difficulty — skips dupe questions"
                    onClick={() => {
                      close();
                      onAddCached(scopeIds);
                    }}
                    className="cursor-pointer rounded border border-zinc-300 px-2 py-0.5 font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    Add cached
                  </button>
                  {stagedTotal > 0 && (
                    <button
                      type="button"
                      onClick={() => setAddCounts({})}
                      className="cursor-pointer text-zinc-400 underline hover:no-underline"
                    >
                      clear
                    </button>
                  )}
                </div>
                {/* Says the quiet part out loud: the badges size the PAID run
                    only, so "Add cached" staying live at zero staged questions
                    is the design, not a bug. */}
                <span className="text-zinc-500">
                  Add every question already generated for identical chunks from
                  all configs at any difficulty — skips dupe questions
                </span>
              </div>
            )}
            {/* Bulk nDCG grading: hit Run and every question in scope
                WITHOUT a ground truth gets the aggregate ranking built and
                promoted (existing truths are left alone). Nothing fires until
                the Run button is clicked. */}
            <button
              type="button"
              onClick={() => setNdcgOpen((s) => !s)}
              disabled={!canRescore}
              title={
                canRescore
                  ? "Builds + promotes the aggregate ranking for every question in scope that has no ground truth yet"
                  : "No labeled questions to grade yet"
              }
              className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Add nDCG rankings{" "}
              <span className="text-zinc-400">{ndcgOpen ? "▾" : "▸"}</span>
            </button>
            {ndcgOpen && (
              <div className="flex flex-col gap-1 px-3 pb-1.5 pt-0.5 text-xs">
                {/* Rebuild toggle: off grades only ungraded questions; on also
                    rebuilds aggregate-truth questions + re-scores them, so ideals
                    built before the latest ingests account for the chunks that
                    arrived since. Manual/LLM truths are left alone either way. */}
                <label
                  className="flex cursor-pointer items-start gap-1.5 pb-0.5 text-zinc-500"
                  title="Also refresh already-graded questions whose ground truth is the aggregate — rebuilds their ideals against the current corpus, so documents ingested since are in play, and re-scores them. Manual/LLM truths are left untouched."
                >
                  <input
                    type="checkbox"
                    checked={ndcgRebuild}
                    onChange={(e) => setNdcgRebuild(e.target.checked)}
                    className="mt-0.5 cursor-pointer"
                  />
                  <span>
                    Rebuild already-graded too{" "}
                    <span className="text-zinc-400">(re-scores them)</span>
                  </span>
                </label>
                {/* The only thing that starts the run. */}
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onAddNdcg(scopeIds, ndcgRebuild);
                  }}
                  title={
                    ndcgRebuild
                      ? "Build + promote the aggregate ranking for every ungraded question in scope, rebuild the aggregate-truth ones, and re-score both"
                      : "Build + promote the aggregate ranking for every question in scope that has no ground truth yet"
                  }
                  className="mt-0.5 cursor-pointer self-start rounded bg-black px-2 py-0.5 font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
                >
                  Run
                </button>
              </div>
            )}
            {/* Bulk LLM re-ranking: for every question in scope that already has
                an aggregate, the LLM re-orders its top-k. Spends per question, so
                the section states what it runs and what it skips, and only the
                Run button fires it. */}
            <button
              type="button"
              onClick={() => setLlmNdcgOpen((s) => !s)}
              disabled={!canRescore}
              title={
                canRescore
                  ? "Ask the LLM to re-order the aggregate's top-k for every question in scope (costs LLM calls; skips questions with no aggregate and ones already cached)"
                  : "No labeled questions to rank yet"
              }
              className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Add LLM nDCG rankings{" "}
              <span className="text-zinc-400">{llmNdcgOpen ? "▾" : "▸"}</span>
            </button>
            {llmNdcgOpen && (
              <div className="flex flex-col gap-1 px-3 pb-1.5 pt-0.5 text-xs text-zinc-500">
                <span>
                  Re-ranks the aggregate’s top-k with the LLM, as a comparison
                  candidate —{" "}
                  <span className="text-zinc-400">
                    it does not become ground truth until you set it on the
                    question.
                  </span>
                </span>
                <span className="text-amber-600 dark:text-amber-400">
                  Costs one LLM call per question. Skips questions with no
                  aggregate ranking yet, and ones whose LLM re-ranking is
                  already cached.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onAddLlmNdcg(scopeIds);
                  }}
                  title="Runs one LLM re-ranking per question in scope that has an aggregate and no cached re-ranking; everything else is skipped and reported"
                  className="mt-0.5 cursor-pointer self-start rounded bg-black px-2 py-0.5 font-medium text-white hover:opacity-90 dark:bg-zinc-50 dark:text-black"
                >
                  Run
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                close();
                onRescore(scopeIds);
              }}
              disabled={!canRescore}
              title={
                canRescore
                  ? "Re-run retrieval scoring for every labeled question in scope"
                  : "No labeled questions to re-score yet"
              }
              className="block w-full cursor-pointer px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Re-score all
            </button>
            <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
            <button
              type="button"
              onClick={() => {
                close();
                onChangeConfig(scopeIds, scopeNames);
              }}
              title={
                scopeIds
                  ? "Overrides the selected documents' chunks to another model (config unchanged)"
                  : "Changes THIS config in place — re-embeds but keeps question(s)"
              }
              className="block w-full cursor-pointer px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Change base model…
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                onChangeConfig(scopeIds, scopeNames);
              }}
              title={
                scopeIds
                  ? "Re-splits the selected documents' chunks via per-chunk overrides (config unchanged)"
                  : "Changes THIS config in place — re-embeds but keeps question(s)"
              }
              className="block w-full cursor-pointer px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Adjust chunk size / overlap…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// A plain bordered headline card. `sub` is an optional small line under the
// value — e.g. the nDCG card's "graded" coverage count. (Metric cards are no
// longer tinted; the per-question MetricChip still carries the red→green tint.)
function Stat({
  label,
  value,
  big,
  sub,
  badge,
}: {
  label: string;
  value: string;
  big?: boolean;
  sub?: string;
  // Small adornment in the label row (e.g. a staleness flag). Sits beside the
  // label so the value below stays fully visible.
  badge?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <span className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-500">
        {label}
        {badge}
      </span>
      <span className={big ? "text-2xl font-semibold" : "text-lg font-medium"}>
        {value}
      </span>
      {sub && <span className="text-xs text-zinc-400">{sub}</span>}
    </div>
  );
}

// The baseline ticker (0057): what this config's per-chunk tuning has bought on the
// corpus as it stands, against the same config with no overrides in effect.
//
// UNITS. Recall moves in percentage POINTS, not percent: 40% → 42% is +2pp, and
// "+5%" would be genuinely ambiguous. MRR and nDCG are already 0–1 scores, so they
// show raw deltas at two decimals.
//
// COLOUR IS NEVER THE ONLY SIGNAL. Red/green is exactly the pair that fails for the
// most common colour-vision deficiency, so the arrow glyph carries the direction on
// its own.
//
// Renders nothing (not a dash) when there is no baseline to compare with: a row of
// dashes would imply a measurement that was never taken.
function MetricTicker({
  live,
  base,
  unit,
  questions,
  what,
}: {
  live: number | null;
  base: number | null;
  unit: "pp" | "score";
  questions: number; // the comparable subset both sides are measured over
  what: string; // metric name, for the tooltip sentence
}) {
  if (live === null || base === null) return null;
  const delta = live - base;
  const shown =
    unit === "pp"
      ? `${Math.abs(delta * 100).toFixed(1)}pp`
      : Math.abs(delta).toFixed(2);
  // Below half a display unit the arrow would point at a change the number
  // can't show — read that as flat rather than as a rounded-away win.
  const flat = unit === "pp" ? Math.abs(delta) < 0.0005 : Math.abs(delta) < 0.005;
  const baseShown = unit === "pp" ? pct(base) : base.toFixed(2);
  return (
    <Tooltip
      align="left"
      text={
        `Baseline ${what} ${baseShown} — this config's model and chunk shape with ` +
        `no per-chunk overrides, over the same ${questions} question${
          questions === 1 ? "" : "s"
        }.\n\n` +
        "The delta is what your overrides and delegates have bought. Both sides " +
        "are measured over the questions that have a baseline, so this is not " +
        "always the whole golden set."
      }
    >
      <span
        className={`text-xs font-medium ${
          flat
            ? "text-zinc-400"
            : delta > 0
              ? "text-green-600 dark:text-green-400"
              : "text-red-600 dark:text-red-400"
        }`}
      >
        {flat ? "—" : delta > 0 ? `▲ +${shown}` : `▼ −${shown}`}
      </span>
    </Tooltip>
  );
}

// Headline-nDCG staleness flag: documents entered this config after the graded
// set's ideals were built and/or after it was scored, so retrieval now competes
// chunks the ideals never saw (0-gain) — the number can understate quality. The
// tooltip points at whichever remedy applies; renders nothing when up to date.
function NdcgStaleBadge({ summary }: { summary: EvalSummary }) {
  if (summary.ndcgStaleDocs === 0) return null;
  const n = summary.ndcgStaleDocs;
  const stuck = summary.ndcgStuckTruths;
  const parts = [
    `${n} document${n === 1 ? "" : "s"} entered this config after some of these ` +
      "rankings were graded. Those chunks were never candidates for the ideal " +
      "rankings, but retrieval now surfaces them and scores them 0 against those " +
      "ideals — so this nDCG can understate quality.",
  ];
  // Bulk rebuild is the fuller fix (it re-scores too), so prefer it whenever an
  // AGGREGATE ideal is stale; fall back to a plain re-score when only retrieval
  // predates the docs. Skip entirely when the only staleness is a stuck truth.
  if (summary.ndcgStaleRebuild) {
    parts.push(
      "Fix: Bulk actions → Add nDCG rankings → tick “Rebuild already-graded too”, " +
        "then Run. That folds the new chunks into the ideals and re-scores in " +
        "one pass.",
    );
  } else if (summary.ndcgStaleRescore) {
    parts.push(
      "Fix: Bulk actions → Re-score all, to refresh retrieval against the current corpus.",
    );
  }
  // Non-aggregate truths the rebuild can't touch — name the chunks so they can
  // be hand-fixed in the per-question panel.
  if (stuck.length > 0) {
    const shown = stuck.slice(0, 6);
    const more = stuck.length - shown.length;
    const list =
      shown.map((s) => `${s.chunk} (${s.kind})`).join(", ") +
      (more > 0 ? `, +${more} more` : "");
    parts.push(
      `${stuck.length} of these can’t be auto-fixed — their ground truth is a ` +
        "manual/LLM ranking the rebuild leaves alone. Re-open each on its row and " +
        `rebuild or re-promote: ${list}.`,
    );
  }
  return (
    <Tooltip text={parts.join("\n\n")}>
      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
        ↻ {n} new doc{n === 1 ? "" : "s"}
      </span>
    </Tooltip>
  );
}

// A per-question metric value next to the hit/miss badge, labeled so it's clear
// which eval it belongs to. null = not graded (unscored, or stale so the old
// score no longer applies) — rendered as the grey-dash placeholder.
function MetricChip({ label, value }: { label: string; value: number | null }) {
  if (value === null) {
    return (
      <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
        {label} –
      </span>
    );
  }
  return (
    <span
      style={scoreTint(value)}
      className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${tintBgClass} ${tintTextClass}`}
    >
      {label} {value.toFixed(2)}
    </span>
  );
}

function Badge({ hit, rank }: { hit: boolean | null; rank: number | null }) {
  if (hit === null) {
    return <span className="shrink-0 text-xs text-zinc-400">unscored</span>;
  }
  if (hit) {
    return (
      <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-400">
        hit{rank ? ` @${rank}` : ""}
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
      miss
    </span>
  );
}

// The "why did it miss?" drill-down: what retrieval returned in rank order, each
// chunk collapsed to its header and expandable on click. The ground-truth chunk
// is flagged green at its rank when it's in the top-k; when it's NOT (a miss, or
// unscored), it's shown up top on its own since the list won't contain it.
// Lazy-loaded, so it renders loading/error states too.
function ExplainPanel({
  state,
  k,
}: {
  state: ExplainState | undefined;
  k: number;
}) {
  // Which retrieved chunks are expanded (keyed by chunk id). Resets when the
  // panel unmounts on collapse — top-k starts collapsed each time it opens.
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (!state || state.status === "loading") {
    return <p className="mt-1 text-xs text-zinc-400">Loading chunk detail…</p>;
  }
  if (state.status === "error") {
    return (
      <p className="mt-1 text-xs text-red-600 dark:text-red-400">
        {state.message}
      </p>
    );
  }

  const { expected, between, retrieved } = state.data;
  const scored = retrieved.length > 0;
  const expectedInTopK = retrieved.some((c) => c.isExpected);
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  // Range label for the gap section, e.g. "ranks 6–22" (or "rank 6" for one).
  const gapLo = k + 1;
  const gapHi = (expected?.rank ?? k + 1) - 1;

  return (
    <div className="mt-1 flex flex-col gap-3 text-xs">
      {/* Only when the ground-truth chunk isn't in the top-k list below. */}
      {!expectedInTopK && (
        <div className="flex flex-col gap-1">
          <span className="font-medium uppercase tracking-wide text-zinc-500">
            Expected ·{" "}
            <span className="font-mono normal-case">
              {expected?.fileName ?? "?"}
            </span>{" "}
            · chunk #{expected?.position ?? "?"}
            {scored && ` · not in top ${k}`}
            {expected?.rank != null && (
              <span className="text-zinc-400"> · rank #{expected.rank}</span>
            )}
            {expected?.score != null && (
              <span className="text-zinc-400">
                {" "}
                · sim {expected.score.toFixed(3)}
              </span>
            )}
          </span>
          <ChunkText
            text={expected?.text ?? "Chunk text unavailable."}
            expected
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="font-medium uppercase tracking-wide text-zinc-500">
          Retrieved · top {k}
        </span>
        {!scored ? (
          <span className="text-zinc-400">
            Not scored yet — no retrieval recorded.
          </span>
        ) : (
          <ol className="flex flex-col gap-1">
            {retrieved.map((c) => (
              <ChunkRow
                key={c.chunkId}
                chunk={c}
                isOpen={open[c.chunkId] ?? false}
                onToggle={() => toggle(c.chunkId)}
              />
            ))}
          </ol>
        )}
      </div>

      {/* The gap: chunks ranked between the cut-off and the expected chunk (miss only) */}
      {between.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium uppercase tracking-wide text-zinc-500">
            Between ·{" "}
            {gapLo === gapHi ? `rank ${gapLo}` : `ranks ${gapLo}–${gapHi}`}
          </span>
          <ol className="flex flex-col gap-1">
            {between.map((c) => (
              <ChunkRow
                key={c.chunkId}
                chunk={c}
                isOpen={open[c.chunkId] ?? false}
                onToggle={() => toggle(c.chunkId)}
              />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded border px-2 py-1 font-medium ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
          : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

// Selection reported by the border picker: the reshaped chunk's text plus the
// stats callers need for annotations and warnings.
type BorderSelection = {
  text: string;
  tokens: number;
  gapTokens: number;
  intoNeighbors: number;
};

// The draggable-border picker for the "try a different configuration" runner's
// custom-shape variations. Stitches the labeled chunk
// + frozen neighbors into contiguous text, lets the user set the chunk's
// [start, end) token borders (numeric inputs, or by dragging the borders in the
// preview — each drag snaps to the nearest token), warns when the borders leave
// document text uncovered (a gap), and reports the selection upward. `children`
// renders in the inputs row — the caller's action button(s). Read-only.
function ChunkBorderPicker({
  questionId,
  positionHint,
  onSelection,
  children,
}: {
  questionId: string;
  positionHint: number;
  onSelection: (sel: BorderSelection | null) => void;
  children?: ReactNode;
}) {
  const [range, setRange] = useState<{ from: number; to: number }>(() => ({
    from: Math.max(0, positionHint - 2),
    to: positionHint + 2,
  }));
  const [win, setWin] = useState<ChunkWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [winError, setWinError] = useState<string | null>(null);

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);

  // Which border the user is currently dragging in the text preview, if any.
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);

  // (Re)fetch the window when the range changes. Widening shifts token indices,
  // so the selection resets to the chunk's own span on each load. Keeping the
  // prior window visible during a refetch avoids a flash back to "Loading…".
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await apiFetch(
          `/api/eval/questions/${questionId}/window?from=${range.from}&to=${range.to}`,
        );
        const data = (await res.json()) as ChunkWindow | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in data) {
          setWinError(
            "error" in data ? data.error : `Request failed (${res.status}).`,
          );
          return;
        }
        setWinError(null);
        setWin(data);
        setStart(data.testDefault.tokenStart);
        setEnd(data.testDefault.tokenEnd);
      } catch (err) {
        if (alive)
          setWinError(
            err instanceof Error ? err.message : "Failed to load window.",
          );
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [questionId, range.from, range.to]);

  // While a border is being dragged, follow the pointer: map its position to a
  // character with the caret APIs, snap to the nearest token boundary, and move
  // that border there. Listening on `window` keeps the drag alive even when the
  // pointer leaves the text box.
  useEffect(() => {
    if (!dragging || !win) return;
    const { offsets, tokenCount } = win;

    // Nearest token boundary to a char index (offsets is ascending).
    const charToToken = (charIdx: number) => {
      let lo = 0;
      let hi = tokenCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] < charIdx) lo = mid + 1;
        else hi = mid;
      }
      if (
        lo > 0 &&
        Math.abs(offsets[lo - 1] - charIdx) <= Math.abs(offsets[lo] - charIdx)
      ) {
        return lo - 1;
      }
      return lo;
    };

    // Pointer → token, via whichever caret API the browser exposes. Returns null
    // when the hit lands off the painted text (e.g. on the handle itself).
    const pointToToken = (x: number, y: number): number | null => {
      const doc = document as Document & {
        caretPositionFromPoint?: (
          x: number,
          y: number,
        ) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      let node: Node | null = null;
      let offset = 0;
      if (doc.caretPositionFromPoint) {
        const pos = doc.caretPositionFromPoint(x, y);
        if (!pos) return null;
        node = pos.offsetNode;
        offset = pos.offset;
      } else if (doc.caretRangeFromPoint) {
        const r = doc.caretRangeFromPoint(x, y);
        if (!r) return null;
        node = r.startContainer;
        offset = r.startOffset;
      } else {
        return null;
      }
      const host =
        node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : (node as Element);
      const span = host?.closest<HTMLElement>("[data-cs]");
      if (!span) return null;
      const base = Number(span.dataset.cs);
      if (Number.isNaN(base)) return null;
      return charToToken(base + offset);
    };

    const onMove = (e: PointerEvent) => {
      const tok = pointToToken(e.clientX, e.clientY);
      if (tok == null) return;
      if (dragging === "start") setStart(tok);
      else setEnd(tok);
    };
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, win]);

  // Report the current selection upward whenever it changes (or turns invalid).
  useEffect(() => {
    if (!win) {
      onSelection(null);
      return;
    }
    const { offsets, tokenCount, exclusive, text } = win;
    const s = Math.max(0, Math.min(start, tokenCount));
    const e = Math.max(0, Math.min(end, tokenCount));
    if (s >= e) {
      onSelection(null);
      return;
    }
    const exLen = Math.max(0, exclusive.tokenEnd - exclusive.tokenStart);
    const exCovered = Math.max(
      0,
      Math.min(e, exclusive.tokenEnd) - Math.max(s, exclusive.tokenStart),
    );
    const intoNeighbors =
      Math.max(0, exclusive.tokenStart - s) +
      Math.max(0, e - exclusive.tokenEnd);
    onSelection({
      text: text.slice(offsets[s], offsets[e]),
      tokens: e - s,
      gapTokens: exLen - exCovered,
      intoNeighbors,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify on selection change only
  }, [win, start, end]);

  if (loading && !win)
    return <span className="text-zinc-400">Loading window…</span>;
  if (winError)
    return <span className="text-red-600 dark:text-red-400">{winError}</span>;
  if (!win) return null;

  const { offsets, tokenCount, exclusive, text } = win;
  const clampedStart = Math.max(0, Math.min(start, tokenCount));
  const clampedEnd = Math.max(0, Math.min(end, tokenCount));
  const validSel = clampedStart < clampedEnd;
  const off = (t: number) => offsets[Math.max(0, Math.min(t, tokenCount))];

  // Gap = exclusive-zone tokens not covered by [start, end); overlap = how far the
  // selection reaches into the frozen neighbors.
  const exLen = Math.max(0, exclusive.tokenEnd - exclusive.tokenStart);
  const exCovered = Math.max(
    0,
    Math.min(clampedEnd, exclusive.tokenEnd) -
      Math.max(clampedStart, exclusive.tokenStart),
  );
  const gapTokens = exLen - exCovered;
  const intoNeighbors =
    Math.max(0, exclusive.tokenStart - clampedStart) +
    Math.max(0, clampedEnd - exclusive.tokenEnd);

  // Char offsets of the selection and the exclusive zone — the breakpoints used
  // to paint the preview and to anchor the draggable borders.
  const sStart = off(clampedStart);
  const sEnd = off(clampedEnd);
  const exStartChar = off(exclusive.tokenStart);
  const exEndChar = off(exclusive.tokenEnd);

  const selClass =
    "bg-indigo-200/70 text-zinc-900 dark:bg-indigo-500/30 dark:text-zinc-100";
  const gapClass =
    "bg-red-200/70 text-zinc-900 dark:bg-red-500/30 dark:text-zinc-100";
  const ctxClass = "text-zinc-400";

  // Paint a [from, to) char range as frozen-neighbor (ctx) or uncovered
  // exclusive-zone (gap) bands. Each span carries its absolute char start
  // (data-cs) so a drag can map a caret hit back to a token. The selected text
  // is rendered separately, between the handles, so it never appears here.
  const bands = (from: number, to: number) => {
    const cuts = Array.from(new Set([from, to, exStartChar, exEndChar]))
      .filter((c) => c >= from && c <= to)
      .sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (b <= a) continue;
      const inExclusive = a >= exStartChar && b <= exEndChar;
      out.push(
        <span key={a} data-cs={a} className={inExclusive ? gapClass : ctxClass}>
          {text.slice(a, b)}
        </span>,
      );
    }
    return out;
  };

  // A draggable border on the selected chunk. Dragging snaps to the nearest
  // token (see the drag effect above); arrow keys nudge by one token (10 with
  // Shift) for precise/keyboard adjustment.
  const handle = (side: "start" | "end") => {
    const value = side === "start" ? clampedStart : clampedEnd;
    const set = side === "start" ? setStart : setEnd;
    return (
      <span
        role="slider"
        tabIndex={0}
        aria-label={`Drag ${side} border`}
        aria-valuemin={0}
        aria-valuemax={tokenCount}
        aria-valuenow={value}
        title="Drag to resize — snaps to the nearest token"
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(side);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 1;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            set(Math.max(0, value - step));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            set(Math.min(tokenCount, value + step));
          }
        }}
        className={`relative mx-px inline-block h-[1.15em] w-1 cursor-col-resize touch-none rounded-sm bg-indigo-500 align-text-bottom after:absolute after:inset-y-0 after:-inset-x-1 after:content-[''] hover:bg-indigo-600 dark:bg-indigo-400 ${
          dragging === side ? "ring-2 ring-indigo-400" : ""
        }`}
      />
    );
  };

  const canLoadMore = win.rangeFrom > 0 || win.rangeTo < win.totalChunks - 1;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-zinc-500">
        chunk #{win.testPosition} of {win.totalChunks} · viewing window #
        {win.rangeFrom}–#{win.rangeTo} · {tokenCount} tokens. Neighbors are
        frozen; this chunk’s exclusive zone is tokens {exclusive.tokenStart}–
        {exclusive.tokenEnd}.
      </span>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-zinc-500">start (token)</span>
          <input
            type="number"
            min={0}
            max={tokenCount}
            value={start}
            onChange={(e) => setStart(Math.floor(Number(e.target.value)))}
            className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-zinc-500">end (token)</span>
          <input
            type="number"
            min={0}
            max={tokenCount}
            value={end}
            onChange={(e) => setEnd(Math.floor(Number(e.target.value)))}
            className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
        </label>
        {children}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-400">
          {validSel
            ? `${clampedEnd - clampedStart} tokens selected`
            : "start must be below end"}
        </span>
        {gapTokens > 0 && (
          <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
            ⚠ {gapTokens} token{gapTokens === 1 ? "" : "s"} uncovered
          </span>
        )}
        {intoNeighbors > 0 && (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            +{intoNeighbors} overlapping neighbors
          </span>
        )}
      </div>

      <pre
        className={`max-h-56 overflow-auto whitespace-pre-wrap rounded border border-zinc-200 bg-zinc-50 p-2 font-mono leading-relaxed dark:border-zinc-800 dark:bg-zinc-900/40 ${
          dragging ? "cursor-col-resize select-none" : ""
        }`}
      >
        {validSel ? (
          <>
            {bands(0, sStart)}
            {handle("start")}
            <span data-cs={sStart} className={selClass}>
              {text.slice(sStart, sEnd)}
            </span>
            {handle("end")}
            {bands(sEnd, text.length)}
          </>
        ) : (
          bands(0, text.length)
        )}
      </pre>

      <div className="flex items-center gap-3 text-zinc-500">
        <span>
          <span className="rounded bg-indigo-200/70 px-1 dark:bg-indigo-500/30">
            selected
          </span>{" "}
          <span className="rounded bg-red-200/70 px-1 dark:bg-red-500/30">
            gap
          </span>{" "}
          <span className="text-zinc-400">frozen neighbor</span>
        </span>
        <span className="text-zinc-400">
          Drag the indigo borders to resize (snaps to tokens).
        </span>
        {canLoadMore && (
          <button
            type="button"
            onClick={() =>
              setRange({
                from: Math.max(0, win.rangeFrom - 2),
                to: Math.min(win.totalChunks - 1, win.rangeTo + 2),
              })
            }
            className="cursor-pointer text-zinc-600 hover:underline dark:text-zinc-300"
          >
            Load more context
          </button>
        )}
      </div>
    </div>
  );
}

// One retrieved/in-between chunk: a collapsed header (rank · file · chunk # · sim,
// green when it's the ground truth) that expands to the chunk text on click.
function ChunkRow({
  chunk,
  isOpen,
  onToggle,
}: {
  chunk: ExplainChunk;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onToggle}
        className={`flex cursor-pointer items-center gap-1 text-left hover:underline ${
          chunk.isExpected
            ? "font-medium text-green-700 dark:text-green-400"
            : "text-zinc-500"
        }`}
      >
        <span className="text-zinc-400">{isOpen ? "▾" : "▸"}</span>#{chunk.rank}{" "}
        · <span className="font-mono">{chunk.fileName ?? "?"}</span> · chunk #
        {chunk.position ?? "?"}
        {chunk.score !== null && (
          <span className="text-zinc-400"> · sim {chunk.score.toFixed(3)}</span>
        )}
        {chunk.isExpected && " · ground truth ✓"}
      </button>
      {isOpen && <ChunkText text={chunk.text} expected={chunk.isExpected} />}
    </li>
  );
}

// A single chunk's text in a scrollable box. The ground-truth chunk gets a green
// tint so it stands out wherever it appears (expected header and, on a hit, in
// the retrieved list).
function ChunkText({ text, expected }: { text: string; expected?: boolean }) {
  const tint = expected
    ? "border-green-300 bg-green-50 dark:border-green-900/50 dark:bg-green-900/15"
    : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40";
  return (
    <pre
      className={`max-h-40 overflow-auto whitespace-pre-wrap rounded border p-2 font-mono leading-relaxed text-zinc-700 dark:text-zinc-300 ${tint}`}
    >
      {text}
    </pre>
  );
}

// Live run panel: a per-phase bar (Generate, then Score). During scoring it also
// shows a running hit count and Recall@k climbing as results stream in, and —
// once the run has announced its id — a Cancel button.
function RunProgress({
  progress,
  k,
  onCancel,
  cancelling,
}: {
  progress: EvalProgress;
  k: number;
  // Absent until the stream's run-started line lands (a fraction of a second),
  // so the button appears rather than sitting there doing nothing.
  onCancel?: () => void;
  cancelling: boolean;
}) {
  const fraction = progress.total > 0 ? progress.done / progress.total : 0;
  const percent = Math.round(fraction * 100);
  const scoring = progress.phase === "score";
  const ranking = progress.phase === "ranking";
  const recall =
    scoring && progress.done > 0 ? progress.hits / progress.done : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>
          {ranking
            ? "Building nDCG rankings"
            : scoring
              ? "Scoring questions"
              : "Generating questions"}{" "}
          <span className="tabular-nums">
            {progress.done}/{progress.total}
          </span>
          {scoring && recall !== null && (
            <span className="ml-2 text-zinc-400">
              · {progress.hits} hit{progress.hits === 1 ? "" : "s"} · Recall@{k}{" "}
              {(recall * 100).toFixed(0)}%
            </span>
          )}
          {ranking && progress.failed > 0 && (
            <span className="ml-2 text-red-500 dark:text-red-400">
              · {progress.failed} failed
            </span>
          )}
          {/* Bulk LLM pass only: what this run decided NOT to spend on. */}
          {ranking &&
            progress.skippedNoAggregate + progress.skippedCached > 0 && (
              <span className="ml-2 text-zinc-400">
                {progress.skippedNoAggregate > 0 &&
                  `· ${progress.skippedNoAggregate} skipped (no aggregate) `}
                {progress.skippedCached > 0 &&
                  `· ${progress.skippedCached} cached`}
              </span>
            )}
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums">{percent}%</span>
          {/* Cooperative: the run stops at its next checkpoint, so the label
              says "Cancelling…" instead of implying it already has. Whatever
              landed before that point is kept. */}
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              title={
                cancelling
                  ? "Stopping at the next question — work already done is kept"
                  : "Stop this run at the next question. Everything generated or scored so far is kept."
              }
              className="cursor-pointer rounded border border-zinc-300 px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full rounded-full bg-zinc-900 transition-all duration-300 dark:bg-zinc-100"
          style={{ width: `${Math.max(percent, 3)}%` }}
        />
      </div>
    </div>
  );
}

// Per-chunk "try a different configuration" experiment. Re-ranks this chunk's
// questions against a small candidate pool — the chunk (always in) + its
// questions' top-k + any corpus chunks you add — under a VARIATION: an alternate
// model, a re-shaped chunk (uniform re-split or dragged borders), or both
// (combination). Ephemeral by default; "Save result" persists a snapshot
// rendered under the chunk's variations lists. Each question's pool rank is
// shown against its stored full-corpus result.
type TrialState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; ctx: ModelTrialContext };

// Which knob(s) the trial turns. "combo" = model + chunk shape together.
type VariationChoice = "model" | "size" | "combo";

// Human label for a trial's shape variation, e.g. "re-split 256/25 tokens · 3
// pieces" or "custom borders · 1 piece". Model-only trials need no shape label.
function variationLabel(
  kind: TrialKind,
  chunkSize: number | null,
  chunkOverlap: number | null,
  pieceCount: number | null,
): string | undefined {
  if (kind === "model") return undefined;
  const shape =
    chunkSize != null
      ? `${chunkSize}/${chunkOverlap ?? 0} tokens`
      : "custom borders";
  const pieces =
    pieceCount != null
      ? ` · ${pieceCount} piece${pieceCount === 1 ? "" : "s"}`
      : "";
  return `re-split ${shape}${pieces}`;
}

// A selectable variation option: colored when active, with a small checkmark —
// deliberately not a checkbox.
function VariationPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-full border px-2.5 py-0.5 font-medium transition-colors ${
        active
          ? "border-indigo-400 bg-indigo-100 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
          : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      }`}
    >
      {active && <span className="mr-1">✓</span>}
      {children}
    </button>
  );
}

function ModelTrial({
  chunkId,
  onSaved,
}: {
  chunkId: string;
  onSaved: (trial: SavedModelTrial) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TrialState | null>(null);

  const [variation, setVariation] = useState<VariationChoice>("model");
  const [model, setModel] = useState("");
  // Chunk-shape knobs (size / combo): uniform re-split inputs, or the custom
  // drag-border selection from the shared picker.
  const [shapeMode, setShapeMode] = useState<"uniform" | "custom">("uniform");
  const [size, setSize] = useState(256);
  const [overlap, setOverlap] = useState(25);
  const [customSel, setCustomSel] = useState<BorderSelection | null>(null);
  // Pool chunk ids the user has ticked (the chunk itself is always included
  // server-side). Seeded with the auto pool — the questions' top-k — on load.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showCorpus, setShowCorpus] = useState(false);
  // Which document groups in "Rest of corpus" are expanded. All collapsed on
  // open — a real corpus is hundreds of undifferentiated rows otherwise.
  const [openDocs, setOpenDocs] = useState<Set<string>>(new Set());
  // Chunks whose text is already embedded under the selected trial model (0020
  // cache) — auto-added to the pool since they're free, tagged "(cached)".
  // prevCachedRef remembers the last auto-add so switching models removes the
  // old model's freebies (they'd cost real embeddings under the new one).
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const prevCachedRef = useRef<Set<string>>(new Set());

  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  // The parsed error BODY, not a string: a missing provider key needs the
  // provider to render a link to /account (see ApiErrorNotice), and trying a
  // model whose provider you have no key for is exactly what this panel invites.
  const [runError, setRunError] = useState<ApiErrorBody | null>(null);
  const [result, setResult] = useState<ModelTrialResult | null>(null);
  // Phase 5: this chunk's persisted model override for the active config (null =
  // none). Setting it re-embeds the chunk under that model so retrieval ranks it
  // there (rank-fused). Re-score to see the effect on recall.
  const [override, setOverride] = useState<string | null>(null);
  const [ovBusy, setOvBusy] = useState(false);

  // Lazy-load the trial context the first time the panel opens.
  function toggleOpen() {
    const opening = !open;
    setOpen(opening);
    if (!opening || state) return;
    setState({ status: "loading" });
    apiFetch(`/api/eval/chunks/${chunkId}/try-model`)
      .then(async (res) => {
        const data = (await res.json()) as
          | ModelTrialContext
          | { error: string };
        if (!res.ok || "error" in data) {
          throw new Error(
            "error" in data ? data.error : `Request failed (${res.status}).`,
          );
        }
        setState({ status: "ready", ctx: data });
        // The first SELECTABLE model, not the first listed: unkeyed models are
        // shown greyed out (see the select below), so seeding with models[0]
        // would open the panel pre-set to one the user can't run.
        setModel(data.models.find((m) => m.selectable)?.id ?? "");
        setSelected(new Set(data.autoPool.map((c) => c.chunkId)));
        setOverride(data.currentOverride);
      })
      .catch((err: unknown) => {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load.",
        });
      });
  }

  function toggleChunk(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const autoPoolIds = useMemo(
    () =>
      new Set(
        state?.status === "ready"
          ? state.ctx.autoPool.map((c) => c.chunkId)
          : [],
      ),
    [state],
  );

  // "Rest of corpus" grouped by document. Pure derivation — the server already
  // orders by file name then document then position, so each document's rows
  // are contiguous and a single pass preserves that order.
  const corpusGroups = useMemo<CorpusGroup[]>(() => {
    if (state?.status !== "ready") return [];
    const groups: CorpusGroup[] = [];
    let current: CorpusGroup | null = null;
    for (const c of state.ctx.restCorpus) {
      if (!current || current.documentId !== c.documentId) {
        current = { documentId: c.documentId, fileName: c.fileName, chunks: [] };
        groups.push(current);
      }
      current.chunks.push(c);
    }
    return groups;
  }, [state]);

  // The pool as it will actually run: everything ticked, plus the test chunk.
  const poolSize = selected.size + 1;
  const cachedSelected = useMemo(
    () => [...selected].filter((id) => cachedIds.has(id)).length,
    [selected, cachedIds],
  );

  const allCorpusSelected =
    corpusGroups.length > 0 &&
    corpusGroups.every((g) => g.chunks.every((c) => selected.has(c.chunkId)));

  function toggleAllCorpus() {
    const ids = corpusGroups.flatMap((g) => g.chunks.map((c) => c.chunkId));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allCorpusSelected) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  }

  function toggleDocOpen(documentId: string) {
    setOpenDocs((prev) => {
      const next = new Set(prev);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }

  // Whole-document tick: all in → clear it, otherwise select all of it.
  function toggleDocSelection(group: CorpusGroup) {
    const ids = group.chunks.map((c) => c.chunkId);
    const allIn = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allIn) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  }

  // Swap the auto-added cached set: drop the previous model's freebies (unless
  // they're regular auto-pool members the user keeps), add the new model's.
  // The test chunk is excluded — it's always in the pool regardless.
  function applyCached(ids: Set<string>) {
    const next = new Set([...ids].filter((id) => id !== chunkId));
    setSelected((prev) => {
      const merged = new Set(prev);
      for (const id of prevCachedRef.current) {
        if (!next.has(id) && !autoPoolIds.has(id)) merged.delete(id);
      }
      for (const id of next) merged.add(id);
      return merged;
    });
    prevCachedRef.current = next;
    setCachedIds(next);
  }

  // Whenever the trial model changes, pull the chunks already embedded under it
  // — including them is free, and a wider pool keeps the trial honest about the
  // live competition. Size-only variations run in base space (competitors'
  // vectors already exist), so nothing extra to add there.
  useEffect(() => {
    if (!open || state?.status !== "ready") return;
    if (variation === "size" || !model) {
      applyCached(new Set());
      return;
    }
    let alive = true;
    apiFetch(`/api/eval/cached-chunks?model=${encodeURIComponent(model)}`)
      .then((res) => res.json())
      .then((data: { chunkIds?: string[] }) => {
        if (alive) applyCached(new Set(data.chunkIds ?? []));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // applyCached/autoPoolIds are stable per `state`; model/variation drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state, model, variation]);

  // Client-side gate mirroring the server's variation validation.
  const shapeInvalid =
    variation !== "model" &&
    (shapeMode === "custom"
      ? customSel === null
      : !Number.isInteger(size) || size < 1 || overlap < 0 || overlap >= size);
  const cantRun = (variation !== "size" && !model) || shapeInvalid;

  // The flat POST body for the current variation (kind is derived server-side).
  function variationBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (variation !== "size") body.model = model;
    if (variation !== "model") {
      if (shapeMode === "custom" && customSel) body.sections = [customSel.text];
      else {
        body.size = size;
        body.overlap = overlap;
      }
    }
    return body;
  }

  async function run(save: boolean) {
    if (cantRun) return;
    if (save) setSaving(true);
    else setRunning(true);
    setRunError(null);
    try {
      const res = await apiFetch(`/api/eval/chunks/${chunkId}/try-model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...variationBody(),
          poolChunkIds: [...selected],
          save,
        }),
      });
      const data = (await res.json()) as
        | { result: ModelTrialResult; savedTrial: SavedModelTrial | null }
        | { error: string };
      if (!res.ok || "error" in data) {
        setRunError(
          "error" in data ? data : { error: `Request failed (${res.status}).` },
        );
        return;
      }
      if (data.savedTrial) {
        // Saved: the trial now lives in "Models tried" (the source of truth),
        // so close the runner instead of showing the same outcomes twice. The
        // knobs/pool keep their state for the next open.
        onSaved(data.savedTrial);
        setResult(null);
        setOpen(false);
      } else {
        setResult(data.result);
      }
    } catch (err) {
      setRunError({
        error: err instanceof Error ? err.message : "Network error.",
      });
    } finally {
      setSaving(false);
      setRunning(false);
    }
  }

  // Clear this chunk's persisted override. (Setting one from here is gone —
  // run + save a trial, then promote it via "Make delegate" in Models tried,
  // so every override comes with its recorded evidence.)
  async function clearOverride() {
    setOvBusy(true);
    setRunError(null);
    try {
      const res = await apiFetch(`/api/eval/chunks/${chunkId}/override`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setRunError(data ?? { error: `Request failed (${res.status}).` });
        return;
      }
      setOverride(null);
    } catch (err) {
      setRunError({
        error: err instanceof Error ? err.message : "Network error.",
      });
    } finally {
      setOvBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <button
          onClick={toggleOpen}
          className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
        >
          Try a different configuration
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Try a different configuration
        </span>
        <button
          onClick={toggleOpen}
          className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          ✕
        </button>
      </div>

      {(!state || state.status === "loading") && (
        <p className="mt-2 text-xs text-zinc-400">Loading…</p>
      )}
      {state?.status === "error" && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {state.message}
        </p>
      )}

      {state?.status === "ready" && (
        <div className="mt-2 flex flex-col gap-3 text-xs">
          {/* What to vary: the model, the chunk's shape, or both. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-zinc-500">Vary:</span>
            <VariationPill
              active={variation === "model"}
              onClick={() => setVariation("model")}
            >
              Model
            </VariationPill>
            <VariationPill
              active={variation === "size"}
              onClick={() => setVariation("size")}
            >
              Chunk size
            </VariationPill>
            <VariationPill
              active={variation === "combo"}
              onClick={() => setVariation("combo")}
            >
              Combination
            </VariationPill>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {variation !== "size" && (
              <>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {/* Unkeyed models are LISTED, disabled, with the reason —
                      never dropped. Same contract as the base-model, autotune
                      and LLM pickers. The `note` is a trade-off (the Cohere v3
                      input cap), not a blocker, so it shows on selectable rows
                      too. */}
                  {state.ctx.models.map((m) => (
                    <option
                      key={m.id}
                      value={m.id}
                      disabled={!m.selectable}
                      title={m.reason ?? m.note ?? undefined}
                    >
                      {m.label}
                      {m.note ? ` — ${noteHeadline(m.note)}` : ""}
                      {m.selectable ? "" : ` (${m.reason})`}
                    </option>
                  ))}
                </select>
                <span className="text-zinc-400">
                  vs baseline{" "}
                  <span className="font-mono">{state.ctx.baselineModel}</span>
                </span>
              </>
            )}
            {variation === "size" && (
              <span className="text-zinc-400">
                under baseline{" "}
                <span className="font-mono">{state.ctx.baselineModel}</span>
              </span>
            )}
            <button
              onClick={() => run(false)}
              disabled={running || saving || cantRun}
              className="rounded-md bg-black px-3 py-1 font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
            >
              {running ? "Running…" : "Run"}
            </button>
          </div>

          {/* Chunk-shape controls: uniform re-split, or drag the chunk's borders. */}
          {variation !== "model" && (
            <div className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-2 dark:border-zinc-700">
              <div className="flex gap-2">
                <ModeTab
                  active={shapeMode === "uniform"}
                  onClick={() => setShapeMode("uniform")}
                >
                  Uniform re-split
                </ModeTab>
                <ModeTab
                  active={shapeMode === "custom"}
                  onClick={() => setShapeMode("custom")}
                >
                  Drag borders
                </ModeTab>
              </div>
              {shapeMode === "uniform" ? (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-0.5">
                    <span className="text-zinc-500">size (tokens)</span>
                    <input
                      type="number"
                      min={1}
                      value={size}
                      onChange={(e) =>
                        setSize(Math.floor(Number(e.target.value)))
                      }
                      className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-zinc-500">overlap (tokens)</span>
                    <input
                      type="number"
                      min={0}
                      value={overlap}
                      onChange={(e) =>
                        setOverlap(Math.floor(Number(e.target.value)))
                      }
                      className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
                    />
                  </label>
                </div>
              ) : state.ctx.questions.length > 0 ? (
                <ChunkBorderPicker
                  questionId={state.ctx.questions[0].questionId}
                  positionHint={state.ctx.chunk.position ?? 0}
                  onSelection={setCustomSel}
                />
              ) : (
                <span className="text-zinc-400">
                  Needs at least one question on this chunk to load the border
                  editor.
                </span>
              )}
            </div>
          )}

          {override && (
            <div className="flex items-center gap-2 rounded border border-indigo-300 bg-indigo-50 px-2 py-1 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-300">
              <span>
                Chunk overridden to{" "}
                <span className="font-mono">{override}</span> for retrieval —
                re-score to see its effect.
              </span>
              <button
                onClick={clearOverride}
                disabled={ovBusy}
                className="cursor-pointer underline hover:no-underline disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          )}

          {/* Candidate pool: the chunk (always), its questions' top-k, + corpus */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="font-medium uppercase tracking-wide text-zinc-500">
                Test pool
              </span>
              {/* Pool size is what decides whether a trial is honest and what it
                  costs, so it's on screen at the point of widening it. +1 = the
                  test chunk, always included server-side (see `selected` above). */}
              <Tooltip
                text={`${poolSize} chunk${poolSize === 1 ? "" : "s"} will be re-embedded under the trial model${
                  cachedSelected > 0
                    ? `, of which ${cachedSelected} ${cachedSelected === 1 ? "is" : "are"} already embedded and cost nothing`
                    : ""
                }.`}
                align="left"
              >
                <span className="rounded-full border border-zinc-200 px-1.5 py-px text-[10px] text-zinc-400 dark:border-zinc-800">
                  {poolSize} chunk{poolSize === 1 ? "" : "s"}
                  {cachedSelected > 0 && ` · ${cachedSelected} cached`}
                </span>
              </Tooltip>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 rounded border border-green-300 bg-green-50 px-2 py-1 dark:border-green-900/50 dark:bg-green-900/15">
              <span className="font-medium text-green-700 dark:text-green-400">
                ✓ test chunk
              </span>
              <span className="font-mono text-zinc-500">
                {state.ctx.chunk.fileName} · #{state.ctx.chunk.position ?? "?"}
              </span>
              <span className="text-zinc-400">(always included)</span>
            </div>

            {cachedIds.size > 0 && (
              <span className="text-zinc-400">
                {cachedIds.size} chunk{cachedIds.size === 1 ? "" : "s"} already
                embedded under <span className="font-mono">{model}</span> joined
                the pool automatically — cached, so they cost nothing.
              </span>
            )}
            {state.ctx.autoPool.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {state.ctx.autoPool.map((c) => (
                  <PoolRow
                    key={c.chunkId}
                    label={`${c.fileName} · #${c.position ?? "?"}`}
                    preview={c.text}
                    checked={selected.has(c.chunkId)}
                    cached={cachedIds.has(c.chunkId)}
                    onToggle={() => toggleChunk(c.chunkId)}
                  />
                ))}
              </ul>
            ) : (
              <span className="text-zinc-400">
                No top-k candidates yet (questions unscored) — add corpus chunks
                below.
              </span>
            )}

            {state.ctx.restCorpus.length > 0 && (
              <div className="mt-1 flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowCorpus((v) => !v)}
                    className="cursor-pointer text-zinc-500 hover:underline"
                  >
                    {showCorpus ? "▾" : "▸"} Rest of corpus (
                    {state.ctx.restCorpus.length})
                  </button>
                  {showCorpus && (
                    // A toggle, not a one-way button: selecting 312 chunks by
                    // mis-click is otherwise unwindable.
                    <button
                      onClick={toggleAllCorpus}
                      className="cursor-pointer rounded border border-zinc-300 px-1.5 py-px text-[11px] text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      {allCorpusSelected
                        ? "Clear all"
                        : `Add all ${state.ctx.restCorpus.length}`}
                    </button>
                  )}
                </div>
                {showCorpus && (
                  <div className="flex max-h-72 flex-col gap-0.5 overflow-auto rounded border border-zinc-200 p-1 dark:border-zinc-800">
                    {corpusGroups.map((g) => (
                      <PoolDocumentGroup
                        key={g.documentId}
                        group={g}
                        selected={selected}
                        cachedIds={cachedIds}
                        open={openDocs.has(g.documentId)}
                        onToggleOpen={() => toggleDocOpen(g.documentId)}
                        onToggleDoc={() => toggleDocSelection(g)}
                        onToggleChunk={toggleChunk}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {runError && (
            <span className="text-red-600 dark:text-red-400">
              <ApiErrorNotice body={runError} fallback="Model trial failed." />
            </span>
          )}

          {result && (
            <div className="flex flex-col gap-2">
              <TrialOutcomes
                model={result.model}
                variation={variationLabel(
                  result.kind,
                  result.chunkSize,
                  result.chunkOverlap,
                  result.pieceCount,
                )}
                poolSize={result.poolSize}
                pool={result.pool}
                pieceCount={result.pieceCount}
                questions={result.questions}
              />
              <button
                onClick={() => run(true)}
                disabled={saving || running}
                className="self-start cursor-pointer rounded border border-zinc-300 px-2 py-1 font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {saving ? "Saving…" : "Save result"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-chunk experiments block, attached to the chunk: the saved "Models tried"
// list (above the add-question form), the add-question form (passed in as
// children so it keeps the dashboard's form state), then the "Try a different
// model" runner. The saved list is the source of truth — the runner reports new
// saves up via onSaved, and deletes happen here. A saved trial's model can be
// promoted to the chunk's DELEGATE (a persisted model override); when one is
// active the config's base model is listed here in yellow as "(baseline)".
function ChunkExperiments({
  chunkId,
  baselineModel,
  chunkAvgRank,
  overrideInfo,
  saved,
  trialsLoading,
  onTrialRemoved,
  onTrialSaved,
  onDelegateChange,
  children,
}: {
  chunkId: string;
  baselineModel: string;
  // Live mean retrieved rank across this chunk's questions, misses as k+1
  // (null when unscored) — what the chunk's CURRENT retrieval (delegate or
  // baseline) achieves; trial rows turn green when strictly lower (e.g. @1+@1
  // beats @1+@2).
  chunkAvgRank: number | null;
  overrideInfo: ChunkOverrideInfo | null;
  // This chunk's saved trials, owned by EvalDashboard: they arrive with every
  // other chunk's in one /api/eval/trials read, rather than a fetch per chunk.
  saved: SavedModelTrial[];
  trialsLoading: boolean;
  onTrialRemoved: (chunkId: string, trialId: string) => void;
  onTrialSaved: (chunkId: string, trial: SavedModelTrial) => void;
  onDelegateChange: () => void;
  children: ReactNode;
}) {
  const [delegating, setDelegating] = useState(false);
  const [delegateErr, setDelegateErr] = useState<string | null>(null);

  // A model-kind override = the chunk's delegate model.
  const delegateModel =
    overrideInfo && overrideInfo.kind !== "size" ? overrideInfo.model : null;

  // The override POST body a saved trial maps to; null = not persistable
  // (custom drag-border shapes have no override path yet).
  function overrideBodyFor(t: SavedModelTrial): Record<string, unknown> | null {
    if (t.kind === "model") return { model: t.trialModel };
    if (t.chunkSize == null) return null;
    const body: Record<string, unknown> = {
      size: t.chunkSize,
      overlap: t.chunkOverlap ?? 0,
    };
    if (t.kind === "size+model") body.model = t.trialModel;
    return body;
  }

  // Is this saved trial the chunk's currently-applied override?
  function isApplied(t: SavedModelTrial): boolean {
    if (!overrideInfo) return false;
    if (t.kind === "model") {
      return (
        overrideInfo.kind === "model" && overrideInfo.model === t.trialModel
      );
    }
    if (t.kind === "size") return overrideInfo.kind === "size";
    return (
      overrideInfo.kind === "size+model" && overrideInfo.model === t.trialModel
    );
  }

  async function removeSaved(id: string) {
    onTrialRemoved(chunkId, id); // optimistic
    await apiFetch(`/api/eval/chunks/${chunkId}/try-model?trialId=${id}`, {
      method: "DELETE",
    }).catch(() => {});
  }

  // Promote a saved trial to this chunk's persisted override (delegate model,
  // size, or combo), or clear it (null) back to the config's base settings.
  // The route re-scores THIS chunk's questions before responding (everything
  // else goes stale-badged); the dashboard reload picks up both.
  async function setDelegate(body: Record<string, unknown> | null) {
    setDelegating(true);
    setDelegateErr(null);
    try {
      const res = body
        ? await apiFetch(`/api/eval/chunks/${chunkId}/override`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await apiFetch(`/api/eval/chunks/${chunkId}/override`, {
            method: "DELETE",
          });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setDelegateErr(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      onDelegateChange();
    } catch (err) {
      setDelegateErr(err instanceof Error ? err.message : "Network error.");
    } finally {
      setDelegating(false);
    }
  }

  const modelTrials = saved.filter((t) => t.kind === "model");
  const sizeTrials = saved.filter((t) => t.kind === "size");
  const comboTrials = saved.filter((t) => t.kind === "size+model");

  // The saved trial the active delegate/override came from (if any) — the
  // baseline row expands with its stored (baseline-side) per-question results.
  const appliedTrial = saved.find((t) => isApplied(t)) ?? null;
  // What currently serves this chunk, as a mean retrieved rank: prefer the live
  // ranks (fresh right after the delegate-change auto-rescore); fall back to
  // the applied trial's in-pool ranks while the chunk is unscored.
  const currentAvgRank =
    chunkAvgRank ?? (appliedTrial ? avgTrialRank(appliedTrial) : null);

  // Any non-applied trial in a group that STRICTLY beats the chunk's current
  // retrieval (same bar as a row's green title) turns that group's collapsed
  // header green — worth expanding.
  const hasBetter = (trials: SavedModelTrial[]) =>
    currentAvgRank !== null &&
    trials.some((t) => {
      if (isApplied(t)) return false;
      const rank = avgTrialRank(t);
      return rank !== null && rank < currentAvgRank;
    });

  const renderRows = (trials: SavedModelTrial[]) =>
    trials.map((t) => {
      const body = overrideBodyFor(t);
      return (
        <SavedTrialRow
          key={t.id}
          trial={t}
          isApplied={isApplied(t)}
          canApply={body !== null}
          currentAvgRank={currentAvgRank}
          delegating={delegating}
          onApply={() => body && setDelegate(body)}
          onDelete={() => removeSaved(t.id)}
        />
      );
    });

  return (
    <>
      {(trialsLoading || saved.length > 0 || delegateModel) && (
        <div className="flex flex-col gap-2 border-t border-zinc-200 px-3 py-2 text-[11px] dark:border-zinc-800">
          {(trialsLoading || modelTrials.length > 0 || delegateModel) && (
            <TrialSection
              label="Models tried"
              hasBetter={hasBetter(modelTrials)}
              count={trialsLoading ? undefined : modelTrials.length}
            >
              <ul className="flex flex-col gap-1">
                {/* With a delegate active, the base model moves down here (it
                    comes from the summary, so it renders before the trials
                    fetch resolves — the loading pulse sits below it). */}
                {delegateModel && (
                  <BaselineRow
                    model={baselineModel}
                    appliedTrial={appliedTrial}
                    overrideInfo={overrideInfo}
                    delegating={delegating}
                    onRestore={() => setDelegate(null)}
                  />
                )}
                {renderRows(modelTrials)}
                {trialsLoading && (
                  <li className="animate-pulse text-zinc-400">
                    Loading models tried…
                  </li>
                )}
              </ul>
            </TrialSection>
          )}
          {sizeTrials.length > 0 && (
            <TrialSection
              label="Chunk variations"
              hasBetter={hasBetter(sizeTrials)}
              count={sizeTrials.length}
            >
              <ul className="flex flex-col gap-1">{renderRows(sizeTrials)}</ul>
            </TrialSection>
          )}
          {comboTrials.length > 0 && (
            <TrialSection
              label="Combination variations"
              hasBetter={hasBetter(comboTrials)}
              count={comboTrials.length}
            >
              <ul className="flex flex-col gap-1">{renderRows(comboTrials)}</ul>
            </TrialSection>
          )}
          {delegateErr && (
            <span className="text-red-600 dark:text-red-400">
              {delegateErr}
            </span>
          )}
        </div>
      )}
      {children}
      <ModelTrial chunkId={chunkId} onSaved={(t) => onTrialSaved(chunkId, t)} />
    </>
  );
}

// One collapsible variations subsection (Models tried / Chunk variations /
// Combination variations). Starts collapsed — the header alone carries the
// signal, turning green when a saved trial in the group beats the chunk's
// current retrieval.
function TrialSection({
  label,
  hasBetter,
  count,
  children,
}: {
  label: string;
  hasBetter: boolean;
  // Collapsed-state hint (trials in the group); omit while still loading.
  count?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          hasBetter
            ? "A saved variation ranks these questions better (lower mean retrieved rank) than the chunk's current retrieval"
            : undefined
        }
        className={`flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left font-medium uppercase tracking-wide ${
          hasBetter
            ? "bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50"
            : "bg-zinc-50 text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
        }`}
      >
        <span
          className={
            hasBetter ? "text-green-600 dark:text-green-500" : "text-zinc-400"
          }
        >
          {open ? "▾" : "▸"}
        </span>
        {label}
        {count != null && (
          <span
            className={`ml-auto rounded-full px-1.5 py-px text-[10px] ${
              hasBetter
                ? "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400"
                : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            }`}
          >
            {count}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
          {children}
        </div>
      )}
    </div>
  );
}

// One selectable pool chunk: a checkbox plus an expandable text/preview.
// One document's worth of "Rest of corpus", built client-side from the ordered
// chunk list (see corpusGroups in ModelTrial).
type CorpusGroup = {
  documentId: string;
  fileName: string;
  chunks: CorpusChunkListItem[];
};

// A collapsed document in the corpus picker: tri-state tick for the whole file,
// counts, and its chunk rows when expanded.
//
// The tick state is DERIVED from `selected` on every render rather than held
// locally — applyCached() adds and removes ids behind the user's back when the
// trial model changes, and local state would silently disagree with reality
// after a model switch.
function PoolDocumentGroup({
  group,
  selected,
  cachedIds,
  open,
  onToggleOpen,
  onToggleDoc,
  onToggleChunk,
}: {
  group: CorpusGroup;
  selected: Set<string>;
  cachedIds: Set<string>;
  open: boolean;
  onToggleOpen: () => void;
  onToggleDoc: () => void;
  onToggleChunk: (chunkId: string) => void;
}) {
  const inCount = group.chunks.filter((c) => selected.has(c.chunkId)).length;
  const allIn = inCount === group.chunks.length;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleOpen}
          className="w-3 shrink-0 cursor-pointer text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          {open ? "▾" : "▸"}
        </button>
        <input
          type="checkbox"
          checked={allIn}
          // HTML has no indeterminate attribute — it's a DOM property only.
          ref={(el) => {
            if (el) el.indeterminate = inCount > 0 && !allIn;
          }}
          onChange={onToggleDoc}
          className="cursor-pointer"
        />
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          <span className="truncate font-mono text-zinc-600 dark:text-zinc-400">
            {group.fileName}
          </span>
          <span className="shrink-0 text-zinc-400">
            ({group.chunks.length})
          </span>
          {inCount > 0 && (
            <span className="shrink-0 text-zinc-400">{inCount} selected</span>
          )}
        </button>
      </div>
      {open && (
        <ul className="flex flex-col gap-0.5 pl-6">
          {group.chunks.map((c) => (
            <PoolRow
              key={c.chunkId}
              label={`${c.fileName} · #${c.position ?? "?"}`}
              preview={c.preview}
              checked={selected.has(c.chunkId)}
              cached={cachedIds.has(c.chunkId)}
              onToggle={() => onToggleChunk(c.chunkId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PoolRow({
  label,
  preview,
  checked,
  cached,
  onToggle,
}: {
  label: string;
  preview: string;
  checked: boolean;
  // Already embedded under the selected trial model (0020 cache) — including
  // it in the pool is free, so it's auto-selected and tagged.
  cached?: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="cursor-pointer"
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex cursor-pointer items-center gap-1 text-left text-zinc-500 hover:underline"
        >
          <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
          <span className="font-mono">{label}</span>
          {cached && <span className="text-zinc-400">(cached)</span>}
        </button>
      </div>
      {open && <ChunkText text={preview} />}
    </li>
  );
}

// Mean cosine similarity of the ground-truth chunk to its questions under the
// trial model — the average of the per-question sims (newScore). A model-level
// read on how tightly this chunk embeds to its own questions, independent of
// whether it cleared the top-k. null when the trial has no questions.
function avgTrialSim(questions: TrialQuestionOutcome[]): number | null {
  if (questions.length === 0) return null;
  return questions.reduce((sum, q) => sum + q.newScore, 0) / questions.length;
}

// Mean retrieved rank of a trial's questions under the trial variation — lower
// is better; a miss counts as k+1 (just past the cutoff), matching the chunk
// card's live chunkAvgRank. Prefers the projected FUSED rank when the trial
// recorded one (a dry-run of real rank-fused retrieval, so directly comparable
// with the live rank); falls back to the optimistic in-pool rank for trials
// saved before fused ranks existed.
function avgTrialRank(trial: SavedModelTrial): number | null {
  if (trial.results.length === 0) return null;
  return (
    trial.results.reduce((sum, r) => {
      const hit = r.fusedRank != null ? (r.fusedHit ?? false) : r.newHit;
      const rank = r.fusedRank ?? r.newRank;
      return sum + (hit ? rank : trial.k + 1);
    }, 0) / trial.results.length
  );
}

// A saved trial's fused-hit rollup for its header — null unless EVERY question
// recorded a fused dry-run (older trials mix in optimistic in-pool numbers,
// which would make the count lie).
function fusedHitCount(trial: SavedModelTrial): number | null {
  if (trial.results.length === 0) return null;
  return trial.results.every((r) => r.fusedRank != null)
    ? trial.results.filter((r) => r.fusedHit).length
    : null;
}

// Per-question before→after for a trial: each question's stored full-corpus
// result next to its in-pool rank under the trial model. Shared by the live
// result and a saved trial's expansion. (The hits/avg-sim rollup lives in the
// saved-trial header and the chunk card, so it isn't repeated here.)
function TrialOutcomes({
  model,
  variation,
  poolSize,
  pool,
  pieceCount,
  questions,
}: {
  model: string;
  variation?: string; // shape annotation for size/combo trials
  poolSize: number;
  pool: PoolChunk[];
  pieceCount?: number | null;
  questions: TrialQuestionOutcome[];
}) {
  // Which question's top-k is expanded, and which chunk rows within are open.
  const [openQ, setOpenQ] = useState<Record<string, boolean>>({});
  const [openChunk, setOpenChunk] = useState<Record<string, boolean>>({});
  const byId = new Map(pool.map((c) => [c.chunkId, c]));

  return (
    // Font size is inherited: text-xs in the runner, smaller in "Models tried".
    <div className="flex flex-col gap-2">
      <span className="text-zinc-600 dark:text-zinc-400"></span>
      <ul className="flex flex-col gap-1.5">
        {questions.map((q) => {
          const top = q.topPool ?? [];
          const qOpen = openQ[q.questionId] ?? false;
          return (
            <li key={q.questionId} className="flex flex-col gap-0.5">
              <span className="text-zinc-700 dark:text-zinc-300">
                {q.question}
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-zinc-500">
                <Badge hit={q.newHit} rank={q.newRank} />
                <span className="text-zinc-400">
                  sim {q.newScore.toFixed(3)}
                </span>
                {/* The promotion forecast: the chunk's merged position under
                    REAL rank-fused retrieval with this variation applied —
                    against the base ANN's full candidate list, not just the
                    test pool. Absent on trials saved before it was recorded. */}
                {q.fusedRank != null && (
                  <span
                    title="Projected rank if applied: real rank-fused retrieval against the base model's full candidate list (plus the config's other overrides), not just the test pool."
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                      q.fusedHit
                        ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                        : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                    }`}
                  >
                    fused @{q.fusedRank}
                  </span>
                )}
                {/* Drill into the re-ranked test pool, like the question top-k.
                    Absent on trials saved before topPool was recorded. */}
                {top.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setOpenQ((o) => ({
                        ...o,
                        [q.questionId]: !o[q.questionId],
                      }))
                    }
                    className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                  >
                    top-k
                  </button>
                )}
              </span>
              {qOpen && top.length > 0 && (
                <ol className="mt-0.5 flex flex-col gap-1">
                  {top.map((h) => {
                    const meta = byId.get(h.chunkId);
                    const key = `${q.questionId}:${h.chunkId}:${h.subIndex ?? "w"}`;
                    // Size/combo trials rank the test chunk as pieces — label
                    // each with its piece index (text shown is the whole chunk).
                    const pieceTag =
                      h.subIndex != null && pieceCount != null
                        ? ` · piece ${h.subIndex + 1}/${pieceCount}`
                        : "";
                    return (
                      <ChunkRow
                        key={key}
                        chunk={{
                          chunkId: h.chunkId,
                          fileName: `${meta?.fileName ?? "?"}${pieceTag}`,
                          position: meta?.position ?? null,
                          text: meta?.text || "Chunk text unavailable.",
                          rank: h.rank,
                          score: h.score,
                          isExpected: h.isExpected,
                        }}
                        isOpen={openChunk[key] ?? false}
                        onToggle={() =>
                          setOpenChunk((o) => ({ ...o, [key]: !o[key] }))
                        }
                      />
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// One saved trial under the chunk's variations lists: a collapsed headline that
// expands to the per-question before→after, with the apply/delegate action at
// the top of the expansion and delete in the header.
function SavedTrialRow({
  trial,
  isApplied,
  canApply,
  currentAvgRank,
  delegating,
  onApply,
  onDelete,
}: {
  trial: SavedModelTrial;
  isApplied: boolean; // this trial is the chunk's active override/delegate
  canApply: boolean; // false for custom drag-border shapes (not persistable)
  // The chunk's current mean retrieved rank (delegate or baseline; misses as
  // k+1) — the bar a trial must strictly beat (LOWER) for the green title.
  // Null = nothing to compare.
  currentAvgRank: number | null;
  delegating: boolean;
  onApply: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sim = avgTrialSim(trial.results);
  const fusedHits = fusedHitCount(trial);
  // Green title: this trial ranks the chunk's questions STRICTLY better than
  // whatever currently serves the chunk — lower mean retrieved rank, so @1+@1
  // beats @1+@2, and a miss costs k+1. With fused ranks recorded this is a
  // like-for-like comparison (both sides are real fused retrieval); on older
  // trials it falls back to the optimistic in-pool rank — a nudge, not a
  // guarantee.
  const trialAvgRank = avgTrialRank(trial);
  const beatsCurrent =
    !isApplied &&
    trialAvgRank !== null &&
    currentAvgRank !== null &&
    trialAvgRank < currentAvgRank;
  const shape = variationLabel(
    trial.kind,
    trial.chunkSize,
    trial.chunkOverlap,
    trial.pieceCount,
  );
  // Headline: the model for model/combo trials, the shape for size trials.
  const headline =
    trial.kind === "size" ? (shape ?? "re-split") : trial.trialModel;
  const subLabel = trial.kind === "size+model" ? shape : undefined;
  const applyLabel =
    trial.kind === "model" ? "Make delegate" : "Apply as override";
  return (
    <li className="flex flex-col gap-1 rounded border border-zinc-200 p-2 dark:border-zinc-800">
      {/* The whole header toggles the row; only the ✕ is a separate target. */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 cursor-pointer flex-wrap items-center gap-1.5 text-left"
        >
          <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
          <span
            title={
              isApplied
                ? "This variation is the chunk's current override"
                : beatsCurrent
                  ? "Ranks these questions better (lower mean retrieved rank) than the chunk's current retrieval (delegate or baseline)"
                  : undefined
            }
            className={`font-mono font-medium ${
              isApplied
                ? "text-blue-700 dark:text-blue-400"
                : beatsCurrent
                  ? "text-green-700 dark:text-green-400"
                  : "text-zinc-700 dark:text-zinc-300"
            }`}
          >
            {headline}
          </span>
          {subLabel && <span className="text-zinc-500">{subLabel}</span>}
          {isApplied && (
            <span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
              {trial.kind === "model" ? "delegate ✓" : "applied ✓"}
            </span>
          )}
          <span className="text-zinc-500">
            {trial.hitCount}/{trial.questionCount} hit
            {trial.questionCount === 1 ? "" : "s"}
          </span>
          {fusedHits !== null && (
            <>
              <span className="text-zinc-400">·</span>
              <span
                title="Hits under the fused dry-run: real rank-fused retrieval with this variation applied — what promotion would actually score."
                className="text-zinc-500"
              >
                fused {fusedHits}/{trial.questionCount}
              </span>
            </>
          )}
          <span className="text-zinc-400">·</span>
          {/* Hover the count to see which chunks made up the test pool. */}
          <PoolTooltip pool={trial.pool}>
            <span className="text-zinc-500 underline decoration-dotted underline-offset-2">
              test pool {trial.poolSize}
            </span>
          </PoolTooltip>
          {sim !== null && (
            <>
              <span className="text-zinc-400">·</span>
              <span className="text-zinc-500">avg sim {sim.toFixed(3)}</span>
            </>
          )}
          <span className="text-zinc-400">
            {new Date(trial.createdAt).toLocaleString()}
          </span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 cursor-pointer text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
        >
          ✕
        </button>
      </div>
      {open && (
        <>
          {!isApplied && (
            <button
              type="button"
              onClick={onApply}
              disabled={delegating || !canApply}
              title={
                canApply
                  ? "Persist this variation to represent this chunk in this config — its questions re-score immediately"
                  : "Custom-border shapes can't be persisted as an override yet"
              }
              className="self-start cursor-pointer rounded border border-blue-300 px-1.5 py-0.5 font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
            >
              {delegating ? "Applying & re-scoring…" : applyLabel}
            </button>
          )}
          <TrialOutcomes
            model={trial.trialModel}
            variation={shape}
            poolSize={trial.poolSize}
            pool={trial.pool}
            pieceCount={trial.pieceCount}
            questions={trial.results}
          />
        </>
      )}
    </li>
  );
}

// Collapse the per-(question, metric) autotune outcome rows to one baseline
// hit/rank per question, so an autotune-applied delegate's baseline row can
// expand exactly like a trial-applied one. The recall row carries the honest
// hit/miss (it always wins); another metric's before side only fills in when a
// question recorded no recall outcome.
function baselineFromOutcomes(outcomes: OverrideOutcome[]): {
  questionId: string;
  question: string;
  hit: boolean | null;
  rank: number | null;
}[] {
  const byQ = new Map<
    string,
    {
      questionId: string;
      question: string;
      hit: boolean | null;
      rank: number | null;
    }
  >();
  for (const o of outcomes) {
    if (byQ.has(o.questionId) && o.metric !== "recall") continue;
    byQ.set(o.questionId, {
      questionId: o.questionId,
      question: o.question,
      hit: o.beforeValue === null ? null : o.beforeValue > 0,
      rank: o.beforeRank,
    });
  }
  return [...byQ.values()];
}

// The config's base model, listed under "Models tried" while a delegate serves
// the chunk. Expands like a trial row: the per-question BASELINE outcomes come
// from the applied trial's stored (before) results, or the autotune outcome
// rows when the delegate wasn't set from a saved trial. "Restore as delegate"
// sits at the top of the expansion, mirroring the trial rows' apply button.
function BaselineRow({
  model,
  appliedTrial,
  overrideInfo,
  delegating,
  onRestore,
}: {
  model: string;
  appliedTrial: SavedModelTrial | null;
  overrideInfo: ChunkOverrideInfo | null;
  delegating: boolean;
  onRestore: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Per-question BASELINE top-k drill-down: what pure base-model retrieval
  // returned (the newest result with the 'baseline' 0022 fingerprint), fetched
  // lazily via the explain endpoint's ?state=baseline filter.
  const [openQ, setOpenQ] = useState<Record<string, boolean>>({});
  const [openChunk, setOpenChunk] = useState<Record<string, boolean>>({});
  const [explains, setExplains] = useState<Record<string, ExplainState>>({});
  const stored = appliedTrial?.results ?? [];
  // Per-question baseline results: the applied trial's stored full-corpus
  // (before) results, or — when autotune applied the delegate with no saved
  // trial — the run's recorded per-question "before" side.
  const baselineQuestions =
    stored.length > 0
      ? stored.map((q) => ({
          questionId: q.questionId,
          question: q.question,
          hit: q.storedHit,
          rank: q.storedRank,
        }))
      : baselineFromOutcomes(overrideInfo?.outcomes ?? []);

  function toggleTopK(id: string) {
    const opening = !openQ[id];
    setOpenQ((o) => ({ ...o, [id]: opening }));
    if (!opening || explains[id]) return;
    setExplains((m) => ({ ...m, [id]: { status: "loading" } }));
    apiFetch(`/api/eval/questions/${id}/explain?state=baseline`)
      .then(async (res) => {
        const data = (await res.json()) as QuestionExplain | { error: string };
        if (!res.ok || "error" in data) {
          throw new Error(
            "error" in data ? data.error : `Request failed (${res.status}).`,
          );
        }
        setExplains((m) => ({ ...m, [id]: { status: "ready", data } }));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Failed to load.";
        setExplains((m) => ({ ...m, [id]: { status: "error", message } }));
      });
  }
  return (
    <li className="flex flex-col gap-1 rounded border border-amber-200 bg-amber-50 p-2 dark:border-amber-900/50 dark:bg-amber-900/15">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 cursor-pointer flex-wrap items-center gap-1.5 text-left"
        >
          <span className="text-amber-500 dark:text-amber-600">
            {open ? "▾" : "▸"}
          </span>
          <span className="font-mono font-medium text-amber-700 dark:text-amber-400">
            {model}
          </span>
          <span className="text-amber-600 dark:text-amber-500">(baseline)</span>
          {baselineQuestions.length > 0 && (
            <span className="text-amber-600/80 dark:text-amber-500/80">
              {baselineQuestions.filter((q) => q.hit).length}/
              {baselineQuestions.length} hit
              {baselineQuestions.length === 1 ? "" : "s"} before the delegate
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onRestore}
          disabled={delegating}
          title="Clear the delegate — rank this chunk under the base model again (its questions re-score immediately)"
          className="shrink-0 cursor-pointer text-amber-700 underline hover:no-underline disabled:opacity-50 dark:text-amber-400"
        >
          {delegating ? "Restoring & re-scoring…" : "Restore as delegate"}
        </button>
      </div>
      {open &&
        // Per-question outcomes under the BASELINE model. No baseline sim/top-k
        // was stored, so this is a slimmer list than a trial expansion.
        (baselineQuestions.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {baselineQuestions.map((q) => {
              const state = explains[q.questionId];
              return (
                <li key={q.questionId} className="flex flex-col gap-0.5">
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {q.question}
                  </span>
                  <span className="flex items-center gap-1.5 text-zinc-500">
                    <Badge hit={q.hit} rank={q.rank} />
                    <button
                      type="button"
                      onClick={() => toggleTopK(q.questionId)}
                      title="What the BASE model's retrieval returned for this question (latest baseline-state score)"
                      className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                    >
                      top-k
                    </button>
                  </span>
                  {openQ[q.questionId] && (
                    <>
                      {(!state || state.status === "loading") && (
                        <span className="animate-pulse text-zinc-400">
                          Loading baseline retrieval…
                        </span>
                      )}
                      {state?.status === "error" && (
                        <span className="text-red-600 dark:text-red-400">
                          {state.message}
                        </span>
                      )}
                      {state?.status === "ready" &&
                        (state.data.retrieved.length > 0 ? (
                          <ol className="mt-0.5 flex flex-col gap-1">
                            {state.data.retrieved.map((c) => {
                              const key = `${q.questionId}:${c.chunkId}`;
                              return (
                                <ChunkRow
                                  key={key}
                                  chunk={c}
                                  isOpen={openChunk[key] ?? false}
                                  onToggle={() =>
                                    setOpenChunk((o) => ({
                                      ...o,
                                      [key]: !o[key],
                                    }))
                                  }
                                />
                              );
                            })}
                          </ol>
                        ) : (
                          <span className="text-zinc-500">
                            No stored baseline retrieval for this question —
                            re-score while the baseline serves this chunk to
                            capture one.
                          </span>
                        ))}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <span className="text-zinc-500">
            No stored baseline outcomes for this chunk — the delegate
            wasn&apos;t applied from a saved trial or an autotune run.
          </span>
        ))}
    </li>
  );
}

// Hover card listing a trial's test-pool chunks (document · #position). The card
// sits below the trigger inside the same hover group — a transparent pad bridges
// the gap so the pointer can reach it — and scrolls when the pool is large.
function PoolTooltip({
  pool,
  children,
}: {
  pool: PoolChunk[];
  children: ReactNode;
}) {
  return (
    <span className="group relative inline-block">
      {children}
      <span className="absolute left-0 top-full z-20 hidden pt-1 group-hover:block">
        <span className="flex w-64 flex-col gap-0.5 rounded border border-zinc-200 bg-white p-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <span className="mb-0.5 font-medium uppercase tracking-wide text-zinc-500">
            Test pool · {pool.length} chunk{pool.length === 1 ? "" : "s"}
          </span>
          <span className="flex max-h-48 flex-col gap-0.5 overflow-auto">
            {pool.map((c) => (
              <span
                key={c.chunkId}
                className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400"
              >
                <span className="truncate font-mono">{c.fileName}</span>
                <span className="shrink-0 text-zinc-400">
                  · #{c.position ?? "?"}
                </span>
              </span>
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}
