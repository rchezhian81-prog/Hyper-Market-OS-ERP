import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { signInAtLane, receiptNumberAt, operatorHeader } from '../support/till-operator';
import { backingsFor, headOffice, startBox, storePack, type Box } from '../support/till-bill-world';

/**
 * **A2 · §31.1 · OB-327 — the bill series changes financial year only on a clock the store computer trusts.** The box's
 * clock check (OB-327: bills flagged at 5 minutes' difference from head office) now drives the year switch of the bill
 * series: while head office's clock says this box is 10 minutes out, a bill at 00:00 IST on 1 April by the box's clock is
 * still numbered in the old year (last-known-good — the box may simply be fast) and the status says the clock is not
 * trusted; once head office's answers put the clock back in step, the next bill starts the new year at 000001. Selling is
 * never stopped (hard rule #1). Across a cold restart the box keeps the old year until the clock is checked again.
 * The box's clock is moved with a fake `Date`; head office's clock is the `Date` header on its answers. Synthetic data only.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'S1';
const boxes: Box[] = [];
const saved = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = saved;
  for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); }
  vi.useRealTimers();
});

describe.each(backings)('A2 — the year switch waits for a trusted clock — on $name', (backing) => {
  it('10 minutes out: the old year carries on, said; back in step: 000001 in the new year; a cold restart keeps last-known-good', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-31T18:20:00.000Z')); // 23:50 IST, 31 March 2027
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }]);
    await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE' });
    await ho.ok('POST', `/v1/stores/${STORE}/settings`, 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 });
    for (const [prefix, financialYear] of [['S1A26-', '2026-27'], ['S1A27-', '2027-28']] as const) {
      expect((await ho.call('POST', `/v1/stores/${STORE}/tills/lane-1/receipt-prefix`, 'u-owner', { prefix, financialYear })).status).toBe(201);
    }
    const served = await ho.call('GET', `/v1/store-packs/${STORE}`, 'u-box', undefined, undefined, STORE);
    const sections = (served.body as { sections: Record<string, unknown> }).sections;

    // Head office's clock, as its answers' Date header says it: `skewMs` ahead of this box.
    let skewMs = 10 * 60_000;
    globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return saved(url, init);
      return new Response('{"error":"down for the test"}', { status: 503, headers: { 'content-type': 'application/json', date: new Date(Date.now() + skewMs).toUTCString() } });
    }) as typeof fetch;

    const box = await startBox({
      tenantId: ho.tenantId, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }], cloud: { boxUser: 'u-box', storeId: STORE },
      pack: { ...storePack(STORE), receiptSeries: sections['receiptSeries'], receiptNumbering: sections['receiptNumbering'] },
    });
    boxes.push(box);
    const next = async (): Promise<string> => receiptNumberAt(box.edge.lane!.port, await signInAtLane(box.edge.lane!.port, 'u-lanecash'));
    const status = async (): Promise<Record<string, unknown>> => (await (await fetch(`http://127.0.0.1:${box.edge.lane!.port}/lane/receipt-numbers`, {
      headers: operatorHeader(await signInAtLane(box.edge.lane!.port, 'u-lanecash')),
    })).json()) as Record<string, unknown>;

    expect(await next()).toBe('S1A26-000001');
    await box.edge.refreshPack!(); // head office answers; the box measures its clock: 10 minutes out
    vi.setSystemTime(new Date('2027-03-31T18:30:00.000Z')); // 00:00 IST, 1 April by THIS box's clock
    expect(await next()).toBe('S1A26-000002'); // last-known-good: the old year carries on
    expect(JSON.stringify(await status())).toContain('"clockTrusted":false');

    await box.restartCold(); // ── the store computer COLD: its clock log says it was out, so the old year still holds ──────
    expect(await next()).toBe('S1A26-000003');

    skewMs = 0; // head office's answers now agree with this box's clock
    await box.edge.refreshPack!();
    expect(await next()).toBe('S1A27-000001'); // the new financial year, from 1
    const after = JSON.stringify(await status());
    expect(after).toContain('"clockTrusted":true');
    expect(after).toContain('"financialYear":"2027-28"');
  }, 90_000);
});
