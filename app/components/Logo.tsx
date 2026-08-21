// UI: the app mark, in the one place every screen takes it from.
//
// The drawing itself lives at design/logo/56-out-r-w52-soft.svg — the tile the
// logo board settled on — and design/logo/gen-app-assets.mjs re-emits it as the
// tab icon, the iOS icon, the link card, and the tile-less public/mark.svg this
// component points at. Re-run that script rather than hand-editing any of them.
//
// A plain <img> rather than next/image: the file is a fixed-size SVG, so there
// is no resizing or format negotiation for the optimizer to do, and the raw tag
// keeps this usable inside the signed-out shells without any config.

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    // Decorative in every current placement — the accessible name comes from
    // the wordmark or link text beside it, so announcing it again is noise.
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/mark.svg" alt="" aria-hidden width={size} height={size} className={className} />
  );
}

// Mark plus name. The signed-out screens have no other chrome to say where you
// are, and the sidebar uses it as its header.
// `textClassName` is how the name keeps up with the mark: the sidebar wants the
// lockup at row height, the signed-out screens want it as the page's masthead,
// and scaling the mark alone leaves the two out of proportion.
export function Wordmark({
  size = 22,
  textClassName = "text-sm",
  className,
}: {
  size?: number;
  textClassName?: string;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-2 ${className ?? ""}`}>
      <Logo size={size} />
      <span className={`font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 ${textClassName}`}>
        Ragurgitator
      </span>
    </span>
  );
}
