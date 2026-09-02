// THE KEY-USAGE BUFFER ACROSS AN AsyncResource.bind BOUNDARY.
//
// The sibling of detached.itest.ts, for the third thing lib/http/ndjson.ts has to
// break inheritance on — and the one that stayed broken longest, because its
// failure produces no error at all. withKeyUsageBuffer is REENTRANT: a nested
// scope appends to the buffer already installed rather than draining its share
// early. Bind restores the handler's buffer, which drained the moment the handler
// returned its Response, so the producer took the reentrant branch and pushed
// every row of a whole ingest, eval or autotune run into an array nobody would
// ever read again.
//
// Nothing throws, nothing warns, and the route works. What is lost is a SPEND
// CONTROL: lib/demo/budget measures the per-guest embedding budget by summing
// provider_key_usage, so a guest bought 744 embeddings on the operator's key
// while assertDemoEmbedBudget read zero.
//
// Only a real table can tell the two apart — the wrong ordering type-checks and
// reports success — which is why this is an itest and not a unit test.
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  runOutsideKeyUsageBuffer,
  trackKeyUsage,
  withKeyUsageBuffer,
} from "../../lib/auth/keyUsageStore";
import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql, runOutsideUserTransaction } from "../../lib/db";
import { runOutsideDetachedQueue } from "../../lib/detached";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

let admin: Sql;
let alice: { id: string; email: string };

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

beforeEach(async () => {
  await truncateAll(admin);
  alice = await createUser(admin);
});

// A provider call that fails. Deliberate: trackKeyUsage records a rejection as
// faithfully as a success — that inversion is the point of the ledger — and it
// needs no provider, no key and no network to exercise the write path.
function recordOneCall(): Promise<void> {
  return trackKeyUsage({ provider: "voyage", model: "voyage-3", surface: "embed", kind: "embed" }, () =>
    Promise.reject(new Error("nope")),
  ).then(
    () => undefined,
    () => undefined,
  );
}

// Committed rows, read on a separate connection — an uncommitted row is invisible
// to `admin`, so asserting absence here cannot pass just because a transaction is
// still open.
async function ledgerRows(): Promise<number> {
  const [row] = await admin<{ n: string }[]>`
    select count(*)::text as n from provider_key_usage where user_id = ${alice.id}`;
  return Number(row.n);
}

// The ndjson.ts shape, reproduced exactly: the handler installs a buffer and
// returns; bind captures its context; the producer runs afterwards and has to
// undo all three inheritances from inside the restored context.
function boundProducer(withExit: boolean): () => Promise<void> {
  return AsyncResource.bind(() =>
    runOutsideDetachedQueue(() =>
      runOutsideUserTransaction(() =>
        withUser(alice, () =>
          withExit
            ? runOutsideKeyUsageBuffer(() => withKeyUsageBuffer(recordOneCall))
            : withKeyUsageBuffer(recordOneCall),
        ),
      ),
    ),
  );
}

describe("runOutsideKeyUsageBuffer", () => {
  it("gives a producer a fresh buffer, so its ledger rows are written", async () => {
    let producer!: () => Promise<void>;
    await withKeyUsageBuffer(async () => {
      await withUser(alice, async () => {
        producer = boundProducer(true);
      });
    });

    // The handler's buffer drained when the block above ended. This is the
    // "minutes later" the producer actually runs in.
    await producer();

    assert.equal(await ledgerRows(), 1, "the producer's ledger row was lost");
  });

  it("loses every row when the exit is dropped", async () => {
    // The same code minus runOutsideKeyUsageBuffer. This is not a hypothetical
    // regression — it is what shipped, and what an added `void` or a reordered
    // wrapper would restore.
    let producer!: () => Promise<void>;
    await withKeyUsageBuffer(async () => {
      await withUser(alice, async () => {
        producer = boundProducer(false);
      });
    });

    await producer();

    assert.equal(await ledgerRows(), 0, "the defect this exit exists for is gone — drop this test");
  });
});
