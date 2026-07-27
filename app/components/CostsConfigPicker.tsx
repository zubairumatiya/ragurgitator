// Scope selector for the Costs page: all configs (the account-wide rollup) or
// one config. The choice lives in the URL (?configId=…) rather than in React
// state so the page stays a Server Component — getCostsReport re-runs on the
// server with the WHERE clause, and the scoped view is linkable/refreshable.
//
// replace() rather than push(): flipping the scope is a filter, not a place, so
// it shouldn't stack up history entries between you and the back button.
"use client";

import { useRouter } from "next/navigation";

import type { ConfigSummary } from "@/lib/rag/configStore";

export function CostsConfigPicker({
  configs,
  value,
}: {
  configs: ConfigSummary[];
  value: string; // "" = all configs
}) {
  const router = useRouter();

  return (
    <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      Scope
      <select
        value={value}
        onChange={(e) =>
          router.replace(
            e.target.value ? `/appraise/costs?configId=${encodeURIComponent(e.target.value)}` : "/appraise/costs",
          )
        }
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
      >
        <option value="">All configs</option>
        {configs.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} · {c.baseModel}
          </option>
        ))}
      </select>
    </label>
  );
}
