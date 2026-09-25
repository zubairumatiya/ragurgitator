import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StartDemo } from "@/app/components/StartDemo";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

function deferredFetch() {
  let resolve!: (res: Response) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const fetch = vi.fn(() => promise);
  vi.stubGlobal("fetch", fetch);
  return { fetch, resolve, reject };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("StartDemo", () => {
  it("POSTs to /api/demo/start and shows the pending copy while it runs", async () => {
    const { fetch } = deferredFetch();
    const user = userEvent.setup();
    render(<StartDemo />);

    await user.click(screen.getByRole("button", { name: "Try the demo" }));

    const button = screen.getByRole("button", { name: /Setting up your workspace/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(/Copying a corpus/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/demo/start", { method: "POST" });
  });

  it("on success replaces the route with the server's redirect and refreshes, staying pending", async () => {
    const { resolve } = deferredFetch();
    const user = userEvent.setup();
    render(<StartDemo />);
    await user.click(screen.getByRole("button", { name: "Try the demo" }));
    resolve(json({ redirect: "/c/abc", expiresAt: "2026-01-01T00:00:00Z" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/c/abc"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(router.replace.mock.invocationCallOrder[0]).toBeLessThan(
      router.refresh.mock.invocationCallOrder[0],
    );
    // Not flipped back to idle: the navigation is the end of this component.
    expect(screen.getByRole("button", { name: /Setting up your workspace/ })).toBeDisabled();
  });

  it("shows the server's own sentence for a 429 and re-enables the button", async () => {
    const { resolve } = deferredFetch();
    const user = userEvent.setup();
    render(<StartDemo />);
    await user.click(screen.getByRole("button", { name: "Try the demo" }));
    resolve(json({ error: "You've already started a few demo workspaces from this connection." }, 429));

    expect(await screen.findByRole("alert")).toHaveTextContent("already started a few demo workspaces");
    expect(screen.getByRole("button", { name: "Try the demo" })).toBeEnabled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("falls back to a generic sentence when the body carries no error", async () => {
    const { resolve } = deferredFetch();
    const user = userEvent.setup();
    render(<StartDemo />);
    await user.click(screen.getByRole("button", { name: "Try the demo" }));
    resolve(new Response("<html>", { status: 500 }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The demo is unavailable right now.");
  });

  it("names the connection when fetch itself throws", async () => {
    const { reject } = deferredFetch();
    const user = userEvent.setup();
    render(<StartDemo />);
    await user.click(screen.getByRole("button", { name: "Try the demo" }));
    reject(new TypeError("Failed to fetch"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the demo.");
    expect(screen.getByRole("button", { name: "Try the demo" })).toBeEnabled();
  });
});
