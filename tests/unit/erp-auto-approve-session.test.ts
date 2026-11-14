// CR-01 OI-12 — the Auto-approve limits page's tested session (apps/web-erp/src/auto-approve-session.ts): who may do what,
// what is checked before anything is sent, what is sent, and that every word has a Tamil twin.
import { describe, it, expect } from 'vitest';
import { createAutoApproveSession, limitOf, AUTO_APPROVE_COPY, type KindView } from '../../apps/web-erp/src/auto-approve-session';

const READ = {
  running: false, switchVersion: 0, versionOf: { reorder_from_approved_supplier: 1, markdown_short_dated: 0, stock_transfer: 0 },
  rules: [{ ruleId: 'reorder_from_approved_supplier-v1', kind: 'reorder_from_approved_supplier', limit: 500_000, askedBy: 'u-owner', confirmedBy: 'u-accountant', confirmedAt: '2026-11-14T04:01:00.000Z', reason: 'small reorders' }],
  pending: [{ requestId: 'aar-1', action: 'resume', reason: 'start', requestedBy: 'u-owner', requestedAt: '2026-11-14T04:02:00.000Z' }],
  history: [], stops: [], decisions: [],
  kinds: [
    { kind: 'reorder_from_approved_supplier', nameEn: 'A reorder', nameTa: 'மறு ஆர்டர்', usualEn: 'u', usualTa: 'u', measure: 'value_minor' },
    { kind: 'markdown_short_dated', nameEn: 'A markdown', nameTa: 'விலைக் குறைப்பு', usualEn: 'u', usualTa: 'u', measure: 'percent_bps' },
  ],
  neverAutoApproved: ['permission_change', 'refund', 'payment_to_new_payee'],
};

function fakeFetch() {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init?: { method?: string; body?: string }) => {
    sent.push({ method: init?.method ?? 'GET', path, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return new Response(JSON.stringify(READ), { status: init?.method === 'POST' ? 201 : 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const OWNER = { userId: 'u-owner', permissions: ['ai.autoapprove.read', 'ai.autoapprove.propose', 'ai.autoapprove.confirm', 'ai.autoapprove.stop'] };
const MANAGER = { userId: 'u-manager', permissions: ['ai.autoapprove.read', 'ai.autoapprove.stop'] };

describe('the Auto-approve limits page session (CR-01 OI-12)', () => {
  it('reads head office once and shapes it — the rule, who set it, what waits, and which request is mine', async () => {
    const f = fakeFetch();
    const s = createAutoApproveSession({ viewer: OWNER, fetch: f.fetch });
    const out = await s.read();
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.kinds[0]!.rule).toMatchObject({ limit: 500_000, askedBy: 'u-owner', confirmedBy: 'u-accountant' });
    expect(out.value.kinds[0]!.version).toBe(1);
    expect(out.value.kinds[1]!.rule).toBeNull();
    expect(out.value.pending[0]).toMatchObject({ requestId: 'aar-1', mine: true });
    expect(out.value.never).toEqual(['permission_change', 'refund', 'payment_to_new_payee']);
    expect(f.sent).toEqual([{ method: 'GET', path: '/v1/ai/auto-approve', body: undefined }]);
  });

  it('asks for a limit with the version it read; a bad limit or no reason is refused before anything is sent', async () => {
    const f = fakeFetch();
    const s = createAutoApproveSession({ viewer: OWNER, fetch: f.fetch });
    const view = await s.read();
    if (view.result !== 'ok') throw new Error('read');
    const reorder = view.value.kinds[0] as KindView; const markdown = view.value.kinds[1] as KindView;
    f.sent.length = 0;
    expect(await s.askLimit(reorder, { limit: 'five thousand', reason: 'x' })).toEqual({ result: 'invalid', why: 'needRupees' });
    expect(await s.askLimit(markdown, { limit: '120', reason: 'x' })).toEqual({ result: 'invalid', why: 'needPercent' });
    expect(await s.askLimit(reorder, { limit: '6000', reason: ' ' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(f.sent).toEqual([]);
    await s.askLimit(reorder, { limit: '6000', reason: 'a little more' });
    expect(f.sent[0]).toEqual({ method: 'POST', path: '/v1/ai/auto-approve/requests', body: { action: 'set_limit', kind: 'reorder_from_approved_supplier', limit: 600_000, basedOnVersion: 1, reason: 'a little more' } });
    await s.askLimit(markdown, { limit: '30', reason: 'clear it' });
    expect(f.sent[2]!.body).toMatchObject({ kind: 'markdown_short_dated', limit: 3_000, basedOnVersion: 0 });
  });

  it('the manager may stop, with a reason, but may not ask or confirm', async () => {
    const f = fakeFetch();
    const s = createAutoApproveSession({ viewer: MANAGER, fetch: f.fetch });
    expect(s.may).toMatchObject({ read: true, propose: false, confirm: false, stop: true });
    const view = await s.read(); if (view.result !== 'ok') throw new Error('read');
    expect(await s.askStart(view.value, 'go')).toEqual({ result: 'invalid', why: 'readOnly' });
    expect(await s.decide('aar-1', 'confirmed', '')).toEqual({ result: 'invalid', why: 'readOnly' });
    expect(await s.stop('')).toEqual({ result: 'invalid', why: 'needReason' });
    await s.stop('checking a delivery');
    expect(f.sent.at(-2)).toEqual({ method: 'POST', path: '/v1/ai/auto-approve/stop', body: { reason: 'checking a delivery' } });
  });

  it('refusing needs a reason; nobody signed in sees nothing', async () => {
    const f = fakeFetch();
    const s = createAutoApproveSession({ viewer: OWNER, fetch: f.fetch });
    expect(await s.decide('aar-1', 'refused', '')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await createAutoApproveSession({ viewer: undefined, fetch: f.fetch }).read()).toEqual({ result: 'invalid', why: 'nobody' });
  });

  it('a limit as typed: whole rupees or paise for money, a whole 1–100 percentage for a markdown', () => {
    expect(limitOf('value_minor', '5000')).toBe(500_000);
    expect(limitOf('value_minor', '49.50')).toBe(4_950);
    expect(limitOf('value_minor', '0')).toBeUndefined();
    expect(limitOf('percent_bps', '30')).toBe(3_000);
    expect(limitOf('percent_bps', '0')).toBeUndefined();
    expect(limitOf('percent_bps', '12.5')).toBeUndefined();
  });

  it('every English word has a Tamil twin', () => {
    expect(Object.keys(AUTO_APPROVE_COPY.ta).sort()).toEqual(Object.keys(AUTO_APPROVE_COPY.en).sort());
    for (const v of Object.values(AUTO_APPROVE_COPY.ta)) expect(v.trim().length).toBeGreaterThan(0);
  });
});
