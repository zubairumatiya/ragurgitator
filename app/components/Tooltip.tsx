// ---------------------------------------------------------------------------
// UI: instant hover tooltip. The native `title` attribute waits on an
// OS-controlled delay (~1s) before showing; this is a pure-CSS replacement
// that fades in after ~150ms and hides immediately on mouse-out. Renders
// inline (span) so it can wrap chips, labels, or whole cards inside flex rows;
// `align` anchors the bubble when the trigger sits near a container edge.
// ---------------------------------------------------------------------------
import type { ReactNode } from "react";

export function Tooltip({
  text,
  align = "center",
  children,
}: {
  text: string;
  align?: "center" | "left";
  children: ReactNode;
}) {
  return (
    <span className="group relative inline-flex cursor-help">
      {children}
      <span
        className={`pointer-events-none absolute top-full z-30 mt-1 w-max max-w-72 whitespace-pre-line rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-left text-xs font-normal normal-case tracking-normal text-zinc-700 opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-hover:delay-150 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 ${
          align === "center" ? "left-1/2 -translate-x-1/2" : "left-0"
        }`}
      >
        {text}
      </span>
    </span>
  );
}
