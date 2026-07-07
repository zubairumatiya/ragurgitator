"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { EvalSettings } from "@/app/components/EvalSettings";

// The nested sub-nav inside a config tab: the three peer views, scoped to the
// active config (/c/[configId], …/eval, …/clusters). Order = display order.
// (The cross-config tab bar lives above this in ConfigTabs.) The hrefs are built
// per-config so switching tabs keeps you on the same view. The config Settings
// dropdown sits on the right, apart from the tabs — it applies to the whole
// config, not one view.
const LINKS = [
  { segment: "", label: "Playground" },
  { segment: "clusters", label: "Clusters" },
  { segment: "eval", label: "Evals" },
] as const;

// Segmented tab switcher shared by every config page. Reads the active configId
// from the route so it works under any tab without prop threading.
export function Nav() {
  const pathname = usePathname();
  const { configId } = useParams<{ configId: string }>();
  const base = `/c/${configId}`;

  return (
    <div className="flex w-full items-center justify-between gap-3">
      <nav className="inline-flex items-center gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
        {LINKS.map(({ segment, label }) => {
          const href = segment ? `${base}/${segment}` : base;
          const active = segment ? pathname.startsWith(href) : pathname === base;
          return (
            <Link
              key={label}
              href={href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-md bg-white px-3 py-1 text-sm font-medium text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                  : "rounded-md px-3 py-1 text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
              }
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <EvalSettings />
    </div>
  );
}
