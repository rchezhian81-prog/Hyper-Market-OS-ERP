import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { readLog } from '../../edge/store-edge/src/file-log';
import { GST_INVOICE_NUMBER_MAX } from '../../packages/contracts/src/receipt-number';
import { signInAtLane, receiptNumberAt, operatorHeader, signInTill } from '../support/till-operator';
import { backingsFor, headOffice, startBox, storePack, type Box } from '../support/till-bill-world';

/**
 * **A2 (roadmap v2.1 addendum · CGST Rule 46(b)) — the till's bill series is per FINANCIAL YEAR and starts again on
 * 1 April: from head office's prefix issue to the store computer's numbering at midnight, on the in-memory store AND real
 * PostgreSQL, head office and the store computer each restarted COLD, the till offline (no head office reachable).**
 *
 *   head office issues till lane-1 a prefix for 2026-27 and another for 2027-28 — the 2026-27 prefix cannot also be issued
 *   for 2027-28 (409, numbers would repeat across years); a year not written YYYY-YY is refused (400); the store pack
 *   carries both, each with its year → the store computer, its clock at 31 March 23:59 IST, numbers under 2026-27; at
 *   00:00 IST on 1 April the next number is 000001 under 2027-28; a cold restart carries on from there; every number is at
 *   most 16 characters and every `S-<number>` sale id is unique; a year with no prefix issued numbers under a fallback made
 *   for THAT year (said), and head office names the till that needs one.
 * The box's clock is moved with a fake `Date` (nothing else is faked). Synthetic data only.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'S1';
const boxes: Box[] = [];
afterEach(async () => {
  for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); }
  vi.useRealTimers();
});

describe.each(backings)('A2 — the bill series starts again on 1 April — on $name', (backing) => {
  it('per-year prefixes from head office; 000001 at midnight IST on 1 April; across cold restarts; a year with none falls back and is named', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-31T17:50:00.000Z')); // 23:20 India time, 31 March 2027
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }, { userId: 'u-lanecash', role: 'cashier' }]);
    await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE' });
    await ho.ok('POST', `/v1/stores/${STORE}/settings`, 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 });
    const issue = (body: Record<string, unknown>) => ho.call('POST', `/v1/stores/${STORE}/tills/lane-1/receipt-prefix`, 'u-owner', body);
    expect((await issue({ prefix: 'S1A26-', financialYear: '2026-27' })).status).toBe(201);
    expect((await issue({ prefix: 'S1A27-', financialYear: '2027-29' })).status).toBe(400);
    const again = await issue({ prefix: 'S1A26-', financialYear: '2027-28' });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/a prefix used in one year can never number another/);
    expect((await issue({ prefix: 'S1A27-', financialYear: '2027-28' })).status).toBe(201);
    ho.restartCold(); // ── head office COLD ─────────────────────────────────────────────────────────────────────────────

    const served = await ho.call('GET', `/v1/store-packs/${STORE}`, 'u-box', undefined, undefined, STORE);
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    const sections = (served.body as { sections: Record<string, unknown> }).sections;
    const series = sections['receiptSeries'] as { laneId: string; prefix: string; financialYear?: string }[];
    expect(series.map((s) => [s.prefix, s.financialYear]).sort()).toEqual([['S1A26-', '2026-27'], ['S1A27-', '2027-28']]);

    // The store computer: head office's series in its setup, then NO head office (the till trades offline).
    const box = await startBox({ tenantId: ho.tenantId, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }], pack: { ...storePack(STORE), receiptSeries: series, receiptNumbering: sections['receiptNumbering'] } });
    boxes.push(box);
    const next = async (): Promise<string> => receiptNumberAt(box.edge.lane!.port, await signInAtLane(box.edge.lane!.port, 'u-lanecash'));
    const numbers: string[] = [await next()];
    vi.setSystemTime(new Date('2027-03-31T18:29:59.000Z')); // 23:59:59 IST, still 2026-27
    numbers.push(await next());
    expect(numbers).toEqual(['S1A26-000001', 'S1A26-000002']);
    vi.setSystemTime(new Date('2027-03-31T18:30:00.000Z')); // 00:00 IST, 1 April 2027 — mid-shift, the box still running
    numbers.push(await next());
    expect(numbers[2]).toBe('S1A27-000001');

    // A real till sale under the new year's number, offline, on the box's disk.
    const till = bootPos({ laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: { tenantId: ho.tenantId, version: 1, builtAt: new Date().toISOString(), products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active' }], barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }] } });
    await signInTill(till, 'u-lanecash');
    till.scanBarcode('8901234567890');
    const n = await till.nextReceipt();
    numbers.push(n);
    await till.tenderCash(`S-${n}`, n, new Date().toISOString());

    // ── the store computer restarts COLD: the count carries on in the new year, never from 1 again ─────────────────────
    await box.restartCold();
    numbers.push(await next());
    expect(numbers.slice(2)).toEqual(['S1A27-000001', 'S1A27-000002', 'S1A27-000003']);
    const status = await (await fetch(`http://127.0.0.1:${box.edge.lane!.port}/lane/receipt-numbers`, { headers: operatorHeader(await signInAtLane(box.edge.lane!.port, 'u-lanecash')) })).json() as Record<string, unknown>;
    expect(JSON.stringify(status)).toContain('"financialYear":"2027-28"');
    expect(JSON.stringify(status)).toContain('"financialYearScoped":true');
    const sales = (await readLog(box.edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { id: string }] : []));
    expect(sales.map((s) => s.id)).toEqual(['S-S1A27-000002']);

    // ── a year with no prefix issued: a fallback made for THAT year, said; head office names the till ─────────────────
    vi.setSystemTime(new Date('2028-04-01T00:00:00.000Z')); // 05:30 IST, 1 April 2028 — 2028-29, nothing issued
    const token = await signInAtLane(box.edge.lane!.port, 'u-lanecash');
    const fallback = await (await fetch(`http://127.0.0.1:${box.edge.lane!.port}/lane/receipt-numbers`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body: JSON.stringify({ requestKey: 'rq-2028' }),
    })).json() as { receiptNumber: string; fallbackBecause?: string; laneMessage?: string; financialYear?: string };
    expect(fallback).toMatchObject({ fallbackBecause: 'financial_year_series_not_issued', financialYear: '2028-29' });
    expect(fallback.receiptNumber).toMatch(/^ZZ[A-Z2-7]{6}-000001$/);
    expect(fallback.laneMessage).toMatch(/has not issued this till its prefix for 2028-29/);
    numbers.push(fallback.receiptNumber);
    const prefixes = await ho.ok('GET', '/v1/receipt-prefixes', 'u-owner') as { needsYearPrefix: { tillId: string; financialYear: string }[] };
    expect(prefixes.needsYearPrefix).toEqual([expect.objectContaining({ tillId: 'lane-1', financialYear: '2028-29' })]);

    // Every number within GST's 16 characters, and no two bills (nor sale ids) the same across the years.
    for (const x of numbers) expect(x.length).toBeLessThanOrEqual(GST_INVOICE_NUMBER_MAX);
    expect(new Set(numbers.map((x) => `S-${x}`)).size).toBe(numbers.length);
  }, 90_000);
});
