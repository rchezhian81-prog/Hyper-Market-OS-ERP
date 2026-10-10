import { describe, it, expect } from 'vitest';
import type { HttpResponse } from '../../services/kernel/src/index';
import { apiHarness } from '../support/api-harness';

/**
 * **The migration pipeline, proven through the REAL request pipeline (MG-01…MG-11).**
 *
 * The route-level unit tests invoke each handler directly. This suite drives the SAME routes the way
 * production composes them — through `buildSurface` with the real token authenticator, the real
 * per-tenant RBAC resolver, the real idempotency store and the real `migrationAdapter` (which folds
 * RoleGranted events for `rolesOf`, so a chartered accountant is a chartered accountant because the
 * ledger says so). It walks the whole chain end to end:
 *
 *   discovery → preserve → map → clean → trial-load → reconcile → sign (CA for finance) →
 *   opening balances → delta → cutover
 *
 * and proves the authority model at the door: a role without migration permission is refused, and a
 * finance total can only be signed by the CA. This is the integration evidence behind rating MG at
 * INTEGRATION_TESTED. Synthetic data only; the harness target is 'rehearsal' (never production).
 */

const T = 't-sre';
const OWNER = 'u-owner';
const CA = 'u-ca';
const SM = 'u-sm';
const bodyOf = (res: HttpResponse) => (typeof res.body === 'string' ? JSON.parse(res.body) : res.body);

async function seededHarness() {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, CA, 'chartered_accountant');
  await h.provisionRole(T, SM, 'store_manager');
  return h;
}

const post = (h: Awaited<ReturnType<typeof seededHarness>>, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });

describe('the migration pipeline over the real authenticated surface', () => {
  it('refuses a role without migration authority at the door (RBAC, real pipeline)', async () => {
    const h = await seededHarness();
    const res = await post(h, '/v1/migration/discovery', SM, 'd-sm', {
      sources: [{ sourceId: 's1', name: 'Old ERP', kind: 'erp_database', volumeBasis: 'counted', extractable: true }],
    });
    expect(res.status).toBe(403); // store_manager holds no migration.* permission
  });

  it('runs discovery, then preservation seal + verify', async () => {
    const h = await seededHarness();
    const disc = await post(h, '/v1/migration/discovery', OWNER, 'd1', {
      sources: [{ sourceId: 's1', name: 'Old ERP', kind: 'erp_database', volumeBasis: 'counted', extractable: true, owner: 'IT', rowCount: 1000, retentionYears: 8 }],
    });
    expect(disc.status).toBe(200);

    const seal = await post(h, '/v1/migration/extracts/X-1/seal', OWNER, 'seal1', {
      sourceId: 's1', material: 'row1\nrow2\nrow3', rowCount: 3, extractedBy: 'u-op', backupVerifiedAt: '2026-09-12T09:00:00Z',
    });
    expect(seal.status).toBe(200);
    const extract = bodyOf(seal);

    const verify = await post(h, '/v1/migration/extracts/verify', OWNER, 'ver1', { extract, material: 'row1\nrow2\nrow3', rowCount: 3 });
    expect(verify.status).toBe(200);
    expect(bodyOf(verify).matches).toBe(true);
  });

  it('approves a mapping and measures coverage, and runs cleaning + trial-load', async () => {
    const h = await seededHarness();
    const table = { mappingId: 'M1', tenantId: T, version: 1, status: 'draft', entries: [
      { domain: 'tax_code', legacyValue: 'TX', targetValue: 'GST18', rationale: 'legacy 18%' },
    ] };
    const approve = await post(h, '/v1/migration/mapping/approve', OWNER, 'map1', { table });
    expect(approve.status).toBe(200);
    const approved = bodyOf(approve);
    expect(approved.status).toBe('approved');

    const cov = await post(h, '/v1/migration/mapping/coverage', OWNER, 'cov1', {
      table: approved, observed: [{ domain: 'tax_code', value: 'TX', rows: 10 }],
    });
    expect(bodyOf(cov).fullyCovered).toBe(true);

    const clean = await post(h, '/v1/migration/cleaning/exceptions', OWNER, 'cln1', {
      dataset: { products: [{ legacyId: 'P1', name: 'Rice', barcode: '89', uom: 'kg', taxCode: 'TX', costMinor: 1, priceMinor: 2, departmentCode: 'G', active: true }], stock: [] },
    });
    expect(bodyOf(clean).nothingWasModified).toBe(true);

    const trial = await post(h, '/v1/migration/trial-loads', OWNER, 'tr1', {
      rowsToLoad: 1000, elapsedMs: 5000, extractVerified: true, blockingExceptionsOpen: 0, targetPreparedEmpty: true, fullVolumeRows: 50000,
    });
    expect(bodyOf(trial).ok).toBe(true);
  });

  it('reconciles, then only the CA can sign a finance total — proven through real role resolution', async () => {
    const h = await seededHarness();
    const stock = { totalId: 'CT-stock', tenantId: T, kind: 'stock', name: 'Stock', unit: 'minor_currency', legacyValue: 100000, loadedValue: 100000, legacyDerivation: 'legacy stock export', loadedDerivation: 'loaded stock_levels' };
    const finance = { totalId: 'CT-fin', tenantId: T, kind: 'financial', name: 'Trial balance', unit: 'minor_currency', legacyValue: 500000, loadedValue: 500000, legacyDerivation: 'legacy TB export', loadedDerivation: 'loaded opening journals' };

    const recon = await post(h, '/v1/migration/reconciliation', OWNER, 'rec1', { totals: [stock, finance] });
    expect(recon.status).toBe(200);
    expect(bodyOf(recon).qg07Passed).toBe(false); // nothing signed yet

    // Nothing is signed before a trial load is on record — then the owner runs it, and head office keeps who did.
    expect((await post(h, '/v1/migration/control-totals/sign', CA, 'sg0', { totals: [stock, finance], totalId: 'CT-stock', statement: 'ok' })).status).toBe(422);
    expect(bodyOf(await post(h, '/v1/migration/trial-loads', OWNER, 'tr-sign', {
      rowsToLoad: 1000, elapsedMs: 5000, extractVerified: true, blockingExceptionsOpen: 0, targetPreparedEmpty: true,
    })).ok).toBe(true);

    // The owner RAN the load, so the owner signs neither total (§28) — and cannot type someone else as the operator
    // (2b-vi-c-2, audit PA-03; before, the owner typed "u-op" and signed the stock total).
    const ownerStock = await post(h, '/v1/migration/control-totals/sign', OWNER, 'sg1', { totals: [stock, finance], totalId: 'CT-stock', statement: 'ok' });
    expect(ownerStock.status).toBe(422);
    expect((ownerStock.body as { error: { code: string } }).error.code).toBe('signer_ran_the_load');
    expect(((await post(h, '/v1/migration/control-totals/sign', OWNER, 'sg1-typed', { totals: [stock, finance], totalId: 'CT-stock', loadOperator: 'u-op', statement: 'ok' })).body as { error: { code: string } }).error.code).toBe('load_operator_is_read_from_the_record');

    // The chartered accountant, who did not run it, signs the stock total and the finance total.
    const caStock = await post(h, '/v1/migration/control-totals/sign', CA, 'sg2', { totals: [stock, finance], totalId: 'CT-stock', statement: 'counted' });
    expect(caStock.status).toBe(200);
    const afterStock = bodyOf(caStock).totals;

    const caFin = await post(h, '/v1/migration/control-totals/sign', CA, 'sg3', { totals: afterStock, totalId: 'CT-fin', statement: 'audited' });
    expect(caFin.status).toBe(200);
    const bothSigned = bodyOf(caFin).totals;

    // With both totals reconciled AND signed, opening balances can be built as append-only events.
    const opening = await post(h, '/v1/migration/opening-events', OWNER, 'op1', {
      totals: bothSigned,
      positions: [
        { kind: 'stock', subjectId: 'P1', valueMinor: 100000, fromTotalId: 'CT-stock' },
      ],
    });
    expect(opening.status).toBe(200);
    expect(bodyOf(opening).events[0].appendOnly).toBe(true);
  });

  it('a stock delta lands as real stock movements, ONCE — a retry under a new HTTP key and a restart change nothing (GT-04)', async () => {
    const h = await seededHarness();
    const changes = [
      // Received at the old store after the final extract: 10 at ₹360; then 3 sold on the old till.
      { changeKey: 'd-in-1', entity: 'stock', legacyId: 'P-RICE', operation: 'update', changedAt: '2026-09-12T08:00:00Z', deltaQty: 10, locationId: 'S1', uom: 'ea', unitCostMinor: 36_000 },
      { changeKey: 'd-out-1', entity: 'stock', legacyId: 'P-RICE', operation: 'update', changedAt: '2026-09-12T09:00:00Z', deltaQty: -3, locationId: 'S1', uom: 'ea' },
    ];
    const onHand = async (harness: typeof h): Promise<number | undefined> =>
      (bodyOf(await harness.request({ method: 'GET', path: '/v1/inventory/availability', userId: OWNER, tenantId: T, query: { productId: 'P-RICE' } })) as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((r) => r.locationId === 'S1')?.onHandMinor;

    const first = bodyOf(await post(h, '/v1/migration/deltas', OWNER, 'dl-a', { changes, extractCutoff: '2026-09-12T00:00:00Z' }));
    expect(first).toMatchObject({ applied: 2, refused: 0 });
    expect(await onHand(h)).toBe(7);
    const valued = bodyOf(await h.request({ method: 'GET', path: '/v1/inventory/valuation', userId: OWNER, tenantId: T, query: { productId: 'P-RICE' } })) as { rows: { value: { minor: number } }[] };
    expect(valued.rows[0]?.value.minor).toBe(7 * 36_000);

    // The same delta re-sent under a NEW HTTP idempotency key: head office's own record says it is in — no second effect.
    const retry = bodyOf(await post(h, '/v1/migration/deltas', OWNER, 'dl-b', { changes, extractCutoff: '2026-09-12T00:00:00Z' }));
    expect(retry).toMatchObject({ applied: 0, duplicatesIgnored: 2 });
    // After a restart (a fresh process over the same store): still once.
    const restarted = apiHarness({ store: h.store });
    const third = bodyOf(await restarted.request({ method: 'POST', path: '/v1/migration/deltas', userId: OWNER, tenantId: T, idempotencyKey: 'dl-c', body: { changes, extractCutoff: '2026-09-12T00:00:00Z' } }));
    expect(third).toMatchObject({ applied: 0, duplicatesIgnored: 2 });
    expect(await onHand(restarted)).toBe(7);
    // The source identity survives on the stock ledger: each movement is named for its change.
    const moved = await h.store.readStream(T, 'inventory', { type: 'InventoryMoved' });
    expect(moved.map((e) => (e.event.payload as { movementId: string }).movementId).sort()).toEqual(['delta-d-in-1', 'delta-d-out-1']);
    // And the cutover's delta check now reads head office's record of it.
    const decision = bodyOf(await post(h, '/v1/migration/cutover/decision', OWNER, 'cut-d', { evidence: {} }));
    expect((decision.checks as { check: string; state: string }[]).find((c) => c.check === 'delta_applied')?.state).toBe('passed');
  });

  it('a forged all-green cutover body gets NO GO — the gate reads head office\'s records, not the caller (GT-03)', async () => {
    const h = await seededHarness();
    // A change this version cannot apply is refused by name — never counted as applied (GT-04).
    const delta = await post(h, '/v1/migration/deltas', OWNER, 'dl1', {
      changes: [{ changeKey: 'c1', entity: 'sale', legacyId: 'S1', operation: 'insert', changedAt: '2026-09-12T09:00:00Z', deltaMinor: 5000 }],
      extractCutoff: '2026-09-12T00:00:00Z',
    });
    expect(bodyOf(delta)).toMatchObject({ applied: 0, refused: 1 });

    const cutover = await post(h, '/v1/migration/cutover/decision', OWNER, 'cut1', {
      evidence: {
        reconciliation: { tenantId: T, assessments: [], open: [], unsigned: [], qg07Passed: true, detail: 'signed' },
        parallel: { sufficient: true, detail: '3 clean days' },
        exceptions: { tenantId: T, clearForCutover: true, blockingUnresolved: [], detail: 'clear' },
        edgeUnsyncedItems: 0,
        deltaAppliedAt: '2026-09-12T02:00:00Z',
        rollbackDemonstratedAt: '2026-09-11T22:00:00Z',
        namedTeam: [{ userId: OWNER, role: 'owner' }],
        ownerGoBy: OWNER,
      },
    });
    expect(cutover.status).toBe(200);
    // Head office holds no signed totals, no run, no performed rollback and no applied delta for this tenant, and the
    // owner gave no GO by their own act — so the typed-in greens change nothing, and each is named as ignored.
    expect(bodyOf(cutover).decision.go).toBe(false);
    expect(bodyOf(cutover).decision.failed).toEqual(expect.arrayContaining(['control_totals_signed', 'rollback_demonstrated', 'parallel_run_sufficient', 'delta_applied', 'owner_go']));
    expect(bodyOf(cutover).ignoredFromCaller).toEqual(expect.arrayContaining(['reconciliation', 'parallel', 'exceptions', 'deltaAppliedAt', 'rollbackDemonstratedAt', 'ownerGoBy']));
    expect(bodyOf(cutover).decision.shopKeepsTrading).toBe(true);
  });
});
