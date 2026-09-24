import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The /next entry points read the route through next/navigation, which has no
// router to read from under jsdom.
vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

// app/layout.tsx mounts both on every page, and no component test renders the
// layout, so this is the only place a throw from either would surface.
describe("Vercel Analytics + Speed Insights", () => {
  it("mount without throwing, render no DOM of their own, and send nothing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container } = render(
      <>
        <Analytics />
        <SpeedInsights />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(fetch).not.toHaveBeenCalled();
  });
});
