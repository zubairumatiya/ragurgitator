// UI: a "?" affordance that parks explanatory prose in a hover tooltip instead
// of a paragraph under every heading. Use it where the copy is worth having but
// isn't worth the vertical space on a dense page — the text still has to earn
// its place, it just stops pushing the data down the screen.
//
// Thin wrapper over Tooltip: same instant-hover behaviour, same `align` for
// headings that sit near a container edge.
import { Tooltip } from "@/app/components/Tooltip";

export function InfoDot({
  text,
  align = "left",
}: {
  text: string;
  align?: "center" | "left" | "right";
}) {
  return (
    <Tooltip text={text} align={align}>
      <span
        aria-label="More information"
        role="img"
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-zinc-300 text-[9px] font-semibold leading-none text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-zinc-500 dark:hover:text-zinc-300"
      >
        ?
      </span>
    </Tooltip>
  );
}
