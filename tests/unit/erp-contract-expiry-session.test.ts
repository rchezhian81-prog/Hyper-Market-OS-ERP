import { describe, it, expect } from 'vitest';
import { createContractExpirySession, windowWords, dueWords, CONTRACT_EXPIRY_COPY } from '../../apps/web-erp/src/contract-expiry-session';

// FG-4 · M04-FR-04 / M06-FR-03: contract endings on the Owner alerts page. The window is "not set" until the owner enters
// it; only the owner sets it (owner.alert.manage), with a whole number of days from 1 to 365, or clears it with a reason.

const recorder = () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    return new Response(JSON.stringify({ due: [] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

describe('contract-expiry session (M04-FR-04 · M06-FR-03)', () => {
  it('reads with owner.alert.read; sets and clears only with owner.alert.manage, the cheap refusals first', async () => {
    const r = recorder();
    const owner = createContractExpirySession({ viewer: { userId: 'u-owner', permissions: ['owner.alert.read', 'owner.alert.manage'] }, fetch: r.fetch, newKey: () => 'k' });
    expect((await owner.read()).result).toBe('ok');
    for (const bad of ['0', '366', '1.5', 'thirty', '']) expect(await owner.setDays(bad)).toEqual({ result: 'invalid', why: 'needDays' });
    expect((await owner.setDays(' 30 ')).result).toBe('ok');
    expect(await owner.clear(' ')).toEqual({ result: 'invalid', why: 'needWhy' });
    expect((await owner.clear('no early warning wanted')).result).toBe('ok');
    expect(r.calls).toEqual([
      { url: '/v1/reporting/contract-expiry-alerts', method: 'GET' },
      { url: '/v1/reporting/contract-expiry-alerts/warning-days', method: 'POST', body: { days: 30 } },
      { url: '/v1/reporting/contract-expiry-alerts/warning-days', method: 'POST', body: { days: null, reason: 'no early warning wanted' } },
    ]);
    const reader = createContractExpirySession({ viewer: { userId: 'u-mgr', permissions: ['owner.alert.read'] }, fetch: r.fetch });
    expect(await reader.setDays('30')).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(await createContractExpirySession({ viewer: { userId: 'u', permissions: [] }, fetch: r.fetch }).read()).toEqual({ result: 'invalid', why: 'cannotRead' });
  });

  it('says the window and each contract in words; a Tamil twin for every word', () => {
    expect(windowWords('en', { state: 'not_set', days: null })).toMatch(/^Not set: only contracts that have already ended/);
    expect(windowWords('en', { state: 'set', days: 30 })).toBe('You are told 30 day(s) before a contract ends');
    expect(dueWords('en', { alertId: 'a', register: 'display', contractId: 'DC-1', supplierId: 'sup-d', endsOn: '2026-10-20', daysLeft: -6, step: 'expired' })).toBe('Display contract DC-1 · sup-d · ended on 2026-10-20');
    expect(Object.keys(CONTRACT_EXPIRY_COPY.ta).sort()).toEqual(Object.keys(CONTRACT_EXPIRY_COPY.en).sort());
  });
});
