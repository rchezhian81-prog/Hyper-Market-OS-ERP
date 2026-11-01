import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller } from '../support/p3-purchase';

// M09-FR-02 (Round 4b) "parameters per product/store … parameter changes logged … parameters drive the numbers": the planning
// parameters are STORED per product and store by the buyer, each change a new version beside the old (append-only) with an
// audit line, and head office's proposal is worked out on the stored parameters — never typed ones; a requisition raised
// from it (WF-03) is worked out again on exactly them. In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Stored { products: { current: { productId: string; version: number; maxLevel: number; reorderPoint?: number; setBy: string; reason: string }; history: { version: number }[] }[] }

describe.each(backings)('stored replenishment parameters drive the proposal (M09-FR-02) — on $name', ({ harness }) => {
  it('set, versioned and audited; refused when malformed or for a cashier; the proposal and the requisition run on them; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    for (const [id, p, q] of [['mv-r', 'rice', 2], ['mv-d', 'dal', 18]] as const) {
      expect((await call('POST', '/v1/inventory/movements', P3.OWNER, { movementId: id, productId: p, locationId: P3.BACK, kind: 'received', quantityMinor: q, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: P3.OWNER, unitCostMinor: 4_000 })).status).toBeLessThan(300);
    }
    const set = (product: string, body: Record<string, unknown>, who: string = P3.BUYER) => call('POST', `/v1/replenishment/parameters/${P3.STORE}/${product}`, who, body, `set-${randomUUID()}`);
    const read = async (hh = h) => (await hh.request({ method: 'GET', path: '/v1/replenishment/parameters', userId: P3.BUYER, tenantId: T, query: { storeId: P3.STORE } })).body as Stored;

    // Nothing stored yet: the proposal says so, never a guess.
    const none = await h.request({ method: 'POST', path: '/v1/replenishment/stored-proposal', userId: P3.BUYER, tenantId: T, idempotencyKey: 'p0', query: { storeId: P3.STORE }, body: {} });
    expect(none.body).toMatchObject({ proposals: [], parametersNotSet: true });

    expect(codeOf(await set('rice', { maxLevel: 40, reorderPoint: 10 }))).toBe('not_readable_as_replenishment_parameters'); // no reason
    expect(codeOf(await set('rice', { maxLevel: 40, reorderPoint: 10.5, reason: 'x' }))).toBe('not_readable_as_replenishment_parameters');
    expect(codeOf(await set('rice', { maxLevel: 40, reorderPoint: 50, reason: 'x' }))).toBe('reorder_point_above_max');
    expect(codeOf(await set('rice', { maxLevel: 40, onHand: 3, reason: 'x' }))).toBe('parameters_carry_stock');
    expect((await set('rice', { maxLevel: 40, reorderPoint: 10, reason: 'x' }, P3.CASHIER)).status).toBe(403);

    expect((await set('rice', { maxLevel: 40, reorderPoint: 10, reason: 'weekly sales ~30' })).status).toBe(201);
    expect((await set('dal', { maxLevel: 20, reorderPoint: 5, reason: 'slow mover' })).status).toBe(201);
    // A change is a new version; the same figures again change nothing.
    const changed = await set('rice', { maxLevel: 50, reorderPoint: 10, reason: 'festival' });
    expect(changed.body).toMatchObject({ parameters: { version: 2, maxLevel: 50 }, supersedes: { version: 1, maxLevel: 40 } });
    expect((await set('rice', { maxLevel: 50, reorderPoint: 10, reason: 'again' })).body).toMatchObject({ unchanged: true });
    const stored = await read();
    expect(stored.products.map((p) => [p.current.productId, p.current.version, p.current.maxLevel, p.history.length])).toEqual([['dal', 1, 20, 1], ['rice', 2, 50, 2]]);
    expect(stored.products[1]!.current).toMatchObject({ setBy: P3.BUYER, reason: 'festival' });

    // The parameter change is on the audit trail with before and after.
    const trail = (await h.request({ method: 'GET', path: '/v1/audit/trail', userId: P3.OWNER, tenantId: T, query: { action: 'replenishment.parameters.set' } })).body as { matches: { actorId: string; objectId: string; before: Record<string, string> | null; after: Record<string, string> }[] };
    expect(trail.matches.map((m) => [m.objectId, m.before?.['maxLevel'] ?? null, m.after['maxLevel']])).toEqual(expect.arrayContaining([[`${P3.STORE}|rice`, null, '40'], [`${P3.STORE}|rice`, '40', '50']]));
    expect(trail.matches).toHaveLength(3);
    expect(trail.matches.every((m) => m.actorId === P3.BUYER)).toBe(true);

    // The proposal on the STORED parameters: rice 2 on hand → up to 50 = 48; dal above its reorder point.
    const proposal = (await h.request({ method: 'POST', path: '/v1/replenishment/stored-proposal', userId: P3.BUYER, tenantId: T, idempotencyKey: 'p1', query: { storeId: P3.STORE }, body: {} })).body as { proposals: { productId: string; suggestedQty: number }[]; items: Record<string, unknown>[]; parametersNotSet: boolean };
    expect(proposal.parametersNotSet).toBe(false);
    expect(proposal.proposals.find((p) => p.productId === 'rice')).toMatchObject({ suggestedQty: 48 });
    expect(proposal.items).toEqual([{ productId: 'dal', maxLevel: 20, reorderPoint: 5 }, { productId: 'rice', maxLevel: 50, reorderPoint: 10 }]);
    // WF-03: the requisition raised from it is worked out again on exactly those parameters.
    const rq = await call('POST', '/v1/purchase/requisitions/rq-p/from-replenishment', P3.BUYER, { storeId: P3.STORE, currency: 'INR', items: proposal.items, accept: [{ productId: 'rice' }] });
    expect(rq.status, JSON.stringify(rq.body)).toBe(201);
    expect(rq.body).toMatchObject({ requisition: { lines: [{ productId: 'rice', quantity: 48 }], source: { kind: 'replenishment', proposed: { rice: 48 } } } });

    const again = harness(h);
    expect((await read(again)).products.map((p) => [p.current.productId, p.current.version])).toEqual([['dal', 1], ['rice', 2]]);
  });
});
