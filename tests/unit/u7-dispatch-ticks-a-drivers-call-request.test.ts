import { describe, it, expect } from 'vitest';
import { createDispatchSession, DISPATCH_COPY, callRequestLine } from '../../apps/web-erp/src/dispatch-session';

// U7 (OB-726 · OB-700 · M19): the Dispatch board lists the drivers' "please call the customer" requests; once the store has
// called the customer from the order's own record, a person with the alert-tick word ticks it — the request's operational
// alert's acknowledgement, the one record the Ops alerts page reads too. Synthetic data.

interface Call { method: string; path: string; body: unknown }
function fakeFetch() {
  const calls: Call[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ alertId: 'x', acknowledgedBy: 'u-d', at: '2026-11-13T10:00:00.000Z' }) };
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('the drivers\' call requests on the Dispatch board', () => {
  it('ticks the request\'s alert as called — only with the alert-tick word', async () => {
    const f = fakeFetch();
    const s = createDispatchSession({ viewer: { userId: 'u-d', permissions: ['delivery.run.read', 'platform.alert.acknowledge'] }, fetch: f.fetch });
    expect(s.may.tickCalls).toBe(true);
    expect((await s.markCalled('R 1', 'S/2')).result).toBe('ok');
    expect(f.calls).toEqual([{ method: 'POST', path: `/v1/platform/alerts/${encodeURIComponent('delivery-call:R 1:S/2')}/acknowledge`, body: {} }]);
    const none = createDispatchSession({ viewer: { userId: 'u-c', permissions: ['delivery.run.read'] }, fetch: fakeFetch().fetch });
    expect(none.may.tickCalls).toBe(false);
    expect(await none.markCalled('R1', 'S1')).toEqual({ result: 'invalid', why: 'cannotTickCalls' });
  });

  it('says each request in both languages: the order, the area, who asked and when; called by whom, or not yet', () => {
    const req = { stopId: 'S1', orderRef: 'ORD-1', driverId: 'u-ravi', area: 'Near the market', at: '2026-11-13T05:00:00.000Z', toldUserIds: ['u-m'], called: null };
    const name = (id: string) => (id === 'u-ravi' ? 'Ravi' : id === 'u-m' ? 'Meena' : id);
    const clock = (iso: string) => (iso === '2026-11-13T05:00:00.000Z' ? '10:30' : '11:00');
    expect(callRequestLine('en', req, name, clock)).toBe('Order ORD-1 · Near the market · Ravi asked at 10:30 · told Meena · not called yet');
    expect(callRequestLine('en', { ...req, called: { by: 'u-m', at: '2026-11-13T05:30:00.000Z' } }, name, clock)).toBe('Order ORD-1 · Near the market · Ravi asked at 10:30 · told Meena · called by Meena at 11:00');
    expect(callRequestLine('ta', req, name, clock)).not.toMatch(/\b(asked|told|called|Order)\b/);
    for (const k of ['callsH', 'callsLead', 'markCalled', 'cannotTickCalls', 'calledChip', 'notCalledChip']) {
      expect((DISPATCH_COPY.en as Record<string, string>)[k], k).toBeTruthy();
      expect((DISPATCH_COPY.ta as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});
