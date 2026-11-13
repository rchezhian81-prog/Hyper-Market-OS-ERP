import { describe, it, expect } from 'vitest';
import { createEslSession } from '../../apps/web-erp/src/esl-session';

// U7 (OB-725) · the Shelf labels page pages its pushes at head office: the table reads ONE page (search by name or code,
// sort by time or product), and the cards and "Send all again" read head office's summary of the WHOLE store — never
// counted from the rows on screen (P-08).

const AUDITOR = { userId: 'u-mgr', permissions: ['price.integrity.audit'] };
const push = { push: { pushId: 'p3', productId: 'DAL', priceMinor: 300, because: 'price_change', at: '2026-11-13T08:00:00.000Z', commands: [{ deviceId: 'd4' }] }, confirmed: [], unconfirmed: ['d4'], detail: '' };
const summary = { sent: 40, confirmed: 31, waiting: 2, noLabels: 7, waitingPushes: [{ pushId: 'p3', productId: 'DAL', priceMinor: 300, unconfirmed: 1 }, { pushId: 'p2', productId: 'RICE', priceMinor: 200, unconfirmed: 1 }] };

function fake() {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ branchId: 'store-1', pushes: [push], paging: { page: 1, size: 10, total: 40, pages: 4 }, notConfirmed: 2, summary, rule: 'r', hardware: 'h', asAt: '2026-11-13T09:00:00.000Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { asked, fetch };
}

describe('the Shelf labels session reads one page and a whole-store summary', () => {
  it('asks head office for one page — sorted by its own field, searched there — and reads the rows and the total', async () => {
    const f = fake();
    const s = createEslSession({ viewer: AUDITOR, fetch: f.fetch, storeId: 'store-1' });
    const out = await s.page({ page: 1, size: 10, search: 'dal', sort: 'at', dir: 'desc' });
    expect(f.asked).toEqual(['/v1/devices/esl/pushes?branchId=store-1&page=2&size=10&search=dal&sort=at&dir=desc']);
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.total).toBe(40);
    expect(out.value.rows.map((r) => [r.pushId, r.state])).toEqual([['p3', 'unconfirmed']]);
  });

  it('reads the whole store\'s summary for the cards and "Send all again" without reading every row', async () => {
    const f = fake();
    const s = createEslSession({ viewer: AUDITOR, fetch: f.fetch, storeId: 'store-1' });
    const out = await s.overview();
    expect(f.asked).toEqual(['/v1/devices/esl/pushes?branchId=store-1&page=1&size=1']);
    expect(out).toEqual({ result: 'ok', value: { sent: 40, confirmed: 31, waiting: 2, noLabels: 7, waitingPushes: summary.waitingPushes, asAt: '2026-11-13T09:00:00.000Z' } });
  });

  it('a person who may not read the pushes is told so, and nothing is asked', async () => {
    const f = fake();
    const s = createEslSession({ viewer: { userId: 'u-c', permissions: [] }, fetch: f.fetch, storeId: 'store-1' });
    expect(await s.overview()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await s.page({ page: 0, size: 10, search: '', sort: null, dir: 'asc' })).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(f.asked).toEqual([]);
  });
});
