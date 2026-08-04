// Scope selector for the Appraise pages that read one config at a time: all
// configs (the account-wide rollup) or one config. The choice lives in the URL
// (?configId=…) rather than in React state so the page stays a Server Component
// — the report re-runs on the server with the WHERE clause, and the scoped view
// is linkable/refreshable.
//
// replace() rather than push(): flipping the scope is a filter, not a place, so
// it shouldn't stack up history entries between you and the back button.
//
// `basePath` and `allowAll` exist because Trial times reuses this: autotune
// timings are per-config (a duration only means something next to runs over the
// same workload), so that page pins to one config and has no all-configs
// reading to offer.
"use client";

import { useRouter } from "next/navigation";

import type { ConfigSummary } from "@/lib/rag/configStore";

export function CostsConfigPicker({
  configs,
  value,
  basePath = "/appraise/costs",
  allowAll = true,
}: {
  configs: ConfigSummary[];
  value: string; // "" = all configs (only reachable when allowAll)
  basePath?: string;
  allowAll?: boolean;
}) {
  const router = useRouter();

  return (
    <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      Scope
      <select
        value={value}
        onChange={(e) =>
          router.replace(
            e.target.value
              ? `${basePath}?configId=${encodeURIComponent(e.target.value)}`
              : basePath,
          )
        }
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
      >
        {allowAll && <option value="">All configs</option>}
        {configs.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} · {c.baseModel}
          </option>
        ))}
      </select>
    </label>
  );
}
