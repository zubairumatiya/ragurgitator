// Appraise → Semantic caching: THE place a threshold gets written. Every other
// panel only computes and displays; a number goes live here or nowhere, so there's
// one control to reason about instead of an apply button per calibration method.
// Rendered into the Collision floor section's FOOTER, directly under the first
// recommendation you'd apply. The would-hit queue recommends into it too.
//
// A footer strip and not the heading row it used to sit on: there it had to stay
// heading-height, which meant a nested bordered box around the controls and every
// status line stacked into a narrow right-aligned column above the numbers they
// were about. Full width instead, controls left and status right, matching the
// key-model panel's footer so both write controls look and sit the same.
//
// The target dropdown picks which LAYER the value lands in:
//   • a vector-space → semantic_cache_thresholds, inherited by every config on that
//     embedding model that hasn't overridden it;
//   • a config       → configs.batch_savings.semanticCache.threshold, an override
//     that wins over its space.
//
// Targets are encoded as "space:<name>" / "config:<uuid>" so one <select> can span
// both layers — "space vs config" and "which one" is a single decision.
"use client";

import { useCallback, useEffect, useState } from "react";

import { Tooltip } from "@/app/components/Tooltip";
import { apiFetch } from "@/lib/http/client";
import type { BatchSavings } from "@/lib/batch/types";
import type { ConfigSummary } from "@/lib/rag/configStore";
import type { ThresholdReport } from "@/lib/rag/semanticCacheCalibration";

import { SC_CHANGED, onRecommendation, type ThresholdRecommendation } from "./events";
import { BTN_PRIMARY } from "./Panel";

const TARGET_HELP =
  "The cosine a new question must reach against a cached one before its answer " +
  "is reused. Higher = fewer hits but safer; lower = more savings, more risk of " +
  "serving the wrong answer.\n\n" +
  "Space — the calibrated value for an embedding model's vector-space. " +
  "Every config using that model inherits it, unless it holds an override.\n\n" +
  "Config — an override for one config only. It wins over its space, and " +
  "is what Settings → Savings edits.";

// "" or anything outside 0..1 => null, which disables Apply. No percent
// shorthand: every number on this page is a raw cosine, so "94" is far likelier
// to be a slip than an intent.
function parseThreshold(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function ApplyThresholdPanel() {
  const [spaces, setSpaces] = useState<ThresholdReport[]>([]);
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [target, setTarget] = useState("");
  const [value, setValue] = useState("");
  // A config's live value, stamped with the target it was read for so a slow
  // response can never be shown against a different selection. Spaces need no
  // such state — they're already in `spaces` and derived during render below.
  const [configCurrent, setConfigCurrent] = useState<{ target: string; text: string } | null>(null);
  // Bumped after every write, to re-read the target we just changed.
  const [tick, setTick] = useState(0);
  const [rec, setRec] = useState<ThresholdRecommendation | null>(null);
  // Whether `value` came from the user rather than a recommendation — an
  // incoming recommendation must not overwrite something half-typed. Emptying
  // the box clears it, so clearing is how you opt back into prefills.
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const loadSpaces = useCallback(() => {
    apiFetch("/api/semantic-cache/thresholds")
      .then((r) => r.json())
      .then((d: { thresholds?: ThresholdReport[] }) => {
        const list = d.thresholds ?? [];
        setSpaces(list);
        setTarget((t) => t || (list[0] ? `space:${list[0].space}` : ""));
      })
      .catch(() => setSpaces([]));
  }, []);

  useEffect(() => {
    loadSpaces();
    apiFetch("/api/configs")
      .then((r) => r.json())
      .then((d) => setConfigs([...(d.open ?? []), ...(d.closed ?? [])]))
      .catch(() => setConfigs([]));
    window.addEventListener(SC_CHANGED, loadSpaces);
    return () => window.removeEventListener(SC_CHANGED, loadSpaces);
  }, [loadSpaces]);

  // A fresh recommendation retargets the panel at the space it was computed for
  // — applying a collision floor to some unrelated space is never the intent.
  useEffect(
    () =>
      onRecommendation((r) => {
        setRec(r);
        setDone(null);
        setTarget((t) => (t.startsWith("config:") ? t : `space:${r.space}`));
        if (!edited) setValue(String(r.value));
      }),
    [edited],
  );

  // A config target needs its own read: its override lives in the savings blob,
  // not the thresholds table. Nothing is set synchronously here — only from the
  // response — so the effect never cascades a render.
  useEffect(() => {
    if (!target.startsWith("config:")) return;
    let live = true;
    apiFetch(`/api/batch?configId=${encodeURIComponent(target.slice(7))}`)
      .then((r) => r.json())
      .then((d: { savings?: BatchSavings; inheritedThreshold?: { threshold: number } }) => {
        const own = d.savings?.semanticCache.threshold ?? null;
        const text =
          own !== null
            ? `${own.toFixed(3)} (override)`
            : d.inheritedThreshold
              ? `${d.inheritedThreshold.threshold.toFixed(3)} (inherited)`
              : null;
        if (live && text) setConfigCurrent({ target, text });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [target, tick]);

  const parsed = parseThreshold(value);
  const selectedSpace = target.startsWith("space:")
    ? spaces.find((s) => s.space === target.slice(6)) ?? null
    : null;
  // What the selected target serves at today, so applying is never done blind.
  const current = selectedSpace
    ? `${selectedSpace.threshold.toFixed(3)} (${selectedSpace.source})`
    : configCurrent?.target === target
      ? configCurrent.text
      : null;
  const label = target.startsWith("space:")
    ? target.slice(6)
    : configs.find((c) => c.id === target.slice(7))?.label ?? "config";

  const apply = () => {
    if (parsed === null || !target) return;
    setBusy(true);
    setError(null);
    setDone(null);

    // Provenance only survives an UNEDITED recommendation — once the number is
    // hand-changed the calibration no longer vouches for it.
    const fromRec = rec !== null && rec.value === parsed;
    const request = target.startsWith("space:")
      ? apiFetch("/api/semantic-cache/thresholds", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            space: target.slice(6),
            threshold: parsed,
            sampleSize: fromRec ? rec.sampleSize : null,
            notes: fromRec ? rec.notes : "manual",
          }),
        })
      : // Scoped to the SELECTED config, which needn't be the tab's active one,
        // so configId is passed explicitly instead of left to apiFetch.
        fetch(`/api/batch?configId=${encodeURIComponent(target.slice(7))}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ semanticCache: { threshold: parsed } }),
        });

    request
      .then((r) => r.json())
      .then((d: { error?: string }) => {
        if (d.error) return setError(d.error);
        setDone(`Applied ${parsed.toFixed(4)} to ${label}.`);
        setTick((t) => t + 1);
        window.dispatchEvent(new Event(SC_CHANGED));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  // Clearing a config's override sends null — the config falls back to its
  // space. Meaningless for a space target, which has no layer to fall back to.
  const clearOverride = () => {
    if (!target.startsWith("config:")) return;
    setBusy(true);
    setError(null);
    setDone(null);
    fetch(`/api/batch?configId=${encodeURIComponent(target.slice(7))}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ semanticCache: { threshold: null } }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => {
        if (d.error) return setError(d.error);
        setValue("");
        setEdited(false);
        setDone(`${label} now inherits its space.`);
        setTick((t) => t + 1);
        window.dispatchEvent(new Event(SC_CHANGED));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    // A fragment, not a box: the two halves are direct children of the Panel
    // footer's `justify-between` row, so the controls sit left and the status
    // text right, on ONE line whenever the card is wide enough for it.
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tooltip align="left" text={TARGET_HELP}>
          <span className="text-xs font-medium text-zinc-500 underline decoration-dotted underline-offset-2 dark:text-zinc-400">
            Set threshold
          </span>
        </Tooltip>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setEdited(e.target.value.trim() !== "");
            setDone(null);
          }}
          placeholder="0.950"
          aria-label="Threshold"
          className="w-20 rounded-md border border-zinc-300 bg-white px-2 py-1 text-right text-xs tabular-nums text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
        />
        <span className="text-xs text-zinc-400">to</span>
        <select
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setDone(null);
          }}
          aria-label="Apply to"
          className="max-w-52 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
        >
          {spaces.length === 0 && configs.length === 0 && <option value="">Nothing yet</option>}
          {spaces.length > 0 && (
            <optgroup label="Space (all configs on this model)">
              {spaces.map((s) => (
                <option key={s.space} value={`space:${s.space}`}>
                  {s.space}
                </option>
              ))}
            </optgroup>
          )}
          {configs.length > 0 && (
            <optgroup label="Config (override, this config only)">
              {configs.map((c) => (
                <option key={c.id} value={`config:${c.id}`}>
                  {c.label} · {c.baseModel}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        <button
          type="button"
          onClick={apply}
          disabled={busy || parsed === null || !target}
          className={BTN_PRIMARY}
        >
          {busy ? "Applying…" : "Apply"}
        </button>
      </div>

      {/* Inline and separated by dots rather than stacked: in a full-width strip
          these are short clauses, and stacking them re-grew the footer by a line
          per state. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-snug empty:hidden">
        {current && (
          <p className="text-zinc-500 dark:text-zinc-400">
            <span className="font-mono">{label}</span> serves at{" "}
            <span className="tabular-nums">{current}</span>
          </p>
        )}

        {/* Recommendations arrive from the calibration panels — the collision
            floor this footer belongs to, and the would-hit queue below. Nothing is
            live until Apply, so this is a suggestion to take, edit, or ignore. */}
        {rec && parsed !== rec.value && (
          <p className="text-zinc-500 dark:text-zinc-400">
            {rec.origin} suggests{" "}
            <button
              type="button"
              onClick={() => {
                setValue(String(rec.value));
                setEdited(false);
                setDone(null);
              }}
              className="tabular-nums text-zinc-700 underline underline-offset-2 cursor-pointer hover:text-black dark:text-zinc-300 dark:hover:text-white"
            >
              {rec.value.toFixed(4)}
            </button>{" "}
            for <span className="font-mono">{rec.space}</span>
          </p>
        )}

        {target.startsWith("config:") && (
          <button
            type="button"
            onClick={clearOverride}
            disabled={busy}
            className="text-zinc-400 underline underline-offset-2 cursor-pointer hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-zinc-200"
          >
            Clear override
          </button>
        )}

        {value.trim() !== "" && parsed === null && (
          <p className="text-amber-700 dark:text-amber-300">Enter a cosine between 0 and 1.</p>
        )}
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        {done && <p className="text-green-700 dark:text-green-400">{done}</p>}
      </div>
    </>
  );
}
