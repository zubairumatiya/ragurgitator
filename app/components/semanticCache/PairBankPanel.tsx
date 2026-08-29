// Appraise → Semantic caching: THE PAIR BANK.
//
// The labeled question↔question pair set — paraphrases and hard negatives written
// from a config's eval questions, screened by a judge, and quarantined when the
// judge contradicts the label. It is the page's one shared ASSET.
//
// IT LIVED INSIDE THE CACHE-KEY LEADERBOARD, which is what made this page read as
// fragmented: the bank has TWO consumers — the leaderboard scores every candidate
// model on it, and a probe replays one of its pairs into the would-hit queue — so a
// bank owned by one of them left the other quietly reaching across a panel border
// for its input. It stands alone now, above both.
//
// Three verbs, in the order they're used:
//   1. Generate — the one-off LLM cost everything downstream is built on. Without
//      hard negatives every model scores ~the same and the leaderboard says nothing.
//   2. Screen   — a second judge pass over the labels nothing has checked. A
//      contradicted pair is quarantined rather than deleted: by then the row exists,
//      and F3 put the generator's hard negatives at only ~80% correct.
//   3. Probe    — replay ONE pair as a question. The only verb here whose output
//      lands somewhere else: an unjudged row in the would-hit queue. Also the only
//      one hidden in the demo: it embeds live, so no publish can bank it.
"use client";

import { useCallback, useEffect, useState } from "react";

import { config } from "@/lib/config";
import { apiFetch } from "@/lib/http/client";
import type { ConfigSummary } from "@/lib/rag/configStore";
import type { PairStats } from "@/lib/rag/semanticCachePairs";

import { SC_CHANGED } from "./events";
import { BTN, NOTE_AMBER, Panel, SELECT } from "./Panel";

const ABOUT =
  "The labeled pair set two things on this page read: the cache-key " +
  "leaderboard scores every candidate model on it, and a probe replays one of " +
  "its pairs into the would-hit queue.\n\n" +
  "Two sources, pooled. Shadow — judged verdicts from real would-hit traffic. " +
  "Free (already paid for), but CENSORED: a pair only got logged if it cleared " +
  "the shadow floor under the model in use at the time, so a candidate's false " +
  "positives are under-counted. Generated — paraphrases and HARD NEGATIVES " +
  "written from your eval questions. Hard negatives are the point: random " +
  "distinct questions are separated near-perfectly by every model and grade " +
  "nothing.\n\n" +
  "The counts are ACCOUNT-WIDE — one pooled set, since a pair is a property of " +
  "two question texts rather than of a config. Only the gap (and the generate " +
  "run that fills it) is per-config, which is what the picker selects.";

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

// The pair counts as this panel holds them: pairStats' own fields plus the one
// the GET adds for a guest (app/api/semantic-cache/pairs). Deliberately NOT
// folded into PairStats — it describes how much of the banked MATRIX is still
// ahead of this visitor, not the pair table, and every other reader of PairStats
// wants the table.
//
// Null rather than absent for a real account, which is the distinction the whole
// generate control is sized off: null means "there is no matrix here", 0 means
// "you have walked to the end of yours".
type PairsState = PairStats & {
  bankedRemaining?: number | null;
};

// What ONE probe reports back (app/api/semantic-cache/probe). Held rather than
// flattened into `note` because two of its fields are numbers a visitor reads
// against the floor, and because `queued: false` is an outcome with its own
// sentence rather than a failure.
type ProbeResult = {
  probed: boolean;
  pair: {
    pairId: string;
    originText: string;
    variantText: string;
    difficulty: string | null;
  } | null;
  floor?: number;
  queued?: boolean;
  sim?: number | null;
  matchedQuery?: string | null;
  remaining?: number;
  reason?: string;
};

// `configs` comes from the page's server render, the same list (open tabs then
// closed) every other panel gets.
export function PairBankPanel({ configs }: { configs: ConfigSummary[] }) {
  const [pairs, setPairs] = useState<PairsState | null>(null);
  // WHICH CONFIG THE GAP DESCRIBES — and nothing else here. The bank itself is
  // account-wide (a pair belongs to two question texts, not to a config), so this
  // scopes only the two things that read an eval bank: the gap, and the generate
  // run that fills it. Probe eligibility is per-config too, for a stronger
  // reason — an origin question has to have been ASKED under the current index.
  const [gapConfigId, setGapConfigId] = useState(configs[0]?.id ?? "");
  const [busy, setBusy] = useState<null | "pairs" | "screen" | "probe">(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // How many origin questions the next generate run covers. Null = untouched, so
  // the default tracks the gap as it shrinks instead of being pinned by an
  // effect the moment the stats first land.
  const [genLimit, setGenLimit] = useState<number | null>(null);
  // The last single probe, or null before one is run. Kept beside `note` rather
  // than inside it: a probe reports a similarity against a floor, and folding
  // numbers into a sentence is how the one live thing here would end up reading
  // like every other status line.
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  // The generate control's range and current position. Capped at the gap (asking
  // for more questions than exist just generates the gap) and at the inline
  // path's own ceiling, so the slider can never promise a run the server will
  // silently trim.
  //
  // WHAT IT COUNTS DEPENDS ON WHOSE PANEL THIS IS. For an account it is ORIGIN
  // QUESTIONS — the paid unit, each yielding PAIRS_PER_QUESTION pairs. A guest
  // writes nothing: the slider picks how many already-generated pairs to UNCOVER,
  // so its unit is PAIRS and its ceiling is the bank the publish left. It cannot
  // be `questionsRemaining` there — the clone gives every cloned question its
  // pairs, so that count is ~0 for a guest and the control would never render.
  const banked = pairs?.bankedRemaining ?? null;
  const genMax = Math.min(banked ?? pairs?.questionsRemaining ?? 0, GEN_MAX);
  // Whether this control WALKS A BANKED MEASUREMENT rather than buying one. Read
  // from the matrix being present at all rather than from any "is this a guest"
  // flag: the shelf says "there is something here to hand you", and a build
  // published without one must fall back to the ordinary control and its ordinary
  // 403. It is also what the panel's two remaining guest-visible differences key
  // off, and both are truth constraints rather than demo copy: the probe below is
  // hidden (nothing can bank an embedding), and the screen button drops "(batch)"
  // (nothing is submitted, so no job will ever appear in the Batch API panel to
  // track). The generate control itself is now worded exactly as an account's.
  const revealing = banked !== null;
  const genQuestions = Math.max(1, Math.min(genLimit ?? GEN_DEFAULT, genMax || 1));

  const load = useCallback(() => {
    if (!gapConfigId) return;
    // Scoped, because the GAP inside this payload is. apiFetch adds no configId
    // off a /c/<id> route, so this is the only one on the request.
    apiFetch(`/api/semantic-cache/pairs?configId=${encodeURIComponent(gapConfigId)}`)
      .then((r) => r.json())
      .then((d: PairsState & { error?: string }) => {
        // Drop a response that landed after the picker moved on, rather than
        // clearing state in an effect: `gap` carries the config it describes, so
        // the check is on the payload itself.
        if (!d.error && d.gap?.configId === gapConfigId) setPairs(d);
      })
      .catch(() => {});
  }, [gapConfigId]);

  useEffect(() => {
    load();
    window.addEventListener(SC_CHANGED, load);
    return () => window.removeEventListener(SC_CHANGED, load);
  }, [load]);

  // POST helper: one place for the busy flag and the error/note reset, so every
  // action can't drift on how it reports.
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
        | (Record<string, unknown> & { error?: string })
        | null;
      if (!res.ok || d?.error) {
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

  // The bank changed under the panels that read it. Broadcast rather than called
  // directly: the leaderboard and the queue subscribe to SC_CHANGED already, and
  // this panel no longer sits inside either of them.
  const announce = () => window.dispatchEvent(new Event(SC_CHANGED));

  const generate = async () => {
    // Explicit every time. The route's own default is 25 questions, so the
    // unlimited-looking button used to quietly do a fraction of the gap and
    // report a number that looked like a failure.
    // Scoped like the GET above, and for the same reason: generatePairs fills the
    // ACTIVE config's gap (so does the batch path — lib/batch/jobs/pairGeneration
    // calls the same query), so a run left unscoped would top up the Default
    // config's bank rather than the one the panel just priced.
    const d = await post(
      "pairs",
      `/api/semantic-cache/pairs?configId=${encodeURIComponent(gapConfigId)}`,
      { limit: genQuestions },
    );
    if (!d) return;
    // THE GUEST PATH WALKS A BANKED MEASUREMENT, IT DOES NOT BUY ONE. `limit`
    // means "how many pairs to bring into the set" rather than "how many origin
    // questions to write pairs for", which is why the counts below are pairs. The
    // pairs and their cosines were paid for once, on the operator's account, at
    // publish time; everything downstream of this click — the counts line, the
    // leaderboard, the pair-bank floor — then re-derives over the larger `n`,
    // which is real arithmetic and moves for real.
    if (d.mode === "revealed") {
      const revealed = Number(d.revealed);
      setNote(
        revealed === 0
          ? "Nothing left — every pair in the set is already here."
          : `Generated ${revealed} pair${revealed === 1 ? "" : "s"}` +
            `; ${d.remaining} still to go.`,
      );
      // The bank count rides in `remaining` rather than in `stats` (it describes
      // the shelf, not the pair table), so it is carried across by hand — without
      // it the slider would keep its old ceiling until the next GET.
      if (d.stats)
        setPairs({
          ...(d.stats as PairStats),
          bankedRemaining: Number(d.remaining),
        });
      load();
      announce();
      return;
    }
    if (d.mode === "batch") {
      setNote(
        d.job
          ? // The batch path screens with a SECOND batch rather than in-line —
            // thousands of sequential judge calls inside one apply step is what
            // batching exists to avoid. It is chained automatically, so the only
            // thing the user has to know is that the verdicts arrive later.
            "Submitted a batch — pairs land when it completes (Batch API panel tracks it), " +
            "and a judge screen is submitted automatically once they do. " +
            "Mislabelled pairs are quarantined when its verdicts arrive, and a " +
            "probe run stocks the would-hit queue at the same time."
          : String(d.reason ?? "Nothing to generate."),
      );
    } else {
      setNote(
        `Generated ${d.pairsInserted} pair(s) from ${d.questionsProcessed} question(s)` +
          (Number(d.skipped) > 0 ? `; ${d.skipped} skipped` : "") +
          // The screen is the reason the generator can be trusted at all, so its
          // count is reported rather than folded into "skipped": a rejected pair
          // is the gate working, not a question that produced nothing.
          (Number(d.screenedOut) > 0
            ? `; ${d.screenedOut} rejected by the judge as mislabelled.`
            : ".") +
          // What generation just did for the queue, or why it did nothing. The
          // route decides the wording (probeTriggerNote) so the batch path and
          // this one cannot drift apart; absent = nothing worth saying.
          (d.probeNote ? ` ${d.probeNote}` : ""),
      );
      if (d.stats) setPairs(d.stats as PairStats);
    }
    load();
    announce();
  };

  // Screen the pairs no judge has ruled on — the batch generator's output, and
  // anything generated before the screen existed. A second batch rather than an
  // inline pass for the reason the generation leg is batched at all: one judge
  // call per pair, at −50%, off the request's clock. Verdicts land on a later
  // poll; a contradicted pair is then quarantined rather than deleted, because
  // by this point the row exists.
  const screen = async () => {
    const d = await post("screen", "/api/batch/submit", { kind: "cache_pair_screen" });
    if (!d) return;
    // A GUEST'S SCREEN RESOLVES RATHER THAN SUBMITS (phase 3b): `{ job: null,
    // published: true, screened }`. Nothing lands on a later poll, so the wording
    // must not send anyone to the Batch API panel to wait for a job that does not
    // exist — the verdicts are already on the rows.
    if (d.published) {
      const s = d.screened as {
        resolved: number;
        quarantined: number;
        remaining: number;
      };
      setNote(
        `Filled in ${s.resolved} audited verdict${s.resolved === 1 ? "" : "s"}` +
          (s.quarantined > 0
            ? `; ${s.quarantined} pair${s.quarantined === 1 ? " was" : "s were"} labelled wrong and ${s.quarantined === 1 ? "is" : "are"} now quarantined out of the sweep.`
            : " — the judge agreed with every label.") +
          (s.remaining > 0 ? ` ${s.remaining} still to go.` : ""),
      );
      load();
      announce();
      return;
    }
    setNote(
      d.job
        ? "Submitted a judge screen — verdicts land when it completes (Batch API panel tracks it). " +
          "Pairs the judge contradicts are quarantined then."
        : String(d.reason ?? "Nothing to screen."),
    );
    load();
    announce();
  };

  // ONE PROBE. It embeds a single question variant and looks it up, landing one
  // UNJUDGED row in the would-hit queue; the bulk replay job fires itself after a
  // generate, which is why this is a button — a top-up you ask for, one row at a
  // time. Not offered while `revealing`: see the control below.
  const runProbe = async () => {
    const d = await post(
      "probe",
      `/api/semantic-cache/probe?configId=${encodeURIComponent(gapConfigId)}`,
      // NO BODY, deliberately, and the route parses none: the server picks the
      // pair. JSON.stringify(undefined) is undefined, so fetch sends nothing —
      // an empty object here would be the first byte of "one probe" becoming N.
      undefined,
    );
    if (!d) return;
    setProbe(d as unknown as ProbeResult);
    // The queue panel renders the row this landed in. It reloads on SC_CHANGED,
    // so without this the visitor is told a row is waiting and looks at a queue
    // that does not have it yet.
    announce();
  };

  // Hard negatives are what makes the leaderboard mean anything — a set that's
  // all 'same' grades every model identically at the top of its ranking.
  const noNegatives = pairs !== null && pairs.total > 0 && pairs.different === 0;

  return (
    <Panel
      title="Pair bank"
      about={ABOUT}
      subtitle="The labeled pair set the leaderboard scores and the probe replays."
      // WHOSE gap — the one thing on this panel that is per-config, and now that
      // the bank is its own section the picker can say so from the heading row
      // instead of hiding on the row it happens to move.
      action={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Gap for</span>
          <select
            value={gapConfigId}
            onChange={(e) => setGapConfigId(e.target.value)}
            aria-label="Config for the pair gap"
            className={SELECT}
          >
            {configs.length === 0 && <option value="">No configs</option>}
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} · {c.baseModel}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        <span className="text-zinc-500 dark:text-zinc-400">Pairs</span>
        <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
          {pairs
            ? `${pairs.total} generated (${pairs.same} same / ${pairs.different} different)`
            : "—"}
        </span>
        {/* Named, because this is the ONE count on the line that isn't
            account-wide — it belongs to the config in the picker above.
            NOT WHILE REVEALING, for the reason the two empty-gap sentences below
            are also suppressed: it prices the control a real account has, and the
            control on screen is not that one. A guest's gap is ~443 because the
            clone gave only the questions it copied their pairs, so this reads as
            "443 questions you could cover" beside a slider that cannot cover
            them — a number about the clone, dressed as a number about the bank. */}
        {!revealing && pairs && pairs.questionsRemaining > 0 && (
          <span className="text-zinc-400">
            · {pairs.questionsRemaining} eval question
            {pairs.questionsRemaining === 1 ? "" : "s"} in{" "}
            <span className="font-mono">{pairs.gap.configLabel}</span> with none yet
          </span>
        )}
        {/* Without this the count above reads as the set the sweep scores, which
            it is not once any row is quarantined — the audited-wrong rows are
            still generated, still occupy their origin question, and still count
            toward "generated"; they are simply no longer scored. */}
        {pairs && pairs.quarantined > 0 && (
          <span className="text-amber-600 dark:text-amber-500">
            · {pairs.quarantined} mislabelled, excluded from the sweep
          </span>
        )}
        {/* Unjudged is not "unlabelled" — these rows carry the generator's own
            label and the sweep scores them. It is the count of labels nothing
            has checked, which is exactly what the screen buys down. */}
        {pairs && pairs.unjudged > 0 && (
          <span className="text-zinc-400">· {pairs.unjudged} unscreened</span>
        )}
      </div>

      {/* --- generate ------------------------------------------------------- */}
      {/* How MANY questions the next run covers. Generation is the only paid step
          here, and it's per-question, so the size of the ask is a real decision —
          one button that took the route's invisible default meant the spend was
          neither chosen nor visible. */}
      {genMax > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <input
            type="range"
            min={1}
            max={genMax}
            value={genQuestions}
            onChange={(e) => setGenLimit(Number(e.target.value))}
            aria-label={revealing ? "Pairs to generate" : "Questions to generate pairs for"}
            disabled={busy !== null}
            className="h-1 w-40 min-w-32 max-w-full cursor-pointer accent-zinc-900 dark:accent-zinc-100"
          />
          {/* The two units are not interchangeable and the arithmetic between
              them only holds on the generating side: a question BUYS ~3 pairs, a
              walk into the matrix brings in exactly the number asked for.
              Printing "→ ~N pairs" over that would promise three times what
              lands. */}
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
              {genQuestions}
            </span>{" "}
            {revealing ? (
              <>
                of {banked} pair{banked === 1 ? "" : "s"}
              </>
            ) : (
              <>
                question{genQuestions === 1 ? "" : "s"} → ~
                <span className="tabular-nums">{genQuestions * PAIRS_PER_QUESTION}</span>{" "}
                pairs
              </>
            )}
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
          <button type="button" className={BTN} onClick={generate} disabled={busy !== null}>
            {busy === "pairs" ? "Generating…" : "Generate pairs"}
          </button>
        </div>
      )}
      {/* The generate control is gated on knowing the gap, so say so rather than
          rendering nothing — an empty space where a button was reads as "the
          feature is gone", not "the count hasn't arrived". */}
      {pairs === null && <p className="text-xs text-zinc-400">Loading pair stats…</p>}
      {/* A ZERO GAP HAS TWO CAUSES WITH OPPOSITE FIXES, and saying only the first
          one is what hid this control: the Appraise page carries no configId, so
          the gap described the Default config's EMPTY bank while the panel
          announced that every question was covered. `labeledQuestions` is the
          field that tells them apart. */}
      {/* NOT WHILE REVEALING. Both sentences below diagnose an empty GAP, and a
          guest's gap is empty for a third reason neither covers: the clone gave
          every question it copied its pairs. "Add eval questions to grow the set"
          would be advice about a control the demo does not offer, pointed at a
          problem the visitor does not have. */}
      {!revealing &&
        pairs !== null &&
        pairs.questionsRemaining === 0 &&
        (pairs.gap.labeledQuestions === 0 ? (
          <p className="text-xs text-zinc-400">
            <span className="font-mono">{pairs.gap.configLabel}</span> has no labeled
            eval questions — pairs are generated from a config&apos;s own eval bank, so
            pick a config that has one.
          </p>
        ) : (
          <p className="text-xs text-zinc-400">
            Every eval question in{" "}
            <span className="font-mono">{pairs.gap.configLabel}</span> already has pairs
            — add eval questions to grow the set.
          </p>
        ))}

      {/* --- screen --------------------------------------------------------- */}
      {/* Only offered when there is something to screen. Batch-generated pairs
          chain their own screen on apply, so a non-zero count here means a run
          that predates the chain — or one whose screen has not come back yet. */}
      {pairs !== null && pairs.unjudged > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
              {pairs.unjudged}
            </span>{" "}
            pair{pairs.unjudged === 1 ? "" : "s"} no judge has checked
          </span>
          <button type="button" className={BTN} onClick={screen} disabled={busy !== null}>
            {busy === "screen"
              ? revealing
                ? "Screening…"
                : "Submitting…"
              : revealing
                ? "Screen pairs"
                : "Screen pairs (batch)"}
          </button>
        </div>
      )}
      {/* --- probe ---------------------------------------------------------- */}
      {/* Draws from a pair and lands in the would-hit queue, so it sits at the
          foot of the bank that feeds it rather than in the queue that receives
          it: the pair is the input you are spending, and one is all it spends. */}
      {/* THE ONE THING A GUEST DOES NOT SEE (phase 5 of
          docs/demo-cache-replay-plan.md). Every other control on this page now
          replays a measurement the publish banked, but a probe has to EMBED a
          question variant and look it up live — there is no cosine a matrix could
          hold that stands in for it — and the pair TEXT it would embed left the
          clone with the pair rows. So it is hidden rather than replayed or left to
          fail, and hidden off `revealing` for the reason the generate control is
          sized off it: the shelf is what says a workspace is walking a banked
          measurement, and that is exactly the workspace with no text to probe. */}
      {!revealing && (
      <div className="flex flex-col gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            className={BTN}
            onClick={runProbe}
            disabled={busy !== null}
            title="Embeds one pair's variant question and looks it up in the cache. A row lands in the would-hit queue, unjudged."
          >
            {busy === "probe" ? "Probing…" : "Probe one pair"}
          </button>
          {/* The COST only. What the probe does is on the button's own tooltip,
              and it was said twice — once as a hint, once on hover — which is the
              standing prose this section had most of. */}
          <span className="text-xs text-zinc-400">Costs one embedding.</span>
        </div>
        {probe && <ProbeReport probe={probe} />}
      </div>
      )}

      {noNegatives && (
        <p className={NOTE_AMBER}>
          Every generated pair is labeled &ldquo;same&rdquo;. Without hard negatives
          the sweep can&apos;t separate models — they&apos;ll all look equally good.
        </p>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {note && <p className="text-xs text-green-700 dark:text-green-400">{note}</p>}
    </Panel>
  );
}

// What one probe did, in the terms the route reports it — and no others.
//
// THE COPY RULE THIS COMPONENT EXISTS TO HOLD: the matched question is the
// NEAREST one in the cache, which is not guaranteed to be the pair's origin
// (replayPairs' own caveat, and F1's dead-origin lesson). So it is labelled
// "nearest match" wherever it appears, and nothing here says "your pair,
// replayed" — a sentence that would be true most of the time and quietly wrong
// the rest of it.
//
// `queued: false` is an OUTCOME, not a failure: the nearest match fell below the
// shadow floor, so there was nothing worth logging. It gets a sentence of its
// own for the reason the floor exists — a 0.4 near-miss in the queue would be a
// row about the demo rather than about the cache.
function ProbeReport({ probe }: { probe: ProbeResult }) {
  if (!probe.probed || !probe.pair)
    return <p className="text-xs text-zinc-400">{probe.reason}</p>;
  const { pair } = probe;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800">
      <p className="text-zinc-600 dark:text-zinc-300">
        Asked: <span className="italic">&ldquo;{pair.variantText}&rdquo;</span>
        {pair.difficulty && (
          <span className="ml-1.5 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {pair.difficulty}
          </span>
        )}
      </p>
      {probe.queued ? (
        <p className="text-zinc-500 dark:text-zinc-400">
          Nearest cached question matched at{" "}
          <span className="tabular-nums text-zinc-800 dark:text-zinc-100">
            {probe.sim?.toFixed(4)}
          </span>
          {probe.matchedQuery && (
            <>
              {" "}
              — <span className="italic">&ldquo;{probe.matchedQuery}&rdquo;</span>
            </>
          )}
          {/* NOT "the queue above": the queue is its own section now and this
              panel no longer sits inside it, so the row is named rather than
              pointed at. A direction that goes stale on a reorder is worse than
              no direction. */}
          . It&apos;s in the would-hit queue with no verdict: nothing has judged it
          but you.
        </p>
      ) : (
        <p className="text-zinc-500 dark:text-zinc-400">
          Nothing cached came within the shadow floor
          {probe.floor !== undefined && (
            <>
              {" "}
              (<span className="tabular-nums">{probe.floor.toFixed(2)}</span>)
            </>
          )}
          , so no row was logged — a match this far off says nothing about the
          threshold.
        </p>
      )}
      {probe.remaining !== undefined && (
        <p className="text-zinc-400">
          {probe.remaining === 0
            ? "No more pairs are eligible to probe."
            : `${probe.remaining} more pair${probe.remaining === 1 ? "" : "s"} eligible.`}
        </p>
      )}
    </div>
  );
}
