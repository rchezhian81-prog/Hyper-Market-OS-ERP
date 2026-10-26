import { describe, it, expect } from 'vitest';
import { createFreeSampleSession, freeSampleWords, freeSampleOutcomeWords, FREE_SAMPLE_COPY } from '../../apps/web-erp/src/free-sample-session';

// FG-4 · OB-386: the free-sample session. Records only with inventory.movement.append (when the page says who is looking),
// sends no value and no tax of its own (head office works both out), lists a month for the accountant and checks with a
// note; a Tamil twin for every word.

const recorder = () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    return new Response(JSON.stringify({ itcWords: '₹5.00', issues: [], toCheck: 0, notComputed: 0 }), { status: 201 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

describe('free-sample session (OB-386)', () => {
  it('records with the stock permission, the cheap refusals first, and sends no figure of its own', async () => {
    const r = recorder();
    const s = createFreeSampleSession({ viewer: { userId: 'u', permissions: ['inventory.movement.append'] }, fetch: r.fetch, newIssueId: () => 'fs-1' });
    const ok = { productId: 'rice', locationId: 'wh-1', qty: '2', uom: 'ea', note: 'tasting' };
    expect(await s.record({ ...ok, qty: '0' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await s.record({ ...ok, qty: '1.5' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await s.record({ ...ok, note: ' ' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect((await s.record(ok)).result).toBe('ok');
    expect(r.calls).toEqual([{ url: '/v1/inventory/free-samples/fs-1', method: 'POST', body: { productId: 'rice', locationId: 'wh-1', qty: 2, uom: 'ea', note: 'tasting' } }]);
    expect(await createFreeSampleSession({ viewer: { userId: 'u', permissions: [] }, fetch: r.fetch }).record(ok)).toEqual({ result: 'invalid', why: 'cannotRecord' });
    expect(await createFreeSampleSession({ viewer: { permissions: ['inventory.movement.append'] }, fetch: r.fetch }).record(ok)).toEqual({ result: 'invalid', why: 'nobody' });
    // A page that carries no identity leaves every permission to head office.
    expect(createFreeSampleSession({ fetch: r.fetch }).may).toEqual({ named: true, record: true, approve: true });
  });

  it('lists a month and checks with a note', async () => {
    const r = recorder();
    const s = createFreeSampleSession({ fetch: r.fetch, newKey: () => 'k' });
    expect(await s.list('October')).toEqual({ result: 'invalid', why: 'noMonth' });
    expect((await s.list('2026-10')).result).toBe('ok');
    expect(await s.check('fs-1', 'agreed', ' ')).toEqual({ result: 'invalid', why: 'needNote' });
    expect((await s.check('fs-1', 'query', 'which bill?')).result).toBe('ok');
    expect(r.calls).toEqual([
      { url: '/v1/finance/free-sample-itc?month=2026-10', method: 'GET' },
      { url: '/v1/finance/free-sample-itc/fs-1/check', method: 'POST', body: { outcome: 'query', note: 'which bill?' } },
    ]);
  });

  it('says outcomes in words; a Tamil twin for every word', () => {
    expect(freeSampleOutcomeWords('en', { result: 'lost_link' })).toMatch(/nothing was recorded/);
    expect(freeSampleOutcomeWords('en', { result: 'refused', status: 403, code: 'self_check', whatHappened: 'not yours' })).toBe('Head office refused: not yours');
    expect(freeSampleWords('ta', 'fsH')).toBe('இலவச மாதிரி கொடு');
    expect(Object.keys(FREE_SAMPLE_COPY.ta).sort()).toEqual(Object.keys(FREE_SAMPLE_COPY.en).sort());
  });
});
