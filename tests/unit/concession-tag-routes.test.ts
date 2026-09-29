// M27-FR-03 — the concession docket tags on the cloud, over stub deps: captured once, corrected only by a
// supervisor (the cashier's refusal recorded), nothing rewritten, and read by settlement as concession sales.
import { describe, it, expect } from 'vitest';
import { concessionTagRoutes, actorRoleOf, type ConcessionTagDeps } from '../../services/finance/src/concession-tags';
import {
  tagsAsConcessionSales, latestTagVersions, type ConcessionTag, type ConcessionContract,
} from '../../packages/concession/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';

const T = 't-sre';
let NOW = '2026-08-07T10:00:00.000Z';
const CONTRACT: ConcessionContract = {
  contractId: 'ct-1', tenantId: T, branchId: 'br-1', concessionaireId: 'cx-gold', name: 'Gold counter',
  startsOn: '2026-01-01', endsOn: '2026-12-31', basis: 'revenue_share', revenueShareBps: 1_500, depositMinor: 0, active: true,
  insuranceUntil: '2027-12-31', licenceUntil: '2027-12-31', approvedBy: 'u-owner',
};
const ROLES: Record<string, string[]> = { 'u-cash': ['cashier'], 'u-mgr': ['store_manager'], 'u-acct': ['accountant'], 'u-owner': ['owner'] };

function stub(contract: ConcessionContract | undefined = CONTRACT) {
  const versions: ConcessionTag[] = [];
  const deps: ConcessionTagDeps = {
    now: () => NOW,
    contract: (_t, id) => (contract !== undefined && contract.contractId === id ? contract : undefined),
    tags: () => latestTagVersions(versions),
    appendTag: (_t, tag) => { versions.push(tag); },
    rolesOf: (_t, u) => ROLES[u] ?? [],
  };
  return { deps, versions, routes: concessionTagRoutes(deps) };
}
const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
  ({ tenantId: T, userId: 'u-cash', branchId: null, params: { contractId: 'ct-1' }, query: {}, body: undefined, traceId: 't', ...over });
const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};
const TAGS = '/v1/concession/contracts/:contractId/tags';
const TAG = '/v1/concession/contracts/:contractId/tags/:tagId';
const line = (over: Record<string, unknown> = {}) => ({
  saleId: 'sale-1', lineId: 'l1', productId: 'RING-22K', counterId: 'gold-1', tillId: 'till-3', shiftId: 'shift-a',
  qty: 1, grossMinor: 100_000, discountMinor: 20_000, taxMinor: 2_400, source: 'docket-7781', ...over,
});
const capture = (routes: readonly Route[], tagId: string, body: Record<string, unknown>, key: string, userId = 'u-cash') =>
  routeFor(routes, 'POST', TAG).handler(ctx({ userId, params: { contractId: 'ct-1', tagId }, body, idempotencyKey: key }));
const correct = (routes: readonly Route[], op: 'reverse' | 'adjust', tagId: string, body: Record<string, unknown>, userId: string) =>
  routeFor(routes, 'POST', `${TAG}/${op}`).handler(ctx({ userId, params: { contractId: 'ct-1', tagId }, body }));
const read = (routes: readonly Route[], query: Record<string, string> = {}) => routeFor(routes, 'GET', TAGS).handler(ctx({ query }));

interface Thrown { status: number; body: { code: string; whatHappened: string; wasItSaved: string } }
const thrown = async (fn: () => unknown): Promise<Thrown> => {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected a refusal');
};
interface CaptureBody { captured: boolean; tag?: ConcessionTag; existing?: ConcessionTag; refusal?: string; trading?: { mayTrade: boolean } }
interface CorrectBody { corrected: boolean; correction: ConcessionTag; original: ConcessionTag }
interface ReadBody { tags: ConcessionTag[]; totals: { tags: number; netMinor: number; commissionMinor: number } }

describe('shape and permissions (API-09, behind dept.concession)', () => {
  it('five routes: read the stream, mark settlement, capture, reverse, adjust', () => {
    const { routes } = stub();
    expect(routes.map((r) => [r.method, r.path, r.permission, r.entitlement])).toEqual([
      ['GET', TAGS, 'concession.tag.record', 'dept.concession'],
      ['POST', '/v1/concession/contracts/:contractId/tag-settlement', 'concession.contract.manage', 'dept.concession'],
      ['POST', TAG, 'concession.tag.record', 'dept.concession'],
      ['POST', `${TAG}/reverse`, 'concession.tag.record', 'dept.concession'],
      ['POST', `${TAG}/adjust`, 'concession.tag.record', 'dept.concession'],
    ]);
    expect(routes.filter((r) => r.method === 'POST').every((r) => r.idempotent === true)).toBe(true);
  });
  it('the engine role from the grants: managers and the owner may correct, anyone else above a cashier is a supervisor, a cashier is a cashier', () => {
    expect(actorRoleOf(['owner'])).toBe('store_manager');
    expect(actorRoleOf(['cashier', 'store_manager'])).toBe('store_manager');
    expect(actorRoleOf(['accountant'])).toBe('supervisor');
    expect(actorRoleOf(['cashier'])).toBe('cashier');
    expect(actorRoleOf([])).toBe('cashier');
  });
});

describe('capture — a docket line is recorded once, under the scheme as it stood', () => {
  it('a cashier records a line: commission on NET by default (what the customer paid), by whom, from which docket, with the trading gate shown', async () => {
    const s = stub();
    const res = await capture(s.routes, 'tag-1', line(), 'till-3:sale-1:l1');
    expect(res.status).toBe(201);
    const body = res.body as CaptureBody;
    expect(body.captured).toBe(true);
    expect(body.tag).toMatchObject({
      tagId: 'tag-1', kind: 'sale', contractId: 'ct-1', concessionaireId: 'cx-gold', branchId: 'br-1',
      netMinor: 80_000, commissionBaseMinor: 80_000, commissionMinor: 12_000, settlementStatus: 'pending',
      capturedBy: 'u-cash', source: 'docket-7781', idempotencyKey: 'till-3:sale-1:l1', at: NOW,
      scheme: { contractId: 'ct-1', basis: 'revenue_share', commissionOn: 'net', revenueShareBps: 1_500 },
    });
    expect(body.tag!.history).toEqual([expect.objectContaining({ op: 'captured', by: 'u-cash', byRole: 'cashier' })]);
    expect(body.trading).toMatchObject({ mayTrade: true });
    expect(s.versions).toHaveLength(1);
  });

  it('a contract that takes its share on GROSS says so and the snapshot follows it', async () => {
    const s = stub({ ...CONTRACT, commissionOn: 'gross' });
    const body = (await capture(s.routes, 'tag-1', line(), 'k1')).body as CaptureBody;
    expect(body.tag).toMatchObject({ commissionBaseMinor: 100_000, commissionMinor: 15_000, scheme: expect.objectContaining({ commissionOn: 'gross' }) });
  });

  it('a resend with the same idempotency key returns the original and records nothing; a reused tag id is refused', async () => {
    const s = stub();
    await capture(s.routes, 'tag-1', line(), 'k1');
    const again = await capture(s.routes, 'tag-2', line({ grossMinor: 999_999 }), 'k1');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ captured: false, refusal: 'duplicate_idempotency_key', existing: expect.objectContaining({ tagId: 'tag-1', grossMinor: 100_000 }) });
    expect(s.versions).toHaveLength(1);
    const reused = await thrown(() => capture(s.routes, 'tag-1', line(), 'k2'));
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('tag_already_recorded');
    expect(s.versions).toHaveLength(1);
  });

  it('refuses an unreadable docket, a missing key, and an unknown contract — recording nothing', async () => {
    const s = stub();
    expect((await thrown(() => capture(s.routes, 'tag-1', line({ qty: 0 }), 'k1'))).body.code).toBe('not_readable_as_a_concession_tag');
    expect((await thrown(() => capture(s.routes, 'tag-1', line({ source: '' }), 'k1'))).body.code).toBe('not_readable_as_a_concession_tag');
    expect((await thrown(() => capture(s.routes, 'tag-1', line({ kind: 'gift' }), 'k1'))).body.code).toBe('not_readable_as_a_concession_tag');
    const noKey = await thrown(() => routeFor(s.routes, 'POST', TAG).handler(ctx({ params: { contractId: 'ct-1', tagId: 'tag-1' }, body: line() })));
    expect(noKey.body.code).toBe('tag_needs_an_idempotency_key');
    const unknown = await thrown(() => routeFor(s.routes, 'POST', TAG).handler(ctx({ params: { contractId: 'ct-9', tagId: 'tag-1' }, body: line(), idempotencyKey: 'k1' })));
    expect(unknown.status).toBe(404);
    expect(s.versions).toEqual([]);
  });

  it('the body may carry its own key and time (a till replaying its queue); a return carries negative money and names what it returns', async () => {
    const s = stub();
    const res = await routeFor(s.routes, 'POST', TAG).handler(ctx({
      params: { contractId: 'ct-1', tagId: 'tag-r' },
      body: line({ kind: 'return', grossMinor: -100_000, discountMinor: -20_000, taxMinor: -2_400, correctsTagId: 'tag-1', at: '2026-08-06T09:00:00.000Z', idempotencyKey: 'till-3:ret-1' }),
    }));
    expect(res.status).toBe(201);
    expect((res.body as CaptureBody).tag).toMatchObject({ kind: 'return', netMinor: -80_000, commissionMinor: -12_000, correctsTagId: 'tag-1', at: '2026-08-06T09:00:00.000Z', idempotencyKey: 'till-3:ret-1' });
  });
});

describe('corrections — a supervisor\'s act, appended never rewritten (§28, hard rule #2)', () => {
  it('a cashier\'s reversal is refused AND written onto the line\'s history; nothing else changes', async () => {
    const s = stub();
    await capture(s.routes, 'tag-1', line(), 'k1');
    const refused = await thrown(() => correct(s.routes, 'reverse', 'tag-1', { reasonCode: 'WRONG-COUNTER' }, 'u-cash'));
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('correction_not_permitted_for_role');
    expect(refused.body.wasItSaved).toBe('saved');
    expect(s.versions).toHaveLength(2); // the original, now carrying the refusal
    const standing = ((await read(s.routes)).body as ReadBody).tags;
    expect(standing).toHaveLength(1);
    expect(standing[0]!.history.map((h) => h.op)).toEqual(['captured', 'correct_refused']);
    expect(standing[0]!.netMinor).toBe(80_000);
  });

  it('a store manager reverses: a negated tag naming the original, the original marked reversed, totals net to zero; a second reversal is refused', async () => {
    const s = stub();
    await capture(s.routes, 'tag-1', line(), 'k1');
    NOW = '2026-08-07T11:00:00.000Z';
    const res = await correct(s.routes, 'reverse', 'tag-1', { reasonCode: 'WRONG-COUNTER' }, 'u-mgr');
    expect(res.status).toBe(201);
    const body = res.body as CorrectBody;
    expect(body.correction).toMatchObject({ tagId: 'tag-1~rev', kind: 'reversal', correctsTagId: 'tag-1', netMinor: -80_000, commissionMinor: -12_000, capturedBy: 'u-mgr' });
    expect(body.original.history.map((h) => [h.op, h.byRole])).toEqual([['captured', 'cashier'], ['reversed', 'store_manager']]);
    const day = (await read(s.routes)).body as ReadBody;
    expect(day.tags.map((t) => t.tagId)).toEqual(['tag-1', 'tag-1~rev']);
    expect(day.totals).toMatchObject({ tags: 2, netMinor: 0, commissionMinor: 0 });
    const again = await thrown(() => correct(s.routes, 'reverse', 'tag-1', { reasonCode: 'AGAIN', newTagId: 'tag-1~rev2' }, 'u-mgr'));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_reversed');
  });

  it('an accountant (a supervisor to the engine) adjusts by a delta; the deltas must not all be zero; a reason is required', async () => {
    const s = stub();
    await capture(s.routes, 'tag-1', line(), 'k1');
    const res = await correct(s.routes, 'adjust', 'tag-1', { grossDeltaMinor: -10_000, discountDeltaMinor: 0, taxDeltaMinor: -240, reasonCode: 'PRICE-CORRECTION' }, 'u-acct');
    expect(res.status).toBe(201);
    expect((res.body as CorrectBody).correction).toMatchObject({ tagId: 'tag-1~adj1', kind: 'adjustment', correctsTagId: 'tag-1', grossMinor: -10_000, netMinor: -10_000 });
    expect(((await read(s.routes)).body as ReadBody).totals.netMinor).toBe(70_000);
    expect((await thrown(() => correct(s.routes, 'adjust', 'tag-1', { grossDeltaMinor: 0, discountDeltaMinor: 0, taxDeltaMinor: 0, reasonCode: 'X' }, 'u-acct'))).body.code).toBe('adjustment_not_readable');
    expect((await thrown(() => correct(s.routes, 'reverse', 'tag-1', {}, 'u-mgr'))).body.code).toBe('reversal_needs_a_reason');
    expect((await thrown(() => correct(s.routes, 'reverse', 'tag-9', { reasonCode: 'X' }, 'u-mgr'))).status).toBe(404);
  });
});

describe('the stream, settlement marking and what settlement reads', () => {
  it('reads a window of the stream with totals; refuses an unreadable window', async () => {
    const s = stub();
    await capture(s.routes, 'tag-1', line({ at: '2026-08-05T09:00:00.000Z' }), 'k1');
    await capture(s.routes, 'tag-2', line({ lineId: 'l2', at: '2026-08-20T09:00:00.000Z' }), 'k2');
    const aug1 = (await read(s.routes, { from: '2026-08-01', to: '2026-08-10' })).body as ReadBody;
    expect(aug1.tags.map((t) => t.tagId)).toEqual(['tag-1']);
    expect(aug1.totals).toMatchObject({ tags: 1, netMinor: 80_000 });
    expect(((await read(s.routes)).body as ReadBody).totals.tags).toBe(2);
    expect((await thrown(() => read(s.routes, { from: 'august' }))).body.code).toBe('tags_window_not_readable');
  });

  it('the settlement run marks the window forward only — pending → included_in_charge → settled — never back', async () => {
    const s = stub();
    await capture(s.routes, 'tag-1', line({ at: '2026-08-05T09:00:00.000Z' }), 'k1');
    await capture(s.routes, 'tag-2', line({ lineId: 'l2', at: '2026-09-02T09:00:00.000Z' }), 'k2');
    const mark = (status: string, userId = 'u-acct') => routeFor(s.routes, 'POST', '/v1/concession/contracts/:contractId/tag-settlement')
      .handler(ctx({ userId, body: { status, from: '2026-08-01', to: '2026-08-31' } }));
    expect((await mark('included_in_charge')).body).toMatchObject({ marked: 1, tagIds: ['tag-1'] });
    expect((await mark('included_in_charge')).body).toMatchObject({ marked: 0 });
    expect((await mark('settled')).body).toMatchObject({ marked: 1 });
    const tags = ((await read(s.routes)).body as ReadBody).tags;
    expect(tags.map((t) => [t.tagId, t.settlementStatus])).toEqual([['tag-1', 'settled'], ['tag-2', 'pending']]);
    expect(tags[0]!.history.map((h) => h.op)).toEqual(['captured', 'settlement_marked', 'settlement_marked']);
    expect((await thrown(() => mark('pending'))).body.code).toBe('not_readable_as_a_settlement_mark');
  });

  it('tags read as concession sales tendered at the store till: net money, reversals negative naming the original, a hand-recorded sale left alone', async () => {
    const s = stub();
    await capture(s.routes, 'tag-1', line(), 'k1');
    await capture(s.routes, 'tag-2', line({ saleId: 'sale-2', lineId: 'l1' }), 'k2');
    await correct(s.routes, 'reverse', 'tag-2', { reasonCode: 'X' }, 'u-mgr');
    const tags = latestTagVersions(s.versions);
    const rows = tagsAsConcessionSales(tags, { excludeSaleIds: new Set(['sale-1']) });
    expect(rows).toEqual([
      expect.objectContaining({ saleId: 'sale-2#l1#tag-2', contractId: 'ct-1', concessionaireId: 'cx-gold', branchId: 'br-1', grossMinor: 80_000, taxMinor: 2_400, tenderedTo: 'store_till' }),
      expect.objectContaining({ saleId: 'sale-2#l1#tag-2~rev', grossMinor: -80_000, taxMinor: -2_400, refundOf: 'tag-2' }),
    ]);
    expect(tagsAsConcessionSales(tags)).toHaveLength(3);
    expect(latestTagVersions([...s.versions, ...s.versions])).toHaveLength(3); // versions fold, never double
  });
});
