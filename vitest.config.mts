// COMPONENT TESTS ONLY. `npm test` (node:test) owns `**/*.test.ts`; this runner
// owns `**/*.test.tsx`. The two globs are disjoint by extension, which is the
// whole mechanism keeping each runner off the other's files — do not widen
// either one. See docs/ui-tests-plan.md §1.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // `@/…` imports resolve through tsconfig's `paths`; Vite reads them itself.
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    include: ["**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    setupFiles: ["test/support/vitest.setup.ts"],
    // A component test that reaches the network is a bug in the test, not a
    // slow test: nothing here may talk to a route, so a hanging fetch should
    // fail fast rather than sit for the default timeout.
    testTimeout: 5_000,
  },
});
