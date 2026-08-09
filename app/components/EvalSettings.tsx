// ---------------------------------------------------------------------------
// UI: the config Settings dropdown (Client Component), mounted on the RIGHT of
// the Nav (see Nav.tsx) so it's reachable from every config view, not just
// /eval. Extracted from EvalDashboard.
//
// Sections: LLM (the config's answer-generation model, §9.2 — first because
// every metric below is measured on answers it produced), eval METRICS
// (per-metric enable + k + optional min-rate, A1), AUTOTUNING (A5; consumed by
// the autotune engine), CORPUS (the auto-sync toggle — corpus ↔ config
// membership sync, 0017), and the greyed "Long-term savings" Phase E stub.
//
// Self-sufficient: opens by seeding from GET /api/eval/criteria (criteria +
// config summary + the model option lists), saves via PATCH /api/eval/criteria
// (+ PATCH /api/configs/[id] carrying whichever of auto-sync / llmModel
// changed), then fires EVAL_CRITERIA_CHANGED
// (the eval dashboard re-pulls its summary) and router.refresh() (the banner
// re-renders). apiFetch scopes everything to the tab in the URL.
//
// The seed is CACHED per config and revalidated behind the open panel (see "the
// seed cache" below), and warmed on hover — opening used to wait on two round
// trips every time, for a payload that rarely changes between opens.
// ---------------------------------------------------------------------------
"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SC_CHANGED } from "@/app/components/semanticCache/events";
import { Tooltip } from "@/app/components/Tooltip";
import { apiFetch, currentConfigId } from "@/lib/http/client";
import {
  DEFAULT_BATCH_SAVINGS,
  JOB_KINDS,
  JOB_LABELS,
  type BatchChoice,
  type BatchSavings,
  type JobKind,
} from "@/lib/batch/types";
import type { ConfigSummary } from "@/lib/rag/configStore";
import type { LlmModelOption, LlmProviderId } from "@/lib/llm/llmModels";
import {
  noteHeadline,
  type AutotuneModelOption,
} from "@/lib/rag/embeddingModels";
import type {
  AutotuneApply,
  AutotuneSearch,
  EvalCriteria,
} from "@/lib/rag/evalSettingsStore";
import type { AutotuneScopeDocument } from "@/lib/rag/evalStore";

// Fired (on window) after a successful save so config-scoped views (the eval
// dashboard) can re-pull data that depends on the criteria.
export const EVAL_CRITERIA_CHANGED = "eval:criteria-changed";

// Per-job wording for the "batch" option. Batching only ever applies to the
// offline/bulk entry point of a job — the interactive one-at-a-time path (a
// single chunk's question, a live query embed) always runs inline, since a
// batch that lands hours later is worse than just doing the work. Say so on the
// rows where a same-named interactive path exists to be confused with.
const BATCH_OPTION_LABELS: Partial<Record<JobKind, string>> = {
  question_generation: "Batch API (bulk actions)",
};

// Recognized everywhere (preference, status panel) but not submittable —
// lib/batch/jobs/registry.ts has no handler, so POST /api/batch/submit 501s.
//
// ndcg_ranking has nothing to batch today: "Bulk actions → Add nDCG rankings"
// builds the CROSS-MODEL AGGREGATE ground truth (embeddings only, no LLM), and
// the LLM rankings (llm_pool / llm_rerank) are per-question, launched one at a
// time from the ranking panel — interactive, so batching is the wrong fit. A
// batched LLM nDCG needs a bulk LLM-ranking flow to exist first.
//
// Shown disabled rather than hidden so the roster of jobs stays honest.
const UNIMPLEMENTED_KINDS = new Set<JobKind>(["ndcg_ranking"]);

// "" / invalid => null (the metric falls back to the config's top_k, A1).
function parseKOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Math.floor(Number(t));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// "" / invalid => null (metric runs but isn't an autotune target). Rates are
// 0..1, so a value above 1 (or with a % sign) can only mean a percentage —
// read it as one (90 → 0.9) instead of clamping it to 1. Clamped 0..1.
function parseRateOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const pct = t.endsWith("%");
  const n = Number(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return null;
  const rate = pct || n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, rate));
}

// The semantic-cache threshold field. "" => null, meaning INHERIT (the space's
// calibrated value, else the conservative default) — that's the normal state, so
// clearing the box has to be the way back rather than an error. Accepts the same
// forms as the metric minimums above (0.94, 94, 94%) since a cosine is a 0..1
// rate too. `undefined` means unparseable, which BLOCKS the save instead of
// falling back to null: silently inheriting after a typo would move the floor
// answers are served at without telling anyone.
function parseThreshold(s: string): number | null | undefined {
  const t = s.trim();
  if (t === "") return null;
  const pct = t.endsWith("%");
  const n = Number(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return undefined;
  const rate = pct || n > 1 ? n / 100 : n;
  return rate >= 0 && rate <= 1 ? rate : undefined;
}

// The calibration PRECISION TARGET is deliberately NOT a field here. It reads at
// a precision (0.99) but is not a cosine, and sitting one row under "Match
// threshold" it read as a second, stricter version of it. It now lives beside
// the slider it governs on Appraise → Semantic caching → Cache key model, where
// you can see what each precision costs before storing one. The wire field
// (semanticCache.acceptTarget) is unchanged; only where it is set moved.

// What the config falls back to with no override of its own (GET /api/batch).
type InheritedThreshold = {
  space: string;
  threshold: number;
  source: "calibrated" | "default";
};

// The CACHE-KEY model in force for this config (GET /api/batch → keyModel; see
// semanticCache.keyModelStatus). Mirrors the server type structurally rather
// than importing it — this is a client component, and the server module pulls
// in the DB client.
type KeyModelStatus = {
  keyModel: string; // resolved: the override, else the global default
  override: string | null; // this config's own, null when it inherits
  globalDefault: string;
  threshold: InheritedThreshold; // what the RESOLVED model's space serves at
  candidates: {
    id: string;
    space: string;
    dimension: number;
    provider: string;
  }[];
};

// Everything one open needs, from both requests — the unit the cache below
// stores. Held as raw payload rather than as the ~30 pieces of form state it
// seeds, so a cached open and a cold one go through the identical apply path.
type Seed = {
  criteria: EvalCriteria;
  config: ConfigSummary;
  scopeOptions: AutotuneScopeDocument[];
  autotuneModels: AutotuneModelOption[];
  aggregateModels: AutotuneModelOption[];
  llmModels: LlmModelOption[];
  // GET /api/batch is non-fatal (the Savings section still renders without it),
  // so it is nullable and the panel keeps its defaults when it fails.
  batch: {
    savings: BatchSavings;
    emailConfigured: boolean;
    inFlight: number;
    cascadeEnabled: boolean;
    inheritedThreshold: InheritedThreshold | null;
    keyModel: KeyModelStatus | null;
  } | null;
};

export function EvalSettings() {
  const router = useRouter();
  // Only used to re-run the mount warm below when the tab changes; every read of
  // the id that matters goes through currentConfigId() so it can't disagree with
  // what apiFetch scopes the request to.
  const { configId } = useParams<{ configId: string }>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<ConfigSummary | null>(null);
  const [recallOn, setRecallOn] = useState(true);
  const [recallK, setRecallK] = useState("");
  const [recallMin, setRecallMin] = useState("");
  const [mrrOn, setMrrOn] = useState(true);
  const [mrrK, setMrrK] = useState("");
  const [mrrMin, setMrrMin] = useState("");
  const [ndcgOn, setNdcgOn] = useState(true);
  const [ndcgK, setNdcgK] = useState("");
  const [ndcgMin, setNdcgMin] = useState("");
  const [ladder, setLadder] = useState("");
  const [overlap, setOverlap] = useState("");
  const [apply, setApply] = useState<AutotuneApply>("choose");
  const [search, setSearch] = useState<AutotuneSearch>("first_success");
  const [stopEarly, setStopEarly] = useState(false);
  const [keepBest, setKeepBest] = useState(false);
  // Fusion pools (0027): "" = unset (autotune follows live; live uses auto).
  const [autotunePool, setAutotunePool] = useState("");
  const [retrievalPool, setRetrievalPool] = useState("");
  // Autotune chunk scope (0025): null = all chunks; a Set = the custom picks.
  const [scopeDocs, setScopeDocs] = useState<AutotuneScopeDocument[]>([]);
  const [scopeSel, setScopeSel] = useState<Set<string> | null>(null);
  const [scopeExpanded, setScopeExpanded] = useState<Set<string>>(new Set());
  // Autotune model scope (0030): the alternate models a run could try (keyed
  // ones plus unkeyed ones shown greyed out), and which are allowed. null = all
  // the keyed ones (also covers models keyed later). The checklist is long
  // enough to bury the sections below it, so it lives behind a disclosure that
  // starts collapsed and pops open when a bulk action changes it.
  // --- LLM picker (§9.2) ---
  // `llmModel` is the config's answer-generation model; `savedLlmModel` is what
  // the server last confirmed, so save can PATCH only on a real change (the same
  // pattern corpusSync uses below).
  //
  // `llmProvider` is UI-ONLY and never persisted — it filters the model select.
  // Provider is derived from the model id server-side (llmProviderOf), so
  // storing it would be a second source of truth for a fact the id already
  // carries, and the two could disagree.
  const [llmOpts, setLlmOpts] = useState<LlmModelOption[]>([]);
  const [llmModel, setLlmModel] = useState<string>("");
  const [savedLlmModel, setSavedLlmModel] = useState<string>("");
  const [llmProvider, setLlmProvider] = useState<LlmProviderId>("anthropic");

  const [modelOpts, setModelOpts] = useState<AutotuneModelOption[]>([]);
  // nDCG "Models in aggregate" (0045): which models build the ideal ranking.
  // null = the default set, same null-means-default contract as modelScope.
  const [aggOpts, setAggOpts] = useState<AutotuneModelOption[]>([]);
  const [aggSel, setAggSel] = useState<Set<string> | null>(null);
  const [aggOpen, setAggOpen] = useState(false);
  const [modelSel, setModelSel] = useState<Set<string> | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [sync, setSync] = useState(false);
  const [savedSync, setSavedSync] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Savings (Phase E1 — batch API): one preference object round-tripped via
  // /api/batch, plus whether real email is wired and how many batches are in
  // flight for THIS config (the overwrite warning).
  const [savings, setSavings] = useState<BatchSavings>(DEFAULT_BATCH_SAVINGS);
  const [emailReady, setEmailReady] = useState(false);
  const [inFlightCount, setInFlightCount] = useState(0);
  // Cache threshold override, held as TEXT (like the metric minimums) so an
  // in-progress "0." isn't rounded out from under the cursor; parsed on save.
  // Empty = no override. `inherited` is what that empty box resolves to.
  const [threshold, setThreshold] = useState("");
  const [inherited, setInherited] = useState<InheritedThreshold | null>(null);
  // Cache-KEY model: the status the server resolved, plus the picker's value
  // ("" = inherit the global default). Held separately from `savings` because
  // the two are read back together after a save — a key-model change moves
  // which SPACE's threshold applies, so `inherited` is stale until the server
  // re-resolves it.
  const [keyModelInfo, setKeyModelInfo] = useState<KeyModelStatus | null>(null);
  const [keyModel, setKeyModel] = useState("");
  // Set when the server REFUSED a switch into an uncalibrated space (409). The
  // switch is offered again explicitly rather than being retried silently — the
  // whole point of the refusal is that the user sees the fallback first.
  const [keyModelBlock, setKeyModelBlock] = useState<{
    space: string;
    fallbackThreshold: number;
  } | null>(null);
  // Which action produced the 409 above, so "Switch anyway" retries the RIGHT
  // one — the full form Save (other fields pending too) or the standalone
  // apply-and-re-key button (key model only).
  const [keyModelBlockedBy, setKeyModelBlockedBy] = useState<
    "save" | "apply" | null
  >(null);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);
  // The combined apply-and-re-key action, in its two phases, so the button can
  // say which one it's doing rather than a single generic "Working…".
  const [keyModelPhase, setKeyModelPhase] = useState<
    null | "saving" | "rekeying"
  >(null);
  // Saver mode (0032): the FrugalGPT cascade on/off for this config (its own
  // column, configs.cascade_enabled — separate from the BatchSavings blob).
  const [cascadeEnabled, setCascadeEnabled] = useState(false);
  const setJob = (kind: JobKind, v: BatchChoice) =>
    setSavings((s) => ({ ...s, jobs: { ...s.jobs, [kind]: v } }));

  // --- the seed cache (open latency) -------------------------------------
  //
  // Opening used to be "two round trips, THEN the panel appears", every time.
  // The re-seed itself is not optional — an override applied from the
  // collision-floor panel on Appraise has to show up here — so the fix is
  // stale-while-revalidate rather than a plain memo: a cached open paints
  // immediately from the last payload and reconciles behind it.
  //
  // Keyed by configId because every field in a Seed is config-scoped (apiFetch
  // scopes both requests to the tab in the URL), so switching tabs must not show
  // the previous config's numbers.
  const seedCache = useRef(new Map<string, Seed>());
  // A reconcile must never overwrite something the user has started editing.
  // One capture-phase handler on the panel (below) sets this for every input in
  // it — cheaper and harder to forget than dirty-tracking ~30 setters.
  const touched = useRef(false);
  // `open` for the async reconcile, which must not close over a stale render.
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // A save here, or a threshold/key-model change made on Appraise (SC_CHANGED),
  // moves what an open would show — so the cache is dropped rather than
  // reconciled: the next open should not paint a value we already know is gone.
  useEffect(() => {
    const invalidate = () => seedCache.current.clear();
    window.addEventListener(EVAL_CRITERIA_CHANGED, invalidate);
    window.addEventListener(SC_CHANGED, invalidate);
    return () => {
      window.removeEventListener(EVAL_CRITERIA_CHANGED, invalidate);
      window.removeEventListener(SC_CHANGED, invalidate);
    };
  }, []);

  // Both requests, as one payload. The criteria call is fatal (there is no panel
  // without it); the batch call is not.
  const fetchSeed = useCallback(async (): Promise<{
    seed?: Seed;
    error?: string;
  }> => {
    // Both requests fired together, not one after the other — /api/batch has
    // nothing the criteria call depends on, and awaiting them in sequence was
    // paying for two round trips back to back every time Settings opened.
    // `jobs=0`: the account-wide job ledger is the expensive half of that
    // payload and nothing here reads it — the panel that does (BatchRequestsPanel)
    // asks for it separately.
    const [res, bres] = await Promise.all([
      apiFetch("/api/eval/criteria"),
      apiFetch("/api/batch?jobs=0").catch(() => null),
    ]);
    const data = (await res.json().catch(() => null)) as {
      criteria?: EvalCriteria;
      config?: ConfigSummary;
      scopeOptions?: AutotuneScopeDocument[];
      autotuneModels?: AutotuneModelOption[];
      aggregateModels?: AutotuneModelOption[];
      llmModels?: LlmModelOption[];
      error?: string;
    } | null;
    if (!res.ok || !data?.criteria || !data.config) {
      return {
        error: data?.error ?? `Failed to load settings (${res.status}).`,
      };
    }

    let batch: Seed["batch"] = null;
    try {
      const bdata = bres
        ? ((await bres.json().catch(() => null)) as {
            savings?: BatchSavings;
            emailConfigured?: boolean;
            inFlight?: unknown[];
            cascadeEnabled?: boolean;
            inheritedThreshold?: InheritedThreshold;
            keyModel?: KeyModelStatus;
          } | null)
        : null;
      if (bres?.ok && bdata?.savings) {
        batch = {
          savings: bdata.savings,
          emailConfigured: Boolean(bdata.emailConfigured),
          inFlight: bdata.inFlight?.length ?? 0,
          cascadeEnabled: Boolean(bdata.cascadeEnabled),
          inheritedThreshold: bdata.inheritedThreshold ?? null,
          keyModel: bdata.keyModel ?? null,
        };
      }
    } catch {
      /* leave null — the Savings section still renders */
    }

    return {
      seed: {
        criteria: data.criteria,
        config: data.config,
        scopeOptions: data.scopeOptions ?? [],
        autotuneModels: data.autotuneModels ?? [],
        aggregateModels: data.aggregateModels ?? [],
        llmModels: data.llmModels ?? [],
        batch,
      },
    };
  }, []);

  // Payload → form state. Pure application, no IO, so the cached and cold paths
  // cannot drift apart.
  const applySeed = useCallback((data: Seed) => {
    const c = data.criteria;
    setConfig(data.config);
    setRecallOn(c.recall.enabled);
    setRecallK(c.recall.k != null ? String(c.recall.k) : "");
    setRecallMin(c.recall.minRate != null ? String(c.recall.minRate) : "");
    setMrrOn(c.mrr.enabled);
    setMrrK(c.mrr.k != null ? String(c.mrr.k) : "");
    setMrrMin(c.mrr.minRate != null ? String(c.mrr.minRate) : "");
    setNdcgOn(c.ndcg.enabled);
    setNdcgK(c.ndcg.k != null ? String(c.ndcg.k) : "");
    setNdcgMin(c.ndcg.minRate != null ? String(c.ndcg.minRate) : "");
    setLadder(c.autotune.sizeLadder.join(", "));
    setOverlap(String(Math.round(c.autotune.overlapPct * 100)));
    setApply(c.autotune.apply);
    setSearch(c.autotune.search);
    setStopEarly(c.autotune.stopEarly);
    setKeepBest(c.autotune.keepBest);
    setAutotunePool(
      c.autotune.fusionPool != null ? String(c.autotune.fusionPool) : "",
    );
    setRetrievalPool(
      c.retrieval.fusionPool != null ? String(c.retrieval.fusionPool) : "",
    );
    setScopeDocs(data.scopeOptions);
    setScopeSel(
      c.autotune.chunkScope === null ? null : new Set(c.autotune.chunkScope),
    );
    setScopeExpanded(new Set());
    // Seed the LLM picker from the config's saved model, and default the
    // provider FILTER to that model's own provider — otherwise opening
    // Settings on a GPT config would show the Anthropic list with the current
    // selection nowhere in it.
    const llmOptions = data.llmModels;
    setLlmOpts(llmOptions);
    setLlmModel(data.config.llmModel);
    setSavedLlmModel(data.config.llmModel);
    setLlmProvider(
      llmOptions.find((m) => m.id === data.config.llmModel)?.provider ??
        "anthropic",
    );

    setModelOpts(data.autotuneModels);
    setAggOpts(data.aggregateModels);
    setAggSel(
      c.ndcg.aggregateModels === null ? null : new Set(c.ndcg.aggregateModels),
    );
    setModelSel(
      c.autotune.modelScope === null ? null : new Set(c.autotune.modelScope),
    );
    setModelsOpen(false);
    setSync(data.config.corpusSync);
    setSavedSync(data.config.corpusSync);
    // Savings preference + email/in-flight state (its own store; non-fatal —
    // null leaves the section on its defaults).
    const b = data.batch;
    if (b) {
      setSavings(b.savings);
      setEmailReady(b.emailConfigured);
      setInFlightCount(b.inFlight);
      setCascadeEnabled(b.cascadeEnabled);
      setInherited(b.inheritedThreshold);
      setKeyModelInfo(b.keyModel);
      setKeyModel(b.savings.semanticCache.keyModel ?? "");
      setKeyModelBlock(null);
      setKeyModelBlockedBy(null);
      setBackfillMsg(null);
      // Re-applied on every open (and on every reconcile), so an override
      // applied from the collision-floor panel meanwhile shows up here.
      const t = b.savings.semanticCache.threshold;
      setThreshold(t === null ? "" : String(t));
    }
  }, []);

  // Refresh the cache behind an already-painted panel, and fold the result in
  // only if the user hasn't started editing and hasn't closed it — a reconcile
  // that overwrote a half-typed threshold would be a worse bug than the latency
  // it exists to hide.
  const revalidate = useCallback(
    async (key: string) => {
      try {
        const { seed } = await fetchSeed();
        if (!seed) return;
        seedCache.current.set(key, seed);
        if (openRef.current && !touched.current) applySeed(seed);
      } catch {
        /* a failed reconcile leaves the painted (cached) values in place */
      }
    },
    [fetchSeed, applySeed],
  );

  // The click path. Cached → paint now, reconcile behind it. Cold → the old
  // fetch-then-open, because there is nothing honest to paint yet.
  async function openPanel() {
    const key = currentConfigId() ?? "";
    touched.current = false;
    const cached = seedCache.current.get(key);
    if (cached) {
      applySeed(cached);
      setErr(null);
      setOpen(true);
      void revalidate(key);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const { seed, error } = await fetchSeed();
      if (seed) {
        seedCache.current.set(key, seed);
        applySeed(seed);
      } else {
        setErr(error ?? "Failed to load settings.");
      }
      setOpen(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error.");
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  // Warm the cache on hover/focus, so even the FIRST open of a page paints
  // instantly. Fills only when empty — a hover isn't a reason to re-fetch what
  // an open would revalidate anyway — and never touches form state.
  function prefetch() {
    const key = currentConfigId() ?? "";
    if (seedCache.current.has(key) || loading) return;
    void fetchSeed()
      .then(({ seed }) => {
        if (seed) seedCache.current.set(key, seed);
      })
      .catch(() => {
        /* the click path will try again and surface the error */
      });
  }

  // Hover/focus only helps if there IS a hover: a straight click, a touch, or a
  // keyboard open all reach openPanel cold, and that first open is the one that
  // felt slow. So warm once per config at mount too, deferred to idle so the
  // seed never competes with the page's own first paint. Same fill-only-when-
  // empty rule as prefetch(), so this costs at most one extra pair of GETs per
  // config visited, and only for the ones that don't get opened.
  useEffect(() => {
    const warm = () => prefetch();
    // requestIdleCallback is typed as always present but isn't on every browser
    // we care about, so the timeout fallback is a real path, not defensive noise.
    const idle = typeof window.requestIdleCallback === "function";
    const handle = idle
      ? window.requestIdleCallback(warm, { timeout: 2000 })
      : window.setTimeout(warm, 500);
    return () => {
      if (idle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
    // Re-warms when the tab (config) changes, which is exactly when the cache
    // key changes too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configId]);

  // `force` acknowledges the uncalibrated-space refusal on a key-model switch
  // (409). Only ever true from the explicit "Switch anyway" button.
  async function save(force = false) {
    const ladderArr = ladder
      .split(/[\s,]+/)
      .map((s) => Math.floor(Number(s)))
      .filter((n) => Number.isFinite(n) && n > 0);
    const overlapNum = Number(overlap);
    // Normalize the chunk scope: full selection saves as null ("all", so chunks
    // labeled later are included automatically); a partial one keeps only ids
    // that still exist in the options (drops stale picks).
    const allChunkIds = scopeDocs.flatMap((d) =>
      d.chunks.map((c) => c.chunkId),
    );
    const chunkScope =
      scopeSel === null || allChunkIds.every((id) => scopeSel.has(id))
        ? null
        : allChunkIds.filter((id) => scopeSel.has(id));
    // Model scope: all-selected saves as null ("all", so models keyed later are
    // included too); a partial selection keeps only ids that still exist as
    // options ([] when the user allowed none = size-only tuning).
    //
    // Only SELECTABLE (keyed) options count on either side: the greyed rows are
    // there to explain a missing space, not to be picked, so they must never
    // land in the saved array — and they must not block the all-checked → null
    // collapse either (with them counted, "all" could never save as null).
    const allModelIds = modelOpts.filter((m) => m.selectable).map((m) => m.id);
    const modelScope =
      modelSel === null || allModelIds.every((id) => modelSel.has(id))
        ? null
        : allModelIds.filter((id) => modelSel.has(id));
    // Same all-checked -> null collapse as modelScope: saving the full keyed set
    // explicitly would freeze today's registry into the config, so a model added
    // later silently wouldn't vote.
    const allAggIds = aggOpts.filter((m) => m.selectable).map((m) => m.id);
    const aggScope =
      aggSel === null || allAggIds.every((id) => aggSel.has(id))
        ? null
        : allAggIds.filter((id) => aggSel.has(id));
    const patch = {
      recall: {
        enabled: recallOn,
        k: parseKOrNull(recallK),
        minRate: parseRateOrNull(recallMin),
      },
      mrr: {
        enabled: mrrOn,
        k: parseKOrNull(mrrK),
        minRate: parseRateOrNull(mrrMin),
      },
      ndcg: {
        enabled: ndcgOn,
        k: parseKOrNull(ndcgK),
        minRate: parseRateOrNull(ndcgMin),
        aggregateModels: aggScope,
      },
      autotune: {
        ...(ladderArr.length > 0 ? { sizeLadder: ladderArr } : {}),
        ...(Number.isFinite(overlapNum)
          ? { overlapPct: Math.min(0.9, Math.max(0, overlapNum / 100)) }
          : {}),
        apply,
        search,
        stopEarly,
        keepBest,
        chunkScope,
        modelScope,
        fusionPool: parseKOrNull(autotunePool),
      },
      retrieval: { fusionPool: parseKOrNull(retrievalPool) },
    };
    setSaving(true);
    setErr(null);
    try {
      const res = await apiFetch("/api/eval/criteria", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setErr(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      // Auto-sync and the LLM model both live on the config ROW, not the
      // criteria — one separate PATCH, carrying whichever of them actually
      // changed. The route applies each field present, so they ride together
      // rather than costing two requests.
      if (config) {
        const configPatch: { corpusSync?: boolean; llmModel?: string } = {};
        if (config.corpusId && sync !== savedSync)
          configPatch.corpusSync = sync;
        if (llmModel && llmModel !== savedLlmModel)
          configPatch.llmModel = llmModel;

        if (Object.keys(configPatch).length > 0) {
          const res2 = await apiFetch(`/api/configs/${config.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(configPatch),
          });
          const data2 = (await res2.json().catch(() => null)) as {
            error?: string;
          } | null;
          if (!res2.ok) {
            setErr(data2?.error ?? `Config update failed (${res2.status}).`);
            return;
          }
          setSavedLlmModel(llmModel);
        }
      }
      // Savings preference lives in its own store (configs.batch_savings).
      const parsedThreshold = parseThreshold(threshold);
      if (parsedThreshold === undefined) {
        setErr(
          "Match threshold must be a cosine between 0 and 1 (e.g. 0.94), or empty to inherit.",
        );
        return;
      }
      const bres = await apiFetch("/api/batch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobs: savings.jobs,
          cascadeEnabled,
          semanticCache: {
            // acceptTarget is deliberately OMITTED, not echoed back: it is set
            // on Appraise now, and an omitted key means "leave the override
            // alone" (see the route). Spreading the value we seeded with would
            // silently revert a target stored there since this panel opened.
            serve: savings.semanticCache.serve,
            threshold: parsedThreshold,
            // "" = inherit the global default.
            keyModel: keyModel === "" ? null : keyModel,
          },
          forceKeyModel: force,
        }),
      });
      if (!bres.ok) {
        const bdata = (await bres.json().catch(() => null)) as {
          error?: string;
          uncalibratedSpace?: { space: string; fallbackThreshold: number };
        } | null;
        // 409 = the key model would move this config into an uncalibrated
        // space. Keep the panel open and offer the switch again explicitly,
        // rather than dropping the user's other edits over it.
        if (bres.status === 409 && bdata?.uncalibratedSpace) {
          setKeyModelBlock(bdata.uncalibratedSpace);
          setKeyModelBlockedBy("save");
        }
        setErr(bdata?.error ?? `Savings update failed (${bres.status}).`);
        return;
      }
      // What we just wrote is what the next open must show, and the payload the
      // server would return now differs from the one we seeded from — so drop
      // the cache rather than trying to patch it. (The event below also clears
      // it; doing it here keeps the invalidation next to the write.)
      seedCache.current.clear();
      setOpen(false);
      window.dispatchEvent(new Event(EVAL_CRITERIA_CHANGED));
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error.");
    } finally {
      setSaving(false);
    }
  }

  // Switching the cache key model used to be two steps — Save the picker, then
  // a second click to re-key past questions — which left a config's cache cold
  // (nothing matchable) for however long sat between them. One button now does
  // both: it writes ONLY semanticCache.keyModel (a partial PATCH — the rest of
  // this form's pending edits are untouched, see `save` for those), then
  // immediately re-keys under whatever it just saved.
  async function applyKeyModelAndRekey(force = false) {
    setKeyModelPhase("saving");
    setBackfillMsg(null);
    try {
      const res = await apiFetch("/api/batch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          semanticCache: { keyModel: keyModel === "" ? null : keyModel },
          forceKeyModel: force,
        }),
      });
      const d = (await res.json().catch(() => null)) as {
        savings?: BatchSavings;
        error?: string;
        uncalibratedSpace?: { space: string; fallbackThreshold: number };
      } | null;
      if (!res.ok || !d || d.error) {
        if (res.status === 409 && d?.uncalibratedSpace) {
          setKeyModelBlock(d.uncalibratedSpace);
          setKeyModelBlockedBy("apply");
        } else {
          setBackfillMsg(d?.error ?? `Save failed (${res.status}).`);
        }
        return;
      }
      const saved = d.savings?.semanticCache.keyModel ?? null;
      setKeyModelInfo((info) =>
        info
          ? { ...info, override: saved, keyModel: saved ?? info.globalDefault }
          : info,
      );
      setKeyModelBlock(null);
      setKeyModelBlockedBy(null);

      setKeyModelPhase("rekeying");
      const bres = await apiFetch("/api/semantic-cache/key-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "backfill" }),
      });
      const bd = (await bres.json().catch(() => null)) as {
        keyModel?: string;
        candidates?: number;
        inserted?: number;
        failed?: number;
        error?: string;
      } | null;
      if (!bres.ok || !bd || bd.error) {
        setBackfillMsg(bd?.error ?? `Re-key failed (${bres.status}).`);
        return;
      }
      setBackfillMsg(
        bd.candidates === 0
          ? `Applied — every cached question already has a ${bd.keyModel} vector.`
          : `Applied and re-keyed ${bd.inserted ?? 0} of ${bd.candidates} cached questions under ${bd.keyModel}` +
              (bd.failed ? `; ${bd.failed} failed to embed.` : "."),
      );
      window.dispatchEvent(new Event(EVAL_CRITERIA_CHANGED));
    } catch (e) {
      setBackfillMsg(e instanceof Error ? e.message : "Network error.");
    } finally {
      setKeyModelPhase(null);
    }
  }

  // The picker's value resolved through the same two layers the server uses, so
  // the line under it names the model that would actually be in force.
  const resolvedKeyModel =
    keyModel === "" ? (keyModelInfo?.globalDefault ?? "") : keyModel;
  // A pending change: backfill acts on the SAVED model, so it must not be
  // offered while the picker shows something else.
  const keyModelDirty = keyModel !== (keyModelInfo?.override ?? "");

  // The collapsed "Models in aggregate" summary. Unkeyed models can't vote, so
  // they never count — same rule as the autotune summary below.
  const aggSelected = aggOpts.filter(
    (m) => m.selectable && (aggSel === null || aggSel.has(m.id)),
  ).length;

  // The collapsed "Models" summary: how many models a run would actually try.
  // Counts only keyed options, so the greyed rows can't inflate it, and treats
  // null ("all") as every keyed option — the same set the save path collapses.
  const modelsSelected = modelOpts.filter(
    (m) => m.selectable && (modelSel === null || modelSel.has(m.id)),
  ).length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        onMouseEnter={prefetch}
        onFocus={prefetch}
        disabled={loading}
        title="Config settings: eval metrics, autotuning, corpus auto-sync"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {loading ? "Settings…" : "Settings ▾"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          {/* One capture-phase pair marks the panel dirty for every control in
              it, so a background reconcile knows to leave the form alone. */}
          <div
            onChangeCapture={() => (touched.current = true)}
            onClickCapture={() => (touched.current = true)}
            className="absolute right-0 top-full z-20 mt-1 w-80 rounded-md border border-zinc-200 bg-white p-3 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
          >
            {/* LLM — the config's answer-generation model (§9.2).
                First in the dropdown because it's the setting with the broadest
                effect: every metric below is measured on answers this model
                produced, so it frames what the rest of the panel is tuning. */}
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              LLM
            </p>
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="flex items-center justify-between gap-2">
                <span className="text-zinc-600 dark:text-zinc-400">
                  Provider
                </span>
                <select
                  value={llmProvider}
                  onChange={(e) => {
                    const next = e.target.value as LlmProviderId;
                    setLlmProvider(next);
                    // Moving the filter must not leave the Model select showing
                    // a value from the other provider. Jump to that provider's
                    // first SELECTABLE model, falling back to its first model —
                    // an unkeyed provider has no selectable option, and leaving
                    // the field blank would read as "no model set" when the
                    // config still has one.
                    const inProvider = llmOpts.filter(
                      (m) => m.provider === next,
                    );
                    const target =
                      inProvider.find((m) => m.selectable) ?? inProvider[0];
                    if (target) setLlmModel(target.id);
                  }}
                  className="w-44 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </select>
              </label>

              <label className="flex items-center justify-between gap-2">
                <span className="text-zinc-600 dark:text-zinc-400">Model</span>
                <select
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  className="w-44 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                >
                  {/* Unkeyed models are LISTED, disabled, with the reason —
                      never dropped. Same contract as the base-model and autotune
                      pickers: a list that silently omitted OpenAI would look
                      like an app that doesn't support it, when the truth is one
                      missing key. */}
                  {llmOpts
                    .filter((m) => m.provider === llmProvider)
                    .map((m) => (
                      <option
                        key={m.id}
                        value={m.id}
                        disabled={!m.selectable}
                        title={m.reason ?? undefined}
                      >
                        {m.label}
                        {m.note ? ` — ${m.note}` : ""}
                        {m.selectable ? "" : ` (${m.reason})`}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            {/* METRICS */}
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Metrics
            </p>
            <MetricRow
              label="Recall"
              on={recallOn}
              setOn={setRecallOn}
              k={recallK}
              setK={setRecallK}
              min={recallMin}
              setMin={setRecallMin}
              topK={config?.topK ?? 5}
            />
            <MetricRow
              label="MRR"
              on={mrrOn}
              setOn={setMrrOn}
              k={mrrK}
              setK={setMrrK}
              min={mrrMin}
              setMin={setMrrMin}
              topK={config?.topK ?? 5}
            />
            <MetricRow
              label="nDCG"
              on={ndcgOn}
              setOn={setNdcgOn}
              k={ndcgK}
              setK={setNdcgK}
              min={ndcgMin}
              setMin={setNdcgMin}
              topK={config?.topK ?? 5}
            />

            {/* Which models VOTE in the ideal ranking nDCG grades against. Sits
                under nDCG rather than in Autotuning because it changes what the
                metric MEANS, not how a run searches — and a model in this set is
                partly grading itself (see the tooltip). */}
            <div className="flex items-center justify-between gap-2 py-0.5 pl-4">
              <Tooltip
                align="left"
                text={
                  "Which embedding models vote when building each question's " +
                  "ideal ranking. Their ranks are averaged; nDCG then scores a " +
                  "model's retrieval against that ideal.\n\n" +
                  "A model in this set helps define the target it is later graded " +
                  "on. Appraise → Models corrects for that by rebuilding the ideal " +
                  "without the model under test, but the remaining voters are " +
                  "still its relatives — so a NARROW set biases nDCG toward that " +
                  "family. Including every candidate makes the correction apply " +
                  "evenly to all of them.\n\n" +
                  "Changing this does not rewrite existing rankings — rebuild them " +
                  "from a question's ranking panel. Unkeyed models are greyed out. " +
                  "Uncheck everything to fall back to the default set."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  Models in aggregate
                </span>
              </Tooltip>
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => {
                    setAggSel(null);
                    setAggOpen(true);
                  }}
                  className="cursor-pointer text-zinc-500 hover:underline"
                >
                  all
                </button>
                <button
                  type="button"
                  onClick={() => setAggOpen((v) => !v)}
                  aria-expanded={aggOpen}
                  title={
                    aggOpen ? "Hide the model list" : "Show the model list"
                  }
                  className="cursor-pointer rounded border border-zinc-300 px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  {aggSelected} selected {aggOpen ? "\u25be" : "\u25b8"}
                </button>
              </div>
            </div>
            {aggOpen && (
              <ModelScopeChecklist
                models={aggOpts}
                selected={aggSel}
                setSelected={setAggSel}
              />
            )}

            {/* AUTOTUNING */}
            <p className="mb-1 mt-3 border-t border-zinc-200 pt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              Autotuning
            </p>
            <label className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-zinc-600 dark:text-zinc-400">
                Size ladder
              </span>
              <input
                value={ladder}
                onChange={(e) => setLadder(e.target.value)}
                placeholder="384, 256, 192, 128"
                className="w-44 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
              />
            </label>
            <label className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-zinc-600 dark:text-zinc-400">
                Overlap %
              </span>
              <input
                type="number"
                min={0}
                max={90}
                value={overlap}
                onChange={(e) => setOverlap(e.target.value)}
                className="w-20 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
              />
            </label>
            <label className="flex items-center justify-between gap-2 py-0.5">
              <Tooltip
                align="left"
                text={
                  "How many top chunks each autotune trial embeds fresh under a " +
                  "candidate model — the main embedding cost of a run. Chunks already " +
                  "cached for that model join the ranking for free on top of this " +
                  "number, so trials get more accurate as the cache warms without " +
                  "costing more. The confirm step always runs at the live retrieval " +
                  "pool, so a low number just means more winners get reverted at " +
                  "confirm time. Empty = match live retrieval."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  Fusion pool
                </span>
              </Tooltip>
              <input
                type="number"
                min={1}
                value={autotunePool}
                onChange={(e) => setAutotunePool(e.target.value)}
                placeholder="live"
                className="w-20 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
              />
            </label>
            <div className="flex items-center justify-between gap-2 py-0.5">
              <Tooltip
                align="left"
                text={
                  "During autotune, several candidate fixes (chunk sizes, models, combos) " +
                  "can all clear your min-rate for the same chunk. 'choose' pauses so you " +
                  "pick which fix to apply; 'auto-best' applies the highest-scoring one " +
                  "automatically."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  When 1+ pass
                </span>
              </Tooltip>
              <div className="flex gap-1">
                <Seg
                  active={apply === "choose"}
                  onClick={() => setApply("choose")}
                >
                  choose
                </Seg>
                <Seg
                  active={apply === "auto_best"}
                  onClick={() => setApply("auto_best")}
                >
                  auto-best
                </Seg>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-zinc-600 dark:text-zinc-400">Search</span>
              <div className="flex gap-1">
                <Seg
                  active={search === "first_success"}
                  onClick={() => setSearch("first_success")}
                >
                  first
                </Seg>
                <Seg
                  active={search === "exhaustive"}
                  onClick={() => setSearch("exhaustive")}
                  title="Best-of-best: tries every size × model combo — slower / more costly"
                >
                  best-of-best
                </Seg>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 py-0.5">
              <Tooltip
                align="left"
                text={
                  "Autotune works through the worst chunks first; with this on, the run " +
                  "stops as soon as every targeted metric's overall rate reaches its " +
                  "min-rate, skipping the remaining below-bar chunks to save embedding cost."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  Stop once reached
                </span>
              </Tooltip>
              <input
                type="checkbox"
                checked={stopEarly}
                onChange={(e) => setStopEarly(e.target.checked)}
                className="cursor-pointer"
              />
            </div>
            <div className="flex items-center justify-between gap-2 py-0.5">
              <Tooltip
                align="left"
                text={
                  "If no fix clears a chunk's min-rate, keep the best improvement " +
                  "anyway (reported as 'improved', not resolved). Drawback: each kept " +
                  "override can shift other chunks' rankings — for less gain than a " +
                  "real fix."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  Keep best effort
                </span>
              </Tooltip>
              <input
                type="checkbox"
                checked={keepBest}
                onChange={(e) => setKeepBest(e.target.checked)}
                className="cursor-pointer"
              />
            </div>
            <div className="flex items-center justify-between gap-2 py-0.5">
              <Tooltip
                align="left"
                text={
                  "Which chunks autotune may target. 'all' covers every labeled chunk — " +
                  "including ones whose questions are added later; 'custom' restricts runs " +
                  "to the checked chunks, grouped by document."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  Chunks
                </span>
              </Tooltip>
              <div className="flex gap-1">
                <Seg
                  active={scopeSel === null}
                  onClick={() => setScopeSel(null)}
                >
                  all
                </Seg>
                <Seg
                  active={scopeSel !== null}
                  onClick={() =>
                    setScopeSel(
                      (prev) =>
                        prev ??
                        new Set(
                          scopeDocs.flatMap((d) =>
                            d.chunks.map((c) => c.chunkId),
                          ),
                        ),
                    )
                  }
                >
                  custom
                </Seg>
              </div>
            </div>
            {scopeSel !== null && (
              <ChunkScopeTree
                docs={scopeDocs}
                selected={scopeSel}
                setSelected={setScopeSel}
                expanded={scopeExpanded}
                setExpanded={setScopeExpanded}
              />
            )}
            <div className="flex items-center justify-between gap-2 py-0.5">
              <Tooltip
                align="left"
                text={
                  "Which alternate embedding models autotune may try as per-chunk " +
                  "overrides. Models in the base model's own vector space rank " +
                  "directly against it — no extra fusion lane, no extra query " +
                  "embedding per live retrieval. A model in a separate space adds a " +
                  "fusion lane. Models whose provider you have no key for are listed " +
                  "greyed out with the key to add. Uncheck all to tune " +
                  "chunk size only."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  Models
                </span>
              </Tooltip>
              {/* Bulk actions open the disclosure: a count changing behind a
                  collapsed panel gives no clue WHICH models moved. */}
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => {
                    setModelSel(null);
                    setModelsOpen(true);
                  }}
                  className="cursor-pointer text-zinc-500 hover:underline"
                >
                  all
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setModelSel(new Set());
                    setModelsOpen(true);
                  }}
                  className="cursor-pointer text-zinc-500 hover:underline"
                >
                  none
                </button>
                <button
                  type="button"
                  onClick={() => setModelsOpen((v) => !v)}
                  aria-expanded={modelsOpen}
                  title={
                    modelsOpen ? "Hide the model list" : "Show the model list"
                  }
                  className="cursor-pointer rounded border border-zinc-300 px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  {modelsSelected} selected {modelsOpen ? "▾" : "▸"}
                </button>
              </div>
            </div>
            {modelsOpen && (
              <ModelScopeChecklist
                models={modelOpts}
                selected={modelSel}
                setSelected={setModelSel}
              />
            )}

            {/* RETRIEVAL (live fusion pool, 0027) */}
            <p className="mb-1 mt-3 border-t border-zinc-200 pt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              Retrieval
            </p>
            <label className="flex items-center justify-between gap-2 py-0.5">
              <Tooltip
                align="left"
                text={
                  "When chunks have overrides, live retrieval positions each one by " +
                  "ranking it against the query's top base-model chunks re-embedded " +
                  "under the override's model. This number is how many are embedded " +
                  "fresh; deeper chunks already in the cache join for free, so the " +
                  "effective pool (and rank accuracy) grows as the cache warms. More " +
                  "= more accurate fusion ranks, with diminishing returns. Changing " +
                  "this changes rankings: scored results go stale until re-scored. " +
                  "Empty = auto (4×top-k, min 50)."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  Fusion pool
                </span>
              </Tooltip>
              <input
                type="number"
                min={1}
                value={retrievalPool}
                onChange={(e) => setRetrievalPool(e.target.value)}
                placeholder="auto"
                className="w-20 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
              />
            </label>

            {/* CORPUS (auto-sync, 0017) */}
            <p className="mb-1 mt-3 border-t border-zinc-200 pt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              Corpus
            </p>
            {config?.corpusId ? (
              <div className="flex items-center justify-between gap-2 py-0.5">
                <Link
                  href={`/corpora/${config.corpusId}`}
                  className="truncate text-zinc-600 hover:underline dark:text-zinc-400"
                  title="Open this corpus"
                >
                  {config.corpusName}
                </Link>
                <label
                  className="flex shrink-0 cursor-pointer items-center gap-1.5 text-zinc-600 dark:text-zinc-400"
                  title={
                    "Auto-sync: documents added to the corpus are embedded into this " +
                    "config, documents removed are removed, and this config's uploads " +
                    "join the corpus."
                  }
                >
                  <input
                    type="checkbox"
                    checked={sync}
                    onChange={(e) => setSync(e.target.checked)}
                  />
                  auto-sync
                </label>
              </div>
            ) : (
              <p className="py-0.5 text-xs text-zinc-400">
                No corpus attached — nothing to sync with.
              </p>
            )}

            {/* SAVINGS (Phase E1 — batch API: −50% on either LLM provider, −33% Voyage) */}
            <p className="mb-1 mt-3 border-t border-zinc-200 pt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              Savings
            </p>
            <div className="flex items-center justify-between gap-2 py-0.5">
              <Tooltip
                align="left"
                text={
                  "Saver mode (FrugalGPT cascade): answer with a cheap model first, " +
                  "then escalate to this config's model only when the answer looks weak " +
                  "(refused or poorly grounded). Off = always this config's model. Saves " +
                  "on easy questions with no quality change on the hard ones."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  Saver mode (cascade)
                </span>
              </Tooltip>
              <input
                type="checkbox"
                checked={cascadeEnabled}
                onChange={(e) => setCascadeEnabled(e.target.checked)}
                className="cursor-pointer"
              />
            </div>
            <p className="mb-1 mt-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Batch API
            </p>
            {/* One row per job — there are only four, so any grouping above them
                is a layer to reason through for nothing. */}
            {JOB_KINDS.map((kind) => (
              <ChoiceRow
                key={kind}
                label={JOB_LABELS[kind]}
                value={savings.jobs[kind]}
                batchLabel={BATCH_OPTION_LABELS[kind]}
                unavailable={UNIMPLEMENTED_KINDS.has(kind)}
                onChange={(v) => setJob(kind, v)}
              />
            ))}

            <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
              Batch API is cheaper but asynchronous.{" "}
              {emailReady
                ? "We'll email you when it's done."
                : "We'll notify you here when it's done."}
            </p>

            {/* Semantic answer cache: serving is opt-in; the cache always fills. */}
            <label className="mt-2 flex items-center justify-between gap-2 py-0.5 pt-2">
              <Tooltip
                align="left"
                text={
                  "Serve a stored answer when a new question is close enough to a " +
                  "past one, skipping retrieval and the LLM. The cache is always " +
                  "populated — this only controls whether close matches are served."
                }
              >
                <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                  Serve cached answers
                </span>
              </Tooltip>
              <input
                type="checkbox"
                checked={savings.semanticCache.serve}
                onChange={(e) =>
                  setSavings((s) => ({
                    ...s,
                    semanticCache: {
                      ...s.semanticCache,
                      serve: e.target.checked,
                    },
                  }))
                }
                className="h-4 w-4 shrink-0 cursor-pointer accent-black dark:accent-white"
              />
            </label>

            {/* The CACHE-KEY model. Shown regardless of the serve toggle — unlike
                the threshold, it governs how the cache is POPULATED too, so it's
                connected to something either way. */}
            <div className="mt-2 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <Tooltip
                  align="left"
                  text={
                    "Which embedding model incoming questions are keyed under for the " +
                    "cache match. Independent of this config's retrieval model: the " +
                    "cache-key vector never touches a vector table, and question↔question " +
                    "matching is a different task from question↔document retrieval. " +
                    "It's paid per question (~10 tokens), not per corpus chunk.\n\n" +
                    "Changing it moves this config into a different vector-space, which " +
                    "has its own calibrated threshold."
                  }
                >
                  <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                    Cache key model
                  </span>
                </Tooltip>
                <select
                  value={keyModel}
                  onChange={(e) => {
                    setKeyModel(e.target.value);
                    setKeyModelBlock(null);
                    setKeyModelBlockedBy(null);
                    setBackfillMsg(null);
                  }}
                  className="max-w-52 rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                >
                  <option value="">
                    Default ({keyModelInfo?.globalDefault ?? "—"})
                  </option>
                  {(keyModelInfo?.candidates ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} · {c.dimension}d
                    </option>
                  ))}
                </select>
              </div>

              <p className="text-xs text-zinc-400 dark:text-zinc-500">
                Currently keyed under{" "}
                <span className="font-mono">{resolvedKeyModel || "—"}</span>
                {keyModel === ""
                  ? " (global default)."
                  : " for this config only."}{" "}
                {keyModelDirty
                  ? "Applying keys this config under the picked model and re-keys past questions in one step."
                  : "Past questions keyed under another model won't match until they're re-keyed."}
              </p>

              {/* Only offered once the picker actually differs from what's
                  saved — a bare "re-key" button with nothing pending to apply
                  read as a second, disconnected step. One click now both
                  saves the picked model AND re-keys, instead of Save-then-
                  re-key as two separate clicks. */}
              {keyModelDirty && (
                <div className="flex items-center justify-end gap-2">
                  {backfillMsg && (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {backfillMsg}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => applyKeyModelAndRekey(false)}
                    disabled={keyModelPhase !== null}
                    className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 cursor-pointer transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    {keyModelPhase === "saving"
                      ? "Saving…"
                      : keyModelPhase === "rekeying"
                        ? "Re-keying…"
                        : "Apply & re-key cached questions"}
                  </button>
                </div>
              )}
              {!keyModelDirty && backfillMsg && (
                <p className="text-right text-xs text-zinc-500 dark:text-zinc-400">
                  {backfillMsg}
                </p>
              )}

              {/* The refusal, made explicit. An uncalibrated target space falls
                  back to the conservative default, which silently changes the
                  floor answers are served at — so the switch is offered again
                  with the number named rather than retried behind the scenes. */}
              {keyModelBlock && (
                <div className="flex flex-col items-end gap-1 rounded-md border border-amber-300 bg-amber-50 p-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  <p className="text-left">
                    <span className="font-mono">{keyModelBlock.space}</span> has
                    no calibrated threshold — this config would serve at{" "}
                    <span className="tabular-nums">
                      {keyModelBlock.fallbackThreshold.toFixed(3)}
                    </span>{" "}
                    (the default). Calibrate it on Appraise → Semantic caching,
                    or switch anyway.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      keyModelBlockedBy === "apply"
                        ? applyKeyModelAndRekey(true)
                        : save(true)
                    }
                    disabled={saving || keyModelPhase !== null}
                    className="rounded-md border border-amber-400 px-2 py-0.5 font-medium cursor-pointer transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-amber-700 dark:hover:bg-amber-900/40"
                  >
                    Switch anyway
                  </button>
                </div>
              )}
            </div>

            {/* The floor a match must clear to be served. Only shown once serving
                is on — with serving off the number governs nothing, and offering
                it there just invites tuning a knob that isn't connected. */}
            {savings.semanticCache.serve && (
              <div className="mt-2 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <Tooltip
                    align="left"
                    text={
                      "Cosine similarity a new question must reach against a cached " +
                      "one before its answer is reused. Higher = fewer hits but safer; " +
                      "lower = more savings and more risk of serving the wrong answer. " +
                      "Leave empty to inherit the calibrated value for this embedding space."
                    }
                  >
                    <span className="text-zinc-600 transition-colors group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-zinc-100">
                      Match threshold
                    </span>
                  </Tooltip>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={threshold}
                      onChange={(e) => setThreshold(e.target.value)}
                      placeholder={
                        inherited ? inherited.threshold.toFixed(3) : "0.950"
                      }
                      className="w-20 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-left text-xs tabular-nums text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                    />
                    <button
                      type="button"
                      onClick={() => setThreshold("")}
                      disabled={threshold.trim() === ""}
                      className="rounded px-1 text-xs text-zinc-400 cursor-pointer transition-colors hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:text-zinc-200"
                    >
                      Reset
                    </button>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  {threshold.trim() === "" ? (
                    <>
                      Inheriting{" "}
                      <span className="tabular-nums">
                        {inherited ? inherited.threshold.toFixed(3) : "—"}
                      </span>{" "}
                      {inherited?.source === "calibrated"
                        ? "calibrated for"
                        : "(default) for"}{" "}
                      <span className="font-mono">
                        {inherited?.space ?? "this space"}
                      </span>
                      . Calibrate it on Appraise → Semantic caching.
                    </>
                  ) : (
                    <>
                      Overrides the{" "}
                      <span className="font-mono">
                        {inherited?.space ?? "space"}
                      </span>{" "}
                      value (
                      <span className="tabular-nums">
                        {inherited ? inherited.threshold.toFixed(3) : "—"}
                      </span>
                      ) for this config only. Reset to inherit again.
                    </>
                  )}
                </p>
              </div>
            )}

            {inFlightCount > 0 && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {inFlightCount} batch request{inFlightCount === 1 ? "" : "s"}{" "}
                processing for this config — changes may be overwritten when{" "}
                {inFlightCount === 1 ? "it" : "they"} complete
                {inFlightCount === 1 ? "s" : ""}.
              </p>
            )}

            {err && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                {err}
              </p>
            )}

            <div className="mt-3 flex justify-end border-t border-zinc-200 pt-2 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => save()}
                disabled={saving || !config}
                className="rounded-md bg-black px-3 py-1 text-xs font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// One metric row in the Settings dropdown: enable checkbox + k + optional min-rate.
function MetricRow({
  label,
  on,
  setOn,
  k,
  setK,
  min,
  setMin,
  topK,
}: {
  label: string;
  on: boolean;
  setOn: (v: boolean) => void;
  k: string;
  setK: (v: string) => void;
  min: string;
  setMin: (v: string) => void;
  topK: number;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <label className="flex w-20 cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
        />
        <span className="text-zinc-700 dark:text-zinc-300">{label}</span>
      </label>
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        k
        <input
          type="number"
          min={1}
          value={k}
          onChange={(e) => setK(e.target.value)}
          placeholder={String(topK)}
          disabled={!on}
          className="w-14 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
        />
      </label>
      <label
        className="flex items-center gap-1 text-xs text-zinc-500"
        title="Fraction from 0–1. Values above 1 are read as a percentage: 90 or 90% becomes 0.9."
      >
        min
        <input
          value={min}
          onChange={(e) => setMin(e.target.value)}
          onBlur={() => {
            // Echo the canonical decimal back (90 → 0.9) so what's saved is
            // never a surprise; garbage clears to unset.
            const rate = parseRateOrNull(min);
            setMin(rate === null ? "" : String(rate));
          }}
          placeholder="–"
          disabled={!on}
          className="w-16 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
        />
      </label>
    </div>
  );
}

// The 'custom' autotune chunk scope picker: labeled chunks grouped by document.
// A document row toggles all its chunks; expanding it exposes per-chunk boxes.
function ChunkScopeTree({
  docs,
  selected,
  setSelected,
  expanded,
  setExpanded,
}: {
  docs: AutotuneScopeDocument[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
}) {
  if (docs.length === 0) {
    return (
      <p className="mt-1 rounded border border-zinc-200 p-2 text-xs text-zinc-400 dark:border-zinc-800">
        No labeled chunks yet — generate questions first.
      </p>
    );
  }

  const toggleChunk = (chunkId: string) => {
    const next = new Set(selected);
    if (next.has(chunkId)) next.delete(chunkId);
    else next.add(chunkId);
    setSelected(next);
  };
  const toggleDoc = (doc: AutotuneScopeDocument) => {
    const next = new Set(selected);
    const allIn = doc.chunks.every((c) => next.has(c.chunkId));
    for (const c of doc.chunks) {
      if (allIn) next.delete(c.chunkId);
      else next.add(c.chunkId);
    }
    setSelected(next);
  };
  const toggleExpanded = (documentId: string) => {
    const next = new Set(expanded);
    if (next.has(documentId)) next.delete(documentId);
    else next.add(documentId);
    setExpanded(next);
  };

  return (
    <div className="mt-1 max-h-44 overflow-y-auto rounded border border-zinc-200 dark:border-zinc-800">
      {docs.map((doc) => {
        const inCount = doc.chunks.filter((c) =>
          selected.has(c.chunkId),
        ).length;
        const allIn = inCount === doc.chunks.length;
        const isOpen = expanded.has(doc.documentId);
        return (
          <div
            key={doc.documentId}
            className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800/60"
          >
            <div className="flex items-center gap-1.5 px-1.5 py-1">
              <button
                type="button"
                onClick={() => toggleExpanded(doc.documentId)}
                className="w-4 shrink-0 cursor-pointer text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                title={isOpen ? "Collapse chunks" : "Show chunks"}
              >
                {isOpen ? "▾" : "▸"}
              </button>
              <input
                type="checkbox"
                checked={allIn}
                ref={(el) => {
                  if (el) el.indeterminate = inCount > 0 && !allIn;
                }}
                onChange={() => toggleDoc(doc)}
                className="cursor-pointer"
              />
              <span
                className="min-w-0 flex-1 truncate text-xs text-zinc-700 dark:text-zinc-300"
                title={doc.fileName}
              >
                {doc.fileName}
              </span>
              <span className="shrink-0 text-[10px] text-zinc-400">
                {inCount}/{doc.chunks.length}
              </span>
            </div>
            {isOpen &&
              doc.chunks.map((c) => (
                <label
                  key={c.chunkId}
                  className="flex cursor-pointer items-center gap-1.5 py-0.5 pl-8 pr-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  title={c.preview ?? undefined}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.chunkId)}
                    onChange={() => toggleChunk(c.chunkId)}
                    className="cursor-pointer"
                  />
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">
                    chunk {c.position ?? "?"}
                  </span>
                  <span className="text-[10px] text-zinc-400">
                    {c.questions} {c.questions === 1 ? "question" : "questions"}
                  </span>
                </label>
              ))}
          </div>
        );
      })}
    </div>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  voyage: "Voyage",
  openai: "OpenAI",
  cohere: "Cohere",
  local: "Local",
};

// The autotune "Models" checklist: the alternate models a run may try, grouped
// by VECTOR SPACE — provider-agnostic, so any model shows up the moment its
// provider key is set. The base model's own space heads the list under a
// "no fusion" label (an override under those models ranks directly against the
// base, so live retrieval opens no extra fusion lane). Every OTHER distinct
// space is its own subsection and costs one fusion lane at retrieval (each
// extra space = one more query embedding + rank-merge lane per query); models
// that genuinely share a space — the voyage-4 family, or two Matryoshka output
// dims of one OpenAI/Cohere model — cluster into a single subsection and share
// that one lane. `selected === null` = all allowed (the default, and what a
// fully-checked list saves back as); nothing checked = size-only tuning.
//
// Models whose provider the user has no key for are LISTED under their own space
// heading, disabled, with the key that would enable them. Hiding them was the bug
// this fixes: with only a Voyage key added the whole list collapsed to the base
// model's own space, so the UI read as "fusion isn't a thing here" instead of
// "the other spaces need a key". A disabled row is never checked, never
// toggleable, and never counted — not in the fusion-lane footer, not in the
// header's "N selected", and (see save()) never in the saved scope.
function ModelScopeChecklist({
  models,
  selected,
  setSelected,
}: {
  models: AutotuneModelOption[];
  selected: Set<string> | null;
  setSelected: (next: Set<string> | null) => void;
}) {
  if (models.length === 0) {
    return (
      <p className="mt-1 rounded border border-zinc-200 p-2 text-xs text-zinc-400 dark:border-zinc-800">
        No alternate models in the ladder — autotune can only tune chunk size.
      </p>
    );
  }

  // "All" only ever means the KEYED models: an unkeyed one can't be embedded
  // with, so it stays unchecked whatever the selection is, and toggling starts
  // from the keyed set so a disabled id can't slip into it.
  const usableIds = models.filter((m) => m.selectable).map((m) => m.id);
  const isChecked = (m: AutotuneModelOption) =>
    m.selectable && (selected === null || selected.has(m.id));
  const toggle = (m: AutotuneModelOption) => {
    if (!m.selectable) return;
    const next = new Set(selected ?? usableIds);
    if (next.has(m.id)) next.delete(m.id);
    else next.add(m.id);
    setSelected(next);
  };

  // A model with no vectorSpace is its own private space (keyed by id). Grouping
  // preserves ladder order; the base space is pulled to the front below.
  const spaceKey = (m: AutotuneModelOption) => m.vectorSpace ?? `solo:${m.id}`;
  const groups = new Map<string, AutotuneModelOption[]>();
  for (const m of models) {
    const list = groups.get(spaceKey(m));
    if (list) list.push(m);
    else groups.set(spaceKey(m), [m]);
  }
  // Base space first (its members carry sameSpaceAsBase), then the keyed spaces,
  // then the greyed ones — actionable choices above aspirational ones. A space's
  // members share a provider, so availability is uniform within a group. Sort is
  // stable, so ladder (cheapest-first) order survives inside each band.
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    const [ga, gb] = [groups.get(a)![0], groups.get(b)![0]];
    return (
      Number(gb.sameSpaceAsBase) - Number(ga.sameSpaceAsBase) ||
      Number(gb.selectable) - Number(ga.selectable)
    );
  });

  // Fusion lanes the CURRENT selection implies = distinct NON-base spaces with a
  // checked member (base-space picks are free; greyed rows are never checked, so
  // an unkeyed space never inflates the count).
  const lanes = new Set(
    models.filter((m) => isChecked(m) && !m.sameSpaceAsBase).map(spaceKey),
  ).size;
  const checkedCount = models.filter(isChecked).length;

  const header = (group: AutotuneModelOption[]) => {
    if (group[0].sameSpaceAsBase) return "Same space as base — no fusion";
    const provider = PROVIDER_LABEL[group[0].provider] ?? group[0].provider;
    return group.length > 1
      ? `${provider} · ${group[0].vectorSpace} — shared space (+1 fusion lane)`
      : `${provider} — separate space (+1 fusion lane)`;
  };

  return (
    <>
      <div className="mt-1 max-h-52 overflow-y-auto rounded border border-zinc-200 dark:border-zinc-800">
        {orderedKeys.map((key) => {
          const group = groups.get(key)!;
          return (
            <div
              key={key}
              className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800/60"
            >
              <p className="px-1.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                {header(group)}
              </p>
              {group.map((m) => (
                <label
                  key={m.id}
                  title={m.reason ?? undefined}
                  className={`flex items-start gap-1.5 px-1.5 py-0.5 ${
                    m.selectable
                      ? "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                      : "cursor-not-allowed"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked(m)}
                    disabled={!m.selectable}
                    onChange={() => toggle(m)}
                    className="mt-0.5 cursor-pointer disabled:cursor-not-allowed"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-xs ${
                        m.selectable
                          ? "text-zinc-700 dark:text-zinc-300"
                          : "text-zinc-400 dark:text-zinc-600"
                      }`}
                    >
                      {m.id}
                    </span>
                    {/* A reason greys the row out; a note doesn't — it's a
                        trade-off worth seeing before ticking the box (the
                        Cohere v3 input cap silently truncates long chunks).
                        Both can be present, so both render. */}
                    {m.reason && (
                      <span className="block truncate text-[10px] text-zinc-400 dark:text-zinc-500">
                        {m.reason}
                      </span>
                    )}
                    {m.note && (
                      <span
                        className="block truncate text-[10px] text-amber-600 dark:text-amber-500"
                        title={m.note}
                      >
                        {noteHeadline(m.note)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[10px] text-zinc-400">
                    {m.provider}
                  </span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
      <p className="mt-0.5 text-[10px] text-zinc-400">
        {checkedCount === 0
          ? "No models checked — autotune will tune chunk size only."
          : lanes === 0
            ? "All picks stay in the base space — no fusion lanes."
            : `${lanes} fusion lane${lanes > 1 ? "s" : ""} at retrieval (1 per extra space).`}
      </p>
    </>
  );
}

// A small segmented-control button used by the autotuning apply/search toggles.
// One Savings row: a label + a Standard/Batch API <select> (a dropdown, not a
// checkbox — matches the requested UX). Used for both the two legs and the
// per-job overrides.
//
// `unavailable` greys the row out for a job that has no batch handler yet — the
// value still round-trips, so whatever is stored is honored the moment one lands.
function ChoiceRow({
  label,
  value,
  batchLabel,
  unavailable,
  onChange,
}: {
  label: string;
  value: BatchChoice;
  batchLabel?: string;
  unavailable?: boolean;
  onChange: (v: BatchChoice) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      <span
        className={`truncate text-zinc-600 dark:text-zinc-400 ${unavailable ? "opacity-50" : ""}`}
      >
        {label}
        {unavailable && " (coming soon)"}
      </span>
      <select
        value={value}
        disabled={unavailable}
        onChange={(e) => onChange(e.target.value as BatchChoice)}
        className="w-40 shrink-0 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="standard">Standard</option>
        <option value="batch">{batchLabel ?? "Batch API"}</option>
      </select>
    </label>
  );
}

function Seg({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`cursor-pointer rounded border px-2 py-0.5 text-xs font-medium ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
          : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}
