// Runs before every component test file (vitest.config.mts `setupFiles`).
//
// jest-dom's matchers (toBeDisabled, toHaveTextContent, …) read as the
// assertion they make; without them a disabled check is `.disabled === true`
// on a cast element. `cleanup` between tests is what stops one test's DOM from
// leaking into the next's queries — RTL does it automatically only when the
// runner exposes `afterEach` globally, which Vitest does not by default.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
