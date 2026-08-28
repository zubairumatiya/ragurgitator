// WHAT THE PRECISION TARGET COSTS — the business axis, beside the slider that
// moves it.
//
// The rest of this page optimizes precision and never showed the price. Drag the
// target from 99% to 95% and every number on screen moves — τ, recall, the
// leaderboard's order — but none of them says the only thing the decision is
// actually about: how many questions get served, and what that is worth.
//
// So this reads the SAME dragged target through the config's live key model: the
// τ that model is held to at this precision, run against the space's traffic
// census (lib/rag/cacheEconomicsCore.ts). One line of arithmetic, no request —
// the census came down with the panel's status read, and every position of the
// slider is derived from it locally.
//
// TWO NUMBERS, NOT ONE. The hit rate is the honest measurement; the money is
// derived from it and from the ledger's realized dollars-per-hit, so it is never
// a modelled price and disappears entirely until a hit has actually been served.
//
// It is deliberately NOT a recommendation. A lower target serves more and saves
// more, always — the constraint that stops you is precision, which is the number
// the slider already shows. This is the other half of that trade, not an argument
// for either end of it.
"use client";

import { Tooltip } from "@/app/components/Tooltip";
import {
  censusCeiling,
  payoffAt,
  REFERENCE_HIT_RATE,
  type CacheEconomics,
} from "@/lib/rag/cacheEconomicsCore";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
// Sub-cent sums are the norm here (a served hit is worth ~$0.004), and a plain
// two-decimal format renders most of them as "$0.00" — which reads as "nothing"
// rather than "less than a cent".
const usd = (v: number) => (v > 0 && v < 0.005 ? "<$0.01" : `$${v.toFixed(2)}`);

const ABOUT =
  "What this precision target costs in served questions, for the space the " +
  "cache actually serves from.\n\n" +
  "REAL TRAFFIC ONLY — questions someone actually asked, counted from the " +
  "shadow census. The pair bank never enters it, so this shares no population " +
  "with the recall and precision columns in the table above.\n\n" +
  "HIT RATE — of every question this cache has seen, the share τ would serve. " +
  "The denominator is banked answers (questions that missed) plus the " +
  "questions served at today's threshold, so it counts each question once and " +
  "does not move when τ does.\n\n" +
  "It is a LOWER BOUND. A question banked under two answering models counts " +
  "twice, a repeated question that hits is counted once, and matches below the " +
  "shadow-log floor were never recorded at all.\n\n" +
  "SAVED — the hit count times the realized dollars per hit from the savings " +
  "ledger, the same total the Costs page itemizes. Never a modelled price: " +
  "with no served hit yet, there is no money line.";

export function PayoffReadout({
  econ,
  tau,
  keyModel,
  atTarget,
}: {
  econ: CacheEconomics;
  // τ for the LIVE key model at the dragged target — null when it reaches no
  // threshold there at all, which is itself the answer: that target serves
  // nothing.
  tau: number | null;
  keyModel: string;
  // Whether that τ actually met the target, or is the model's best attainable
  // point (the table's ✳). A payoff read off a τ that missed the target is a
  // real number about an operating point nobody chose, so it says which it is.
  atTarget: boolean;
}) {
  const now = payoffAt(econ, econ.liveThreshold);
  const at = tau === null ? null : payoffAt(econ, tau);
  // The most any τ could serve — see censusCeiling. Read once, not per position:
  // it is a property of the traffic, and the whole point of showing it is that
  // dragging the slider does not move it.
  const ceiling = censusCeiling(econ);

  // No questions have reached this cache in this space — every rate below would
  // be 0/0. Says which of the two halves is empty, since "nothing banked" and
  // "nothing served" have different fixes.
  if (now === null) {
    return (
      <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
        No questions have reached the cache in{" "}
        <span className="font-mono">{econ.space}</span> yet — ask some, and this
        says what each precision target would have served.
      </p>
    );
  }

  const shown = at ?? now;
  const delta = at === null ? 0 : at.served - now.served;

  return (
    <div className="flex flex-col gap-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <Tooltip align="left" text={ABOUT}>
          {/* NAMES ITS POPULATION, because the numbers either side of it do not
              share one: recall@τ and precision in the table are over the labeled
              pair set, and this is over traffic. Unlabelled, a 100% recall above
              a 21% hit rate reads as the panel contradicting itself. */}
          <span className="text-zinc-500 underline decoration-dotted underline-offset-2 dark:text-zinc-400">
            Which serves <span className="text-zinc-400 dark:text-zinc-500">(real traffic)</span>
          </span>
        </Tooltip>

        {at === null ? (
          <span className="text-amber-700 dark:text-amber-400">
            nothing — <span className="font-mono">{keyModel}</span> reaches no τ at
            this target, so every question would be answered from scratch.
          </span>
        ) : (
          <>
            <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
              {pct(at.hitRate)}
            </span>
            <span className="text-zinc-500 dark:text-zinc-400">
              of{" "}
              <span className="tabular-nums">{at.questionsSeen.toLocaleString()}</span>{" "}
              questions seen —{" "}
              <span className="tabular-nums">{at.served.toLocaleString()}</span> served
              at τ <span className="tabular-nums">{at.tau.toFixed(3)}</span> in{" "}
              <span className="font-mono">{econ.space}</span>
              {!atTarget && " (best attainable, ✳)"}
            </span>
            {at.savedUsd !== null && (
              <span className="text-zinc-500 dark:text-zinc-400">
                ·{" "}
                <span className="tabular-nums text-zinc-700 dark:text-zinc-200">
                  {usd(at.savedUsd)}
                </span>{" "}
                saved, {usd(at.perThousandUsd!)} per 1,000 questions
              </span>
            )}
          </>
        )}
      </div>

      <Band rate={shown.hitRate} />

      {/* THE CEILING. Without it the panel looks broken at the bottom of the
          slider: recall@τ reads 100% while the hit rate stalls around a fifth,
          and the two are over different populations — recall over the labeled
          pairs, this over traffic. The reconciling fact is that most questions
          never arrived near anything cached — within the measured range, since
          the census itself starts at the floor. */}
      {ceiling !== null && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Ceiling <span className="tabular-nums">{pct(ceiling.rate)}</span> above the
          floor — only{" "}
          <span className="tabular-nums">{ceiling.matched.toLocaleString()}</span> of{" "}
          <span className="tabular-nums">{shown.questionsSeen.toLocaleString()}</span>{" "}
          questions arrived within{" "}
          <span className="tabular-nums">{econ.censusFloor.toFixed(2)}</span> of a
          cached one, so no τ in the swept range reaches the rest. A τ under the
          floor would serve more, unmeasured.
        </p>
      )}

      {/* WHAT MOVING THE SLIDER DID, in questions. The absolute rate answers "is
          this cache any good"; only the delta answers "what did that drag just
          cost me", and that is the question the control in front of it asks. */}
      {at !== null && delta !== 0 && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          {delta > 0 ? "+" : "−"}
          <span className="tabular-nums">{Math.abs(delta)}</span> question
          {Math.abs(delta) === 1 ? "" : "s"} against today&apos;s live{" "}
          <span className="tabular-nums">{econ.liveThreshold.toFixed(3)}</span>, which
          serves <span className="tabular-nums">{pct(now.hitRate)}</span>
          {now.savedUsd !== null && at.savedUsd !== null && (
            <>
              {" "}
              ({delta > 0 ? "+" : "−"}
              {usd(Math.abs(at.savedUsd - now.savedUsd))})
            </>
          )}
          . Nothing is live until it is applied in the Threshold section.
        </p>
      )}

      {/* The two things that make the number a lower bound and are worth acting
          on, rather than the full list — that is in the tooltip. */}
      <p className="text-[11px] text-zinc-400 dark:text-zinc-500 empty:hidden">
        {at?.belowCensusFloor && (
          <>
            τ is below the {econ.censusFloor.toFixed(2)} shadow-log floor, where
            matches were never recorded — the count above is a lower bound, not a
            measurement.{" "}
          </>
        )}
        {econ.guardBlocked > 0 && (
          <>
            The entity guard refused{" "}
            <span className="tabular-nums">{econ.guardBlocked}</span> further match
            {econ.guardBlocked === 1 ? "" : "es"} outright, at any τ.{" "}
          </>
        )}
        {econ.savedPerHitUsd === null && (
          <>
            No hit has been priced yet, so there is no money line — the ledger gets
            its first dollars-per-hit the first time the cache serves.
          </>
        )}
      </p>
    </div>
  );
}

// The hit rate on a 0–100% track, against the band production caches report.
//
// Context, not a target — which is why the band is drawn recessive and the marker
// is the only thing with weight. A workbench asking mostly novel eval questions
// belongs well below it, and a reader who cannot see where the published numbers
// sit has no way to tell that from a broken cache.
function Band({ rate }: { rate: number }) {
  const lo = REFERENCE_HIT_RATE.low * 100;
  const hi = REFERENCE_HIT_RATE.high * 100;
  return (
    <div className="flex items-center gap-2">
      {/* Capped: at full card width the track is ~700px of context under a
          one-line number, which inverts their importance. */}
      <div className="relative h-2 w-full min-w-24 max-w-sm">
        <div className="absolute inset-0 rounded-full bg-zinc-100 dark:bg-zinc-800" />
        <div
          className="absolute inset-y-0 bg-emerald-500/15 dark:bg-emerald-400/20"
          style={{ left: `${lo}%`, width: `${hi - lo}%` }}
        />
        <div
          className="absolute -top-0.5 h-3 w-0.5 -translate-x-1/2 rounded-full bg-zinc-900 ring-2 ring-white dark:bg-zinc-100 dark:ring-zinc-950"
          style={{ left: `${Math.min(100, Math.max(0, rate * 100))}%` }}
        />
      </div>
      <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
        production caches report {lo}–{hi}%
      </span>
    </div>
  );
}
