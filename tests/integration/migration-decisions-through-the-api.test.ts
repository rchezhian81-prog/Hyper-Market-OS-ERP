import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// MG-04 / MG-06 — the migration screen's decisions KEPT on the cloud, through the real authenticated API
// (Stage C3a): exceptions and control totals are recorded once; a manager resolves at the desk; the owner and
// the CA sign; a decision relayed by the store box is applied only under a decider whose OWN grants carry the
// authority, otherwise recorded as refused; QG-07 turns true when every total is reconciled and signed.

const T = 'ab000000-0000-4000-8000-000000000043';
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CA = 'u-ca'; const CASHIER = 'u-cash'; const LOADER = 'u-loader'; const SYNC = 'u-sync';

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager');
  await h.provisionRole(T, CA, 'chartered_accountant');
  await h.provisionRole(T, CASHIER, 'cashier');
  await h.provisionRole(T, SYNC, 'cashier');          // the store box's sync identity
  await h.provisionRole(T, LOADER, 'store_manager');  // ran the extraction/load
  // Who ran the extraction — the ledger fact the signature rule reads (never the body).
  expect((await post(h, '/v1/migration/extraction-runs/run-1', OWNER, 'er1', { operatorId: LOADER })).status).toBe(201);
  return h;
}
const post = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId = OWNER) => h.request({ method: 'GET', path, userId, tenantId: T });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const EX = [
  { exceptionId: 'EX-1', kind: 'duplicate_product', severity: 'low', confidence: 'probable', legacyIds: ['L-1', 'L-2'], evidence: 'same name and pack' },
  { exceptionId: 'EX-2', kind: 'negative_stock', severity: 'blocking', confidence: 'certain', legacyIds: ['L-9'], evidence: 'qty -4 on the shelf', valueMinor: 12000 },
];
const TOTALS = [
  { totalId: 'CT-STOCK', kind: 'stock', name: 'Stock units', unit: 'quantity', legacyValue: 1000, loadedValue: 1000, legacyDerivation: 'SUM(qty) FROM legacy stock', loadedDerivation: 'count of opening movements' },
  { totalId: 'CT-FIN', kind: 'financial', name: 'Debtors', unit: 'minor_currency', legacyValue: 500_000, loadedValue: 500_000, legacyDerivation: 'debtors ledger', loadedDerivation: 'opening receivable events' },
];

describe('MG-04 exceptions through the API', () => {
  it('a manager records and resolves; the cutover-blocking one shows until decided; the register keeps every decision', async () => {
    const h = await seeded();
    expect((await post(h, '/v1/migration/exceptions', CASHIER, 'x0', { exceptions: EX })).status).toBe(403);
    const rec = await post(h, '/v1/migration/exceptions', MGR, 'x1', { exceptions: EX });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(rec.body).toMatchObject({ recorded: 2, outstanding: { total: 2, clearForCutover: false, valueAtStakeMinor: 12000 } });
    expect(codeOf(await post(h, '/v1/migration/exceptions/EX-1/resolution', MGR, 'r0', { action: 'merge', reason: 'same item' }))).toBe('merge_without_survivor');
    expect((await post(h, '/v1/migration/exceptions/EX-1/resolution', MGR, 'r1', { action: 'merge', reason: 'same item, keep the newer', survivingLegacyId: 'L-2' })).status).toBe(200);
    const ok = await post(h, '/v1/migration/exceptions/EX-2/resolution', OWNER, 'r2', { action: 'correct', reason: 'counted the shelf: 0' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ outstanding: { clearForCutover: true, unresolved: [] } });
    const read = (await get(h, '/v1/migration/exceptions', MGR)).body as { exceptions: { exceptionId: string; resolution?: { decidedBy: string } }[]; outstanding: { total: number } };
    expect(read.outstanding.total).toBe(2); // resolved ones are the evidence — never pruned
    expect(read.exceptions.find((e) => e.exceptionId === 'EX-2')?.resolution?.decidedBy).toBe(OWNER);
    expect((await get(h, '/v1/migration/exceptions', CASHIER)).status).toBe(403);
    expect(await h.store.readStream(T, 'migration', { type: 'MigrationExceptionResolved' })).toHaveLength(2);
  });

  it('a decision relayed from the store box: applied for a manager, REFUSED-and-recorded for a cashier or a stranger', async () => {
    const h = await seeded();
    await post(h, '/v1/migration/exceptions', MGR, 'x1', { exceptions: EX });
    const applied = await post(h, '/v1/migration/exceptions/EX-1/resolution/synced', SYNC, 's1', { action: 'migrate_as_is', decidedBy: MGR, reason: 'both are genuinely sold' });
    expect(applied.status).toBe(202);
    expect(applied.body).toMatchObject({ applied: true });
    const refused = await post(h, '/v1/migration/exceptions/EX-2/resolution/synced', SYNC, 's2', { action: 'correct', decidedBy: CASHIER, reason: 'fixed it' });
    expect(refused.status).toBe(202);
    expect(refused.body).toMatchObject({ applied: false, refusedBecause: 'decider_lacks_authority' });
    const read = (await get(h, '/v1/migration/exceptions')).body as { exceptions: { exceptionId: string; resolution?: unknown }[]; refusedDecisions: { attemptedBy: string; refusedBecause: string }[] };
    expect(read.exceptions.find((e) => e.exceptionId === 'EX-1')?.resolution).toMatchObject({ decidedBy: MGR });
    expect(read.exceptions.find((e) => e.exceptionId === 'EX-2')?.resolution).toBeUndefined();
    expect(read.refusedDecisions).toEqual([expect.objectContaining({ attemptedBy: CASHIER, refusedBecause: 'decider_lacks_authority' })]);
    // Only a sync-capable identity may relay; an accountant cannot.
    await h.provisionRole(T, 'u-acct', 'accountant');
    expect((await post(h, '/v1/migration/exceptions/EX-2/resolution/synced', 'u-acct', 's3', { action: 'correct', decidedBy: MGR, reason: 'r' })).status).toBe(403);
  });
});

describe('MG-06 control totals through the API', () => {
  it('records, signs by the right people, refuses the wrong ones, and QG-07 turns true when all are signed', async () => {
    const h = await seeded();
    expect(codeOf(await post(h, '/v1/migration/control-totals', MGR, 't0', { totals: [{ ...TOTALS[0], loadedDerivation: 'SUM(qty) FROM legacy stock' }] }))).toBe('same_derivation_both_sides');
    const rec = await post(h, '/v1/migration/control-totals', MGR, 't1', { totals: TOTALS });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(rec.body).toMatchObject({ recorded: 2, reconciliation: { qg07Passed: false } });
    // The manager cannot sign at all (no permission); the loader cannot sign their own load; finance needs the CA.
    expect((await post(h, '/v1/migration/control-totals/CT-STOCK/signature', MGR, 'sg0', { statement: 'ok' })).status).toBe(403);
    expect(codeOf(await post(h, '/v1/migration/control-totals/CT-FIN/signature', OWNER, 'sg1', { statement: 'ok' }))).toBe('finance_or_tax_needs_ca');
    expect((await post(h, '/v1/migration/control-totals/CT-STOCK/signature', OWNER, 'sg2', { statement: 'counted a 40-line sample myself' })).status).toBe(200);
    const fin = await post(h, '/v1/migration/control-totals/CT-FIN/signature', CA, 'sg3', { statement: 'agrees to the signed accounts' });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ total: { signature: { signedBy: CA, signerRole: 'chartered_accountant' } }, reconciliation: { qg07Passed: true } });
    expect(codeOf(await post(h, '/v1/migration/control-totals/CT-STOCK/signature', CA, 'sg4', { statement: 'again' }))).toBe('already_signed');
    const read = (await get(h, '/v1/migration/control-totals', CA)).body as { totals: unknown[]; reconciliation: { qg07Passed: boolean } };
    expect(read.totals).toHaveLength(2);
    expect(read.reconciliation.qg07Passed).toBe(true);
  });

  it('a signature relayed from the store box: applied for the CA on finance, refused-and-recorded for the loader and for a manager', async () => {
    const h = await seeded();
    await post(h, '/v1/migration/control-totals', MGR, 't1', { totals: TOTALS });
    const applied = await post(h, '/v1/migration/control-totals/CT-FIN/signature/synced', SYNC, 's1', { signedBy: CA, signerRole: 'owner', statement: 'agrees to the accounts' });
    expect(applied.status).toBe(202);
    expect(applied.body).toMatchObject({ applied: true });
    expect((await post(h, '/v1/migration/control-totals/CT-STOCK/signature/synced', SYNC, 's2', { signedBy: LOADER, statement: 'I loaded it, it is right' })).body)
      .toMatchObject({ applied: false, refusedBecause: 'signer_lacks_authority' }); // a manager holds no sign permission at all
    const read = (await get(h, '/v1/migration/control-totals')).body as { totals: { totalId: string; signature?: { signedBy: string; signerRole: string } }[]; refusedDecisions: { refusedBecause: string }[] };
    expect(read.totals.find((t) => t.totalId === 'CT-FIN')?.signature).toMatchObject({ signedBy: CA, signerRole: 'chartered_accountant' }); // role from grants, not the body's "owner"
    expect(read.totals.find((t) => t.totalId === 'CT-STOCK')?.signature).toBeUndefined();
    expect(read.refusedDecisions).toHaveLength(1);
  });
});
