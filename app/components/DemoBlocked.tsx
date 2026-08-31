"use client";

// WHAT THE DEMO WON'T LET YOU PRESS, on the client side of the wire.
//
// §5 of docs/demo-real-flow-plan.md: confirmed in a browser on a live guest that
// EVERY gated control rendered enabled and answered with a 403 from three layers
// down — "Add nDCG rankings", "Add LLM nDCG rankings", "Change base model…",
// "Adjust chunk size / overlap…", "Try a different configuration". A visitor who
// presses one learns that the workbench is broken, which is the opposite of what
// a demo is for.
//
// The sentences come from the server (EvalSummary.demoBlocked), so there is
// still exactly ONE copy of the wording — lib/demo/policy's DEMO_ACTIONS — and a
// non-guest gets `null` rather than an empty map, which is what keeps every
// consumer's "not a demo" branch a single check.
//
// A DISABLED BUTTON IS A COURTESY, NOT A BOUNDARY. assertDemoAllows is still the
// enforcement; nothing here may be the only thing standing between a guest and a
// spend. That is also why this is a context rather than prop-drilling: the gated
// controls are scattered from the Bulk actions menu down into per-chunk panels,
// and a boundary would not be allowed to live somewhere so easy to forget.

import { createContext, useContext, type ReactNode } from "react";

// Keyed by lib/demo/policy's DemoAction. Typed loosely on purpose: the value is
// server data, and a key the client does not know about is not an error here.
export type DemoBlockedMap = Partial<Record<string, string>>;

const DemoBlockedContext = createContext<DemoBlockedMap | null>(null);

export function DemoBlockedProvider({
  value,
  children,
}: {
  value: DemoBlockedMap | null;
  children: ReactNode;
}) {
  return (
    <DemoBlockedContext.Provider value={value}>
      {children}
    </DemoBlockedContext.Provider>
  );
}

// The sentence explaining why this action is off, or null when it is allowed —
// which is every action for a real account, and the actions with a replay behind
// them for a guest.
export function useDemoBlock(action: string): string | null {
  const map = useContext(DemoBlockedContext);
  return map?.[action] ?? null;
}
