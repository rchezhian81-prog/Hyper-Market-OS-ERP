import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M35-FR-01/02 (P-04 tested recovery): backup verification & restore reconciliation on the live API. A
// backup nobody verified is a hope; a restore is only proven when every row count and money total matches
// exactly — there is no "close enough".

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const MANIFEST = {
  backupId: 'bkp-1', tenantScope: 'all', startedAt: '2026-08-11T02:00:00Z', completedAt: '2026-08-11T02:05:00Z',
  sizeBytes: 1024, checksum: 'chk-match', checksumAlgorithm: 'sha256', encrypted: true, offsiteLocation: 'offsite-vault',
  controlTotals: { rowCounts: { event_ledger: 1000, roles: 12 }, valueTotals: { sales: 500000 }, maxEventSeq: 1000 },
  schemaVersion: '0007',
};
const POLICY = { requireEncryption: true, requireOffsite: true };

const verify = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/backups/verify', userId, tenantId: A, idempotencyKey: key, body });
const reconcile = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/backups/reconcile-restore', userId, tenantId: A, idempotencyKey: key, body });

describe('backup verification & restore reconciliation (M35-FR-01/02)', () => {
  it('verifies a good backup and catches an empty artefact and a checksum mismatch', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect(((await verify(h, 'u-owner', { manifest: MANIFEST, actual: { checksum: 'chk-match', sizeBytes: 1024 }, policy: POLICY }, 'bv-ok')).body as { verdict: string; usable: boolean }).usable).toBe(true);
    // The job "succeeded" but produced nothing.
    expect(((await verify(h, 'u-owner', { manifest: MANIFEST, actual: { checksum: 'chk-match', sizeBytes: 0 }, policy: POLICY }, 'bv-empty')).body as { verdict: string }).verdict).toBe('empty_artefact');
    // The file rotted after it was written.
    expect(((await verify(h, 'u-owner', { manifest: MANIFEST, actual: { checksum: 'chk-changed', sizeBytes: 1024 }, policy: POLICY }, 'bv-chk')).body as { verdict: string }).verdict).toBe('checksum_mismatch');
    // Not encrypted, when the policy requires it.
    expect(((await verify(h, 'u-owner', { manifest: { ...MANIFEST, encrypted: false }, actual: { checksum: 'chk-match', sizeBytes: 1024 }, policy: POLICY }, 'bv-enc')).body as { verdict: string }).verdict).toBe('not_encrypted');
  });

  it('reconciles a whole restore, and fails one with rows missing — naming the table', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const whole = (await reconcile(h, 'u-owner', { manifest: MANIFEST, restored: { rowCounts: { event_ledger: 1000, roles: 12 }, valueTotals: { sales: 500000 }, maxEventSeq: 1000 }, restoredAt: '2026-08-11T03:00:00Z' }, 'bv-whole')).body as { reconciled: boolean; differences: unknown[] };
    expect(whole.reconciled).toBe(true);
    expect(whole.differences).toHaveLength(0);

    const short = (await reconcile(h, 'u-owner', { manifest: MANIFEST, restored: { rowCounts: { event_ledger: 998, roles: 12 }, valueTotals: { sales: 500000 }, maxEventSeq: 1000 }, restoredAt: '2026-08-11T03:00:00Z' }, 'bv-short')).body as { reconciled: boolean; differences: { kind: string; name: string; difference: number }[] };
    expect(short.reconciled).toBe(false); // no "close enough"
    expect(short.differences[0]!.kind).toBe('row_count');
    expect(short.differences[0]!.name).toBe('event_ledger');
    expect(short.differences[0]!.difference).toBe(-2); // two rows missing
  });

  it('refuses a malformed request and gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await verify(h, 'u-owner', { manifest: MANIFEST, actual: { checksum: 'x', sizeBytes: 1 } }, 'bv-nopolicy')).status).toBe(400);
    expect((await verify(h, 'u-cash', { manifest: MANIFEST, actual: { checksum: 'chk-match', sizeBytes: 1024 }, policy: POLICY }, 'bv-rbac')).status).toBe(403);
  });
});
