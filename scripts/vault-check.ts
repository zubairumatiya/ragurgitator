// ---------------------------------------------------------------------------
// LIVE Azure Key Vault check — the half of Phase 0 that envelope.test.ts cannot
// cover. Those tests run against an in-memory fake wrapper so `npm test` needs
// no credentials, no network and no vault; this script is the counterpart that
// proves the REAL adapter works: RBAC is granted, the key resolves, wrap/unwrap
// round-trips, and the DEK cache actually elides a second vault call.
//
// Deliberately NOT a *.test.ts file — it would break `npm test` for anyone
// without Azure configured. Run it by hand after provisioning or after changing
// vault config / roles:
//
//   npm run vault:check
//
// Prints no secret material: the probe value is a synthetic string, and even
// that is only ever compared, never logged.
// ---------------------------------------------------------------------------
import { KeyClient } from "@azure/keyvault-keys";
import { DefaultAzureCredential } from "@azure/identity";

import { azureKeyWrapper, cachedKeyWrapper } from "../lib/crypto/azureKeyVault";
import { open, seal } from "../lib/crypto/envelope";

const USER = "3f1a7c2e-8b40-4d9a-9c11-0e5f6a7b8c90";
const OTHER_USER = "9a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
const PROBE = "sk-probe-not-a-real-key-0000";

let failures = 0;

function report(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✔" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
  const keyName = process.env.AZURE_KEY_VAULT_KEY_NAME;
  if (!vaultUrl || !keyName) {
    console.error("AZURE_KEY_VAULT_URL / AZURE_KEY_VAULT_KEY_NAME must be set in .env.local.");
    process.exit(1);
  }
  console.log(`vault: ${vaultUrl}\nkey:   ${keyName}\n`);

  // 1. Can we see the key at all? This is the step that fails when the RBAC role
  //    assignment is missing or hasn't propagated, so it gets its own error path.
  let keyId: string;
  try {
    const key = await new KeyClient(vaultUrl, new DefaultAzureCredential()).getKey(keyName);
    keyId = key.id ?? "";
    report("resolve key version", Boolean(keyId), keyId.split("/").slice(-1)[0]);
    report("key type is RSA", key.keyType === "RSA", String(key.keyType));
    // An expiry on the KEK would eventually make every stored provider key
    // un-unwrappable — a silent, dated outage. Warn loudly if one is set.
    report("no expiration set on the KEK", key.properties.expiresOn == null,
      key.properties.expiresOn ? `EXPIRES ${key.properties.expiresOn.toISOString()}` : "");
  } catch (err) {
    console.error(`\n✗ Could not read the key.\n  ${(err as Error).message}\n`);
    console.error("  Most likely: your account lacks 'Key Vault Crypto Officer' on this");
    console.error("  vault, or the role assignment hasn't propagated yet (up to ~10 min).");
    process.exit(1);
  }

  // 2. Full envelope round-trip through the real vault.
  const sealed = await seal(azureKeyWrapper, USER, "anthropic", PROBE);
  report("seal against live vault", sealed.wrappedDek.length > 0, `${sealed.wrappedDek.length}b wrapped dek`);
  report("kekId records the key VERSION", sealed.kekId === keyId);
  report("lastFour extracted", sealed.lastFour === "0000", sealed.lastFour);

  const opened = await open(azureKeyWrapper, USER, "anthropic", sealed);
  report("open recovers the exact plaintext", opened.expose() === PROBE);

  // 3. Tenant binding holds against the real wrapper too — the AAD check is in
  //    our code, not the vault's, so it's worth confirming end to end.
  let rejected = false;
  try {
    await open(azureKeyWrapper, OTHER_USER, "anthropic", sealed);
  } catch {
    rejected = true;
  }
  report("cross-user replay rejected", rejected);

  // 4. The DEK cache should turn the second open into zero vault calls. Compare
  //    elapsed time: a live unwrap is a network round trip (tens of ms), a cache
  //    hit is sub-millisecond, so the ratio is unambiguous even on a slow link.
  const cached = cachedKeyWrapper(azureKeyWrapper);
  const t0 = performance.now();
  await open(cached, USER, "anthropic", sealed);
  const cold = performance.now() - t0;
  const t1 = performance.now();
  await open(cached, USER, "anthropic", sealed);
  const warm = performance.now() - t1;
  report("DEK cache elides the second vault call", warm < cold / 5,
    `cold ${cold.toFixed(1)}ms → warm ${warm.toFixed(1)}ms`);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
