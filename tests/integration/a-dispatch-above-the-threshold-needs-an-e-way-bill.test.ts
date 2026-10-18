import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { transferEwbMovementId } from '../../services/api/src/r3-tax-pay-adapters';

/**
 * **R3 · A23 remainder — a stock-transfer dispatch above the e-way-bill threshold needs a GENERATED e-way bill, on the real
 * API, in memory AND on real PostgreSQL, with a cold restart.** Signed sentence: "a dispatch at or below the threshold
 * proceeds. One above it without a `generated` e-way bill is refused by name. With one, it proceeds and the movement links
 * to the EWB number." The thresholds are the existing engine's (inter-State ₹50,000; intra-Tamil-Nadu ₹1,00,000 — the TN
 * figure still to be confirmed with the CA, as its traceability row says). Synthetic GSTINs with valid check characters.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const TN_1 = '33AAACS1111A1ZH';
const TN_2 = '33AAACS1111A2ZG';
const KA = '29AAACS1111A1Z6';
/** The Part-A request the e-way bill for a transfer is generated from (synthetic). */
const partA = (documentNumber: string, consignmentValueMinor: number, supplyRoute: 'intra_state' | 'inter_state') => ({
  request: { supplierGstin: TN_1, recipientGstin: supplyRoute === 'intra_state' ? TN_2 : KA, documentType: 'CHL', documentNumber, documentDate: '2026-10-15', hsnCode: '1006', consignmentValueMinor, supplyRoute, movementReason: 'stock_transfer', fromPincode: '600001', toPincode: supplyRoute === 'intra_state' ? '641001' : '560001' },
});

describe.each(backings)('a dispatch above the threshold needs an e-way bill — on $name (A23)', ({ harness, restart }) => {
  it('at or below proceeds; above is refused by name until a generated e-way bill exists; then it proceeds carrying the number', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    for (const u of ['u-boss', 'u-proposer']) await h.provisionRole(T, u, 'store_manager');
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // The organisation: the warehouse and store 1 in Tamil Nadu, store 2 in Karnataka, store 3 with no registration yet.
    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'Synthetic Retail' }), 'company');
    for (const [g, name] of [[TN_1, 'TN head'], [TN_2, 'TN store'], [KA, 'KA store']] as const) await ok(call('POST', `/v1/org/gst-registrations/${g}`, 'u-owner', { companyId: 'C1', legalName: `Synthetic ${name}` }), `registration ${g}`);
    await ok(call('POST', '/v1/org/nodes/WH', 'u-owner', { kind: 'warehouse', name: 'Central warehouse', parentId: 'C1', companyId: 'C1', gstin: TN_1 }), 'warehouse');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1 (TN)', parentId: 'C1', companyId: 'C1', gstin: TN_2 }), 'store 1');
    await ok(call('POST', '/v1/org/nodes/S2', 'u-owner', { kind: 'branch', name: 'Store 2 (KA)', parentId: 'C1', companyId: 'C1', gstin: KA }), 'store 2');
    await ok(call('POST', '/v1/org/nodes/S3', 'u-owner', { kind: 'branch', name: 'Store 3 (registration pending)', parentId: 'C1', companyId: 'C1' }), 'store 3');
    // Rice at the warehouse at ₹100.00 a bag (head office's own cost).
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rx-rice', productId: 'P-RICE', locationId: 'WH', kind: 'received', quantityMinor: 5_000, uom: 'EA', occurredAt: '2026-10-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 10_000 }), 'stock');
    const propose = (id: string, to: string, qty: number) => ok(call('POST', `/v1/warehouse/transfers/${id}`, 'u-proposer', { fromLocationId: 'WH', toLocationId: to, lines: [{ productId: 'P-RICE', batchId: null, quantityMinor: qty, uom: 'EA' }] }), `propose ${id}`);
    const dispatch = (id: string) => call('POST', `/v1/warehouse/transfers/${id}/dispatch`, 'u-boss', {});
    const onHand = async () => ((await call('GET', '/v1/inventory/availability', 'u-owner')).body as { rows: { productId: string; locationId: string; onHandMinor: number }[]; inTransit: { transferId: string }[] });

    // ── AT OR BELOW THE THRESHOLD: ₹1,00,000 exactly within Tamil Nadu proceeds ──
    await propose('t-small', 'S1', 1_000);
    const small = await dispatch('t-small');
    expect(small.status, JSON.stringify(small.body)).toBe(200);
    expect(small.body).toMatchObject({ state: 'in_transit', ewayBill: { outcome: 'not_required', consignmentValueMinor: 10_000_000, thresholdMinor: 10_000_000, supplyRoute: 'intra_state' } });

    // ── ABOVE IT, NO E-WAY BILL: refused by name, nothing moves ──
    await propose('t-big', 'S1', 1_001);
    expect((await onHand()).rows.find((r) => r.locationId === 'WH')?.onHandMinor).toBe(4_000);
    const big = await dispatch('t-big');
    expect([big.status, codeOf(big)]).toEqual([409, 'ewb_required']);
    expect((big.body as { error: { whatHappened: string } }).error.whatHappened).toBe('Transfer t-big cannot leave without an e-way bill: movement transfer-t-big is worth ₹1,00,100.00, above the ₹1,00,000.00 threshold, and no e-way bill has been generated for it.');
    const after = await onHand();
    expect(after.rows.find((r) => r.locationId === 'WH')?.onHandMinor).toBe(4_000);
    expect(after.inTransit.map((x) => x.transferId)).toEqual(['t-small']);
    expect(((await call('GET', '/v1/warehouse/transfers/t-big', 'u-owner')).body as { state: string }).state).toBe('proposed');
    // Inter-State the lower threshold applies: ₹60,000 to Karnataka is refused; to the unregistered store too (said).
    await propose('t-ka', 'S2', 600);
    expect(codeOf(await dispatch('t-ka'))).toBe('ewb_required');
    await propose('t-s3', 'S3', 600);
    const s3 = await dispatch('t-s3');
    expect(codeOf(s3)).toBe('ewb_required');
    expect((s3.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/the GST state of one end is not known, so the lower inter-State threshold applies/);

    // ── AN E-WAY BILL NOT YET GENERATED (submitted, no portal answer) is still refused, naming its state ──
    const movement = transferEwbMovementId('t-big');
    expect(movement).toBe('transfer-t-big');
    await ok(call('POST', `/v1/finance/e-way-bill/movements/${movement}/submit`, 'u-owner', partA('TR-t-big', 10_010_000, 'intra_state')), 'submit');
    const pending = await dispatch('t-big');
    expect(codeOf(pending)).toBe('ewb_required');
    expect((pending.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/its e-way bill is pending unknown, not generated/);

    // ── A COLD RESTART, then the portal's answer: generated ──
    h = restart(h);
    await ok(call('POST', `/v1/finance/e-way-bill/movements/${movement}/record-response`, 'u-owner', { result: { status: 'generated', ewbNo: '391000123456', ewbDate: '2026-10-15', validUpto: '2026-10-16' } }), 'generated');
    const covered = await dispatch('t-big');
    expect(covered.status, JSON.stringify(covered.body)).toBe(200);
    expect(covered.body).toMatchObject({ state: 'in_transit', ewayBill: { outcome: 'covered', ewbNo: '391000123456', movementId: 'transfer-t-big' } });
    // The movement links to the EWB number — on the transfer as head office keeps it.
    expect((await call('GET', '/v1/warehouse/transfers/t-big', 'u-owner')).body).toMatchObject({ state: 'in_transit', ewayBill: { movementId: 'transfer-t-big', ewbNo: '391000123456' } });

    // ── A CANCELLED e-way bill no longer covers the goods ──
    const kaMovement = transferEwbMovementId('t-ka');
    await ok(call('POST', `/v1/finance/e-way-bill/movements/${kaMovement}/submit`, 'u-owner', partA('TR-t-ka', 6_000_000, 'inter_state')), 'submit ka');
    await ok(call('POST', `/v1/finance/e-way-bill/movements/${kaMovement}/record-response`, 'u-owner', { result: { status: 'generated', ewbNo: '391000123457', ewbDate: '2026-10-15', validUpto: '2026-10-17' } }), 'generated ka');
    await ok(call('POST', `/v1/finance/e-way-bill/movements/${kaMovement}/cancel`, 'u-owner', { reason: 'lorry changed (synthetic)' }), 'cancel ka');
    const cancelled = await dispatch('t-ka');
    expect(codeOf(cancelled)).toBe('ewb_required');
    expect((cancelled.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/its e-way bill is cancelled, not generated/);
  }, 120_000);
});
