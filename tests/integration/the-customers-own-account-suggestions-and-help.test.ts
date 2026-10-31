import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { seedOnlineShop, listShopOnline, callsFor, codeOf, OWNER, CASHIER, CUSTOMER, OTHER_CUSTOMER, STORE } from '../support/online-shop';

// M20-FR-04 (account controls: addresses, payment tokens) · M20-FR-02 (consent-safe recommendations) · A05 customer help
// (AI-NFR-11 notice · OB-296 no free text · OB-314). In memory and on real PostgreSQL, with a cold restart:
//   • saved addresses are the customer's own, kept minimised (a label, the location to ~100 m, a landmark); removing one is
//     one tap and it is never offered again; the shop keeps no card, so "saved payments" is empty and says why;
//   • suggestions: "bought together" from the shop's own banked bills for everyone; "you bought before" only after the
//     customer's own yes to profiling — before it, nothing of their history is read;
//   • help: where is MY order (only mine — another's is not found) through the A05 assistant, which says it cannot answer
//     while the AI is switched off; the return windows ("not set" until the owner sets them) and the delivery charges from
//     store setup; each marked as an automatic answer; a typed question is refused (it goes to a person).

const backings = useRestartableBackings();
const DAY = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
const bill = (saleId: string, productIds: readonly string[]) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: CASHIER, tradingDay: DAY, committedAt: `${DAY}T06:30:00.000Z`, totalMinor: productIds.length * 10_00, currency: 'INR', packVersion: 1,
  lines: productIds.map((productId) => ({ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_00, lineTotalMinor: 10_00 })), tenders: [{ kind: 'cash', amountMinor: productIds.length * 10_00 }],
});

describe.each(backings)('the customer\'s own account, suggestions and help (M20-FR-02/04 · A05) — on $name', ({ harness }) => {
  it('addresses kept minimised and removed in a tap; no saved card; suggestions consent-safe; help from the shop\'s own records, own order only; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await listShopOnline(c);

    // ── Addresses ──
    expect(codeOf(await req('POST', '/v1/me/addresses/home', { label: 'Home' }, CUSTOMER))).toBe('not_readable_as_an_address');
    await ok(req('POST', '/v1/me/addresses/home', { label: 'Home', location: { lat: 11.016_844, lon: 76.955_832 }, landmark: 'Near the temple (synthetic)' }, CUSTOMER), 'save home');
    await ok(req('POST', '/v1/me/addresses/work', { label: 'Work', location: { lat: 11.02, lon: 76.96 } }, CUSTOMER), 'save work');
    const list = async (who = CUSTOMER, hh = h) => ((await hh.request({ method: 'GET', path: '/v1/me/addresses', userId: who, tenantId: T })).body as { addresses: { addressId: string; label: string; location: { lat: number; lon: number }; landmark?: string }[] }).addresses;
    expect(await list()).toEqual([
      expect.objectContaining({ addressId: 'home', label: 'Home', location: { lat: 11.017, lon: 76.956 }, landmark: 'Near the temple (synthetic)' }),
      expect.objectContaining({ addressId: 'work', label: 'Work' }),
    ]);
    expect(await list(OTHER_CUSTOMER)).toEqual([]);
    expect((await req('POST', '/v1/me/addresses/work/remove', {}, OTHER_CUSTOMER)).status).toBe(404);
    await ok(req('POST', '/v1/me/addresses/work/remove', {}, CUSTOMER), 'remove work');
    expect((await list()).map((a) => a.addressId)).toEqual(['home']);
    expect((await req('POST', '/v1/me/addresses/work/remove', {}, CUSTOMER)).status).toBe(404);
    // No card is kept: nothing to remove, said.
    expect((await req('GET', '/v1/me/payment-methods', undefined, CUSTOMER)).body).toMatchObject({ saved: [], providerConnected: false });
    expect((await req('POST', '/v1/me/payment-methods/any/remove', {}, CUSTOMER)).body).toMatchObject({ removed: false });

    // ── Suggestions ──
    for (const [id, items] of [['S1', ['MILK', 'BROOM']], ['S2', ['MILK', 'BROOM']], ['S3', ['MILK', 'SAREE']]] as const) {
      const r = await h.request({ method: 'POST', path: '/v1/sales', userId: CASHIER, tenantId: T, idempotencyKey: `bank-${id}`, body: bill(id, items) });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    }
    // The customer's own earlier online order (BROOM only).
    await ok(req('POST', '/v1/storefront/orders/ORD-B', { lines: [{ productId: 'BROOM', quantityMinor: 1 }], locationId: STORE }, CUSTOMER), 'earlier order');
    const suggest = async (productId: string) => (await ok(req('GET', '/v1/storefront/recommendations', undefined, CUSTOMER, { productId }), 'suggest')).body as { recommendations: { productId: string; basis: string }[]; personalised: boolean; say: string };
    const before = await suggest('MILK');
    expect(before.personalised).toBe(false);
    expect(before.recommendations.map((r) => [r.productId, r.basis])).toEqual([['BROOM', 'aggregate'], ['SAREE', 'aggregate']]);
    expect(before.say).toMatch(/not from what you bought/);
    expect((await suggest('SAREE')).recommendations.map((r) => r.productId)).toEqual(['MILK']);
    await ok(req('POST', '/v1/me/privacy/consent', { purpose: 'profiling', channel: 'push', given: true }, CUSTOMER), 'profiling yes');
    const after = await suggest('SAREE');
    expect(after.personalised).toBe(true);
    expect(after.recommendations.map((r) => [r.productId, r.basis])).toEqual([['BROOM', 'personal'], ['MILK', 'aggregate']]);
    expect(codeOf(await req('GET', '/v1/storefront/recommendations', undefined, CUSTOMER))).toBe('product_not_given');

    // ── Help ──
    const help = (body: Record<string, unknown>, who = CUSTOMER) => req('POST', '/v1/me/help/answers', body, who);
    expect(codeOf(await help({ topic: 'order_status', orderId: 'ORD-B', question: 'where is it??' }))).toBe('not_readable_as_a_help_question');
    expect((await help({ topic: 'order_status', orderId: 'ORD-B' }, OTHER_CUSTOMER)).status).toBe(404);
    expect((await help({ topic: 'return_policy' }, CASHIER)).status).toBe(403);
    // The AI is switched off by default: the assistant says it cannot answer and offers a person.
    const off = (await ok(help({ topic: 'order_status', orderId: 'ORD-B' }), 'help off')).body as { answered: boolean; escalate: boolean; notice: { en: string; ta: string } };
    expect(off).toMatchObject({ answered: false, escalate: true });
    expect(off.notice.en).toMatch(/given automatically by the shop's assistant/);
    await ok(req('PUT', '/v1/ai/kill-switch', { on: false }, OWNER), 'unkill');
    await ok(req('PUT', '/v1/ai/agents/enabled', { expected: [], agents: ['A05'] }, OWNER), 'enable A05');
    const on = (await ok(help({ topic: 'order_status', orderId: 'ORD-B' }), 'help on')).body as { answered: boolean; text: string; source: string };
    expect(on.answered).toBe(true);
    expect(on.text).toContain('ORD-B');
    expect(on.source).toBe('the order register');
    expect(((await ok(help({ topic: 'return_policy' }), 'returns')).body as { text: string }).text).toMatch(/has not set its return windows yet \("not set"\)/);
    expect(((await ok(help({ topic: 'delivery_charges' }), 'delivery')).body as { text: string }).text).toBe('We deliver within 10 km. Delivery costs ₹40.00. You can also collect from the store at no charge.');

    // A cold restart reads the same addresses.
    expect((await list(CUSTOMER, harness(h))).map((a) => a.addressId)).toEqual(['home']);
  });
});
