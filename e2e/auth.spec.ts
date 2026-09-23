// THE WALL. Free, no writes: every request here is either a redirect, a page
// render, or a sign-in that Supabase rejects. See docs/ui-tests-plan.md §4.
import { expect, test } from "@playwright/test";

test("a cookie-less visitor to a workbench page is sent to /login with the path preserved", async ({
  page,
}) => {
  await page.goto("/c/anything/eval?tab=1");
  await expect(page).toHaveURL(/\/login\?next=%2Fc%2Fanything%2Feval%3Ftab%3D1$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("an API route answers 401 JSON in place rather than redirecting", async ({ request }) => {
  const res = await request.get("/api/configs", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  expect(res.headers()["content-type"]).toContain("application/json");
});

test("the sign-in page renders with the demo as the way past the wall", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeFocused();
  await expect(page.getByRole("link", { name: "Try the demo" })).toHaveAttribute("href", "/demo");
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toBeVisible();
});

test("wrong credentials surface the generic error and keep the email", async ({ page }) => {
  await page.goto("/login");
  const email = `nobody-${Date.now()}@example.test`;
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill("definitely-not-the-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();

  // Next's route announcer is also role=alert (and empty), so filter to the
  // one that says something.
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveText(
    "Incorrect email or password.",
  );
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await expect(page).toHaveURL(/\/login/);
});
