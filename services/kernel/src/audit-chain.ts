// The audit-log hash chain (audit FND-02 / GAP-SEC-03, SEC-07, hard rule #6).
//
// The kernel writes an `audit_log` row for every write and every refusal — who did what, when, and
// what they were told, including "no". Until now those rows sat unsealed: append-only at the
// database (migration 0004/0008 refuse UPDATE and DELETE), but nothing bound each row to the one
// before it, so a row inserted, removed or reordered *behind* the database — a restored backup with
// a row quietly dropped, a direct write by whoever holds the credentials — left no trace.
//
// This seals the trail. Each row carries the SHA-256 hash of its predecessor (per tenant, §35), so
// the trail is a chain: change one byte of one row, or drop one, and `verifyAuditChain` names the
// exact row where the chain breaks. That is what "tamper-EVIDENT" means (P-08) — we do not claim
// tampering is impossible, we guarantee it is detectable.
//
// SHA-256, not the pure-TypeScript FNV-1a that `packages/audit` carries as its dependency-free
// default: this runs in the cloud kernel where `node:crypto` is present, so the seal is a real
// cryptographic digest a determined attacker cannot forge, not merely a corruption check.

import { createHash } from 'node:crypto';

/** The seal on the first record of a tenant's chain: there is nothing before the beginning. */
export const GENESIS_HASH = '';

/** A real cryptographic digest — SHA-256, hex-encoded. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The fields of an audit row that the seal covers. Everything here is sealed, so a change to any of
 * it — the actor, the outcome status, even the timestamp — breaks the hash. `recordedAt` is an ISO
 * string supplied by the writer (not the database's `now()` default) precisely so it is sealed and a
 * back-dated row is detectable.
 */
export interface SealedAuditFields {
  readonly tenantId: string;
  readonly userId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly permission: string;
  readonly traceId: string;
  readonly idempotencyKey: string | null;
  readonly recordedAt: string;
}

/**
 * The hash of one record, over its predecessor's hash and its own sealed fields. `JSON.stringify`
 * of a fixed-order array is the canonical form — unambiguous (no separator a field could contain)
 * and stable (array order is fixed here and must never be reordered, or every existing seal breaks).
 * The writer and the verifier both call this, so the seal has exactly one definition.
 */
export function auditChainHash(prevHash: string, f: SealedAuditFields): string {
  return sha256Hex(JSON.stringify([
    prevHash,
    f.tenantId, f.userId, f.method, f.path, f.status,
    f.permission, f.traceId, f.idempotencyKey, f.recordedAt,
  ]));
}

/** A sealed audit row as read back for verification. */
export interface ChainedAuditRow extends SealedAuditFields {
  /** The global monotonic `seq` — used only to order a tenant's rows for the walk. */
  readonly sequence: number;
  readonly prevHash: string;
  readonly hash: string;
}

/** Where a tenant's chain first fails to verify, and why. */
export interface AuditChainFinding {
  readonly tenantId: string;
  readonly sequence: number;
  readonly reason: 'hash_mismatch' | 'broken_link';
  readonly detail: string;
}

/** The result of checking every tenant's chain. */
export interface AuditChainVerifyResult {
  readonly intact: boolean;
  readonly recordsChecked: number;
  readonly tenantsChecked: number;
  /** Empty when intact; otherwise every place a chain does not hold up. */
  readonly findings: readonly AuditChainFinding[];
}

/**
 * Verify every tenant's audit chain (M34-FR-01 shape). Each tenant links independently (§35): its
 * rows, ordered by the global `seq`, must form a chain from the genesis hash, each row's `prevHash`
 * equal to the previous row's `hash` and each `hash` equal to a fresh recompute over its contents.
 * Reports every break rather than the first, so an auditor sees the full extent, not a hint.
 *
 * Rows are grouped by tenant here; a caller that has already filtered out any unsealed legacy prefix
 * (rows written before this migration, whose hash is absent) passes only the sealed rows.
 */
export function verifyAuditChain(rows: readonly ChainedAuditRow[]): AuditChainVerifyResult {
  const byTenant = new Map<string, ChainedAuditRow[]>();
  for (const r of rows) {
    const list = byTenant.get(r.tenantId);
    if (list) list.push(r); else byTenant.set(r.tenantId, [r]);
  }

  const findings: AuditChainFinding[] = [];
  let checked = 0;
  for (const [tenantId, list] of byTenant) {
    list.sort((a, b) => a.sequence - b.sequence);
    let expectedPrev = GENESIS_HASH;
    for (const r of list) {
      checked += 1;
      if (r.prevHash !== expectedPrev) {
        findings.push({
          tenantId, sequence: r.sequence, reason: 'broken_link',
          detail: 'prev_hash does not match the previous record — a row was inserted, removed or reordered',
        });
      }
      if (auditChainHash(r.prevHash, r) !== r.hash) {
        findings.push({
          tenantId, sequence: r.sequence, reason: 'hash_mismatch',
          detail: 'the contents of this record no longer match its seal',
        });
      }
      expectedPrev = r.hash;
    }
  }

  return { intact: findings.length === 0, recordsChecked: checked, tenantsChecked: byTenant.size, findings };
}
