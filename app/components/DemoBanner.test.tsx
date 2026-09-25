import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { DemoBanner } from "@/app/components/DemoBanner";

function me(body: unknown, status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe("DemoBanner", () => {
  it("renders nothing for a real account", async () => {
    const fetch = me({ user: { email: "a@b.c" }, guest: { isGuest: false, expiresAt: null } });
    const { container } = render(<DemoBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth/me", undefined));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is nobody to be about (401)", async () => {
    const fetch = me({ error: "Unauthorized" }, 401);
    const { container } = render(<DemoBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("for a guest: names the workspace, the rule, the countdown and the way to keep it", async () => {
    me({ guest: { isGuest: true, expiresAt: minutesFromNow(107.5) } });
    render(<DemoBanner />);
    expect(await screen.findByText("Demo workspace")).toBeInTheDocument();
    expect(screen.getByText("Expires in 1h 47m.")).toBeInTheDocument();
    expect(screen.getByText(/uploads, re-chunking, generating questions — are switched off/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign up to keep this" })).toHaveAttribute("href", "/signup");
  });

  it("rounds a short remainder up to a minute and reads an expired one as imminent", async () => {
    me({ guest: { isGuest: true, expiresAt: minutesFromNow(0.6) } });
    const { unmount } = render(<DemoBanner />);
    expect(await screen.findByText("Expires in 1m.")).toBeInTheDocument();
    unmount();

    me({ guest: { isGuest: true, expiresAt: minutesFromNow(-5) } });
    render(<DemoBanner />);
    expect(await screen.findByText("Expires in any moment now.")).toBeInTheDocument();
  });

  // The defect the first e2e run found: mounted on /demo before any session
  // exists, the banner had asked once, heard 401, and never asked again.
  it("asks again after a navigation when the first answer was 401, then stops once it has one", async () => {
    nav.pathname = "/demo";
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const { container, rerender } = render(<DemoBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();

    fetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ guest: { isGuest: true, expiresAt: minutesFromNow(60.5) } })),
    );
    nav.pathname = "/c/abc";
    rerender(<DemoBanner />);
    expect(await screen.findByText("Demo workspace")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);

    // Settled: a further navigation costs nothing.
    nav.pathname = "/c/abc/eval";
    rerender(<DemoBanner />);
    await waitFor(() => expect(screen.getByText("Expires in 1h 0m.")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
    nav.pathname = "/";
  });

  it("a signed-in account settles on the first 200 and is never asked again", async () => {
    nav.pathname = "/c/abc";
    const fetch = me({ user: { email: "a@b.c" }, guest: { isGuest: false, expiresAt: null } });
    const { container, rerender } = render(<DemoBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    nav.pathname = "/c/abc/eval";
    rerender(<DemoBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
    nav.pathname = "/";
  });
});
