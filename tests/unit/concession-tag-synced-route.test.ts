// M27-FR-03 · Item 3 · §31 — the SYNCED concession-tag route over stub deps: the box relays a till's docket line;
// the cloud resolves the partner's contract in force (or the one the till named), snapshots the scheme there,
// records the RELAYED cashier as the author, and refuses by name what a person must look at.
import { describe, it, expect } from 'vitest';
import { concessionTagRoutes, type ConcessionTagDeps } from '../../services/finance/src/concession-tags';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { ConcessionContract, ConcessionTag } from '../../packages/concession/src/index';

const T = 't-sre'; const NOW = '2026-09-29T11:00:00.000Z';
const contract = (over: Partial<ConcessionContract> = {}): ConcessionContract => ({
  contractId: 'ct-gold', tenantId: T, branchId: 'br-1', concessionaireId: 'jeweller-1', name: 'Gold counter', startsOn: '2026-01-01', endsOn: '2026-12-31',
  basis: 'revenue_share', revenueShareBps: 1_500, commissionOn: 'gross', depositMinor: 500_000, active: true, insuranceUntil: '2027-01-01', licenceUntil: '2027-01-01', approvedBy: 'u-owner', ...over,
});
const LINE = {
  tagId: 'till-1:S-77:line-1', saleId: 'S-77', lineId: 'line-1', productId: 'ring-22k', concessionaireId: 'jeweller-1', counterId: 'counter-gold',
  tillId: 'till-1', shiftId: 'shift-2026-09-29', qty: 1, grossMinor: 100_000, discountMinor: 0, taxMinor: 3_000,
  capturedBy: 'cashier-anita', byRole: 'cashier', source: 'docket-8842', at: '2026-09-29T10:30:00.000Z',
};

function stub(over: Partial<ConcessionTagDeps> = {}, contracts: readonly ConcessionContract[] = [contract()]) {
  const appended: ConcessionTag[] = [];
  const deps: ConcessionTagDeps = {
    now: () => NOW,
    contract: (_t, id) => contracts.find((c) => c.contractId === id),
    contractsFor: (_t, concessionaireId) => contracts.filter((c) => c.concessionaireId === concessionaireId),
    tags: () => appended,
    appendTag: (_t, tag) => { appended.push(tag); },
    rolesOf: () => ['cashier'],
    ...over,
  };
  const routes = concessionTagRoutes(deps);
  const route = routes.find((r): r is Route => r.method === 'POST' && r.path === '/v1/concession/tags/synced')!;
  return { appended, route };
}
/** `null` = the box sent NO idempotency key (an explicit `undefined` would take the default). */
const ctx = (body: unknown, key: string | null = 'edge-concession-tag-t-sre-till-1:S-77:line-1'): RequestContext =>
  ({ tenantId: T, userId: 'u-sync', branchId: null, params: {}, query: {}, body, traceId: 't', ...(key === null ? {} : { idempotencyKey: key }) });
interface Thrown { status: number; body: { code: string; whatHappened: string } }
const thrown = async (fn: () => unknown): Promise<Thrown> => { try { await fn(); } catch (e) { return e as Thrown; } throw new Error('expected a refusal'); };

describe('POST /v1/concession/tags/synced', () => {
  it('is the box\'s route: concession.tag.sync, the concession feature, idempotent', () => {
    const { route } = stub();
    expect(route.permission).toBe('concession.tag.sync');
    expect(route.entitlement).toBe('dept.concession');
    expect(route.idempotent).toBe(true);
  });

  it('resolves the partner\'s one contract in force on the day, snapshots ITS scheme, and records the relayed cashier as the author', async () => {
    const s = stub();
    const res = await s.route.handler(ctx(LINE));
    expect(res.status).toBe(201);
    const body = res.body as { captured: boolean; contractId: string; synced: boolean; tag: ConcessionTag };
    expect(body).toMatchObject({ captured: true, contractId: 'ct-gold', synced: true });
    expect(body.tag).toMatchObject({
      tagId: 'till-1:S-77:line-1', contractId: 'ct-gold', concessionaireId: 'jeweller-1', branchId: 'br-1',
      capturedBy: 'cashier-anita', source: 'docket-8842', grossMinor: 100_000, netMinor: 100_000, at: '2026-09-29T10:30:00.000Z',
      scheme: { contractId: 'ct-gold', basis: 'revenue_share', commissionOn: 'gross', revenueShareBps: 1_500 },
      idempotencyKey: 'edge-concession-tag-t-sre-till-1:S-77:line-1',
    });
    expect(body.tag.commissionMinor).toBe(15_000); // 15% of the gross — computed HERE from the contract, never at the till
    expect(body.tag.history[0]).toMatchObject({ by: 'cashier-anita', byRole: 'cashier' }); // the courier (u-sync) is not the author
    expect(s.appended).toHaveLength(1);
  });

  it('takes the contract the till named when it is the partner\'s; refuses another partner\'s contract by name', async () => {
    const s = stub({}, [contract(), contract({ contractId: 'ct-silver', concessionaireId: 'silversmith-2' })]);
    expect((await s.route.handler(ctx({ ...LINE, contractId: 'ct-gold' }))).status).toBe(201);
    const wrong = await thrown(() => s.route.handler(ctx({ ...LINE, tagId: 'till-1:S-78:line-1', contractId: 'ct-silver' }, 'k2')));
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('contract_is_not_this_partners');
    expect((await thrown(() => s.route.handler(ctx({ ...LINE, tagId: 'x', contractId: 'ct-none' }, 'k3')))).status).toBe(404);
    expect(s.appended).toHaveLength(1);
  });

  it('no contract in force, or two, is a 422 for a person — never a guess, nothing recorded', async () => {
    const none = stub({}, [contract({ active: false })]);
    const r1 = await thrown(() => none.route.handler(ctx(LINE)));
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('no_contract_in_force_for_partner');
    const expired = stub({}, [contract({ endsOn: '2026-08-31' })]);
    expect((await thrown(() => expired.route.handler(ctx(LINE)))).body.code).toBe('no_contract_in_force_for_partner');
    const two = stub({}, [contract(), contract({ contractId: 'ct-gold-2' })]);
    const r2 = await thrown(() => two.route.handler(ctx(LINE)));
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe('contract_ambiguous_for_partner');
    expect(none.appended.concat(expired.appended, two.appended)).toHaveLength(0);
  });

  it('a tag id already on the contract is 409 (the box counts it delivered); a resend under the same key is the original, not a second charge', async () => {
    const s = stub();
    await s.route.handler(ctx(LINE));
    const dup = await thrown(() => s.route.handler(ctx({ ...LINE }, 'another-key')));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('tag_already_recorded');
    const resend = await s.route.handler(ctx({ ...LINE, tagId: 'till-1:S-77:line-9' })); // same key, new id → the engine's dedupe
    expect(resend.status).toBe(200);
    expect(resend.body).toMatchObject({ captured: false, refusal: 'duplicate_idempotency_key', synced: true });
    expect(s.appended).toHaveLength(1);
  });

  it('refuses an unreadable line or a missing key with the box told to keep it, and names every required field', async () => {
    const s = stub();
    for (const bad of [{ ...LINE, byRole: 'owner' }, { ...LINE, qty: 0 }, { ...LINE, capturedBy: '' }, { ...LINE, grossMinor: 10.5 }, { ...LINE, tagId: undefined }]) {
      const r = await thrown(() => s.route.handler(ctx(bad)));
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('not_readable_as_a_synced_concession_tag');
    }
    const noKey = await thrown(() => s.route.handler(ctx(LINE, null)));
    expect(noKey.body.code).toBe('tag_needs_an_idempotency_key');
    expect(s.appended).toHaveLength(0);
  });
});
