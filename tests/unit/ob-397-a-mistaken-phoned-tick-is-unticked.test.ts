import { describe, it, expect } from 'vitest';
import type { RequestContext } from '../../services/kernel/src/index';
import {
  foldPhoneTicks, standingPhoneTicks, recallNoticeRoutes, buildRecallNoticeList,
  type RecallPhonedTick, type RecallPhonedUntick, type RecallNoticeDeps, type RecallBuyer,
} from '../../services/customer/src/recall-notices';

/**
 * **OB-397 (owner decision, 26 Oct 2026) — a mistaken "phoned" tick may be unticked with a written reason by someone other
 * than the person who ticked; both stay on record; withdrawal is judged on the ticks still standing.** The pure fold and
 * the route rule over in-memory records.
 */

const AT = '2030-06-11T00:00:00.000Z';
const tick = (customerRef: string, phonedBy: string, phonedAt: string, round?: number): RecallPhonedTick =>
  ({ batchId: 'B-1', customerRef, recallStartedAt: AT, phonedBy, phonedAt, ...(round === undefined ? {} : { round }) });
const untick = (customerRef: string, round: number, by: string, at: string, reason = 'ticked the wrong row'): RecallPhonedUntick =>
  ({ batchId: 'B-1', customerRef, recallStartedAt: AT, round, tickedBy: 'u-mgr', tickedAt: '2030-06-11T10:00:00.000Z', untickedBy: by, untickedAt: at, reason });

describe('the tick fold: standing ticks, the next round, and the whole record (OB-397)', () => {
  it('a tick stands until it is taken back; then none stands and the next tick is round 1; both stay in the record', () => {
    const one = foldPhoneTicks([tick('a', 'u-mgr', '2030-06-11T10:00:00.000Z')], []).get('a')!;
    expect([one.standing?.phonedBy, one.nextRound]).toEqual(['u-mgr', 0]);
    const back = foldPhoneTicks([tick('a', 'u-mgr', '2030-06-11T10:00:00.000Z')], [untick('a', 0, 'u-mgr2', '2030-06-11T11:00:00.000Z')]).get('a')!;
    expect([back.standing, back.nextRound]).toEqual([null, 1]);
    expect(back.history.map((h) => [h.kind, h.by])).toEqual([['ticked', 'u-mgr'], ['unticked', 'u-mgr2']]);
    const again = foldPhoneTicks([tick('a', 'u-mgr', '2030-06-11T10:00:00.000Z'), tick('a', 'u-owner', '2030-06-11T12:00:00.000Z', 1)], [untick('a', 0, 'u-mgr2', '2030-06-11T11:00:00.000Z')]).get('a')!;
    expect([again.standing?.phonedBy, again.nextRound]).toEqual(['u-owner', 1]);
    expect(again.history.map((h) => h.kind)).toEqual(['ticked', 'unticked', 'ticked']);
  });

  it('only the ticks still standing count for the withdrawal; an untick naming no tick takes nothing back', () => {
    const ticks = [tick('a', 'u-mgr', '2030-06-11T10:00:00.000Z'), tick('b', 'u-mgr', '2030-06-11T10:05:00.000Z')];
    expect(standingPhoneTicks(ticks, []).map((t) => t.customerRef)).toEqual(['a', 'b']);
    expect(standingPhoneTicks(ticks, [untick('a', 0, 'u-mgr2', '2030-06-11T11:00:00.000Z')]).map((t) => t.customerRef)).toEqual(['b']);
    expect(standingPhoneTicks(ticks, [untick('b', 5, 'u-mgr2', '2030-06-11T11:00:00.000Z')]).map((t) => t.customerRef)).toEqual(['a', 'b']);
  });

  it('the call list shows the standing tick and the whole record, and counts only the standing ones', () => {
    const buyer = (saleId: string, customerRef: string): RecallBuyer => ({ saleId, soldDate: '2030-06-10', quantityMinor: 1, source: 'captured', customerRef, via: { kind: 'this_batch' } });
    const folded = foldPhoneTicks([tick('a', 'u-mgr', '2030-06-11T10:00:00.000Z')], [untick('a', 0, 'u-mgr2', '2030-06-11T11:00:00.000Z')]);
    const list = buildRecallNoticeList({
      recall: { batchId: 'B-1', status: 'open', reason: 'r', initiatedAt: AT, closedAt: null }, buyers: [buyer('S1', 'a')],
      consentOf: new Map(), nameOf: new Map(), phoneLast4Of: new Map(), phonedOf: new Map(),
      historyOf: new Map([...folded].map(([k, v]) => [k, v.history])), now: AT,
    });
    expect(list.callList[0]).toMatchObject({ phoned: null, phoneHistory: [{ kind: 'ticked', by: 'u-mgr' }, { kind: 'unticked', by: 'u-mgr2', reason: 'ticked the wrong row' }] });
    expect(list.phonedCount).toBe(0);
  });
});

describe('the untick route (OB-397)', () => {
  function world() {
    const ticks: RecallPhonedTick[] = [];
    const unticks: RecallPhonedUntick[] = [];
    const audit: { actorId: string; action: string; reason?: string }[] = [];
    let status: 'open' | 'closed' | 'withdrawn' = 'open';
    const deps: RecallNoticeDeps = {
      now: () => '2030-06-11T12:00:00.000Z',
      recall: async () => ({ batchId: 'B-1', status, reason: 'r', initiatedAt: AT, closedAt: null }),
      buyers: async () => [{ saleId: 'S1', soldDate: '2030-06-10', quantityMinor: 1, source: 'captured', customerRef: 'a', via: { kind: 'this_batch' } }],
      consentRecords: () => [], name: async () => undefined, phoneLast4: async () => undefined,
      switchState: async () => undefined, recordSwitch: async () => {}, attempts: async () => [], recordAttempt: async () => {},
      phonedTicks: async () => ticks,
      recordPhoned: async (_t, k) => { const had = ticks.find((x) => x.customerRef === k.customerRef && (x.round ?? 0) === (k.round ?? 0)); if (had) return { tick: had, first: false }; ticks.push(k); return { tick: k, first: true }; },
      phoneUnticks: async () => unticks,
      recordUntick: async (_t, u) => { const had = unticks.find((x) => x.customerRef === u.customerRef && x.round === u.round); if (had) return { untick: had, first: false }; unticks.push(u); return { untick: u, first: true }; },
      recordAudit: (_t, e) => { audit.push({ actorId: e.actorId, action: e.action, ...(e.reason === undefined ? {} : { reason: e.reason }) }); },
    };
    const routes = recallNoticeRoutes(deps);
    const route = (path: string) => routes.find((r) => r.method === 'POST' && r.path === path)!;
    const ctx = (userId: string, params: Record<string, string>, body?: unknown): RequestContext =>
      ({ tenantId: 'T', userId, branchId: null, scope: 'all', params, query: {}, body, idempotencyKey: `k-${userId}`, traceId: 't' }) as RequestContext;
    const doTick = (userId: string, customerRef = 'a') => route('/v1/quality/recalls/:batchId/call-list/:customerRef/phoned').handler(ctx(userId, { batchId: 'B-1', customerRef }));
    const doUntick = (userId: string, body: unknown = { reason: 'ticked the wrong row' }, customerRef = 'a') => route('/v1/quality/recalls/:batchId/call-list/:customerRef/phoned/untick').handler(ctx(userId, { batchId: 'B-1', customerRef }, body));
    return { ticks, unticks, audit, doTick, doUntick, close: () => { status = 'closed'; } };
  }
  const codeOf = async (p: unknown): Promise<string> => { try { await p; return 'no refusal'; } catch (e) { return (e as { body?: { code?: string } }).body?.code ?? `other: ${String(e)}`; } };

  it('a reason is required; the ticker is refused by name; no tick, not on the list, or not open is refused by name', async () => {
    const w = world();
    expect(await codeOf(w.doUntick('u-mgr2'))).toBe('recall_customer_not_ticked_as_phoned');
    await w.doTick('u-mgr');
    expect(await codeOf(w.doUntick('u-mgr2', {}))).toBe('recall_untick_needs_a_reason');
    expect(await codeOf(w.doUntick('u-mgr2', { reason: 'no' }))).toBe('recall_untick_needs_a_reason');
    expect(await codeOf(w.doUntick('u-mgr2', null))).toBe('recall_untick_needs_a_reason');
    expect(await codeOf(w.doUntick('u-mgr'))).toBe('recall_untick_by_the_person_who_ticked');
    expect(await codeOf(w.doUntick('u-mgr2', undefined, 'z'))).toBe('customer_not_on_the_recall_call_list');
    expect(w.unticks).toEqual([]);
    w.close();
    expect(await codeOf(w.doUntick('u-mgr2'))).toBe('recall_is_not_open_for_phone_ticks');
  });

  it('someone else takes it back: compensating (the tick stays), audited with the reason; a re-tick is a new round', async () => {
    const w = world();
    await w.doTick('u-mgr');
    const r = await w.doUntick('u-mgr2');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ticksStillStanding: 0, untick: { round: 0, tickedBy: 'u-mgr', untickedBy: 'u-mgr2' } });
    expect(w.ticks.length).toBe(1); // never deleted
    expect(w.audit).toEqual([{ actorId: 'u-mgr', action: 'quality.recall.customer.phoned' }, { actorId: 'u-mgr2', action: 'quality.recall.customer.unticked', reason: 'ticked the wrong row' }]);
    const re = await w.doTick('u-owner');
    expect(re.status).toBe(201);
    expect(w.ticks.map((t) => [t.phonedBy, t.round ?? 0])).toEqual([['u-mgr', 0], ['u-owner', 1]]);
    expect(await codeOf(w.doUntick('u-owner'))).toBe('recall_untick_by_the_person_who_ticked');
  });
});
