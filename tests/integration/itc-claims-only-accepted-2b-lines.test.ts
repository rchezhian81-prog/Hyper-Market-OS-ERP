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
import { itcForPeriodAdapter } from '../../services/api/src/r3-tax-pay-adapters';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { seedItcShop, october2b, ITC_PERIOD, ACCOUNTANT, SUP_A, SUP_B, SHOP_GSTIN } from '../support/itc-shop';

/**
 * **R3 · A17 — input tax credit through GSTR-2B + IMS, on the real API, in memory AND on real PostgreSQL, with a cold
 * restart (OB-145 "A": the accountant uploads the 2B).** Signed sentence: "an imported GSTR-2B/IMS file is matched line by
 * line against matched supplier invoices (GSTIN + invoice no. + date + tax). Each line ends accepted, rejected or pending by
 * a named person. ITC claimed in 3B Table 4 equals the accepted lines only. A booked invoice missing from 2B, and a 2B line
 * with no booked invoice, each appear as exceptions. A reversal (Rule 37/42/43, free samples via A12) is a compensating
 * entry."
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
interface Line { lineId: string; invoiceNo: string; supplierGstin: string; match: string; differences: string[]; state: string; actedBy: string | null; bookedInvoiceId: string | null }
interface Review {
  imported: boolean; lines: Line[]; uploadedBy: string | null; recipientGstin: string | null;
  exceptions: { missingFrom2b: { invoiceId: string; supplierInvoiceNo: string }[]; notInBooks: string[]; differs: string[]; incompleteBooked: unknown[]; notThreeWayMatched: string[] };
  totals: { awaitingCount: number; reversed: Record<string, number> };
  claim: Record<string, unknown>;
}

describe.each(backings)('ITC claims only the accepted GSTR-2B lines — on $name (A17)', ({ harness, restart }) => {
  it('upload → match → named exceptions → each line acted on by a named person → the claim is the accepted lines → reversal → restart', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-till', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: idempotencyKey ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    await seedItcShop({ call, owner: 'u-owner', grant: (u, r) => h.provisionRole(T, u, r), store: 'st-itc', createStore: true });
    const review = async (): Promise<Review> => {
      const r = await call('GET', `/v1/finance/itc/${ITC_PERIOD}`, ACCOUNTANT);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as Review;
    };

    // Before any upload: nothing to claim, and it says why — never a zero (P-08). The books' bills are all "missing".
    const before = await review();
    expect(before.imported).toBe(false);
    expect(before.claim).toEqual({ status: 'not_reconciled', reason: 'no GSTR-2B has been uploaded for 2026-10' });
    expect(before.exceptions.missingFrom2b).toHaveLength(4);

    // A cashier may neither upload nor read; a file for another month, and an unreadable one, are refused — nothing kept.
    expect((await call('POST', `/v1/finance/itc/${ITC_PERIOD}/statement`, 'u-till', { statement: october2b() })).status).toBe(403);
    expect((await call('GET', `/v1/finance/itc/${ITC_PERIOD}`, 'u-till')).status).toBe(403);
    const wrongMonth = await call('POST', '/v1/finance/itc/2026-09/statement', ACCOUNTANT, { statement: october2b() });
    expect([wrongMonth.status, codeOf(wrongMonth)]).toEqual([422, 'gstr2b_for_another_month']);
    const garbled = await call('POST', `/v1/finance/itc/${ITC_PERIOD}/statement`, ACCOUNTANT, { statement: { data: { rtnprd: '102026', gstin: SHOP_GSTIN, docdata: { b2b: [{ ctin: 'XX', inv: [] }] } } } });
    expect([garbled.status, codeOf(garbled)]).toEqual([422, 'gstr2b_not_readable']);
    expect((await call('POST', '/v1/finance/itc/2026-13/statement', ACCOUNTANT, { statement: october2b() })).status).toBe(400);

    // The accountant uploads October's 2B. The same file again is the same upload.
    const up = await call('POST', `/v1/finance/itc/${ITC_PERIOD}/statement`, ACCOUNTANT, { statement: october2b() });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ period: ITC_PERIOD, lines: 4, uploadedBy: ACCOUNTANT, alreadyUploaded: false });
    expect(((await call('POST', `/v1/finance/itc/${ITC_PERIOD}/statement`, ACCOUNTANT, { statement: october2b() })).body as { alreadyUploaded: boolean }).alreadyUploaded).toBe(true);

    // Matched line by line: GSTIN + number + date + tax. Both kinds of exception by name.
    let r = await review();
    expect(r).toMatchObject({ imported: true, uploadedBy: ACCOUNTANT, recipientGstin: SHOP_GSTIN });
    const line = (no: string): Line => r.lines.find((l) => l.invoiceNo === no)!;
    expect(line('A/101')).toMatchObject({ supplierGstin: SUP_A, match: 'matched', bookedInvoiceId: 'inv-a101', state: 'awaiting_a_person' });
    expect(line('A/102')).toMatchObject({ match: 'differs', differences: ['sgst'], bookedInvoiceId: 'inv-a102' });
    expect(line('B-77')).toMatchObject({ supplierGstin: SUP_B, match: 'matched', bookedInvoiceId: 'inv-b77' });
    expect(line('B-78')).toMatchObject({ match: 'not_in_books', bookedInvoiceId: null });
    expect(r.exceptions.notInBooks).toEqual([line('B-78').lineId]);
    expect(r.exceptions.differs).toEqual([line('A/102').lineId]);
    expect(r.exceptions.missingFrom2b.map((b) => [b.invoiceId, b.supplierInvoiceNo])).toEqual([['inv-b90', 'B-90']]);
    expect(r.claim).toMatchObject({ status: 'not_reconciled' });
    expect(r.totals.awaitingCount).toBe(4);

    const act = (no: string, body: Record<string, unknown>, who = ACCOUNTANT) => call('POST', `/v1/finance/itc/${ITC_PERIOD}/lines/${line(no).lineId}/action`, who, body);
    // Refusals: a cashier; a body that names who acted; an accept of a line the shop holds no invoice for, or one that
    // differs; a reject with no reason; a line that does not exist. Nothing is recorded by any of them.
    expect((await act('A/101', { action: 'accept' }, 'u-till')).status).toBe(403);
    expect(codeOf(await act('A/101', { action: 'accept', by: 'u-owner' }))).toBe('itc_action_names_a_person');
    const notBooked = await act('B-78', { action: 'accept' });
    expect([notBooked.status, codeOf(notBooked)]).toEqual([422, 'itc_line_not_matched']);
    expect(codeOf(await act('A/102', { action: 'accept' }))).toBe('itc_line_not_matched');
    expect(codeOf(await act('B-78', { action: 'reject' }))).toBe('itc_action_needs_a_reason');
    expect((await call('POST', `/v1/finance/itc/${ITC_PERIOD}/lines/ln-0000000000000000/action`, ACCOUNTANT, { action: 'pending', reason: 'x' })).status).toBe(404);
    expect((await review()).totals.awaitingCount).toBe(4);

    // Each line is acted on by a named, signed-in person.
    expect((await act('A/101', { action: 'accept' })).status).toBe(201);
    expect((await act('B-77', { action: 'accept' }, 'u-owner')).status).toBe(201);
    expect((await act('A/102', { action: 'pending', reason: 'SGST on the paper is ₹440; asked the supplier to correct the portal' })).status).toBe(201);
    // Three of four acted on: still not reconciled, and the port says the same.
    expect((await review()).claim).toMatchObject({ status: 'not_reconciled', reason: expect.stringMatching(/1 line\(s\)/) });
    expect(await itcForPeriodAdapter({ store: h.store, now: () => new Date().toISOString() })(T, ITC_PERIOD)).toMatchObject({ status: 'not_reconciled' });
    expect((await act('B-78', { action: 'reject', reason: 'no such bill received from Synthetic Oils' })).status).toBe(201);

    // A different file for a month people have acted on is refused — their decisions were on this one.
    const other = october2b() as { data: { docdata: { b2b: { inv: unknown[] }[] } } };
    other.data.docdata.b2b[1]!.inv.pop();
    expect(codeOf(await call('POST', `/v1/finance/itc/${ITC_PERIOD}/statement`, ACCOUNTANT, { statement: other }))).toBe('gstr2b_already_acted_on');

    // ── A COLD RESTART: everything above is rebuilt from the store ──
    h = restart(h);
    r = await review();
    expect(line('A/101')).toMatchObject({ state: 'accepted', actedBy: ACCOUNTANT });
    expect(line('B-77')).toMatchObject({ state: 'accepted', actedBy: 'u-owner' });
    expect(line('A/102')).toMatchObject({ state: 'pending', actedBy: ACCOUNTANT });
    expect(line('B-78')).toMatchObject({ state: 'rejected', actedBy: ACCOUNTANT });
    // The claim is the ACCEPTED lines only: CGST ₹900 + SGST ₹900 (A/101) + IGST ₹240 (B-77).
    expect(r.claim).toEqual({ status: 'reconciled', igstMinor: 24_000, cgstMinor: 90_000, sgstMinor: 90_000, cessMinor: 0, reversed: { igstMinor: 0, cgstMinor: 0, sgstMinor: 0, cessMinor: 0 }, acceptedLines: 2 });
    const port = itcForPeriodAdapter({ store: h.store, now: () => new Date().toISOString() });
    expect(await port(T, ITC_PERIOD)).toEqual({ status: 'reconciled', igstMinor: 24_000, cgstMinor: 90_000, sgstMinor: 90_000, cessMinor: 0 });
    expect(await port(T, '2026-11')).toEqual({ status: 'not_reconciled', reason: 'no GSTR-2B has been uploaded for 2026-11' });
    expect((await call('GET', `/v1/finance/itc/${ITC_PERIOD}/claim`, ACCOUNTANT)).body).toMatchObject({ claim: { status: 'reconciled', cgstMinor: 90_000 } });
    // The missing-from-2B bill is still named; B-78 still an exception (rejected, never claimed).
    expect(r.exceptions.missingFrom2b.map((b) => b.invoiceId)).toEqual(['inv-b90']);

    // A reversal (free samples under A12) is its own compensating record; the accepted credit is not edited.
    expect(codeOf(await call('POST', `/v1/finance/itc/${ITC_PERIOD}/reversals/rv-1`, ACCOUNTANT, { rule: 'rule_99', sourceRef: 'x', reason: 'x', cgstMinor: 1 }))).toBe('not_readable_as_an_itc_reversal');
    const rv = await call('POST', `/v1/finance/itc/${ITC_PERIOD}/reversals/rv-1`, ACCOUNTANT, { rule: 'free_samples', sourceRef: 'A12 free sample FS-SYN-1', reason: 'rice given away as free samples', cgstMinor: 4_500, sgstMinor: 4_500 });
    expect(rv.status, JSON.stringify(rv.body)).toBe(201);
    expect(((await call('POST', `/v1/finance/itc/${ITC_PERIOD}/reversals/rv-1`, ACCOUNTANT, { rule: 'free_samples', sourceRef: 'A12 free sample FS-SYN-1', reason: 'rice given away as free samples', cgstMinor: 4_500, sgstMinor: 4_500 })).body as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true);
    r = await review();
    expect(r.claim).toMatchObject({ status: 'reconciled', cgstMinor: 90_000, sgstMinor: 90_000, reversed: { cgstMinor: 4_500, sgstMinor: 4_500 } });

    // Each action is in the sealed audit trail under the person who took it.
    const trail = (await h.store.readStream(T, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' })).map((e) => e.event.payload as { actorId: string; action: string });
    expect(trail.filter((a) => a.action.startsWith('finance.itc.')).map((a) => `${a.actorId}:${a.action}`)).toEqual(expect.arrayContaining([
      `${ACCOUNTANT}:finance.itc.statement.upload`, `${ACCOUNTANT}:finance.itc.line.accept`, 'u-owner:finance.itc.line.accept',
      `${ACCOUNTANT}:finance.itc.line.pending`, `${ACCOUNTANT}:finance.itc.line.reject`, `${ACCOUNTANT}:finance.itc.reversal`,
    ]));
  }, 120_000);
});
