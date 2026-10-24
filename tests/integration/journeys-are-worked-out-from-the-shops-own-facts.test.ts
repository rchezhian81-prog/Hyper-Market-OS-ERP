import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { seedOnlineShop, listShopOnline, callsFor, codeOf, OWNER, MANAGER, CHECKER, CASHIER, CUSTOMER, OTHER_CUSTOMER } from '../support/online-shop';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { dayIn, customerCommerceSweep } from '../../services/api/src/customer-commerce-adapters';
import { addDays } from '../../packages/storefront/src/subscriptions';

// M21-FR-02 — abandoned-cart, occasion and win-back journeys, worked out from the shop's OWN facts (a basket kept on the
// shop while the customer is signed in, an occasion the customer gave with their yes, the last purchase on the till's banked
// bills), judged by the journey engine (too soon / too late / already done), and SENT only when a person switches the
// journey on with an approved template — each through the campaign send (consent, frequency cap, do-not-contact, budget),
// once per trigger; what was held back is kept with the reason. In memory and on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const hoursAgo = (n: number): string => new Date(Date.now() - n * 3_600_000).toISOString();
interface Journey { kind: string; on: boolean; say: string; candidates: { customerRef: string; eligible: boolean; ref: string; detail: string }[]; eligibleCount: number; outcomes: { customerRef: string; outcome: string; code?: string }[] }

describe.each(backings)('journeys are worked out from the shop\'s own facts (M21-FR-02) — on $name', ({ harness }) => {
  it('held basket, occasion with consent and last purchase become triggers; off until switched on; sent through the campaign send once; held back with the reason; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await listShopOnline(c);
    const today = dayIn(new Date().toISOString(), 'Asia/Kolkata');

    // The customer's basket is kept on the shop as they fill it (valued at the shop's prices).
    const held = await ok(req('PUT', '/v1/me/cart', { lines: [{ productId: 'MILK', quantityMinor: 2 }] }, CUSTOMER), 'hold cart');
    expect((held.body as { cart: { valueMinor: number } }).cart.valueMinor).toBe(120_00);
    expect(((await req('GET', '/v1/me/cart', undefined, CUSTOMER)).body as { cart: { lines: unknown[] } }).cart.lines).toHaveLength(1);
    // Another customer left a basket three hours ago (an older fact of the same register).
    await h.store.append(T, streamName(STREAM.customer, 'journeys'), makeEvent({ id: `cart-old-${T}`, type: 'CartHeld', occurredAt: hoursAgo(3), idempotencyKey: `cart-old-${T}`, source: 'test/seed', payload: { customerRef: OTHER_CUSTOMER, lines: [{ productId: 'BROOM', quantityMinor: 1 }], valueMinor: 150_00, updatedAt: hoursAgo(3) } }));
    // An occasion only with the customer's yes; three days away.
    const in3 = addDays(today, 3).slice(5);
    expect(codeOf(await req('POST', '/v1/me/occasions/bday', { kind: 'birthday', monthDay: in3 }, CUSTOMER))).toBe('consent_required');
    expect(codeOf(await req('POST', '/v1/me/occasions/bday', { kind: 'birthday', monthDay: '13-01', consent: true }, CUSTOMER))).toBe('not_readable_as_an_occasion');
    await ok(req('POST', '/v1/me/occasions/bday', { kind: 'birthday', monthDay: in3, consent: true }, CUSTOMER), 'occasion');
    // A loyalty member whose last bill was 70 days ago (the segment policy's lapsing line is 60 days).
    const old = hoursAgo(70 * 24);
    expect((await h.request({ method: 'POST', path: '/v1/sales', userId: CASHIER, tenantId: T, idempotencyKey: 'bank-old', body: {
      saleId: 'S-OLD', receiptNumber: 'R-OLD', laneId: 'lane-1', cashierId: CASHIER, tradingDay: old.slice(0, 10), committedAt: old, totalMinor: 500_00, currency: 'INR', packVersion: 1, customerRef: 'M-lapsed',
      lines: [{ productId: 'MILK', quantityMinor: 1, uom: 'ea', unitPriceMinor: 500_00, lineTotalMinor: 500_00 }], tenders: [{ kind: 'cash', amountMinor: 500_00 }],
    } })).status).toBe(202);

    const journeys = async (hh = h) => { const r = await hh.request({ method: 'GET', path: '/v1/service/journeys', userId: MANAGER, tenantId: T }); expect(r.status, JSON.stringify(r.body)).toBe(200); return (r.body as { journeys: Journey[] }).journeys; };
    const byKind = async (kind: string, hh = h) => (await journeys(hh)).find((j) => j.kind === kind)!;
    const cart = await byKind('abandoned_cart');
    expect(cart.on).toBe(false);
    expect(cart.say).toMatch(/^Off — nothing is sent/);
    // The basket just held is too soon; the one from three hours ago is eligible.
    expect(cart.candidates.find((x) => x.customerRef === CUSTOMER)).toMatchObject({ eligible: false });
    expect(cart.candidates.find((x) => x.customerRef === OTHER_CUSTOMER)).toMatchObject({ eligible: true });
    expect((await byKind('occasion')).candidates).toEqual([expect.objectContaining({ customerRef: CUSTOMER, eligible: true, ref: `occasion:bday:${addDays(today, 3)}` })]);
    expect((await byKind('win_back')).candidates).toEqual([expect.objectContaining({ customerRef: 'M-lapsed', eligible: true })]);

    // Off: a run sends nothing.
    expect((await ok(req('POST', '/v1/service/journeys/run', {}, MANAGER), 'run off')).body).toEqual({ queued: 0, notQueued: 0 });
    // A cashier reads no journeys; a customer cannot switch one on.
    expect((await req('GET', '/v1/service/journeys', undefined, CASHIER)).status).toBe(403);
    expect((await req('PUT', '/v1/service/journeys/abandoned_cart', { on: true, templateId: 'cart-reminder', channel: 'sms', reason: 'x' }, CUSTOMER)).status).toBe(403);

    // The owner's words (approved by a second person), the cap, the budget, and one customer's yes to offers.
    await ok(req('POST', '/v1/notifications/templates/cart-reminder', { purpose: 'marketing', channel: 'sms', body: 'SRE: your basket ({value}) is waiting. (synthetic)' }, MANAGER), 'draft');
    await ok(req('POST', '/v1/notifications/templates/cart-reminder/approval', { version: 1 }, CHECKER), 'approve');
    await ok(req('PUT', '/v1/service/campaigns/frequency-policy', { capPerWindow: 2, windowDays: 7 }, OWNER), 'cap');
    await ok(req('POST', '/v1/notifications/budget', { capMinor: 100_000, costMinorByChannel: { sms: 25 } }, OWNER), 'budget');
    await ok(req('POST', '/v1/me/privacy/consent', { purpose: 'marketing', channel: 'sms', given: true }, OTHER_CUSTOMER), 'marketing yes');
    for (const kind of ['abandoned_cart', 'win_back']) {
      await ok(req('PUT', `/v1/service/journeys/${kind}`, { on: true, templateId: 'cart-reminder', channel: 'sms', reason: 'owner said (synthetic)' }, MANAGER), `switch ${kind}`);
    }
    // The timed pass sends it: the old basket's customer (consented) is queued; the lapsed member (no consent) is held back.
    expect(await customerCommerceSweep({ store: h.store, now: () => new Date().toISOString() })(T, new Date().toISOString())).toBeGreaterThanOrEqual(2);
    const afterCart = await byKind('abandoned_cart');
    expect(afterCart.on).toBe(true);
    expect(afterCart.outcomes).toEqual([expect.objectContaining({ customerRef: OTHER_CUSTOMER, outcome: 'queued' })]);
    expect((await byKind('win_back')).outcomes).toEqual([expect.objectContaining({ customerRef: 'M-lapsed', outcome: 'not_queued', code: 'no_consent' })]);
    // Once per trigger: a second run sends nothing more and records nothing new.
    expect((await ok(req('POST', '/v1/service/journeys/run', {}, MANAGER), 'run again')).body).toEqual({ queued: 0, notQueued: 0 });
    const pending = JSON.stringify((await req('GET', '/v1/notifications/queue/pending', undefined, OWNER)).body);
    expect(pending).toContain('jr-abandoned-cart-');
    // The occasion stays unsent (that journey is off); the customer removes it in one tap.
    await ok(req('POST', '/v1/me/occasions/bday/remove', {}, CUSTOMER), 'remove occasion');
    expect(((await req('GET', '/v1/me/occasions', undefined, CUSTOMER)).body as { occasions: unknown[] }).occasions).toEqual([]);
    expect((await byKind('occasion')).candidates).toEqual([]);

    // A cold restart reads the same switches and outcomes.
    expect((await byKind('abandoned_cart', harness(h))).outcomes).toHaveLength(1);
  });
});
