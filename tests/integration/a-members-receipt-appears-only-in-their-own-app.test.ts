import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { seedOnlineShop, callsFor, codeOf, saidOf, OWNER, CASHIER, CUSTOMER, OTHER_CUSTOMER, STORE } from '../support/online-shop';

/**
 * **R4 · D-28 — a member's digital receipt appears only in their own app, and only once they asked — on the real API, in
 * memory and on REAL PostgreSQL, across a cold restart.**
 *
 * The signed sentence (OB-227 · OB-214 · OB-222): nobody is switched on by default; once the member switches digital
 * receipts on in their own app, a banked sale naming them appears under "My receipts" after the till syncs, with the same
 * bill number, lines, tax and payments as the printed bill; a card shows only its last four digits. A member who has not
 * switched on gets no copy. Another customer's receipt is refused ("not your receipt"). Sending by SMS or WhatsApp is
 * switched off and nothing is sent. The app account is tied to the member at the desk after seeing the number on the
 * customer's own phone (OB-29), because the SMS code is switched off.
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

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

const MOBILE_A = '9000000011';
const MOBILE_B = '9000000022';
type Copy = { receiptNumber: string; lines: { productId: string; name: string; quantityMinor: number; lineTotalMinor: number }[]; taxBands: { rateBps: number; netMinor: number; taxMinor: number }[]; taxMinor: number; totalMinor: number; payments: { kind: string; amountMinor: number; cardLast4?: string; say: string }[] };

describe.each(backings)('D-28 — a member\'s receipt appears only in their own app, on $name', ({ harness, restart }) => {
  it('off by default · tied at the desk · on in the app · the same bill, card last four only · nobody else\'s · sending off', async () => {
    let h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    const enrol = async (mobile: string, name?: string) => ((await ok(req('POST', '/v1/loyalty/members', { mobile, consent: true, verifiedHow: 'seen_on_phone', ...(name === undefined ? {} : { name }) }), `enrol ${mobile}`)).body as { memberRef: string }).memberRef;
    // OB-329: A gives her name at the desk; it is on her own receipts.
    const memberA = await enrol(MOBILE_A, 'Kavitha Raj');
    const memberB = await enrol(MOBILE_B);
    const today = new Date().toISOString().slice(0, 10);
    let n = 0;
    const bank = async (memberRef: string, committedAt = new Date().toISOString()) => {
      n += 1;
      const receiptNumber = `S01-L1-${String(n).padStart(6, '0')}`;
      await ok(req('POST', '/v1/sales', {
        saleId: `sale-${n}`, receiptNumber, laneId: 'lane-1', locationId: STORE, cashierId: OWNER, tradingDay: today, committedAt,
        totalMinor: 2 * 60_00 + 150_00, currency: 'INR', packVersion: 1, customerRef: memberRef,
        lines: [
          { productId: 'MILK', quantityMinor: 2, uom: 'ea', unitPriceMinor: 60_00, lineTotalMinor: 120_00, taxRateBps: 500, hsnCode: '0401' },
          { productId: 'BROOM', quantityMinor: 1, uom: 'ea', unitPriceMinor: 150_00, lineTotalMinor: 150_00, taxRateBps: 1_800, hsnCode: '9603' },
        ],
        tenders: [{ kind: 'card', amountMinor: 200_00, ref: 'ntok-ref-1', card: { tokenRef: 'ntok-secret-token-1', last4: '4242', network: 'visa' } }, { kind: 'cash', amountMinor: 70_00 }],
      }), `bank ${receiptNumber}`);
      return receiptNumber;
    };

    // Nobody is switched on by default — and an untied app sees nothing.
    const choice0 = (await ok(req('GET', '/v1/me/receipts/choice', undefined, CUSTOMER), 'choice')).body as { on: boolean; member: unknown; notLinkedSay?: string; sending: { switchedOn: boolean; say: string } };
    expect(choice0).toMatchObject({ on: false, member: null, sending: { switchedOn: false } });
    expect(choice0.notLinkedSay).toContain(CUSTOMER);
    const before = await bank(memberA, new Date(Date.now() - 3_600_000).toISOString()); // a bill banked before anything was switched on

    // The desk ties the app account to the member — after seeing the number on the customer's own phone.
    expect((await req('POST', '/v1/loyalty/members/app-link', { mobile: MOBILE_A, appCustomerRef: CUSTOMER, verifiedHow: 'seen_on_phone' }, CUSTOMER)).status).toBe(403);
    expect(codeOf(await req('POST', '/v1/loyalty/members/app-link', { mobile: MOBILE_A, appCustomerRef: CUSTOMER }))).toBe('number_not_checked');
    expect(codeOf(await req('POST', '/v1/loyalty/members/app-link', { mobile: '9000000099', appCustomerRef: CUSTOMER, verifiedHow: 'seen_on_phone' }))).toBe('not_a_member');
    await ok(req('POST', '/v1/loyalty/members/app-link', { mobile: MOBILE_A, appCustomerRef: CUSTOMER, verifiedHow: 'seen_on_phone' }), 'link A');
    await ok(req('POST', '/v1/loyalty/members/app-link', { mobile: MOBILE_B, appCustomerRef: OTHER_CUSTOMER, verifiedHow: 'seen_on_phone' }), 'link B');
    // Tied, but still OFF: no copy of a bill banked now.
    await bank(memberA);
    expect(((await ok(req('GET', '/v1/me/receipts', undefined, CUSTOMER), 'mine off')).body as { count: number; say: string })).toMatchObject({ count: 0, say: 'Digital receipts are off. Switch them on to get a copy of each bill here.' });

    // The member switches them ON in their own app; the next banked bill is copied.
    expect(codeOf(await req('POST', '/v1/me/receipts/choice', { on: 'yes' }, CUSTOMER))).toBe('not_readable_as_a_choice');
    await ok(req('POST', '/v1/me/receipts/choice', { on: true }, CUSTOMER), 'on');
    const billed = await bank(memberA);
    const billedB = await bank(memberB); // member B never switched on

    // ── A cold restart: copies are read from the banked sales and the member's own choices ──
    h = restart(h);
    const mine = (await ok(req('GET', '/v1/me/receipts', undefined, CUSTOMER), 'mine')).body as { on: boolean; linked: boolean; count: number; receipts: Copy[] };
    expect(mine).toMatchObject({ on: true, linked: true, count: 1 });
    const copy = mine.receipts[0]!;
    expect(copy.receiptNumber).toBe(billed);
    expect((copy as unknown as { billedTo: string | null }).billedTo).toBe('Kavitha Raj'); // OB-329
    expect(copy.lines.map((l) => [l.productId, l.name, l.quantityMinor, l.lineTotalMinor])).toEqual([['MILK', 'Synthetic Milk 1L', 2, 120_00], ['BROOM', 'Synthetic Broom', 1, 150_00]]);
    // The same tax as the printed bill: GST inside each line's price, per rate.
    expect(copy.taxBands).toEqual([{ rateBps: 500, netMinor: 11_429, taxMinor: 571 }, { rateBps: 1_800, netMinor: 12_712, taxMinor: 2_288 }]);
    expect(copy.totalMinor).toBe(270_00);
    // A card shows its last four digits ONLY — no token, no reference (hard rule #3).
    expect(copy.payments).toEqual([
      { kind: 'card', amountMinor: 200_00, cardLast4: '4242', say: 'Card ending 4242 ₹200.00' },
      { kind: 'cash', amountMinor: 70_00, say: 'cash ₹70.00' },
    ]);
    expect(JSON.stringify(mine)).not.toMatch(/ntok|tokenRef|network/);
    expect(mine.receipts.map((r) => r.receiptNumber)).not.toContain(before);

    // One of my own opens; anybody else's is refused by name (and kept for staff).
    expect(((await ok(req('GET', `/v1/me/receipts/${billed}`, undefined, CUSTOMER), 'one')).body as { receipt: Copy }).receipt.receiptNumber).toBe(billed);
    const theirs = await req('GET', `/v1/me/receipts/${billed}`, undefined, OTHER_CUSTOMER);
    expect([theirs.status, codeOf(theirs)]).toEqual([403, 'not_your_receipt']);
    expect(saidOf(theirs)).toMatch(/^not your receipt/);
    // Member B never switched on: no copy of B's bill, even in B's own app.
    expect(((await ok(req('GET', '/v1/me/receipts', undefined, OTHER_CUSTOMER), 'B')).body as { count: number }).count).toBe(0);
    expect((await req('GET', `/v1/me/receipts/${billedB}`, undefined, OTHER_CUSTOMER)).status).toBe(403);

    // Sending by SMS or WhatsApp is switched off: nothing is sent, and it says so.
    const send = await req('POST', `/v1/me/receipts/${billed}/send`, { channel: 'sms' }, CUSTOMER);
    expect([send.status, codeOf(send)]).toEqual([409, 'sending_switched_off']);
    expect(saidOf(send)).toBe('Sending receipts by SMS or WhatsApp is switched off — nothing is sent. Your receipts are here in the app.');

    // Switched off again: the next bill is not copied; the one already copied stays.
    await ok(req('POST', '/v1/me/receipts/choice', { on: false }, CUSTOMER), 'off');
    await bank(memberA);
    expect(((await ok(req('GET', '/v1/me/receipts', undefined, CUSTOMER), 'after off')).body as { receipts: Copy[] }).receipts.map((r) => r.receiptNumber)).toEqual([billed]);
    // The cashier's till role reaches none of it.
    expect((await req('GET', '/v1/me/receipts', undefined, CASHIER)).status).toBe(403);
  }, 120_000);
});
