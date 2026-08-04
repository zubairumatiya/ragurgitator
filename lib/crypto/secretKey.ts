// ---------------------------------------------------------------------------
// SECRET KEY — a plaintext provider credential that cannot be logged by accident.
//
// A decrypted API key is the one value in this codebase that is directly
// spendable by anyone who obtains it: paste it into curl and it bills the user's
// provider account, from anywhere, until they notice and rotate. Memory hygiene
// in a GC'd runtime is not really available to us (V8 strings are immutable and
// the collector may have copied them), so the defence that actually pays is
// making the value UNSERIALIZABLE BY DEFAULT rather than trying to erase it.
//
// Every accidental-disclosure path we can realistically expect goes through one
// of four hooks — string coercion, JSON, util.inspect, or console.log (which is
// util.inspect). All four are overridden below, so:
//
//   console.log(key)              -> [redacted]
//   `bearer ${key}`               -> bearer [redacted]
//   JSON.stringify({ key })       -> {"key":"[redacted]"}
//   throw new Error(`… ${key}`)   -> [redacted] in the message AND in whatever
//                                    error reporter serializes it later
//
// Only an explicit .expose() yields the real string. That call is greppable, so
// "where can this key escape to?" is a search rather than an audit — see the
// hardening phase in docs/user-accounts-plan.md, which asserts in CI that
// .expose() appears only at the provider-client construction sites.
// ---------------------------------------------------------------------------

const REDACTED = "[redacted]";

export class SecretKey {
  // #private (not TS `private`): TS's modifier is erased at runtime, so a plain
  // `private value` would still show up in util.inspect output and in a
  // structured clone. A real ECMAScript private field is invisible to both.
  readonly #value: string;

  constructor(value: string) {
    if (!value) throw new Error("SecretKey cannot wrap an empty value.");
    this.#value = value;
  }

  // The ONLY way out. Call it as late as possible — ideally inline in the
  // provider-client constructor — so the plaintext never lands in a variable
  // that an enclosing scope, error object, or stack frame could retain.
  expose(): string {
    return this.#value;
  }

  // The non-secret fragment we're allowed to show a user, so the settings UI can
  // say "sk-ant-…4f9c" without the full value ever reaching the client. Short
  // inputs would leak proportionally more of themselves, so anything under 8
  // characters reports no tail at all rather than most of the key.
  get lastFour(): string {
    return this.#value.length >= 8 ? this.#value.slice(-4) : "";
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  // console.log / util.inspect / Node's error formatting.
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}
