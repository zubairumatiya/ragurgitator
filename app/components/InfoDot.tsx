// UI: a "?" affordance that parks explanatory prose in a hover tooltip instead
// of a paragraph under every heading. Use it where the copy is worth having but
// isn't worth the vertical space on a dense page — the text still has to earn
// its place, it just stops pushing the data down the screen.
//
// Thin wrapper over Tooltip: same instant-hover behaviour, same `align` for
// headings that sit near a container edge.
//
// A BUTTON, not a decorative span. It was role="img", which is unreachable by
// keyboard and inert on touch — fine while the hidden copy was a gloss on a
// metric, not fine now that /account keeps its BYOK caveats in here. As a button
// it takes focus, which opens the bubble via Tooltip's group-focus-within, and
// aria-describedby hands the same text to a screen reader rather than making it
// re-derive the text from a hover state it cannot enter. type="button" because
// these sit inside <form> elements on /account and must not submit them.
//
// "use client" is the price of useId, which is a hook and so cannot run in the
// Server Components that render this (/usage, /cache, /account). Cheap: the
// component ships no state and no effects, and the id has to be generated
// somewhere stable enough for aria-describedby to point at the right bubble
// when several dots share a page.
"use client";

import { useId } from "react";

import { Tooltip } from "@/app/components/Tooltip";

export function InfoDot({
  text,
  align = "left",
}: {
  text: string;
  align?: "center" | "left" | "right";
}) {
  const id = useId();

  return (
    <Tooltip text={text} align={align} describedById={id}>
      <button
        type="button"
        aria-label="More information"
        aria-describedby={id}
        className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-zinc-300 text-[9px] font-semibold leading-none text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-700 focus-visible:border-zinc-500 focus-visible:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-zinc-500 dark:hover:text-zinc-300 dark:focus-visible:border-zinc-500 dark:focus-visible:text-zinc-300"
      >
        ?
      </button>
    </Tooltip>
  );
}
