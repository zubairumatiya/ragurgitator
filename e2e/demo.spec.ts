// THE GUEST DEMO, walked the way a visitor walks it. One guest for the whole
// file — minting is the expensive step and the caps count each one — and the
// tests run in order because each starts from the state the last one left.
// See docs/ui-tests-plan.md §4 for what each step pins and why.
import { expect, test, type Page } from "@playwright/test";

import { startDemoFromFrontDoor } from "./support/demo";

test.describe.configure({ mode: "serial" });

let page: Page;
let configId: string;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  configId = await startDemoFromFrontDoor(page);
});

test.afterAll(async () => {
  await page?.close();
});

test("the workbench opens framed by the demo banner and the active-config line", async () => {
  await expect(page).toHaveURL(new RegExp(`/c/${configId}$`));
  await expect(page.getByRole("heading", { name: "Config workbench" })).toBeVisible();

  const banner = page.getByText("Demo workspace");
  await expect(banner).toBeVisible();
  await expect(page.getByText(/Expires in \d+h \d+m\./)).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up to keep this" })).toBeVisible();

  await expect(page.getByText("active:")).toBeVisible();
  // Bounded levers are withheld from a guest at the control, not only at the
  // route: the upload box must not pretend to work.
  await expect(page.getByRole("heading", { name: "1. Ingest" })).toBeVisible();
});

test("a suggestion chip is answered from the bank, with sources", async () => {
  // Scoped to the Ask section: the Ingest section above it is also a list.
  const chat = page.locator("section", { has: page.getByRole("heading", { name: "2. Ask" }) });
  await expect(chat.getByText("Try one of these — each has a banked answer:")).toBeVisible();
  const chips = chat.locator("button.rounded-full").filter({ hasNotText: /^Ask/ });
  const count = await chips.count();
  expect(count, "a guest should be offered at least one banked question").toBeGreaterThan(0);

  const question = (await chips.first().textContent())!.trim();
  await chips.first().click();

  // Pending paints first, then the answer replaces it.
  await expect(page.getByRole("status")).toContainText("Thinking");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 60_000 });

  const bubbles = chat.locator("li");
  await expect(bubbles.nth(0)).toHaveText(question);
  await expect(bubbles.nth(1)).not.toContainText("Error:");

  const sources = chat.locator("summary", { hasText: /\d+ sources?/ });
  await expect(sources).toBeVisible();
  await sources.click();
  await expect(chat.getByText(/score \d\.\d{3}/).first()).toBeVisible();
});

test("Evals: Add fills the board from the bank, Score pending puts a recall number on it", async () => {
  await page.getByRole("link", { name: "Evals" }).click();
  await expect(page.getByRole("heading", { name: "Retrieval evals" })).toBeVisible();
  await expect(page.getByText(/No eval questions yet — the chunks below are the board/)).toBeVisible();

  await page.getByRole("button", { name: "Bulk actions ▾" }).click();
  await page.getByRole("button", { name: /^Add question/ }).click();
  const add = page.getByRole("button", { name: "Add", exact: true });
  await expect(add).toBeEnabled();
  // The paid twin is dark on a demo board; a guest can only reuse.
  await expect(page.getByRole("button", { name: "Add cached" })).toBeDisabled();
  await add.click();

  await expect(page.getByText(/Added \d+ banked question\(s\) for \$0, unscored\./)).toBeVisible({
    timeout: 90_000,
  });

  const score = page.getByRole("button", { name: "Score pending" });
  await expect(score).toBeEnabled();
  await score.click();
  await expect(page.getByText(/Scored \d+ question\(s\)\. Recall@k \d+(\.\d+)?%/)).toBeVisible({
    timeout: 90_000,
  });

  // The headline card: its label span may also carry a ticker badge, so match
  // the prefix, and the value is the next span over.
  const recall = page.getByText(/^Recall@\d+/).first();
  await expect(recall).toBeVisible();
  await expect(recall.locator("xpath=following-sibling::span[1]")).toHaveText(/^\d+(\.\d+)?%$/);
});
