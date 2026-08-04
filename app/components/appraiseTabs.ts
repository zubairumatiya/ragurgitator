// The Appraise section's tab list, in one place. Split out of AppraiseNav so the
// *landing* tab can be imported by Server Components too (AppraiseNav is a
// "use client" module): app/appraise/page.tsx redirects to it, and the pinned
// "📊 Appraise" tab in ConfigTabs links straight at it.
//
// ConfigTabs links to the leaf route rather than bare /appraise on purpose: a
// route whose only job is redirect() has nothing to prefetch, so pointing the
// tab at it made every click pay two sequential round trips (RSC /appraise →
// 307 → RSC /appraise/costs) with no shell to show in between. Bare /appraise
// still redirects, for hand-typed URLs and old links.

// Order = display order. Money first: it's the page you open Appraise for.
export const APPRAISE_TABS = [
  { href: "/appraise/costs", label: "Costs" },
  { href: "/appraise/semantic-cache", label: "Semantic caching" },
  { href: "/appraise/configs", label: "Config metrics" },
  { href: "/appraise/trials", label: "Trial times" },
] as const;

// Where "Appraise" lands. Change this (or reorder TABS) in one place.
export const APPRAISE_LANDING_HREF = APPRAISE_TABS[0].href;
