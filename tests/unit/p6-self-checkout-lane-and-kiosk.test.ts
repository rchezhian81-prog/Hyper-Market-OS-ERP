import { describe, it, expect } from 'vitest';
import { createSelfCheckoutLane, auditDraw, WORDS, type TillEngine } from '../../apps/self-checkout/src/self-checkout-lane';
import { createPriceKiosk } from '../../apps/price-kiosk/src/price-kiosk';
import { readBasketEvidence, basketSummary } from '../../packages/self-checkout/src/basket-evidence';
import { selfCheckoutWatchOf, kioskStaleAfterOf, customerFacingGlobals } from '../../edge/store-edge/src/self-checkout-screens';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

// R8-3 · D04-FR-06 · D14-FR-02 · OB-302 · OB-316: the self-checkout lane model over a stand-in till engine, and the price
// kiosk model over a real catalogue. The till engine's own rules are tested where they live; this holds the lane's.

const NOW = '2026-10-24T10:00:00.000Z';
const err = (name: string, extra: Record<string, unknown>) => Object.assign(new Error(name), { name, ...extra });

/** A stand-in till: codes it knows, the age and pack-date rules, a PIN per person, a card machine, a disk. */
function fakeTill(opts: { pins?: Record<string, string>; failReceipt?: boolean } = {}) {
  const pins = opts.pins ?? { 'u-attend': '111111', 'u-two': '222222' };
  const catalogue: Record<string, { productId: string; name: string; price: number; age?: number; perishable?: boolean; refused?: string }> = {
    RICE: { productId: 'P-RICE', name: 'Rice', price: 7_000 },
    CIG: { productId: 'P-CIG', name: 'Cigarettes', price: 18_000, age: 18 },
    MILK: { productId: 'P-MILK', name: 'Milk', price: 3_000, perishable: true },
    RECALL: { productId: 'P-REC', name: 'Recalled tin', price: 100, refused: 'Recalled tin is under recall and cannot be sold' },
  };
  const state = { operator: undefined as string | undefined, ages: 0, dates: new Set<string>(), lines: [] as { lineId: string; productId: string; description: string; amountMinor: number; voided: boolean }[], seq: 0, attempts: [] as string[], committed: [] as Record<string, unknown>[], voids: [] as string[], signIns: [] as string[], answers: [] as string[], newSales: 0 };
  const till: TillEngine = {
    scanBarcode(code) {
      const p = catalogue[code];
      if (p === undefined) throw err('UnknownBarcodeError', { message: `Barcode "${code}" is not in the catalogue.` });
      if (p.refused !== undefined) throw err('RecalledItemError', { message: p.refused });
      if (p.age !== undefined && state.ages < p.age) throw err('AgeCheckRequiredError', { productId: p.productId, description: p.name, minimumAge: p.age, laneMessage: 'age' });
      if (p.perishable === true && !state.dates.has(p.productId)) throw err('PackDateCheckRequiredError', { productId: p.productId, description: p.name });
      state.dates.delete(p.productId);
      state.seq += 1;
      const line = { lineId: `L${state.seq}`, productId: p.productId, description: p.name, amountMinor: p.price, voided: false };
      state.lines.push(line);
      return { lineId: line.lineId, description: p.name, amountMinor: p.price };
    },
    basket: () => state.lines.map((l) => ({ ...l, qtyText: '1', uom: 'ea' })),
    payableMinor: () => state.lines.filter((l) => !l.voided).reduce((s, l) => s + l.amountMinor, 0),
    voidAtTill: async (lineId) => { const l = state.lines.find((x) => x.lineId === lineId); if (l === undefined) return { ok: false, laneMessage: 'no' }; l.voided = true; state.voids.push(lineId); return { ok: true, laneMessage: 'ok' }; },
    confirmAge: (age) => { state.ages = Math.max(state.ages, age); return undefined; },
    refuseAge: () => undefined,
    confirmPackDate: (productId) => { state.dates.add(productId); return undefined; },
    refusePackDate: () => undefined,
    signInAtTill: async ({ staffId, pin }) => {
      if (staffId !== undefined && pins[staffId] === pin) { state.operator = staffId; state.signIns.push(staffId); return { signedIn: true as const, userId: staffId }; }
      return { signedIn: false as const, refusedBecause: 'wrong_pin', laneMessage: 'That PIN is not right.' };
    },
    signOutAtTill: async () => { state.operator = undefined; },
    operator: () => state.operator,
    nextReceipt: async () => { if (opts.failReceipt === true) throw err('ReceiptNumberRefusedError', { laneMessage: 'no numbers left' }); return `R-${state.committed.length + 1}`; },
    startCardPayment: async (kind) => { const id = `PAY-${state.attempts.length + 1}`; state.attempts.push(`${kind}:${id}`); return { ok: true, laneMessage: 'asked', attemptId: id, amountMinor: till.payableMinor() }; },
    answerCardPayment: async (attemptId, outcome, _a, machineRef) => { state.answers.push(`${attemptId}:${outcome}:${machineRef ?? ''}`); return { ok: true, laneMessage: outcome, attemptId, state: outcome }; },
    tenderCardOrUpi: async (i) => { state.committed.push({ ...i, cashierId: state.operator }); return i.receiptNumber; },
    newSale: () => { state.lines = []; state.ages = 0; state.newSales += 1; },
    currentBillRef: () => 'B-lane-1-test',
  };
  return { till, state };
}

const config = (over: Partial<Parameters<typeof createSelfCheckoutLane>[1]> = {}) => {
  const recorded: Record<string, unknown>[] = [];
  return {
    recorded,
    config: {
      switchOn: true, switchWhy: null, mirrorPilot: false, realTrading: false, now: () => NOW,
      lookup: { scan: (code: string) => {
        if (code === 'BANANA') return { product: { productId: 'P-BAN', name: 'Banana', baseUom: 'kg' }, barcodeKind: 'standard' };
        if (code === 'BANANA-LABEL') return { product: { productId: 'P-BAN', name: 'Banana', baseUom: 'kg' }, barcodeKind: 'weight_embedded' };
        return { product: { productId: 'x', name: 'x', baseUom: 'ea' }, barcodeKind: 'standard' };
      } },
      recordBasket: async (b: Record<string, unknown>) => { recorded.push(b); return { recorded: true, laneMessage: 'Recorded.' }; },
      ...over,
    },
  };
};

describe('the self-checkout lane', () => {
  it('is off unless the switch is on for this lane, and in the mirror pilot it takes nothing', async () => {
    const off = createSelfCheckoutLane(fakeTill().till, config({ switchOn: false, switchWhy: 'never set' }).config);
    expect(off.view()).toMatchObject({ open: false, closed: WORDS.switchedOff });
    expect(await off.openLane('u-attend', '111111')).toMatchObject({ ok: false, refusedBecause: 'self_checkout_switched_off' });
    expect(off.scan('RICE')).toMatchObject({ ok: false, refusedBecause: 'lane_closed' });
    const pilot = createSelfCheckoutLane(fakeTill().till, config({ mirrorPilot: true }).config);
    expect(await pilot.openLane('u-attend', '111111')).toMatchObject({ ok: false, refusedBecause: 'mirror_pilot' });
  });

  it('a colleague opens it with their own PIN; a wrong PIN opens nothing', async () => {
    const { till } = fakeTill();
    const lane = createSelfCheckoutLane(till, config().config);
    expect(lane.view().closed).toEqual(WORDS.notOpened);
    expect(await lane.openLane('u-attend', '999999')).toMatchObject({ ok: false, refusedBecause: 'wrong_pin' });
    expect(await lane.openLane('', '')).toMatchObject({ ok: false, refusedBecause: 'colleague_not_named' });
    expect(await lane.openLane('u-attend', '111111')).toMatchObject({ ok: true });
    expect(lane.view()).toMatchObject({ open: true, attendant: 'u-attend', customerNow: WORDS.scanItems });
  });

  it('age, pack date, a weighed item without a label, a refused and an unknown item each go to a colleague — the customer reads neutral words', async () => {
    const { till, state } = fakeTill();
    const lane = createSelfCheckoutLane(till, config().config);
    await lane.openLane('u-attend', '111111');
    expect(lane.scan('RICE')).toMatchObject({ ok: true });
    expect(lane.scan('CIG')).toMatchObject({ ok: false, refusedBecause: 'age_check', words: WORDS.colleagueOneItem });
    expect(lane.scan('MILK')).toMatchObject({ ok: false, refusedBecause: 'pack_date_check' });
    expect(lane.scan('BANANA')).toMatchObject({ ok: false, refusedBecause: 'weighed_item', words: WORDS.colleagueWeigh });
    // A weighed item WITH its scale label goes to the till like any scan (the till's own rules then apply).
    expect(lane.scan('BANANA-LABEL').refusedBecause).not.toBe('weighed_item');
    expect(lane.scan('RECALL')).toMatchObject({ ok: false, refusedBecause: 'item_refused' });
    expect(lane.scan('NOPE')).toMatchObject({ ok: false, refusedBecause: 'not_found' });
    const v = lane.view();
    expect(v.interventions.map((i) => [i.kind, i.blocking])).toEqual([['age_check', true], ['pack_date_check', true], ['weighed_item', true], ['not_found', false], ['item_refused', false], ['not_found', false]]);
    expect(v.waitingForColleague).toBe(true);
    // Neutral for the customer; specific for the colleague.
    for (const i of v.interventions) expect(`${i.customerMessage.en} ${i.customerMessage.ta}`).not.toMatch(/age|18|recall|kg/i);
    expect(v.interventions.find((i) => i.kind === 'weighed_item')!.attendantDetail).toMatch(/Never key a weight \(OB-302\)/);
    expect(v.interventions.find((i) => i.kind === 'item_refused')!.attendantDetail).toMatch(/under recall/);
    // Nothing can be paid while a colleague is needed.
    expect(await lane.pay('card')).toMatchObject({ ok: false, refusedBecause: 'colleague_needed' });
    expect(state.attempts).toEqual([]);
  });

  it('each decision takes the colleague\'s own PIN, is limited to its kind, and goes through the till\'s own engine', async () => {
    const { till, state } = fakeTill();
    const lane = createSelfCheckoutLane(till, config().config);
    await lane.openLane('u-attend', '111111');
    lane.scan('CIG'); lane.scan('MILK'); lane.scan('BANANA');
    const id = (k: string) => lane.view().interventions.find((i) => i.kind === k)!.id;
    expect(await lane.settle(id('age_check'), 'u-attend', 'bad', 'old_enough')).toMatchObject({ ok: false, refusedBecause: 'wrong_pin' });
    expect(await lane.settle(id('age_check'), 'u-attend', '111111', 'sent_to_scale')).toMatchObject({ ok: false, refusedBecause: 'not_a_decision_for_this' });
    // Another colleague may settle it — in their own name.
    expect(await lane.settle(id('age_check'), 'u-two', '222222', 'old_enough')).toMatchObject({ ok: true });
    expect(await lane.settle(id('pack_date_check'), 'u-attend', '111111', 'date_passed')).toMatchObject({ ok: true });
    expect(await lane.settle(id('weighed_item'), 'u-attend', '111111', 'not_sold')).toMatchObject({ ok: true });
    expect(lane.view().lines.map((l) => l.description)).toEqual(['Cigarettes']); // the milk was not sold, the banana neither
    expect(lane.view().interventions).toEqual([]);
    expect(state.signIns).toEqual(['u-attend', 'u-two', 'u-attend', 'u-attend']);
  });

  it('pays only through the machine and a colleague\'s confirmation; the sale names them; the evidence follows', async () => {
    const { till, state } = fakeTill();
    const c = config();
    const lane = createSelfCheckoutLane(till, c.config);
    expect(await lane.pay('upi')).toMatchObject({ ok: false, refusedBecause: 'lane_closed' });
    await lane.openLane('u-attend', '111111');
    expect(await lane.pay('upi')).toMatchObject({ ok: false, refusedBecause: 'nothing_to_pay' });
    lane.scan('RICE'); lane.scan('CIG');
    await lane.settle(lane.view().interventions[0]!.id, 'u-attend', '111111', 'old_enough');
    expect(await lane.removeLine('L1')).toMatchObject({ ok: true });
    lane.scan('RICE');
    expect(await lane.confirmPayment('u-attend', '111111', 'approved')).toMatchObject({ ok: false, refusedBecause: 'no_payment_started' });
    expect(await lane.pay('upi')).toMatchObject({ ok: true, words: WORDS.payOnMachine });
    expect(lane.scan('RICE')).toMatchObject({ ok: false, refusedBecause: 'not_now' });
    // Declined: nothing saved, the customer may try again.
    expect(await lane.confirmPayment('u-attend', '111111', 'declined')).toMatchObject({ ok: false, refusedBecause: 'declined', words: WORDS.declined });
    expect(state.committed).toEqual([]);
    await lane.pay('card');
    expect(await lane.confirmPayment('u-two', '222222', 'approved')).toMatchObject({ ok: true, detail: 'R-1' });
    expect(state.committed).toEqual([expect.objectContaining({ saleId: 'S-R-1', kind: 'card', outcome: 'approved', ref: 'PAY-2', cashierId: 'u-two' })]);
    expect(lane.view()).toMatchObject({ receipt: { number: 'R-1', basketRecorded: true }, customerNow: WORDS.paidThanks });
    const body = c.recorded[0]!;
    expect(body).toMatchObject({ activityId: 'SCO-S-R-1', kind: 'self_checkout_basket', billRef: 'S-R-1', valueMinor: 25_000 });
    const ev = readBasketEvidence(body['selfCheckout'])!;
    expect(ev).toMatchObject({ lines: 2, voids: 1, riskBps: null, auditSelected: null });
    expect(ev.interventions.map((i) => [i.kind, i.outcome, i.settledBy])).toEqual([['age_check', 'old_enough', 'u-attend'], ['payment', 'declined', 'u-attend'], ['payment', 'approved', 'u-two']]);
    expect(basketSummary(ev)).toContain('risk figure not set');
    lane.nextCustomer();
    expect(lane.view()).toMatchObject({ receipt: null, payment: null, open: true, lines: [] });
  });

  it('OB-374 (owner, 25 Oct 2026): a card or UPI payment is confirmed only by a colleague with THEIR OWN PIN — never the customer, never a wrong PIN', async () => {
    const { till, state } = fakeTill();
    const lane = createSelfCheckoutLane(till, config().config);
    await lane.openLane('u-attend', '111111');
    lane.scan('RICE');
    await lane.pay('upi');
    // The attendant's staff ID with the other colleague's PIN, or no PIN at all: refused, nothing saved, the lane waits.
    expect(await lane.confirmPayment('u-attend', '222222', 'approved')).toMatchObject({ ok: false, refusedBecause: 'wrong_pin' });
    expect(await lane.confirmPayment('u-attend', '', 'approved')).toMatchObject({ ok: false });
    expect(state.committed).toEqual([]);
    // The colleague's own PIN confirms it — and the sale names that colleague, as the box verified them.
    expect(await lane.confirmPayment('u-two', '222222', 'approved')).toMatchObject({ ok: true });
    expect(state.committed).toEqual([expect.objectContaining({ kind: 'upi', outcome: 'approved', cashierId: 'u-two' })]);
  });

  it('in real trading an approval needs the machine\'s number; no answer is never treated as paid', async () => {
    const { till, state } = fakeTill();
    const lane = createSelfCheckoutLane(till, config({ realTrading: true }).config);
    await lane.openLane('u-attend', '111111');
    lane.scan('RICE');
    await lane.pay('card');
    expect(await lane.confirmPayment('u-attend', '111111', 'approved')).toMatchObject({ ok: false, refusedBecause: 'machine_ref_required' });
    expect(await lane.confirmPayment('u-attend', '111111', 'no_answer')).toMatchObject({ ok: false, refusedBecause: 'no_answer', words: WORDS.noAnswer });
    expect(state.committed).toEqual([]);
    expect(await lane.confirmPayment('u-attend', '111111', 'approved', ' 123456 ')).toMatchObject({ ok: true });
    expect(state.answers.at(-1)).toBe('PAY-1:approved:123456');
    expect(state.committed[0]).toMatchObject({ machineRef: '123456' });
  });

  it('a bill number the store computer will not give stops the sale, in words', async () => {
    const { till, state } = fakeTill({ failReceipt: true });
    const lane = createSelfCheckoutLane(till, config().config);
    await lane.openLane('u-attend', '111111');
    lane.scan('RICE');
    await lane.pay('card');
    expect(await lane.confirmPayment('u-attend', '111111', 'approved')).toMatchObject({ ok: false, refusedBecause: 'receipt_number_not_issued', words: WORDS.saleNotSaved });
    expect(state.committed).toEqual([]);
  });

  it('the watch runs only once the owner has set its numbers (P-08): a random audit then blocks until a colleague checks', async () => {
    const watch = { auditRateBps: 10_000, auditAboveMinor: 0, looseProducePatternCount: 2, voidPatternCount: 1 };
    const { till } = fakeTill();
    const c = config({ watch });
    const lane = createSelfCheckoutLane(till, c.config);
    await lane.openLane('u-attend', '111111');
    lane.scan('RICE');
    expect(lane.view().interventions.map((i) => i.kind)).toEqual(['random_audit']);
    await lane.removeLine('L1'); lane.scan('RICE');
    expect(lane.view().interventions.map((i) => [i.kind, i.blocking]).sort()).toEqual([['random_audit', true], ['void_pattern', false]]);
    expect(await lane.pay('card')).toMatchObject({ ok: false, refusedBecause: 'colleague_needed' });
    await lane.settle('E-random_audit', 'u-attend', '111111', 'checked');
    await lane.settle('E-void_pattern', 'u-attend', '111111', 'noted');
    expect(lane.view().interventions).toEqual([]);
    await lane.pay('card');
    await lane.confirmPayment('u-attend', '111111', 'approved');
    const ev = readBasketEvidence(c.recorded[0]!['selfCheckout'])!;
    expect(ev.auditSelected).toBe(true);
    expect(typeof ev.riskBps).toBe('number');
    expect(lane.view().attendantNotes.join(' ')).toMatch(/random audit 100%/);
    // The draw is fixed by the bill: the same basket always draws the same way.
    expect(auditDraw('B-1')).toBe(auditDraw('B-1'));
  });

  it('says to the colleague that no security scale is fitted and that the watch is not set', () => {
    const lane = createSelfCheckoutLane(fakeTill().till, config().config);
    expect(lane.view().attendantNotes.join(' ')).toMatch(/No security scale.*not set/s);
  });
});

describe('the store computer\'s settings for the two screens', () => {
  it('sends the watch numbers and the kiosk limit only when the store pack carries them whole', () => {
    expect(selfCheckoutWatchOf({})).toBeUndefined();
    expect(selfCheckoutWatchOf({ selfCheckoutWatch: { auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4 } })).toBeUndefined();
    expect(selfCheckoutWatchOf({ selfCheckoutWatch: { auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4, voidPatternCount: 3 } })).toEqual({ auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4, voidPatternCount: 3 });
    expect(kioskStaleAfterOf({})).toBeNull();
    expect(kioskStaleAfterOf({ kioskStaleAfterMinutes: 240 })).toBe(240);
    expect(customerFacingGlobals('price-kiosk', undefined)).toEqual({ priceKiosk: { staleAfterMinutes: null, timeZone: 'Asia/Kolkata' } });
    // R1c: the kiosk is told the shop's zone from the pack, so a price "from today" starts at the shop's midnight.
    expect(customerFacingGlobals('price-kiosk', { kioskStaleAfterMinutes: 5, timeZone: 'Asia/Dubai' })).toEqual({ priceKiosk: { staleAfterMinutes: 5, timeZone: 'Asia/Dubai' } });
    expect(customerFacingGlobals('self-checkout', undefined)).toEqual({});
    expect(customerFacingGlobals('pos', { kioskStaleAfterMinutes: 5 })).toEqual({});
  });
});

describe('the price kiosk', () => {
  const builtAt = '2026-10-24T09:00:00.000Z';
  const snapshot: CatalogueSnapshot = {
    tenantId: 't', version: 3, builtAt,
    products: [
      { productId: 'P-RICE', sku: 'RICE', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 7_000, taxBps: 0, status: 'active' },
      { productId: 'P-BAN', sku: '000123', name: 'Banana', baseUom: 'kg', unitPriceMinor: 9_999, taxBps: 0, status: 'active' },
      { productId: 'P-REC', sku: 'REC', name: 'Recalled tin', baseUom: 'ea', unitPriceMinor: 100, taxBps: 0, status: 'active', recallBlock: true },
    ],
    barcodes: [{ code: '890001', productId: 'P-RICE', kind: 'standard' }, { code: '890002', productId: 'P-BAN', kind: 'standard' }, { code: '890003', productId: 'P-REC', kind: 'standard' }],
    embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
  };
  it('quotes the till\'s price, always with the list\'s age; a weighed item per kg or by its label; never a recalled one', () => {
    const k = createPriceKiosk({ catalogue: snapshot, staleAfterMinutes: null, now: () => NOW });
    expect(k.lookup('890001')).toMatchObject({ outcome: 'quoted', priceMinor: 7_000, minutesSincePack: 60, age: { en: 'Prices from a list updated 1 hour(s) ago.' } });
    expect(k.lookup('890001').words.en).toMatch(/Offers are applied at the till/);
    expect(k.lookup('890001').words.ta).toMatch(/₹70\.00/);
    expect(k.lookup('890002')).toMatchObject({ outcome: 'quoted', priceMinor: 9_999, per: 'per kg' });
    expect(k.lookup('2000123003330')).toMatchObject({ outcome: 'quoted', priceMinor: 3_330 }); // 333 g at ₹99.99/kg
    expect(k.lookup('890003')).toMatchObject({ outcome: 'not_sold_here' });
    expect(k.lookup('nope')).toMatchObject({ outcome: 'not_found' });
    expect(k.staleAfter).toBeNull();
  });
  it('stops quoting an old list only once the owner sets the limit; with no list it says so', () => {
    expect(createPriceKiosk({ catalogue: snapshot, staleAfterMinutes: 30, now: () => NOW }).lookup('890001')).toMatchObject({ outcome: 'stale' });
    expect(createPriceKiosk({ catalogue: snapshot, staleAfterMinutes: 120, now: () => NOW }).lookup('890001')).toMatchObject({ outcome: 'quoted' });
    const none = createPriceKiosk({ staleAfterMinutes: null, now: () => NOW });
    expect(none.lookup('890001')).toMatchObject({ outcome: 'no_list', minutesSincePack: null });
    expect(none.age().en).toMatch(/no price list/);
  });
});
