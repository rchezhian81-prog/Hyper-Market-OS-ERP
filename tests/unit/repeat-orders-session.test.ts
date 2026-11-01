import { describe, it, expect } from 'vitest';
import { createRepeatOrdersSession, planWords, occurrenceWords, repeatOutcomeWords, repeatWords, REPEAT_ORDERS_COPY } from '../../apps/web-erp/src/repeat-orders-session';

// Repeat orders on the Delivery exceptions page (M17-FR-02 · OB-303 · Round 4b): a read, and "place the ones due now" only for
// a person who manages order exceptions. The connected proof is tests/e2e/repeat-orders-show-on-the-delivery-exceptions-page.e2e.ts.

describe('repeat orders (M17-FR-02)', () => {
  it('reads for an order reader; runs only for an exceptions manager; a nobody sends nothing', async () => {
    const sent: string[] = [];
    const fetch = (async (p: string, init: { method: string }) => { sent.push(`${init.method} ${p}`); return { ok: true, status: 200, json: async () => ({ placed: 0, notPlaced: 0, missed: 0 }) }; }) as unknown as typeof globalThis.fetch;
    const reader = createRepeatOrdersSession({ viewer: { userId: 'u-r', permissions: ['order.read'] }, fetch });
    expect(reader.may).toEqual({ named: true, read: true, run: false });
    await reader.read();
    expect(await reader.run()).toEqual({ result: 'invalid', why: 'cannotRun' });
    const manager = createRepeatOrdersSession({ viewer: { userId: 'u-m', permissions: ['order.read', 'order.exception.manage'] }, fetch });
    expect(repeatOutcomeWords('en', await manager.run())).toBe('Nothing was due — nothing was placed twice.');
    expect(await createRepeatOrdersSession({ viewer: undefined, fetch }).read()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(sent).toEqual(['GET /v1/repeat-orders', 'POST /v1/repeat-orders/run']);
  });
  it('words a plan and a day not placed; every word has a Tamil twin', () => {
    expect(planWords('en', { subscriptionId: 'S-1', locationId: 'br-1', fulfilment: 'delivery', startsOn: '2026-11-01', state: 'paused', nextDays: ['2026-11-03'], lines: [{}, {}], occurrences: [] }))
      .toBe('S-1 · Paused · delivered from br-1 · 2 items · from 2026-11-01 · next 2026-11-03');
    expect(occurrenceWords('en', { subscriptionId: 'S-1', day: '2026-11-02', orderId: 'o', outcome: 'missed', at: 'x', detail: 'not placed in time' })).toBe('S-1 · 2026-11-02 · Missed — not placed in time');
    expect(repeatOutcomeWords('en', { result: 'ok', value: { placed: 2, notPlaced: 1, missed: 0 } })).toBe('Done — placed 2 · not placed 1 · missed 0');
    for (const k of Object.keys(REPEAT_ORDERS_COPY.en)) expect(repeatWords('ta', k), k).not.toBe(repeatWords('en', k));
  });
});
