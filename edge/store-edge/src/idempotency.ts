// Operation identity for the lane's durable writes — §31.1, hard rules #2/#10, review finding RR-F03.
//
// A refund carries its own id, minted at the lane. That id is an *operation identity*: the same id
// must mean the same operation. Before this, the edge appended a refund to its durable log on every
// call, so the same id sent twice with different money wrote two conflicting records and both
// "succeeded" — the exact defect RR-F03 found. The outbox deduped the cloud send on the key, which
// hid it: the local log and the cloud disagreed and nothing said so.
//
// This is the guard that makes the id mean what it says:
//   • an IDENTICAL retry (same id, same canonical payload) returns the original outcome and writes
//     nothing new — that is what lets a lost-reply retry be safe (RR-F02);
//   • a CHANGED payload under the same id is an explicit CONFLICT, refused with nothing written —
//     a refund id is not a slot to overwrite.
//
// "Canonical" matters: two payloads that differ only in key order are the same operation, so the
// hash is taken over a form with object keys sorted, recursively. The money differing is a different
// hash, so it conflicts; a re-serialisation with the same content is the same hash, so it is a safe
// retry. The guard is rebuilt from the durable log at boot, so the rule holds across a restart.

import { createHash } from 'node:crypto';

/** A stable, key-order-independent form of a parsed value, so equal content hashes equally. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The canonical payload identity of a record. Two records with the same content hash the same
 * whatever their key order; any change to the money, lines or any other field changes the hash.
 */
export function canonicalHash(record: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    parsed = record; // a non-JSON record still gets a stable identity from its bytes
  }
  // Round 29 · OB-108: the store computer's own "taken at" stamp is the box's, not the till's — a till re-sending the SAME
  // sale must hash the same as the record on the disk that carries the stamp (the guard is rebuilt from the disk at boot).
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && STORE_COMPUTER_TAKEN_AT in parsed) {
    const { [STORE_COMPUTER_TAKEN_AT]: _stamp, ...rest } = parsed as Record<string, unknown>;
    void _stamp;
    parsed = rest;
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(parsed))).digest('hex');
}

/**
 * Round 29 · OB-108 "A" (owner, 14 Oct 2026, in writing, "Use store computer time"; verifier r28 NEW-4): the field in which the
 * store computer writes, on the sale record it keeps and sends, WHEN IT took the bill from the till — by its own clock, the
 * clock its health reports are written by. Head office compares "said unused" times with this, never with the till's clock.
 */
export const STORE_COMPUTER_TAKEN_AT = 'storeComputerTakenAt';
/** Stamp a record (JSON text) with the store computer's time; a record that is not a JSON object is left as it is. */
export function stampTakenAt(record: string, at: string): string {
  try {
    const parsed = JSON.parse(record) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return record;
    return JSON.stringify({ ...(parsed as Record<string, unknown>), [STORE_COMPUTER_TAKEN_AT]: at });
  } catch {
    return record;
  }
}

export type IdempotencyVerdict =
  /** Not seen before — the caller should perform the operation, then `remember` it. */
  | { readonly kind: 'fresh' }
  /** Seen with the same payload — the caller must NOT repeat the effect; return the original outcome. */
  | { readonly kind: 'duplicate' }
  /** Seen with a DIFFERENT payload under the same id — refuse, write nothing. */
  | { readonly kind: 'conflict' };

/**
 * Remembers which operation ids have been committed, and the canonical payload each committed with.
 * Rebuilt from the durable log at boot (so it survives a restart) and consulted before every write.
 */
export class IdempotencyGuard {
  private readonly committed = new Map<string, string>(); // operation id -> canonical payload hash

  constructor(restored: Iterable<readonly [string, string]> = []) {
    for (const [id, hash] of restored) this.committed.set(id, hash);
  }

  /** Classify an operation id + payload hash against what has already committed. */
  verdict(operationId: string, payloadHash: string): IdempotencyVerdict {
    const prior = this.committed.get(operationId);
    if (prior === undefined) return { kind: 'fresh' };
    return prior === payloadHash ? { kind: 'duplicate' } : { kind: 'conflict' };
  }

  /** Record that an operation id committed with this canonical payload hash. */
  remember(operationId: string, payloadHash: string): void {
    this.committed.set(operationId, payloadHash);
  }

  /** Has this operation id committed at all? */
  has(operationId: string): boolean {
    return this.committed.has(operationId);
  }
}
