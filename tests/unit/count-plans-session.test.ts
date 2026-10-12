import { describe, it, expect } from 'vitest';
import { createCountPlansSession, planBody, freezeWords, lineView, COUNT_PLAN_WORD_KEYS, text, paiseOf } from '../../apps/web-erp/src/count-plans-session';
import { headOfficeHttp, type HeadOfficeHttp, type HttpAnswer } from '../../apps/web-erp/src/head-office-http';

/**
 * The Count plans page's session model (WF-08 · D05-FR-05 · OB-59): it shapes the manager's form into the body head
 * office's count-plan route reads, refuses only the cheap things before any POST, and hands head office's refusal back in
 * head office's words. The connected proof is tests/e2e/count-plans-on-the-production-api.e2e.ts.
 */

function fakeHttp(answer: HttpAnswer = { result: 'ok', status: 200, body: {} }) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const http: HeadOfficeHttp = {
    get: async (path) => { sent.push({ method: 'GET', path }); return answer; },
    post: async (path, body) => { sent.push({ method: 'POST', path, body }); return answer; },
  };
  return { http, sent };
}
const MANAGER = { userId: 'u-mgr', permissions: ['inventory.count.plan', 'inventory.movement.append', 'inventory.adjustment.approve'] };
const IDS = { plan: () => 'cp-1', count: (p: string, x: string) => `${p}-${x}-k` };
const FORM = { locationId: ' br-1 ', productsText: 'P1, P2\nP1\n', thresholdRupees: '₹20', freeze: 'default' as const, kinds: [], note: ' aisle 4 ' };

describe('the count plans session', () => {
  it('a plan left on the owner\'s default names NO frozen kinds, so head office applies OB-59 (adjustments and write-offs) and says so', () => {
    expect(planBody(FORM)).toEqual({ body: { locationId: 'br-1', productIds: ['P1', 'P2'], recountThresholdMinor: 2_000, note: 'aisle 4' } });
    expect(planBody({ ...FORM, freeze: 'custom', kinds: ['adjusted', 'received'] })).toMatchObject({ body: { frozenKinds: ['adjusted', 'received'] } });
    expect(planBody({ ...FORM, freeze: 'none' })).toMatchObject({ body: { frozenKinds: [] } });
    expect(freezeWords('en', { frozenKinds: ['adjusted', 'wasted'], frozenByDefault: true })).toBe('Frozen while counting: Adjustments, Write-offs (the owner\'s default, OB-59). Till sales and returns are never frozen.');
    expect(freezeWords('en', { frozenKinds: [] })).toMatch(/^Freezes nothing\./);
  });

  it('refuses the cheap things before any POST: no place, no products, a threshold that is not money, a custom freeze with nothing ticked', async () => {
    expect(planBody({ ...FORM, locationId: ' ' })).toEqual({ key: 'needPlace' });
    expect(planBody({ ...FORM, productsText: ' , ' })).toEqual({ key: 'needProducts' });
    expect(planBody({ ...FORM, thresholdRupees: '-5' })).toEqual({ key: 'needThreshold' });
    expect(planBody({ ...FORM, freeze: 'custom', kinds: [] })).toEqual({ key: 'needKinds' });
    expect([paiseOf('1,250.5'), paiseOf('12.345'), paiseOf('abc')]).toEqual([125_050, undefined, undefined]);
    const { http, sent } = fakeHttp();
    const s = createCountPlansSession(MANAGER, http, IDS);
    expect(await s.create({ ...FORM, locationId: '' })).toEqual({ result: 'invalid', key: 'needPlace' });
    expect(await s.count('cp-1', { productId: 'P1', locationId: 'br-1', uom: 'EA', countedText: '9.5', recountOf: null })).toEqual({ result: 'invalid', key: 'needQty' });
    expect(await s.approve('cp-1', '  ')).toEqual({ result: 'invalid', key: 'needReason' });
    expect(await s.cancel('cp-1', '')).toEqual({ result: 'invalid', key: 'needReason' });
    expect(await s.cause('cp-1', 'k', 'bad_luck', 'x')).toEqual({ result: 'invalid', key: 'needCause' });
    expect(sent).toEqual([]);
  });

  it('a blind count carries only what the counter saw — never an expected figure, a value or an approver', async () => {
    const { http, sent } = fakeHttp({ result: 'ok', status: 201, body: { recorded: true } });
    const s = createCountPlansSession(MANAGER, http, IDS);
    await s.count('cp-1', { productId: 'P2', locationId: 'br-1', uom: ' ', countedText: '46', recountOf: 'cp-1-P2-a' });
    expect(sent).toEqual([{ method: 'POST', path: '/v1/inventory/count-plans/cp-1/counts/cp-1-P2-k', body: { productId: 'P2', locationId: 'br-1', uom: 'EA', countedMinor: 46, recountOf: 'cp-1-P2-a' } }]);
    await s.create(FORM);
    await s.open('cp-1');
    await s.approve('cp-1', ' aisle 4 done ');
    expect(sent.slice(1).map((x) => [x.path, x.body])).toEqual([
      ['/v1/inventory/count-plans/cp-1', { locationId: 'br-1', productIds: ['P1', 'P2'], recountThresholdMinor: 2_000, note: 'aisle 4' }],
      ['/v1/inventory/count-plans/cp-1/open', {}],
      ['/v1/inventory/count-plans/cp-1/approve', { reason: 'aisle 4 done' }],
    ]);
  });

  it('shows head office\'s refusal in head office\'s words, says when head office could not be reached, and a nobody sends nothing', async () => {
    const refused = createCountPlansSession(MANAGER, fakeHttp({ result: 'refused', status: 422, code: 'self_approval', whatHappened: 'u-mgr counted P1 and cannot approve their own variance (§28).' }).http, IDS);
    const out = await refused.approve('cp-1', 'done');
    expect(refused.say('en', out)).toEqual({ tone: 'err', words: 'Head office refused: u-mgr counted P1 and cannot approve their own variance (§28).' });
    expect(refused.say('ta', out).words).toMatch(/^தலைமை அலுவலகம் மறுத்தது: u-mgr counted P1/);
    const lost = createCountPlansSession(MANAGER, fakeHttp({ result: 'lost_link' }).http, IDS);
    expect(lost.say('en', await lost.open('cp-1')).words).toBe('Head office cannot be reached — nothing is known to have changed.');
    const { http, sent } = fakeHttp();
    const nobody = createCountPlansSession(undefined, http, IDS);
    expect(nobody.nobody).toBe(true);
    expect(await nobody.list()).toEqual({ result: 'invalid', key: 'nobody' });
    expect(await nobody.open('cp-1')).toEqual({ result: 'invalid', key: 'nobody' });
    expect(sent).toEqual([]);
    const cashier = createCountPlansSession({ userId: 'u-till', permissions: ['pos.sale.sync'] }, http, IDS);
    expect(cashier.may).toEqual({ read: false, plan: false, count: false, approve: false });
  });

  it('reads a line as the manager needs it — the standing count, the reasons a recount is needed, the cause', () => {
    const v = lineView('en', {
      productId: 'P2', state: 'recount_required', finalCountId: 'k2', recountBecause: ['over_recount_threshold', 'moved_during_freeze'], cause: null, varianceMinor: -5, valueMinor: 5_000,
      counts: [{ countId: 'k2', productId: 'P2', expectedMinor: 50, countedMinor: 45, varianceMinor: -5, valueMinor: 5_000, counterId: 'u-c1' }],
    });
    expect(v).toMatchObject({ stateWord: 'Recount needed', expected: 50, counted: 45, variance: -5, value: '−₹50.00', tone: 'degraded', needsCause: false });
    expect(v.recountBecause).toEqual(['difference at or over the recount threshold', 'a frozen movement landed after it was counted']);
  });

  it('has a Tamil word for every English one', () => {
    for (const k of COUNT_PLAN_WORD_KEYS) expect(text('ta', k), k).not.toBe(text('en', k));
  });

  it('the head-office port sends a POST with its own idempotency key and reads a refusal\'s own words', async () => {
    const calls: { path: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
    const http = headOfficeHttp(async (path, init) => {
      calls.push({ path, init });
      return { status: 409, json: async () => ({ error: { code: 'count_plan_not_open', whatHappened: 'Count plan cp-1 is approved.' } }) };
    }, () => 'key-1');
    expect(await http.post('/v1/x', { a: 1 })).toEqual({ result: 'refused', status: 409, code: 'count_plan_not_open', whatHappened: 'Count plan cp-1 is approved.' });
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'idempotency-key': 'key-1' } });
    const down = headOfficeHttp(async () => { throw new Error('offline'); });
    expect(await down.get('/v1/x')).toEqual({ result: 'lost_link' });
  });
});
