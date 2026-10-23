import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { tenantClient } from '../support/r3-ops-backings';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { InMemoryNumberSeriesStore, SqlNumberSeriesStore } from '../../packages/persistence/src/number-series-store';

/**
 * **R3 · D-11 · OB-196 "A" (owner, 18 Oct 2026, in writing, "Yes, numbered")** — on the real API, in memory and on real
 * PostgreSQL, with a cold restart: goods handed back at the DSD door get a debit note NUMBERED from the shop's own gap-free
 * debit-note series — the same series the supplier master issues every other debit note under — and it shows on the
 * supplier's account statement. A refused close spends no number; a resent close keeps its number; a delivery with nothing
 * handed back has no note.
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

// The series is durable like the store: the in-memory backing shares one series across the restart (as the SQL table does).
const backings: { name: string; harness: () => { make: () => ApiHarness } }[] = [
  { name: 'the in-memory event store', harness: () => { const series = new InMemoryNumberSeriesStore(); let h: ApiHarness | undefined; return { make: () => (h = apiHarness({ ...(h === undefined ? {} : { store: h.store }), numberSeries: series })) }; } },
];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: () => ({ make: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), numberSeries: new SqlNumberSeriesStore(sql) }); } }) });
}

const cost = { minor: 2_500, currency: 'INR' };
const note = (noteRef: string, driverSignedName: string) => ({ deliveryNote: { noteRef, driverSignedName } });

describe.each(backings)('a DSD hand-back gets a numbered debit note — on $name (D-11 · OB-196)', ({ harness }) => {
  it('numbered from the one series at close, gap-free; on the supplier statement; shared with the supplier master; 403 and error paths', async () => {
    const life = harness();
    let h = life.make();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-recv', 'store_manager');
    await h.provisionRole(T, 'u-po-buyer', 'store_manager'); // OB-288 P3 (§28): the buyer who raises the order is never the one who books it in
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    await approvedSuppliers(h, T, 'sup-dairy');
    const { req, ok, code } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S-A', { kind: 'branch', name: 'Store A', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(req('POST', '/v1/purchase/orders/po-dairy', { supplierId: 'sup-dairy', deliverToLocationId: 'S-A', lines: [{ productId: 'p-milk', orderedQty: 40, unitCost: cost }] }, 'u-po-buyer'), 'po');
    await ok(req('POST', '/v1/purchase/orders/po-dairy/approval', { reason: 'weekly dairy' }), 'issue po');
    const open = (id: string, arrivedAt: string) => ok(req('POST', `/v1/inventory/dsd-checkins/${id}`, { supplierId: 'sup-dairy', storeId: 'S-A', poId: 'po-dairy', driverName: 'Ravi', arrivedAt }, 'u-recv'), `open ${id}`);
    const scan = (id: string, scanId: string, q: number) => ok(req('POST', `/v1/inventory/dsd-checkins/${id}/scans/${scanId}`, { productId: 'p-milk', quantityMinor: q }, 'u-recv'), `scan ${scanId}`);
    const handBack = (id: string, hbId: string, q: number) => ok(req('POST', `/v1/inventory/dsd-checkins/${id}/hand-backs/${hbId}`, { productId: 'p-milk', quantityMinor: q, reason: 'damaged' }, 'u-recv'), `hand back ${hbId}`);
    type Closed = { checkIn: { debitNote: { debitNoteRef: string; number: string | null; seq: number | null; valueMinor: number | null } | null } };

    // ── c-1: 3 handed back. A cashier cannot close; a close with cash is refused — neither spends a number ──
    await open('c-1', '2030-06-01T06:30:00.000Z');
    await scan('c-1', 's1', 10);
    await handBack('c-1', 'h1', 3);
    expect((await req('POST', '/v1/inventory/dsd-checkins/c-1/close', note('DN-SUP-1', 'Ravi'), 'u-till')).status).toBe(403);
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/close', { ...note('DN-SUP-1', 'Ravi'), cashMinor: 100 }, 'u-recv'))).toBe('no_cash_at_the_door');
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/close', {}, 'u-recv'))).toBe('delivery_note_not_signed');
    const c1 = (await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/close', note('DN-SUP-1', 'Ravi'), 'u-recv'), 'close c-1')).body as Closed;
    expect(c1.checkIn.debitNote).toMatchObject({ debitNoteRef: 'DN-DSD-c-1', number: 'DN-000001', seq: 1, valueMinor: 7_500 });

    // ── c-2: nothing handed back — no note, no number spent ──
    await open('c-2', '2030-06-02T06:30:00.000Z');
    await scan('c-2', 's2', 5);
    const c2 = (await ok(req('POST', '/v1/inventory/dsd-checkins/c-2/close', note('DN-SUP-2', 'Ravi'), 'u-recv'), 'close c-2')).body as Closed;
    expect(c2.checkIn.debitNote).toBeNull();

    h = life.make(); // ── COLD RESTART ──────────────────────────────────────────────────────────────────────────

    // A resent close keeps its number.
    expect(((await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/close', note('DN-SUP-1', 'Ravi'), 'u-recv'), 'close c-1 again')).body as Closed & { alreadyClosed: boolean })).toMatchObject({ alreadyClosed: true, checkIn: { debitNote: { number: 'DN-000001' } } });

    // ── c-3: the next hand-back takes the NEXT number — no gap ──
    await open('c-3', '2030-06-03T06:30:00.000Z');
    await scan('c-3', 's3', 6);
    await handBack('c-3', 'h3', 2);
    const c3 = (await ok(req('POST', '/v1/inventory/dsd-checkins/c-3/close', note('DN-SUP-3', 'Ravi'), 'u-recv'), 'close c-3')).body as Closed;
    expect(c3.checkIn.debitNote).toMatchObject({ number: 'DN-000002', seq: 2, valueMinor: 5_000 });

    // ── ONE series: a debit note the supplier master issues for a returned receipt line takes the next number ──
    await ok(req('POST', '/v1/inventory/goods-receipt/grn-1', { warehouseId: 'S-A', receivedOnDate: '2030-06-04', currency: 'INR', poId: 'po-dairy', lines: [{ lineId: 'L1', productId: 'p-milk', orderedMinor: 2, countedMinor: 2, uom: 'ea', unitCost: cost, condition: 'damaged' }] }, 'u-recv'), 'grn');
    await ok(req('POST', '/v1/inventory/goods-receipt/grn-1/lines/L1/disposition', { disposition: 'return', reason: 'dented' }, 'u-mgr2'), 'disposition');
    const issued = (await ok(req('POST', '/v1/purchase/suppliers/sup-dairy/debit-notes/DN-grn-1-L1/issue', {}, 'u-mgr2'), 'issue')).body as { number: string };
    expect(issued.number).toBe('DN-000003');

    // ── the supplier's statement shows the door notes, numbered; they are shown, not netted (OB-196 open question) ──
    const st = (await ok(req('GET', '/v1/purchase/suppliers/sup-dairy/account'), 'statement')).body as {
      doorDebitNotes: { debitNoteRef: string; number: string; checkInId: string; valueMinor: number; nettedInBalance: boolean }[];
      doorDebitNotesTotal: { valueMinor: number; notesWithValueUnknown: number; nettedInBalance: boolean };
      debitNotes: { debitNoteRef: string; number: string | null }[]; totals: { debitNotesMinor: number };
    };
    expect(st.doorDebitNotes.map((d) => `${d.debitNoteRef}=${d.number}`)).toEqual(['DN-DSD-c-1=DN-000001', 'DN-DSD-c-3=DN-000002']);
    expect(st.doorDebitNotes.every((d) => d.nettedInBalance === false)).toBe(true);
    expect(st.doorDebitNotesTotal).toEqual({ valueMinor: 12_500, notesWithValueUnknown: 0, nettedInBalance: false });
    expect(st.debitNotes).toEqual([expect.objectContaining({ debitNoteRef: 'DN-grn-1-L1', number: 'DN-000003' })]);
    expect(st.totals.debitNotesMinor).toBe(5_000); // the receipt-line note only; the door notes are not netted
    // A cashier cannot read the statement.
    expect((await req('GET', '/v1/purchase/suppliers/sup-dairy/account', undefined, 'u-till')).status).toBe(403);
  }, 60_000);
});
