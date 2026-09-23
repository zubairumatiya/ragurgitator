// The parts of a frozen-vector fixture that know nothing about what the vectors
// are FOR: the float32 blob, references into it, pgvector's wire decoding, the
// identity hash, and the one-record-per-line manifest serialization. Shared by
// the CI eval gate (scripts/lib/evalGateFixture.ts) and the semantic cache gate
// (scripts/lib/cacheGateFixture.ts), which each add their own manifest shape and
// hole checks on top.
import { createHash } from "node:crypto";

// [offset, length] into vectors.f32, both counted in FLOATS, not bytes.
export type VecRef = [offset: number, length: number];

// Append-only builder for vectors.f32.
export class VectorBlob {
  private parts: Float32Array[] = [];
  private floats = 0;

  add(vec: Float32Array): VecRef {
    const ref: VecRef = [this.floats, vec.length];
    this.parts.push(vec);
    this.floats += vec.length;
    return ref;
  }

  get length(): number {
    return this.floats;
  }

  // Little-endian on disk whatever the host is: a Float32Array's own buffer is
  // host-endian, and a fixture written on one machine is read on another.
  toBuffer(): Buffer {
    const out = Buffer.allocUnsafe(this.floats * 4);
    let at = 0;
    for (const p of this.parts) {
      for (let i = 0; i < p.length; i++, at += 4) out.writeFloatLE(p[i], at);
    }
    return out;
  }
}

export function readVec(blob: Buffer, [offset, length]: VecRef): Float32Array {
  if (offset < 0 || length <= 0 || (offset + length) * 4 > blob.length) {
    throw new Error(`vector [${offset}, ${length}] is outside the blob (${blob.length / 4} floats)`);
  }
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = blob.readFloatLE((offset + i) * 4);
  return out;
}

// pgvector's binary send format: int16 dim, int16 unused, then dim float4s, all
// big-endian. Exports read vectors as base64 of this rather than as text — less
// than half the bytes on the wire — and it is exact by construction, where a
// text round trip is only exact because float4 prints shortest-round-trip.
export function decodeVectorSend(base64: string): Float32Array {
  const buf = Buffer.from(base64, "base64");
  const dim = buf.readUInt16BE(0);
  if (buf.length !== 4 + dim * 4) {
    throw new Error(`vector_send payload is ${buf.length} bytes, expected ${4 + dim * 4} for dim ${dim}`);
  }
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = buf.readFloatBE(4 + i * 4);
  return out;
}

// A fixture's identity: sha256 over the manifest and the blob. A baseline
// records it, and a gate refuses a baseline taken over a different fixture.
//
// `exportedAt` is left out along with the hash itself: a re-export of unchanged
// data would otherwise mint a new identity and invalidate a baseline that is
// still exactly right.
export function hashFixture(manifest: { fixtureHash: string; exportedAt: string }, blob: Buffer): string {
  const identity: Partial<typeof manifest> = { ...manifest };
  delete identity.fixtureHash;
  delete identity.exportedAt;
  return createHash("sha256").update(JSON.stringify(identity)).update(blob).digest("hex");
}

// Bounds check shared by the hole finders: pushes a problem rather than
// throwing, so a broken export lists every symptom of its one cause.
export function vecProblem(where: string, [offset, length]: VecRef, blobFloats: number, dim?: number): string | null {
  if (offset < 0 || length <= 0 || offset + length > blobFloats) return `${where}: vector [${offset}, ${length}] is outside the blob`;
  if (dim !== undefined && length !== dim) return `${where}: vector is ${length} wide, expected ${dim}`;
  return null;
}

// One record per line. A fixture refresh is a reviewed PR diff, and an indent-2
// dump of thousands of `[offset, length]` pairs spends four lines on each.
export function serializeManifest(m: object): string {
  const lines = (rows: unknown[]) =>
    rows.length === 0 ? "[]" : `[\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(",\n")}\n  ]`;
  const fields = Object.entries(m).map(
    ([k, v]) => `  ${JSON.stringify(k)}: ${Array.isArray(v) && typeof v[0] === "object" ? lines(v) : JSON.stringify(v)}`,
  );
  return `{\n${fields.join(",\n")}\n}\n`;
}
