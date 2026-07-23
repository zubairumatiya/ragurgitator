// Sub-nav for the Appraise section (a peer group of the config tabs). Turns
// /appraise into a small section with its own pages: the cross-config metrics
// table and the semantic-cache calibration page. Client Component so it can
// highlight the active tab from the pathname.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/appraise", label: "Config metrics" },
  { href: "/appraise/semantic-cache", label: "Semantic caching" },
];

export function AppraiseNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "-mb-px border-b-2 border-zinc-900 px-3 py-2 text-sm font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
