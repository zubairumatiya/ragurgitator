// WHO MAY PRESS "Add" WITHOUT SPENDING — phase 3 of docs/demo-add-flow-plan.md,
// against a real database.
//
// The flip that phase makes is small and entirely about trust: the plain "Add"
// used to mean "generate", and for a guest whose build carries a published board
// it now means "hand out the next banked question". Everything that could go
// wrong with that is a question about a database row rather than about transport,
// which is why it is checked here and not through the route:
//
//   1. A REAL ACCOUNT IS UNTOUCHED. readBoard() opens with
//      `if (!(await isGuest())) return null` (lib/demo/replay.ts), so the widened
//      disjunct can only ever be true for a guest — however stocked the account's
//      own demo_replay table is. If that null ever became a row, every real
//      account's Add would be swallowed by the demo's carve-out and silently stop
//      generating.
//   2. IT FAILS CLOSED. A guest cloned from a build published WITHOUT a board
//      reads the same null and must still be REFUSED, not handed the generator.
//      That is the routine-cheap-republish case the four other shelf-before-gate
//      lines in scripts/guards.ts exist for.
//   3. "Add cached" STILL WORKS FOR EVERYONE, board or no board — the older
//      carve-out is a disjunct, not a replacement.
//
// The route (app/api/eval/bulk-generate) is the same three lines in the same
// order, and scripts/guards.ts pins all three literally; they are re-stated in
// `decide()` below because the transport is Next's and the decision is not.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { privilegedSql } from "../../lib/db";
import { forgetBoard, readBoard, writeBoard } from "../../lib/demo/replay";
import type { ReplayBoard } from "../../lib/demo/replayCore";
import { assertDemoAllows, isDemoBlocked } from "../../lib/demo/policy";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

let admin: Sql;
let guest: { id: string; email: string };
let real: { id: string; email: string };

const BOARD: ReplayBoard = { version: 1, chunks: ["chunk-a", "chunk-b"] };

// POST /api/eval/bulk-generate's decision, minus the transport: read the shelf,
// gate unconditionally behind it, branch on the SAME boolean the gate used.
// Returns which branch the request would take, or throws what the visitor sees.
async function decide(user: { id: string; email: string }, cachedOnly = false) {
  return withUser(user, async () => {
    const boarded = (await readBoard()) !== null;
    const fromBank = cachedOnly || boarded;
    if (!fromBank) await assertDemoAllows("generate");
    return fromBank ? "bank" : "generate";
  });
}

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await privilegedSql.end();
});

beforeEach(async () => {
  await truncateAll(admin);
  forgetBoard();
  guest = await createUser(admin);
  real = await createUser(admin);
  // Set directly, as the other demo tests do: lib/demo/guest reads exactly this
  // column and the provisioning path that writes it is not what is under test.
  await admin`
    update user_profiles set is_guest = true, expires_at = now() + interval '2 hours'
     where id = ${guest.id}`;
});

describe("the bank carve-out on bulk-generate (docs/demo-add-flow-plan.md, phase 3)", () => {
  it("a boarded guest's plain Add is a bank press, and never reaches the gate", async () => {
    await withUser(guest, () => writeBoard(guest.id, BOARD));
    forgetBoard();
    assert.equal(await decide(guest), "bank");
  });

  it("refuses a guest whose build was published without a board", async () => {
    // Nothing written, which is exactly what a cheap republish leaves behind.
    await assert.rejects(
      () => decide(guest),
      (err: unknown) => isDemoBlocked(err),
      "an empty build reached the generator instead of the refusal sentence",
    );
  });

  it("still lets that guest press Add cached", async () => {
    assert.equal(await decide(guest, true), "bank", "the older carve-out is a disjunct");
  });

  it("a real account still generates, however stocked its own demo_replay is", async () => {
    // Stocked under the REAL account: the carve-out is being a guest, not the
    // absence of a row.
    await withUser(real, () => writeBoard(real.id, BOARD));
    forgetBoard();
    await withUser(real, async () =>
      assert.equal(await readBoard(), null, "a non-guest read a board"),
    );
    assert.equal(await decide(real), "generate");
  });

  it("a real account's Add cached is still free", async () => {
    assert.equal(await decide(real, true), "bank");
  });
});
