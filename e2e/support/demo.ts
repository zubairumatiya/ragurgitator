// Minting a guest from the browser, with the refusals named.
//
// POST /api/demo/start is the one unauthenticated write in the app, and it can
// say no for two reasons that are not defects: the per-address cap (429 — three
// per 24 h, and GitHub runners share address ranges) and the live-guest ceiling
// (503 — twenty). A run that hits either must fail with THAT sentence rather
// than with a timeout waiting for a workbench that was never going to render,
// so the person reading the red check knows whether to look at the code or at
// the caps. See docs/ui-tests-plan.md §2.
import { expect, type Page } from "@playwright/test";

export async function startDemoFromFrontDoor(page: Page): Promise<string> {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "A RAG workbench you can actually run" })).toBeVisible();

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/demo/start") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Try the demo" }).click(),
  ]);

  if (response.status() !== 200) {
    const body = await response.text().catch(() => "");
    const why =
      response.status() === 429
        ? "the per-address provisioning cap refused this run"
        : response.status() === 503
          ? "the live-guest ceiling refused this run"
          : "provisioning failed";
    throw new Error(`demo/start answered ${response.status()} — ${why}: ${body.slice(0, 300)}`);
  }

  const { redirect } = (await response.json()) as { redirect: string };
  expect(redirect).toMatch(/^\/c\/[^/]+$/);
  await page.waitForURL(`**${redirect}`);
  return redirect.replace(/^\/c\//, "");
}
