// UI: instant hover tooltip. The native `title` attribute waits on an
// OS-controlled delay (~1s) before showing; this is a pure-CSS replacement
// that fades in after ~150ms and hides immediately on mouse-out. Renders
// inline (span) so it can wrap chips, labels, or whole cards inside flex rows;
// `align` anchors the bubble when the trigger sits near a container edge —
// "left"/"right" pin that edge of the bubble to the trigger so it grows inward.
//
// NOT HOVER-ONLY. group-focus-within opens the same bubble, so a focusable
// trigger (see InfoDot) reaches it by keyboard and by tap — a pointer has no
// hover state on touch, and copy only a mouse can read is copy that is missing
// for everyone else. That matters most where the hidden text is a caveat rather
// than a nicety, which is exactly what /account puts in here.
import type { ReactNode } from "react";

// `className` is for sizing the trigger inside a flex row — a truncating label
// needs `min-w-0 flex-1` on this span, not just on the text inside it.
export function Tooltip({
  text,
  align = "center",
  className = "",
  describedById,
  children,
}: {
  text: string;
  align?: "center" | "left" | "right";
  className?: string;
  // Set by a trigger that points aria-describedby at the bubble, so the text is
  // announced rather than left to a hover a screen reader never performs.
  describedById?: string;
  children: ReactNode;
}) {
  return (
    <span className={`group relative inline-flex cursor-help ${className}`}>
      {children}
      <span
        id={describedById}
        className={`pointer-events-none absolute top-full z-30 mt-1 w-max max-w-72 whitespace-pre-line rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-left text-xs font-normal normal-case tracking-normal text-zinc-700 opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-hover:delay-150 group-focus-within:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 ${
          align === "center"
            ? "left-1/2 -translate-x-1/2"
            : align === "right"
              ? "right-0"
              : "left-0"
        }`}
      >
        {text}
      </span>
    </span>
  );
}
