import { describe, it, expect } from 'vitest';
import {
  sha256Hex, auditChainHash, verifyAuditChain, GENESIS_HASH,
  type SealedAuditFields, type ChainedAuditRow,
} from '../../services/kernel/src/audit-chain';

// The audit-log hash chain (audit FND-02 / GAP-SEC-03). The kernel seals every audit_log row onto
// the one before it with SHA-256, so a row inserted, removed, reordered or edited behind the
// database is detectable. The writer (SqlAuditSink) and this verifier share ONE definition of the
// seal, so these tests pin that definition and prove the verifier catches every kind of break.

const AT = '2026-08-09T10:00:00.000Z';

function fields(over: Partial<SealedAuditFields> = {}): SealedAuditFields {
  return {
    tenantId: 't1', userId: 'u-meena', method: 'POST', path: '/v1/sales', status: 202,
    permission: 'pos.sale.sync', traceId: 'trace-1', idempotencyKey: 'k1', recordedAt: AT, ...over,
  };
}

/** Build a genuine chain from sealed entries — each row sealed onto the previous, per tenant. */
function chain(entries: readonly SealedAuditFields[]): ChainedAuditRow[] {
  const lastByTenant = new Map<string, string>();
  return entries.map((f, i) => {
    const prevHash = lastByTenant.get(f.tenantId) ?? GENESIS_HASH;
    const hash = auditChainHash(prevHash, f);
    lastByTenant.set(f.tenantId, hash);
    return { ...f, sequence: i + 1, prevHash, hash };
  });
}

describe('sha256Hex', () => {
  it('is a real SHA-256 digest, hex-encoded (known vector for the empty string)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('auditChainHash', () => {
  it('is deterministic', () => {
    expect(auditChainHash('', fields())).toBe(auditChainHash('', fields()));
  });

  it('changes when the predecessor changes — the link is part of the seal', () => {
    expect(auditChainHash('aaaa', fields())).not.toBe(auditChainHash('bbbb', fields()));
  });

  it('changes when ANY sealed field changes — even the timestamp', () => {
    const base = auditChainHash('', fields());
    expect(auditChainHash('', fields({ userId: 'someone-else' }))).not.toBe(base);
    expect(auditChainHash('', fields({ status: 403 }))).not.toBe(base);
    expect(auditChainHash('', fields({ path: '/v1/refunds' }))).not.toBe(base);
    expect(auditChainHash('', fields({ recordedAt: '2026-08-09T10:00:00.001Z' }))).not.toBe(base);
    expect(auditChainHash('', fields({ idempotencyKey: null }))).not.toBe(base);
  });
});

describe('verifyAuditChain', () => {
  it('accepts an intact chain', () => {
    const rows = chain([fields(), fields({ traceId: 't2' }), fields({ traceId: 't3' })]);
    const result = verifyAuditChain(rows);
    expect(result.intact).toBe(true);
    expect(result.recordsChecked).toBe(3);
    expect(result.tenantsChecked).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('accepts an empty trail', () => {
    expect(verifyAuditChain([])).toMatchObject({ intact: true, recordsChecked: 0 });
  });

  it('catches an EDITED row — its contents no longer match its seal', () => {
    const rows = chain([fields(), fields({ traceId: 't2' })]);
    // Someone changes who did it, but cannot recompute the (chained) seal — the hash still covers
    // the old actor. This is the row the trail exists to protect.
    const tampered = rows.map((r, i) => (i === 0 ? { ...r, userId: 'somebody-else' } : r));
    const result = verifyAuditChain(tampered);
    expect(result.intact).toBe(false);
    expect(result.findings.some((f) => f.sequence === 1 && f.reason === 'hash_mismatch')).toBe(true);
  });

  it('catches a REMOVED row — the link no longer joins up', () => {
    const rows = chain([fields(), fields({ traceId: 't2' }), fields({ traceId: 't3' })]);
    // Drop the middle row: row 3 now follows row 1, but its prev_hash still points at row 2.
    const withHole = [rows[0]!, rows[2]!];
    const result = verifyAuditChain(withHole);
    expect(result.intact).toBe(false);
    expect(result.findings.some((f) => f.reason === 'broken_link')).toBe(true);
  });

  it('catches a FORGED row inserted with a fabricated seal', () => {
    const rows = chain([fields(), fields({ traceId: 't2' })]);
    const forged: ChainedAuditRow = {
      ...fields({ traceId: 'forged', userId: 'attacker' }),
      sequence: 3, prevHash: rows[1]!.hash, hash: 'deadbeef'.repeat(8),
    };
    const result = verifyAuditChain([...rows, forged]);
    expect(result.intact).toBe(false);
    expect(result.findings.some((f) => f.sequence === 3 && f.reason === 'hash_mismatch')).toBe(true);
  });

  it('verifies each tenant independently, even when their rows interleave by seq (§35)', () => {
    // Two tenants writing at the same time: seqs interleave, but each chain links only to its own.
    const rows = chain([
      fields({ tenantId: 'a' }),
      fields({ tenantId: 'b' }),
      fields({ tenantId: 'a', traceId: 'a2' }),
      fields({ tenantId: 'b', traceId: 'b2' }),
    ]);
    const result = verifyAuditChain(rows);
    expect(result.intact).toBe(true);
    expect(result.tenantsChecked).toBe(2);
  });

  it('flags only the tenant whose chain was tampered, not the innocent one', () => {
    const rows = chain([
      fields({ tenantId: 'a' }),
      fields({ tenantId: 'b' }),
      fields({ tenantId: 'a', traceId: 'a2' }),
    ]);
    const tampered = rows.map((r) => (r.tenantId === 'a' && r.sequence === 3 ? { ...r, status: 500 } : r));
    const result = verifyAuditChain(tampered);
    expect(result.intact).toBe(false);
    expect(result.findings.every((f) => f.tenantId === 'a')).toBe(true);
  });
});
