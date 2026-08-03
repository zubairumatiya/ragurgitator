// Appraise → Models: the cost/quality scatter.
//
// This is the one view a table can't give you — "is voyage-4-large worth 6×
// voyage-4-lite?" is a position on a plane, not two numbers in adjacent columns.
// It was deferred while every model sat at recall 1.000 (a flat line reads as a
// broken chart, not as "no data"); the full-corpus replay gave the y-axis real
// spread, so it earns its place now.
//
// COLOR: one series, not seven. Identity comes from direct labels on every
// point, so hue is free to carry one thing — whether a model is the config's
// current base. Seven categorical hues would also be flatly wrong here: a
// scatter compares ALL pairs, and no eight-hue ordering clears the colorblind
// separation floors on all pairs at once (dataviz skill, references/palette.md).
//
// Palette validated with the skill's validator in BOTH modes against the real
// surfaces (light #fcfcfb, dark #1a1a19), --pairs all:
//   neutral #71717a — lightness band, contrast >= 3:1, both modes
//   accent  #2a78d6 light / #3987e5 dark — CVD dE 14.6 light / 16.3 dark
// The chroma-floor FAIL on the neutral is intentional and out of scope: it reads
// gray BECAUSE it isn't encoding identity. Don't "fix" it by adding hues.
//
// Server Component: no JS, so the hover layer is a native SVG <title> per mark.
// The table above is the required table view.
import type { ReplayRow } from "@/lib/rag/replayStore";
import { embedRate } from "@/lib/rag/pricing";

// Plot geometry. viewBox units; the SVG scales to its container width.
const W = 720;
const H = 340;
const PAD = { top: 18, right: 26, bottom: 46, left: 58 };

type Point = { model: string; x: number; y: number; isBase: boolean };

export function ModelCostQualityChart({
  rows,
  baseModel,
}: {
  rows: ReplayRow[];
  baseModel: string | null;
}) {
  // Only models with BOTH a quality score and a price we'd stand behind can be
  // placed. An unverified price has no defensible x position, and plotting it
  // at a guessed one would be the chart telling a lie the table refuses to.
  const points: Point[] = [];
  for (const r of rows) {
    if (r.mrr === null) continue;
    const rate = embedRate(r.model);
    if (!rate || !rate.verified) continue;
    points.push({ model: r.model, x: rate.usdPerM, y: r.mrr, isBase: r.model === baseModel });
  }
  if (points.length < 2) return null;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  // x starts at 0: price is a magnitude, and a truncated cost axis would
  // exaggerate the gap between a $0.02 and a $0.06 model.
  const xMax = Math.max(...xs) * 1.12;
  // y is NOT zero-based — these are all high scores and a 0..1 axis would flatten
  // the differences the chart exists to show. Padded so no point sits on a wall.
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yPad = Math.max((yMax - yMin) * 0.25, 0.01);
  const y0 = yMin - yPad;
  const y1 = yMax + yPad;

  const px = (x: number) => PAD.left + (x / xMax) * (W - PAD.left - PAD.right);
  const py = (y: number) =>
    PAD.top + (1 - (y - y0) / (y1 - y0)) * (H - PAD.top - PAD.bottom);

  // Ticks come from the padded ranges, so a tick can't sit outside the plot.
  const yTicks = niceTicks(y0, y1, 4);
  const xTicks = niceTicks(0, xMax, 4);
  // Enough decimals that two adjacent ticks never print the same label. The two
  // axes decide independently — prices are cents, MRR is a fraction.
  const decimalsFor = (t: number[]) => ((t.length > 1 ? t[1] - t[0] : 1) < 0.01 ? 3 : 2);
  const yDecimals = decimalsFor(yTicks);
  const xDecimals = decimalsFor(xTicks);

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Cost versus quality for ${points.length} embedding models. ${points
          .map((p) => `${p.model}: $${p.x.toFixed(2)} per million tokens, MRR ${p.y.toFixed(3)}`)
          .join(". ")}`}
      >
        {/* Recessive grid — never competes with the marks. */}
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={py(t)}
              y2={py(t)}
              className="stroke-zinc-200 dark:stroke-zinc-800"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 10}
              y={py(t) + 4}
              textAnchor="end"
              className="fill-zinc-500 text-[11px] dark:fill-zinc-400"
            >
              {t.toFixed(yDecimals)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text
            key={`x${t}`}
            x={px(t)}
            y={H - PAD.bottom + 20}
            textAnchor="middle"
            className="fill-zinc-500 text-[11px] dark:fill-zinc-400"
          >
            ${t.toFixed(xDecimals)}
          </text>
        ))}

        {/* Axis titles. Text wears text tokens, never a series color. */}
        <text
          x={PAD.left + (W - PAD.left - PAD.right) / 2}
          y={H - 8}
          textAnchor="middle"
          className="fill-zinc-500 text-[11px] dark:fill-zinc-400"
        >
          $ per 1M tokens →
        </text>
        <text
          transform={`translate(14 ${PAD.top + (H - PAD.top - PAD.bottom) / 2}) rotate(-90)`}
          textAnchor="middle"
          className="fill-zinc-500 text-[11px] dark:fill-zinc-400"
        >
          MRR →
        </text>

        {points.map((p) => {
          // Label right by default; flip left near the right edge so it can't
          // run outside the plot. 7 points at 4 distinct prices — the vertical
          // spread keeps same-x labels from colliding.
          const flip = px(p.x) > W - PAD.right - 130;
          return (
            <g key={p.model}>
              {/* 2px surface ring: marks overlap at shared price points, and the
                  ring keeps them readable where they touch. */}
              <circle
                cx={px(p.x)}
                cy={py(p.y)}
                r={6}
                strokeWidth={2}
                className={
                  p.isBase
                    ? "fill-[#2a78d6] stroke-[#fcfcfb] dark:fill-[#3987e5] dark:stroke-[#1a1a19]"
                    : "fill-[#71717a] stroke-[#fcfcfb] dark:stroke-[#1a1a19]"
                }
              >
                <title>
                  {p.model} — ${p.x.toFixed(2)}/1M, MRR {p.y.toFixed(3)}
                  {p.isBase ? " (in use)" : ""}
                </title>
              </circle>
              <text
                x={px(p.x) + (flip ? -12 : 12)}
                y={py(p.y) + 4}
                textAnchor={flip ? "end" : "start"}
                className={
                  p.isBase
                    ? "fill-zinc-900 text-[11px] font-semibold dark:fill-zinc-100"
                    : "fill-zinc-600 text-[11px] dark:fill-zinc-400"
                }
              >
                {p.model}
                {p.isBase ? " (in use)" : ""}
              </text>
            </g>
          );
        })}
      </svg>

      <figcaption className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        Up and to the left is better quality per dollar. Models priced but not
        scored, or scored without a price we&apos;d quote, are omitted — see the
        table above.
      </figcaption>
    </figure>
  );
}

// Ticks on ROUND values, not evenly-divided ones.
//
// Dividing the range into n equal parts and printing each to 2dp puts a gridline
// labelled "$0.05" at $0.0504 and one labelled "0.78" at 0.77975. The error is
// invisible, which is exactly why it's worth removing: an axis that rounds its
// own labels is a chart quietly misreporting where its gridlines are.
//
// Snap the step up to the nearest 1/2/5 × 10^n, then walk round multiples of it.
function niceTicks(lo: number, hi: number, target: number): number[] {
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // Pick the candidate whose tick COUNT lands nearest the target, rather than the
  // first step >= raw — that rule always rounds up and can halve the ticks (a
  // $0..$0.20 axis gets 3 labels instead of 5). Ties prefer the finer step.
  const candidates = [1, 2, 5, 10].map((m) => m * mag);
  const step = candidates.reduce((best, s) =>
    Math.abs((hi - lo) / s - target) < Math.abs((hi - lo) / best - target) ? s : best,
  );

  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) {
    // Re-round each step: repeated addition of e.g. 0.05 drifts in binary float,
    // and a tick at 0.15000000000000002 formats fine but positions marginally off.
    out.push(Number(t.toFixed(10)));
  }
  return out;
}
