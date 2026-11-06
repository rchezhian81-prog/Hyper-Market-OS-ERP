import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sellOnline, onlineReady } from '../support/sell-online';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';
import { PickSession, type SubstitutionAnswer, type PickLineInput } from '../../apps/picker-app/src/pick-session';

/**
 * **W6 · OB-687 (owner, 4 Nov 2026: "a substitute that needs the customer's yes is answered by the customer in the app") ·
 * FUL-14 · M19-FR-02 — propose → answer → substitute → packed, on the real API (in memory and, with DATABASE_URL, on real
 * PostgreSQL).**
 *
 *   • the owner's wait reads "not set" until he sets it (15 minutes), under its own permission — a store manager may not;
 *   • the picker phone (the real `PickSession`) proposes a swap on a line whose customer asked to be asked first; the store
 *     computer relays it (the box's own credential) and head office keeps it ONCE (a replay is the same record);
 *   • the box's assignments pull carries the line's rule, the owner's wait and head office's word ("waiting");
 *   • the CUSTOMER reads the waiting swap on their own order (the product, the price, why) and says YES — once (the same
 *     answer again is the same answer; a different one is refused by name);
 *   • the phone reads the yes back and packs the swap; head office puts it on the ORDER through the one substitution path —
 *     charged at the original price (never more for our shortfall), the order's pack carries the substitute;
 *   • a NO told to staff by phone (with how they were reached) counts the same: the line is packed short, the order's
 *     substitution DECLINED, charged nothing; a late answer is refused and the line goes short as "no answer".
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });
}

const STORE = 'L1';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('W6 · OB-687 — a swap the customer answers is what was packed — on $name', ({ harness }) => {
  async function shop() {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.enableFeature(T, 'customer_app');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-picker', 'store_manager');
    await h.provisionRole(T, 'cust-1', 'customer');
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, query?: Record<string, string>, key?: string): Promise<Res> =>
      h.request({ method, path, userId: user, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}`, body: body ?? {} }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, label: string): Promise<Res> => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const today = shopDateIn(new Date().toISOString());
    await ok(call('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', 'u-owner', { rateBps: 0 }), 'tax');
    for (const [id, name, price, brand] of [['MILK', 'Aavin Milk 1L', 60_00, 'aavin'], ['MILK-ORG', 'Organic Milk 1L', 75_00, 'arokya']] as const) {
      await ok(call('POST', `/v1/catalogue/products/${id}/publish`, 'u-owner', { product: { sku: `${id}-SKU`, name, baseUom: 'each', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active', handling: 'ambient', brand, ...onlineReady(price) }, categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }] }), `publish ${id}`);
      await ok(call('POST', `/v1/prices/list/${id}/entries/e1`, 'u-owner', { scope: 'store', scopeRef: STORE, priceMinor: price, mrpMinor: price, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), `price ${id}`);
      await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: `mv-${id}`, productId: id, locationId: STORE, kind: 'received', quantityMinor: 10, uom: 'each', occurredAt: new Date().toISOString(), enteredBy: 'u-owner', unitCostMinor: 40_00 }), `stock ${id}`);
    }
    await ok(call('POST', '/v1/catalogue/pack', 'u-owner', { storeId: STORE, asOf: today }), 'pack');
    await ok(call('POST', '/v1/serviceability/periods/2025-01-01', 'u-owner', { radiusMetres: 10_000, deliveryFeeMinor: 0 }), 'fee');
    await sellOnline((path, body) => call('POST', path, 'u-owner', body), ['MILK']);
    // The customer's standing rule: ask me first before any swap (FUL-14).
    await ok(call('PUT', '/v1/storefront/substitution-preferences', 'cust-1', { rules: { preference: 'contact_me' } }), 'rules');
    return { h, T, call, ok };
  }
  type Shop = Awaited<ReturnType<typeof shop>>;

  /** The customer orders 2 milk for collection; the wave is handed to the picker; the picker's phone holds it. */
  async function ordered(s: Shop, orderId: string, waveId: string, clock: { now: string }) {
    await s.ok(s.call('POST', `/v1/storefront/orders/${orderId}`, 'cust-1', { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: STORE, fulfilment: 'pickup' }), 'place');
    const line = { lineId: `${orderId}:MILK`, orderRef: orderId, productId: 'MILK', description: 'Aavin Milk 1L', bin: 'C-01', requiredQty: 2, uom: 'each', unitPriceMinor: 60_00 };
    await s.ok(s.call('POST', `/v1/fulfilment/waves/${waveId}/assignment`, 'u-owner', { storeId: STORE, pickerId: 'u-picker', lines: [line] }), 'assign');
    const feed = (await s.ok(s.call('GET', '/v1/fulfilment/assignments', 'u-owner', undefined, { storeId: STORE }), 'feed')).body as { waves: { waveId: string; lines: { substitution?: string }[]; substitutionWaitMinutes: number | null; substitutionAnswers: SubstitutionAnswer[] }[] };
    const wave = feed.waves.find((w) => w.waveId === waveId)!;
    const outbox = new SyncOutbox();
    // The phone holds the wave as the store computer serves it (the unit as head office spells it; the session reads it).
    const held = { ...line, unitPrice: money(60_00, 'INR'), ...(wave.lines[0]!.substitution === undefined ? {} : { substitution: wave.lines[0]!.substitution as 'ask_first' }) } as unknown as PickLineInput;
    const phone = new PickSession(waveId, [held], outbox, { now: () => clock.now, pickerId: 'u-picker' });
    /** The store computer carries the phone's queue to head office (the synced routes), each item once. */
    const relay = async () => {
      for (const item of outbox.pending()) {
        const p = item.event.payload as Record<string, unknown>;
        const path = item.event.type === 'SubstitutionProposed' ? `/v1/fulfilment/waves/${waveId}/lines/${String(p['lineId'])}/substitution-proposal/synced`
          : item.event.type === 'PickLineResolved' ? `/v1/fulfilment/waves/${waveId}/lines/${String(p['lineId'])}/synced` : `/v1/fulfilment/waves/${waveId}/packed/synced`;
        await s.ok(s.call('POST', path, 'u-owner', p, undefined, item.event.idempotencyKey), `relay ${item.event.type}`);
        outbox.acknowledge(item.key);
      }
    };
    const answers = async () => (((await s.ok(s.call('GET', '/v1/fulfilment/assignments', 'u-owner', undefined, { storeId: STORE }), 'feed')).body as { waves: { waveId: string; substitutionAnswers: SubstitutionAnswer[]; substitutionWaitMinutes: number | null }[] }).waves.find((w) => w.waveId === waveId));
    return { wave, phone, outbox, relay, answers, line };
  }

  it('the owner sets the wait; the picker proposes; the customer says YES in the app; the swap is packed and is on the order at the original price', async () => {
    const s = await shop();
    // The owner's number: "not set" until he sets it; a store manager may not set it.
    expect((await s.ok(s.call('GET', '/v1/fulfilment/substitution-wait', 'u-mgr'), 'wait')).body).toMatchObject({ minutes: null, state: 'not_set' });
    expect((await s.call('POST', '/v1/fulfilment/substitution-wait', 'u-mgr', { minutes: 15 })).status).toBe(403);
    expect(codeOf(await s.call('POST', '/v1/fulfilment/substitution-wait', 'u-owner', { minutes: 0 }))).toBe('not_readable_as_a_wait');
    expect((await s.ok(s.call('POST', '/v1/fulfilment/substitution-wait', 'u-owner', { minutes: 15, reason: 'synthetic test wait' }), 'set wait')).body).toMatchObject({ minutes: 15, state: 'set', setBy: 'u-owner' });

    const clock = { now: new Date().toISOString() };
    const o = await ordered(s, 'ORD-Y', 'W-Y', clock);
    expect(o.wave.lines[0]!.substitution).toBe('ask_first');
    expect(o.wave.substitutionWaitMinutes).toBe(15);
    expect(o.wave.substitutionAnswers).toEqual([]);

    // The picker finds no milk and puts the organic milk to the customer; the store computer relays it — once.
    const asked = o.phone.proposeSubstitute('ORD-Y:MILK', 'MILK-ORG', 'out_of_stock', o.wave.substitutionWaitMinutes);
    expect(asked.outcome).toBe('asked');
    const proposal = o.outbox.pending()[0]!;
    await o.relay();
    const replay = await s.call('POST', '/v1/fulfilment/waves/W-Y/lines/ORD-Y:MILK/substitution-proposal/synced', 'u-owner', proposal.event.payload);
    expect(replay.body).toMatchObject({ alreadyRecorded: true, eligibility: 'needs_confirmation' });

    // The box's pull carries head office's word: waiting.
    expect((await o.answers())!.substitutionAnswers).toEqual([expect.objectContaining({ lineId: 'ORD-Y:MILK', state: 'waiting', substituteProductId: 'MILK-ORG', substituteName: 'Organic Milk 1L', substituteUnitPriceMinor: 75_00 })]);
    expect(o.phone.applyAnswers((await o.answers())!.substitutionAnswers, clock.now)).toEqual([]);

    // The customer, in the app: the waiting swap on MY order — the product, the price, why.
    const mine = (await s.ok(s.call('GET', '/v1/storefront/orders/ORD-Y', 'cust-1'), 'mine')).body as { substitutions: Record<string, unknown>[] };
    expect(mine.substitutions).toEqual([expect.objectContaining({ lineId: 'ORD-Y:MILK', orderedName: 'Aavin Milk 1L', substituteName: 'Organic Milk 1L', substituteUnitPriceMinor: 75_00, state: 'waiting', why: 'out_of_stock', whySay: { en: 'We have none left on the shelf.', ta: 'அலமாரியில் இது தீர்ந்துவிட்டது.' } })]);
    // A different product than the one offered is refused; YES once; the same YES again is the same answer; a NO after is refused.
    expect(codeOf(await s.call('POST', '/v1/storefront/orders/ORD-Y/substitutions/ORD-Y:MILK', 'cust-1', { substituteProductId: 'MILK', decision: 'confirmed' }))).toBe('not_the_proposed_substitute');
    expect((await s.call('POST', '/v1/storefront/orders/ORD-Y/substitutions/ORD-Y:MILK', 'cust-1', { substituteProductId: 'MILK-ORG', decision: 'confirmed' })).status).toBe(201);
    expect((await s.call('POST', '/v1/storefront/orders/ORD-Y/substitutions/ORD-Y:MILK', 'cust-1', { substituteProductId: 'MILK-ORG', decision: 'confirmed' })).body).toMatchObject({ alreadyAnswered: true });
    expect(codeOf(await s.call('POST', '/v1/storefront/orders/ORD-Y/substitutions/ORD-Y:MILK', 'cust-1', { substituteProductId: 'MILK-ORG', decision: 'declined' }))).toBe('already_answered');

    // The phone reads the YES back through the box's pull and packs the swap at the published price.
    const back = (await o.answers())!.substitutionAnswers;
    expect(back).toEqual([expect.objectContaining({ state: 'yes', via: 'app' })]);
    const settled = o.phone.applyAnswers(back, clock.now);
    expect(settled.map((x) => x.outcome)).toEqual(['swapped']);
    await o.relay();
    o.phone.pack({ packedBy: 'u-picker', at: clock.now, temperatureC: 4, tamperSealRef: 'SEAL-Y' });
    await o.relay();

    // Head office put the swap on the ORDER through the one substitution path: charged at the original 2 × ₹60, not ₹150.
    const held = (await s.ok(s.call('GET', '/v1/orders/ORD-Y/substitution-proposals', 'u-mgr'), 'proposals')).body as { proposals: Record<string, unknown>[] };
    expect(held.proposals).toEqual([expect.objectContaining({ state: 'yes', answeredVia: 'app', settled: { packed: 'swapped', decision: 'confirmed', onOrder: true, onOrderAs: { outcome: 'substituted', pickProductId: 'MILK-ORG', pickQuantityMinor: 2, chargeMinor: 120_00, refundMinor: 0 }, refusal: null } })]);
    // The substitution path refuses a second decision on the line: the order holds this one (append-only, a line is swapped once).
    expect(codeOf(await s.call('POST', '/v1/orders/ORD-Y/substitute', 'u-owner', { offer: { lineId: 'ORD-Y:MILK', orderedProductId: 'MILK', orderedName: 'x', orderedUnitPriceMinor: 1, orderedQuantityMinor: 2, substituteProductId: 'MILK-ORG', substituteName: 'y', substituteUnitPriceMinor: 1, substituteQuantityMinor: 2, offeredAt: clock.now }, decision: 'confirmed' }))).toBe('line_already_substituted');
    // The order's pack carries what went in the crate.
    const pack = (await s.ok(s.call('GET', '/v1/fulfilment/orders/ORD-Y/pack', 'u-owner'), 'pack')).body as { lines: { productId: string; packedMinor: number }[] };
    expect(pack.lines.map((l) => [l.productId, l.packedMinor])).toEqual([['MILK-ORG', 2]]);
    // And the swap no longer waits in the app.
    expect(((await s.ok(s.call('GET', '/v1/storefront/orders/ORD-Y', 'cust-1'), 'mine')).body as { substitutions: { state: string }[] }).substitutions.map((x) => x.state)).toEqual(['yes']);
  }, 120_000);

  it('a NO told to staff by phone counts the same — packed short, declined on the order, charged nothing; a late answer is refused and the line goes short', async () => {
    const s = await shop();
    await s.ok(s.call('POST', '/v1/fulfilment/substitution-wait', 'u-owner', { minutes: 15 }), 'wait');
    const clock = { now: new Date().toISOString() };
    const o = await ordered(s, 'ORD-N', 'W-N', clock);
    o.phone.proposeSubstitute('ORD-N:MILK', 'MILK-ORG', 'not_found', 15);
    await o.relay();
    // Staff, on the Online orders desk: the customer rang back and said no.
    expect(codeOf(await s.call('POST', '/v1/orders/ORD-N/substitution-proposals/ORD-N:MILK/answer', 'u-mgr', { decision: 'declined' }))).toBe('not_readable_as_a_substitution_answer');
    expect((await s.call('POST', '/v1/orders/ORD-N/substitution-proposals/ORD-N:MILK/answer', 'u-mgr', { decision: 'declined', contact: { method: 'phone', reference: 'CALL-0042' } })).status).toBe(201);
    // The app now refuses a different answer: it was given once.
    expect(codeOf(await s.call('POST', '/v1/storefront/orders/ORD-N/substitutions/ORD-N:MILK', 'cust-1', { substituteProductId: 'MILK-ORG', decision: 'confirmed' }))).toBe('already_answered');
    const back = (await o.answers())!.substitutionAnswers;
    expect(back).toEqual([expect.objectContaining({ state: 'no', via: 'staff', reference: 'phone: CALL-0042' })]);
    expect(o.phone.applyAnswers(back, clock.now).map((x) => x.outcome)).toEqual(['customer_said_no']);
    await o.relay();
    const held = (await s.ok(s.call('GET', '/v1/orders/ORD-N/substitution-proposals', 'u-mgr'), 'proposals')).body as { proposals: Record<string, unknown>[] };
    expect(held.proposals).toEqual([expect.objectContaining({ state: 'no', answeredVia: 'staff', contact: { method: 'phone', reference: 'CALL-0042' }, settled: expect.objectContaining({ packed: 'short', decision: 'declined', onOrder: true, onOrderAs: expect.objectContaining({ outcome: 'short_picked', chargeMinor: 0, pickProductId: null }), refusal: null }) })]);

    // A third order: the picker asked 20 minutes ago with a 15-minute wait — too late. The app refuses the answer; the phone
    // packs short on its own clock, and head office records "no answer" on the order (silence is never a yes).
    const late = { now: new Date(Date.now() - 20 * 60_000).toISOString() };
    const l = await ordered(s, 'ORD-L', 'W-L', late);
    l.phone.proposeSubstitute('ORD-L:MILK', 'MILK-ORG', 'out_of_stock', 15);
    await l.relay();
    expect(codeOf(await s.call('POST', '/v1/storefront/orders/ORD-L/substitutions/ORD-L:MILK', 'cust-1', { substituteProductId: 'MILK-ORG', decision: 'confirmed' }))).toBe('answer_too_late');
    expect((await l.answers())!.substitutionAnswers).toEqual([expect.objectContaining({ state: 'too_late' })]);
    expect(l.phone.applyAnswers([], new Date().toISOString()).map((x) => x.outcome)).toEqual(['no_answer_in_time']);
    await l.relay();
    const lateHeld = (await s.ok(s.call('GET', '/v1/orders/ORD-L/substitution-proposals', 'u-mgr'), 'proposals')).body as { proposals: Record<string, unknown>[] };
    expect(lateHeld.proposals).toEqual([expect.objectContaining({ state: 'too_late', settled: expect.objectContaining({ packed: 'short', decision: 'no_answer', onOrder: true, onOrderAs: expect.objectContaining({ outcome: 'not_confirmed', chargeMinor: 0 }) }) })]);
  }, 120_000);

  it('with no wait set the proposal is kept closed: nothing waits for the customer, and the app refuses an answer', async () => {
    const s = await shop();
    const clock = { now: new Date().toISOString() };
    const o = await ordered(s, 'ORD-0', 'W-0', clock);
    expect(o.wave.substitutionWaitMinutes).toBeNull();
    // The phone does not wait — it sends nothing and the line is short at once.
    expect(o.phone.proposeSubstitute('ORD-0:MILK', 'MILK-ORG', 'out_of_stock', o.wave.substitutionWaitMinutes).outcome).toBe('short_no_wait');
    expect(o.outbox.pending().map((i) => i.event.type)).toEqual(['PickLineResolved']);
  }, 120_000);
});
