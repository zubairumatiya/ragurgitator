// THE TWO CLAIMS 0075 MAKES, checked against a real database.
//
//   1. is_guest and expires_at are OPERATOR-OWNED. user_profiles' policy
//      (0051:161) is `for all` with `with check (id = app.current_user_id())`,
//      so rag_app may update its own profile row — which means "a guest extends
//      their own TTL" is prevented by nothing but the trigger this file exercises.
//      No route exposes that update today, so a regression here would be
//      invisible until the day someone adds a display-name field.
//
//   2. THE REAPER DELETES THE WHOLE WORKSPACE, and it does so by deleting
//      auth.users. The direction is the entire point: deleting user_profiles
//      instead would strand the auth.users row permanently and leave the guest's
//      cookie still validating — getSessionUser() needs only an email — so the
//      guest would land in an app whose every scoped query references a profile
//      that is gone. That failure cannot be seen by counting rows in
//      user_profiles, so the assertion walks the owned tables instead.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { privilegedSql } from "../../lib/db";
import { reapExpiredGuests } from "../../lib/demo/guest";
import { overIpLimit, pruneProvisionLedger, recordProvision } from "../../lib/demo/rateLimit";
import { adminClient, appClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

let admin: Sql;
let app: Sql;
let guest: { id: string; email: string };

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
  app = appClient();
});

after(async () => {
  await admin?.end();
  await app?.end();
  await privilegedSql.end();
});

beforeEach(async () => {
  await truncateAll(admin);
  guest = await createUser(admin);
  // Provisioning writes these as `postgres`, which the trigger lets through.
  await admin`
    update user_profiles
       set is_guest = true, expires_at = now() + interval '2 hours'
     where id = ${guest.id}`;
});

describe("guest columns are operator-owned (0075)", () => {
  it("refuses a guest extending their own expiry", async () => {
    await assert.rejects(
      () =>
        app.begin(async (tx) => {
          await tx`select set_config('app.user_id', ${guest.id}, true)`;
          await tx`
            update user_profiles set expires_at = now() + interval '100 years'
             where id = ${guest.id}`;
          return [];
        }),
      /operator-owned/,
      "a guest moved their own expiry",
    );
  });

  it("refuses a guest clearing their own guest flag", async () => {
    await assert.rejects(
      () =>
        app.begin(async (tx) => {
          await tx`select set_config('app.user_id', ${guest.id}, true)`;
          await tx`update user_profiles set is_guest = false where id = ${guest.id}`;
          return [];
        }),
      /operator-owned/,
      "a guest promoted themselves to a permanent account",
    );
  });

  it("still allows rag_app to update the rest of the profile", async () => {
    // The trigger keys on the two columns CHANGING, not on the table being
    // written — so an ordinary profile update (here, the MCP toggle) must still
    // go through. A trigger that refused every update would pass both tests
    // above while breaking a working feature.
    const updated = await app.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${guest.id}, true)`;
      const rows = await tx`
        update user_profiles set mcp_enabled = true where id = ${guest.id} returning id`;
      return [rows];
    });
    assert.equal((updated as unknown as unknown[][])[0].length, 1);
  });
});

describe("reapExpiredGuests", () => {
  it("deletes an expired guest's auth user, and everything it owns with it", async () => {
    await admin`
      insert into corpora (name, user_id) values ('doomed', ${guest.id})`;
    await admin`
      update user_profiles set expires_at = now() - interval '1 minute' where id = ${guest.id}`;

    assert.equal(await reapExpiredGuests(), 1);

    // auth.users FIRST, because that is the row whose absence makes the cookie
    // stop validating. A reaper that deleted only the profile would leave this
    // one behind and the session alive.
    const [{ n: authUsers }] = await admin<{ n: number }[]>`
      select count(*)::int as n from auth.users where id = ${guest.id}`;
    assert.equal(authUsers, 0, "the auth user survived the reaper");

    const [{ n: corpora }] = await admin<{ n: number }[]>`
      select count(*)::int as n from corpora where user_id = ${guest.id}`;
    assert.equal(corpora, 0, "the guest's workspace outlived the guest");
  });

  it("leaves an unexpired guest and a real account alone", async () => {
    const real = await createUser(admin);
    assert.equal(await reapExpiredGuests(), 0);

    const [{ n }] = await admin<{ n: number }[]>`
      select count(*)::int as n from auth.users where id in (${guest.id}, ${real.id})`;
    assert.equal(n, 2, "the reaper took someone it should not have");
  });
});

describe("the per-IP provisioning limit", () => {
  // DEMO_IP_SALT is required by demoEnabled(), but the hash only has to be
  // stable within a process for these assertions — the salt's job is to keep a
  // raw address out of the table, not to make the counting work.
  before(() => {
    process.env.DEMO_IP_SALT ??= "itest-salt";
  });

  it("counts an address up to its allowance and then refuses it", async () => {
    const address = "203.0.113.7";
    assert.equal(await overIpLimit(address), false);

    // The default allowance is 3 (lib/demo/config.ts). Recording exactly that
    // many is what makes the boundary — not one either side of it — the thing
    // under test.
    for (let i = 0; i < 3; i++) await recordProvision(address);
    assert.equal(await overIpLimit(address), true, "an address minted a fourth workspace");

    // The counter is PER ADDRESS. A shared limit would look identical until the
    // day a second visitor arrived.
    assert.equal(await overIpLimit("198.51.100.9"), false, "one visitor locked out another");
  });

  it("ignores rows older than the window, and prunes them", async () => {
    const address = "203.0.113.8";
    for (let i = 0; i < 3; i++) await recordProvision(address);
    await admin`update demo_provisions set created_at = now() - interval '30 days'`;

    assert.equal(await overIpLimit(address), false, "an expired row still counted");
    assert.equal(await pruneProvisionLedger(), 3);
  });
});
