"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The app's three peer destinations. Order = display order.
const LINKS = [
  { href: "/", label: "Playground" },
  { href: "/clusters", label: "Clusters" },
  { href: "/eval", label: "Evals" },
] as const;

// Segmented tab switcher shared by every page. Replaces the old ←/→ links,
// which implied a back/forward sequence between what are really sibling pages
// and never showed which page you were on.
export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="inline-flex items-center gap-1 self-start rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
      {LINKS.map(({ href, label }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
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
  );
}
