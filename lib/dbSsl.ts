// Whether a Postgres URL needs TLS.
//
// Every connection in this repo hardcoded `ssl: "require"` — correct for
// Supabase, impossible against a local container, which serves no TLS at all.
//
// KEYED OFF THE URL, DELIBERATELY NOT OFF NODE_ENV. An env-keyed switch is one
// mis-set variable away from talking to the live project in cleartext, and that
// failure is silent. A host that resolves to this machine cannot be Supabase, so
// the URL answers the question without anything to misconfigure.
export function sslFor(url: string): "require" | false {
  let host: string;
  try {
    // WHATWG URL keeps IPv6 literals bracketed — hostname for `@[::1]:5432` is
    // "[::1]", not "::1" — so strip them or the loopback check misses.
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    // Unparseable means it isn't a local URL we recognise, so require TLS —
    // the safe direction to fail in.
    return "require";
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "host.docker.internal"
    ? false
    : "require";
}
