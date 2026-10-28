import { describe, it, expect } from 'vitest';
import { createQuotationsSession, quotationsOutcomeWords, newQuotationNumber, defaultValidUntil, QUOTATIONS_COPY } from '../../apps/web-erp/src/quotations-session';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { barcodesByProduct, laneQuotations, QUOTATION_TILL_WORDS, type QuotationsLanePort, type QuotationLaneAnswer } from '../../apps/pos/src/quotation-at-till';
import { httpQuotations } from '../../edge/store-edge/src/quotations-at-lane';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { HEAD_OFFICE_PAGE_SCREENS, HEAD_OFFICE_PAGE_GLOBALS } from '../../edge/store-edge/src/head-office-pages';
import { buildSurface } from '../../services/api/src/main';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { CatalogueCache, type CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { PosSession, taxRateFromPercent, createPosView } from '../../apps/pos/src/index';
import { QuotedPriceRefusedError } from '../../apps/pos/src/session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/sale-intake';

/**
 * **A retail quotation is made in the office and rung up at the till by its number (OB-506 · M12-FR-02 · hard rule #1 ·
 * P-08).** The office page makes, lists, follows up and voids quotations over head office's own routes (only those, with the
 * body the handler reads; counted items from the signed pack; an eight-digit number the till's keypad can key). At the till
 * the number goes to the store computer, which asks head office to convert it; the till rings each line through its OWN
 * pack at the QUOTED price — lowered or, since the owner's word of 28 Oct 2026, RAISED to it (the quotation named as the
 * evidence, its number on the line) — never above the MRP: a quoted price above the MRP is refused in words and not rung.
 * It lists what it cannot ring. With head office (or the store computer) out of reach NOTHING is rung, said in words.
 * Head office's sale check explains a quoted line from its OWN quotation record, never on the till's word.
 * Synthetic data only.
 */

interface Call { readonly url: string; readonly method: string; readonly body: unknown; readonly key: string | null; readonly auth?: string }
function http(answer: (url: string, method: string, body: unknown) => { status: number; body: unknown } | 'throw'): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ url, method, body, key: headers['idempotency-key'] ?? null, ...(headers['authorization'] === undefined ? {} : { auth: headers['authorization'] }) });
    const a = answer(url, method, body);
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const served = buildSurface({ signingKey: 'k'.repeat(48), migrationTargetKind: 'rehearsal', store: new InMemoryEventStore() });
const isServed = (method: string, url: string): boolean => served.some((r) => r.method === method && new RegExp(`^${r.path.replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`).test(url.split('?')[0]!));
const PACK = { snapshot: { tenantId: 't', version: 3, builtAt: '2026-10-28T00:00:00.000Z', barcodes: [{ code: '8901', productId: 'P-RICE', kind: 'standard' }],
  products: [
    { productId: 'P-RICE', sku: 'RICE-25', name: 'Ponni rice 25 kg', baseUom: 'ea', unitPriceMinor: 1_450_00, mrpMinor: 1_500_00, taxBps: 0, status: 'active' },
    { productId: 'P-ONION', sku: 'ONION', name: 'Onion', baseUom: 'kg', unitPriceMinor: 42_00, taxBps: 0, status: 'active' },
  ] } };
const MANAGER = { userId: 'u-mgr', permissions: ['pos.quotation.read', 'pos.quotation.write'] };
const keys = (() => { let n = 0; return () => `k-${(n += 1)}`; })();

describe('the Quotations page session', () => {
  it('makes a quotation from pack lines (a typed promised price, or the till\'s), lists, follows up and voids — only head office\'s own routes', async () => {
    const ho = http((url, method) => {
      if (url === '/v1/catalogue/pack') return { status: 200, body: PACK };
      if (method === 'POST' && url === '/v1/pos/quotations/48151623') return { status: 201, body: { quotationId: '48151623', state: 'issued', totalMinor: 13_800_00, validUntil: '2026-11-04' } };
      return { status: 200, body: { quotations: [] } };
    });
    const s = createQuotationsSession({ viewer: MANAGER, fetch: ho.fetch, newKey: keys, newNumber: () => '48151623', now: () => '2026-10-28T06:00:00.000Z' });
    expect(s.may).toEqual({ named: true, read: true, write: true });
    const typed = await s.line({ code: 'RICE-25', qty: '10', priceRupees: '₹1,380' });
    const tills = await s.line({ code: '8901', qty: '1', priceRupees: '' });
    expect(typed).toEqual({ result: 'ok', value: { productId: 'P-RICE', description: 'Ponni rice 25 kg', quantity: 10, unitPriceMinor: 1_380_00, uom: 'ea', taxBps: 0 } });
    expect(tills.result === 'ok' && tills.value.unitPriceMinor).toBe(1_450_00);
    const made = await s.make({ storeId: ' store-1 ', customerRef: ' Murugan Stores ', validUntil: '2026-11-04', approvalId: '', lines: [typed.result === 'ok' ? typed.value : (undefined as never)] });
    expect(quotationsOutcomeWords('en', made)).toBe('Quotation made at head office. Its number — give it to the customer: 48151623');
    await s.list('issued'); await s.list('nonsense'); await s.followUp(); await s.void('48151623', ' customer bought elsewhere ');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/catalogue/pack', 'POST /v1/pos/quotations/48151623', 'GET /v1/pos/quotations?state=issued', 'GET /v1/pos/quotations', 'GET /v1/pos/quotations/follow-up', 'POST /v1/pos/quotations/48151623/withdraw',
    ]);
    expect(ho.calls[1]!.body).toEqual({ storeId: 'store-1', customerRef: 'Murugan Stores', currency: 'INR', validUntil: '2026-11-04', lines: [{ lineId: 'l1', productId: 'P-RICE', description: 'Ponni rice 25 kg', unitPriceMinor: 1_380_00, quantityMinor: 10, uom: 'ea', taxBps: 0 }] });
    expect(ho.calls[5]!.body).toEqual({ reason: 'customer bought elsewhere' });
    expect(ho.calls.filter((c) => c.method === 'POST').every((c) => c.key !== null)).toBe(true);
    for (const c of ho.calls) expect(isServed(c.method, c.url), `${c.method} ${c.url}`).toBe(true);
  });

  it('refuses before any call: nobody, a reader trying to write, a weighed item, a code not in the pack, a past date, no reason', async () => {
    const ho = http((url) => (url === '/v1/catalogue/pack' ? { status: 200, body: PACK } : { status: 200, body: {} }));
    expect(await createQuotationsSession({ viewer: undefined, fetch: ho.fetch }).list('')).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createQuotationsSession({ viewer: { userId: 'u', permissions: ['pos.quotation.read'] }, fetch: ho.fetch });
    expect(reader.may.write).toBe(false);
    expect(await reader.void('1', 'x')).toEqual({ result: 'invalid', why: 'cannotWrite' });
    const s = createQuotationsSession({ viewer: MANAGER, fetch: ho.fetch, now: () => '2026-10-28T06:00:00.000Z' });
    expect(await s.line({ code: 'RICE-25', qty: '0', priceRupees: '' })).toEqual({ result: 'invalid', why: 'needLine' });
    expect(await s.line({ code: 'RICE-25', qty: '2', priceRupees: 'cheap' })).toEqual({ result: 'invalid', why: 'needLine' });
    expect(ho.calls).toEqual([]);
    expect(await s.line({ code: 'ONION', qty: '5', priceRupees: '' })).toEqual({ result: 'invalid', why: 'notCounted' });
    expect(await s.line({ code: 'NOPE', qty: '5', priceRupees: '' })).toEqual({ result: 'invalid', why: 'notInPack' });
    const line = { productId: 'P-RICE', description: 'r', quantity: 1, unitPriceMinor: 1, uom: 'ea', taxBps: 0 };
    expect(await s.make({ storeId: 's', customerRef: 'c', validUntil: '2026-10-27', approvalId: '', lines: [line] })).toEqual({ result: 'invalid', why: 'needMake' });
    expect(await s.make({ storeId: 's', customerRef: 'c', validUntil: '2026-11-01', approvalId: '', lines: [] })).toEqual({ result: 'invalid', why: 'needMake' });
    expect(await s.void('1', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(ho.calls.map((c) => c.url)).toEqual(['/v1/catalogue/pack']); // the pack, read once
    const lost = await createQuotationsSession({ viewer: MANAGER, fetch: http(() => 'throw').fetch }).list('');
    expect(quotationsOutcomeWords('ta', lost)).toMatch(/தலைமை அலுவலகத்தை அடைய முடியவில்லை/);
    // The number is eight digits — what the till's keypad keys; the default date is a week from the shop's today.
    expect(newQuotationNumber()).toMatch(/^[1-9]\d{7}$/);
    expect(defaultValidUntil('2026-10-28T06:00:00.000Z')).toBe('2026-11-04');
  });

  it('is on the menu (Sales), served by the store computer, and every word has a Tamil twin', () => {
    expect(ERP_NAVIGATION.find((i) => i.id === 'quotations')).toMatchObject({ path: '/quotations', requires: 'pos.quotation.read', group: 'Sales' });
    expect(HEAD_OFFICE_PAGE_SCREENS).toContain('quotations');
    expect(HEAD_OFFICE_PAGE_GLOBALS.quotations).toBe('quotationsData');
    expect(Object.keys(QUOTATIONS_COPY.ta).sort()).toEqual(Object.keys(QUOTATIONS_COPY.en).sort());
    for (const [k, v] of Object.entries(QUOTATIONS_COPY.ta)) if (k !== 's_') expect(v, k).toMatch(/[஀-௿]/);
    expect(Object.keys(QUOTATION_TILL_WORDS.ta).sort()).toEqual(Object.keys(QUOTATION_TILL_WORDS.en).sort());
  });
});

const NOW = new Date().toISOString();
const CAT: CatalogueSnapshot = {
  tenantId: 't', version: 5, builtAt: NOW,
  products: [
    { productId: 'P-RICE', sku: 'RICE', name: 'Ponni rice 25 kg', baseUom: 'ea', unitPriceMinor: 1_450_00, mrpMinor: 1_500_00, taxBps: 0, status: 'active' },
    { productId: 'P-OIL', sku: 'OIL', name: 'Oil 1 L', baseUom: 'ea', unitPriceMinor: 180_00, mrpMinor: 200_00, taxBps: 500, status: 'active' },
    { productId: 'P-GHEE', sku: 'GHEE', name: 'Ghee', baseUom: 'ea', unitPriceMinor: 300_00, mrpMinor: 300_00, taxBps: 1200, status: 'active', recallBlock: true },
  ],
  barcodes: [{ code: '8901', productId: 'P-RICE', kind: 'standard' }, { code: '8902', productId: 'P-OIL', kind: 'standard' }, { code: '8903', productId: 'P-GHEE', kind: 'standard' }],
};
function till(port: QuotationsLanePort) {
  const written: Record<string, unknown>[] = [];
  const pos = bootPos({
    laneId: 'lane-1', cashierId: 'u-cash', tradingDay: NOW.slice(0, 10), catalogue: CAT, quotationsPort: port,
    durable: async (_id, record) => { written.push(JSON.parse(record) as Record<string, unknown>); return { committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }; },
  });
  return { pos, written };
}
const converted = (lines: { productId: string; unitPriceMinor: number; quantityMinor: number; uom?: string }[]): QuotationLaneAnswer => ({
  converted: true, quotationId: '48151623', laneMessage: '',
  lines: lines.map((l, i) => ({ lineId: `l${i + 1}`, description: l.productId, uom: 'ea', ...l })),
});

describe('the till rings a quotation up by its number', () => {
  it('lowers a line to the quoted price and RAISES one quoted above the till\'s price, the quotation as evidence; lists what it cannot ring — and the bill pays', async () => {
    const asked: { quotationNumber: string; billRef: string }[] = [];
    const { pos, written } = till({ convert: async (i) => { asked.push(i); return converted([{ productId: 'P-RICE', unitPriceMinor: 1_380_00, quantityMinor: 2 }, { productId: 'P-OIL', unitPriceMinor: 190_00, quantityMinor: 1 }, { productId: 'P-GHEE', unitPriceMinor: 290_00, quantityMinor: 1 }, { productId: 'P-ONION', unitPriceMinor: 40_00, quantityMinor: 1000, uom: 'kg' }]); } });
    const r = await pos.ringQuotationAtTill(' 48151623 ');
    expect(asked).toEqual([{ quotationNumber: '48151623', billRef: pos.currentBillRef() }]);
    expect(r.ok).toBe(true);
    // Rice quoted BELOW the till's ₹1,450 → lowered to ₹1,380; oil quoted ABOVE the till's ₹180 (MRP ₹200) → charged ₹190.
    expect(r.added?.map((a) => [a.description, a.qty, a.unitPriceMinor, a.at])).toEqual([['Ponni rice 25 kg', 2, 1_380_00, 'quoted'], ['Oil 1 L', 1, 190_00, 'quoted_higher']]);
    expect(r.notAdded?.map((n) => n.productId)).toEqual(['P-GHEE', 'P-ONION']);
    expect(r.notAdded?.[1]?.laneMessage).toMatch(/weigh it on the scale/);
    expect(r.laneMessage).toBe('Quotation 48151623: 2 line(s) rung; 2 need the cashier — deal with each one. 1 line(s) are quoted above today\'s till price — the quoted price is charged.');
    expect(r.laneMessageTa).toMatch(/விலைப்புள்ளி 48151623/);
    expect(r.laneMessageTa).toMatch(/சொன்ன விலையே வசூலிக்கப்படும்/);
    expect(pos.payableMinor()).toBe(2 * 1_380_00 + 190_00);
    await pos.tenderCash('S-Q1', 'R-Q1', NOW);
    const lines = (written[0] as { lines: { productId: string; unitPriceMinor: number; priceOverride?: Record<string, unknown> }[] }).lines;
    expect(lines.find((l) => l.productId === 'P-RICE')).toMatchObject({ unitPriceMinor: 1_380_00, priceOverride: { fromUnitPriceMinor: 1_450_00, approvedBy: 'quotation 48151623', activityId: 'quotation:48151623', quotationId: '48151623' } });
    // The raised line says truthfully where its price came from: the till's ₹180 raised to quotation 48151623's ₹190.
    expect(lines.find((l) => l.productId === 'P-OIL')).toMatchObject({ unitPriceMinor: 190_00, priceOverride: { fromUnitPriceMinor: 180_00, approvedBy: 'quotation 48151623', activityId: 'quotation:48151623', quotationId: '48151623' } });
  });

  it('OB-506 (owner, 28 Oct 2026): quoted ABOVE the till price → charged the quoted price; quoted BELOW → lowered as before; the same → unchanged', async () => {
    const { pos, written } = till({ convert: async () => converted([{ productId: 'P-OIL', unitPriceMinor: 200_00, quantityMinor: 3 }, { productId: 'P-RICE', unitPriceMinor: 1_400_00, quantityMinor: 1 }]) });
    const r = await pos.ringQuotationAtTill('48151623');
    expect(r).toMatchObject({ ok: true, notAdded: [] });
    // Oil quoted at exactly its MRP (₹200) — above the till's ₹180, so the quoted ₹200 is charged, not more.
    expect(r.added?.map((a) => [a.description, a.qty, a.unitPriceMinor, a.at])).toEqual([['Oil 1 L', 3, 200_00, 'quoted_higher'], ['Ponni rice 25 kg', 1, 1_400_00, 'quoted']]);
    expect(r.laneMessage).toBe('Quotation 48151623: 2 line(s) rung at the quoted prices. 1 line(s) are quoted above today\'s till price — the quoted price is charged. Check the goods, then take the payment.');
    expect(pos.payableMinor()).toBe(3 * 200_00 + 1_400_00);
    await pos.tenderCash('S-Q2', 'R-Q2', NOW);
    const lines = (written[0] as { lines: { productId: string; unitPriceMinor: number; lineTotalMinor: number; priceOverride?: Record<string, unknown> }[] }).lines;
    expect(lines.find((l) => l.productId === 'P-OIL')).toMatchObject({ unitPriceMinor: 200_00, lineTotalMinor: 600_00, priceOverride: { fromUnitPriceMinor: 180_00, quotationId: '48151623' } });
    expect(lines.find((l) => l.productId === 'P-RICE')).toMatchObject({ unitPriceMinor: 1_400_00, priceOverride: { fromUnitPriceMinor: 1_450_00, quotationId: '48151623' } });
    // Quoted at the till's own price: nothing changed, nothing recorded as a change.
    const same = till({ convert: async () => converted([{ productId: 'P-OIL', unitPriceMinor: 180_00, quantityMinor: 1 }]) });
    expect((await same.pos.ringQuotationAtTill('48151623')).added?.map((a) => [a.unitPriceMinor, a.at])).toEqual([[180_00, 'same']]);
    expect(same.pos.payableMinor()).toBe(180_00);
  });

  it('OB-506 · Legal Metrology: a quoted price ABOVE the MRP is refused in English and Tamil and NOT rung — never charged, never quietly capped', async () => {
    const { pos } = till({ convert: async () => converted([{ productId: 'P-OIL', unitPriceMinor: 210_00, quantityMinor: 1 }, { productId: 'P-RICE', unitPriceMinor: 1_380_00, quantityMinor: 1 }]) });
    const r = await pos.ringQuotationAtTill('48151623');
    expect(r.ok).toBe(true);
    expect(r.added?.map((a) => [a.description, a.unitPriceMinor, a.at])).toEqual([['Ponni rice 25 kg', 1_380_00, 'quoted']]);
    expect(r.notAdded).toEqual([{
      productId: 'P-OIL', name: 'P-OIL', qty: 1, refusedBecause: 'quoted_above_mrp',
      laneMessage: 'NOT rung — the quoted price ₹210.00 is above this item\'s MRP ₹200.00 — a customer is never charged above the MRP. Ask the office to correct the quotation.',
      laneMessageTa: expect.stringMatching(/^சேர்க்கப்படவில்லை — சொன்ன விலை ₹210\.00 .*MRP.*₹200\.00/),
    }]);
    expect(r.laneMessage).toBe('Quotation 48151623: 1 line(s) rung; 1 need the cashier — deal with each one. 1 line(s) are quoted above the MRP and were NOT rung — the office must correct the quotation.');
    expect(r.laneMessageTa).toMatch(/MRP-க்கு மேல் சொல்லப்பட்டதால் சேர்க்கப்படவில்லை/);
    // Only the rice is on the bill: the oil was never rung, so nothing above the MRP can be charged.
    expect(pos.basket().map((l) => [l.productId, l.unitPriceMinor])).toEqual([['P-RICE', 1_380_00]]);
    expect(pos.payableMinor()).toBe(1_380_00);
  });

  it('OB-506: a raise on an item whose MRP this till\'s pack does not carry is refused in words; the session itself never raises past the MRP', async () => {
    const noMrp: CatalogueSnapshot = { ...CAT, products: CAT.products.map((p) => (p.productId === 'P-OIL' ? { ...p, mrpMinor: undefined } as typeof p : p)) };
    const pos = bootPos({ laneId: 'lane-1', cashierId: 'u-cash', tradingDay: NOW.slice(0, 10), catalogue: noMrp, quotationsPort: { convert: async () => converted([{ productId: 'P-OIL', unitPriceMinor: 190_00, quantityMinor: 1 }]) } });
    const r = await pos.ringQuotationAtTill('48151623');
    expect(r.notAdded).toMatchObject([{ productId: 'P-OIL', refusedBecause: 'mrp_not_known', laneMessage: expect.stringMatching(/^NOT rung — the quoted price ₹190\.00 is higher than the till's price, and this till's price pack carries no MRP/), laneMessageTa: expect.stringMatching(/MRP இல்லை/) }]);
    expect(pos.basket()).toEqual([]);
    // The till's model refuses on its own too (a backstop behind the screen step): above the MRP, at it, and only upwards.
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'u-cash', tradingDay: NOW.slice(0, 10), currency: 'INR', defaultTaxRate: taxRateFromPercent(0), mrpOf: (id) => CAT.products.find((p) => p.productId === id)?.mrpMinor },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }),
    );
    const view = createPosView(session, 'INR', new CatalogueCache(CAT));
    const line = view.scanBarcode('8902');
    expect(() => session.chargeQuotedPrice(line.lineId, 201_00, '48151623')).toThrow(QuotedPriceRefusedError);
    expect(() => session.chargeQuotedPrice(line.lineId, 201_00, '48151623')).toThrow(expect.objectContaining({ refusedBecause: 'quoted_above_mrp', laneMessageTa: expect.stringMatching(/MRP/) }));
    expect(() => session.chargeQuotedPrice(line.lineId, 170_00, '48151623')).toThrow(RangeError);
    expect(session.basket()[0]).toMatchObject({ unitPrice: { minor: 180_00 } });
    session.chargeQuotedPrice(line.lineId, 200_00, '48151623');
    expect(session.basket()[0]).toMatchObject({ unitPrice: { minor: 200_00 }, priceOverride: { fromUnitMinor: 180_00, approvedBy: 'quotation 48151623', activityId: 'quotation:48151623', quotationId: '48151623' } });
    // A session with no MRP source (an older composition) never raises a price.
    const blind = new PosSession(
      { laneId: 'lane-1', cashierId: 'u-cash', tradingDay: NOW.slice(0, 10), currency: 'INR', defaultTaxRate: taxRateFromPercent(0) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }),
    );
    const blindLine = createPosView(blind, 'INR', new CatalogueCache(CAT)).scanBarcode('8902');
    expect(() => blind.chargeQuotedPrice(blindLine.lineId, 190_00, '48151623')).toThrow(expect.objectContaining({ refusedBecause: 'mrp_not_known' }));
  });

  it('says plainly when head office (or the store computer) cannot be reached, or refuses — and rings nothing', async () => {
    for (const answer of [
      { converted: false, refusedBecause: 'head_office_unreachable', laneMessage: 'A quotation is rung up through head office, and head office cannot be reached now. Nothing was rung.' },
      { converted: false, refusedBecause: 'quotation_expired', laneMessage: 'expired. Nothing was rung.' },
    ] as const) {
      const { pos } = till({ convert: async () => answer });
      const r = await pos.ringQuotationAtTill('48151623');
      expect(r).toMatchObject({ ok: false, refusedBecause: answer.refusedBecause, laneMessage: answer.laneMessage });
      expect(pos.basket()).toEqual([]);
    }
    // The till → store computer link itself is down.
    const lane = laneQuotations({ base: () => 'http://127.0.0.1:1', headers: () => ({}), frontRefused: {}, fetch: http(() => 'throw').fetch });
    expect(await lane.convert({ quotationNumber: '1', billRef: 'B-1' })).toMatchObject({ converted: false, refusedBecause: 'lane_unreachable', laneMessage: expect.stringMatching(/cannot reach its store computer/) });
    // Refused before the box is asked: a number that is not one, a basket already on the till, nobody signed in.
    let asked = 0;
    const { pos } = till({ convert: async () => { asked += 1; return converted([]); } });
    expect((await pos.ringQuotationAtTill('48 15')).refusedBecause).toBe('not_a_quotation_number');
    pos.scanBarcode('8901');
    expect((await pos.ringQuotationAtTill('48151623')).refusedBecause).toBe('basket_not_empty');
    const nobody = bootPos({ laneId: 'lane-1', catalogue: CAT, quotationsPort: { convert: async () => { asked += 1; return converted([]); } } });
    expect((await nobody.ringQuotationAtTill('48151623')).refusedBecause).toBe('operator_not_signed_in');
    expect(asked).toBe(0);
    expect(barcodesByProduct(CAT).get('P-OIL')).toBe('8902');
    // The box's packs name a plain barcode's kind as they read it ('ean13'); a weight- or price-carrying one is never used.
    const kinds = barcodesByProduct({ ...CAT, barcodes: [{ code: '2100001', productId: 'P-OIL', kind: 'weight_embedded' }, { code: '8902', productId: 'P-OIL', kind: 'ean13' as never }] });
    expect(kinds.get('P-OIL')).toBe('8902');
  });
});

describe('the store computer asks head office to convert, under its own credential', () => {
  const box = (answer: (url: string, body: unknown) => { status: number; body: unknown } | 'throw') => {
    const ho = http((url, _m, body) => answer(url, body));
    return { ho, port: httpQuotations({ baseUrl: 'https://ho.example.test/', token: 'box-token', fetch: ho.fetch }) };
  };
  const LINES = [{ lineId: 'l1', productId: 'P-RICE', description: 'Rice', unitPriceMinor: 1_380_00, quantityMinor: 2, uom: 'ea', taxBps: 0 }];

  it('posts the existing convert for the till\'s bill (the box\'s bearer, a fresh key) and passes the quoted lines on', async () => {
    const { ho, port } = box(() => ({ status: 200, body: { quotationId: '48151623', converted: true, saleId: 'B-lane-1-x', saleLines: LINES } }));
    const r = await port.convert({ quotationNumber: ' 48151623 ', billRef: 'B-lane-1-x', laneId: 'lane-1', cashierId: 'u-cash' });
    expect(r).toMatchObject({ converted: true, quotationId: '48151623', lines: [{ productId: 'P-RICE', unitPriceMinor: 1_380_00, quantityMinor: 2 }] });
    expect(ho.calls).toEqual([{ url: 'https://ho.example.test/v1/pos/quotations/48151623/convert', method: 'POST', body: { saleId: 'B-lane-1-x', laneId: 'lane-1', cashierId: 'u-cash' }, key: expect.stringMatching(/^quote-convert-48151623-lane-1-/), auth: 'Bearer box-token' }]);
    expect(isServed('POST', '/v1/pos/quotations/48151623/convert')).toBe(true);
  });

  it('the same bill again gets its lines; another bill is told which bill has it; expired, withdrawn, unknown, refused, down — each in words, nothing rung', async () => {
    const same = await box(() => ({ status: 200, body: { converted: false, alreadyConverted: true, sameSale: true, saleId: 'B-1', saleLines: LINES } })).port.convert({ quotationNumber: '1', billRef: 'B-1', laneId: 'l', cashierId: 'c' });
    expect(same.converted).toBe(true);
    const other = await box(() => ({ status: 200, body: { converted: false, alreadyConverted: true, saleId: 'B-1' } })).port.convert({ quotationNumber: '1', billRef: 'B-2', laneId: 'l', cashierId: 'c' });
    expect(other).toMatchObject({ converted: false, refusedBecause: 'already_converted', laneMessage: 'Quotation 1 was already rung up on bill B-1. A quotation becomes one bill — nothing was rung.' });
    const cases: [number | 'throw', unknown, string][] = [
      [422, { error: { code: 'quotation_expired', whatHappened: 'the quoted price was held until 2026-10-20 and that date has passed.' } }, 'quotation_expired'],
      [422, { error: { code: 'quotation_withdrawn', whatHappened: 'withdrawn (customer cancelled)' } }, 'quotation_withdrawn'],
      [404, { error: { code: 'unknown_quotation' } }, 'no_such_quotation'],
      [403, {}, 'head_office_refused'],
      [503, {}, 'head_office_unreachable'],
      ['throw', {}, 'head_office_unreachable'],
      [200, { converted: true, saleLines: [{ lineId: 'l1' }] }, 'not_readable'],
    ];
    for (const [status, body, why] of cases) {
      const r = await box(() => (status === 'throw' ? 'throw' : { status, body })).port.convert({ quotationNumber: '1', billRef: 'B-1', laneId: 'l', cashierId: 'c' });
      expect(r, why).toMatchObject({ converted: false, refusedBecause: why });
      if (!r.converted) { expect(r.laneMessage).toMatch(/[Nn]othing was rung|cannot be reached|Check the number/); expect(r.laneMessageTa).toMatch(/[஀-௿]/); }
    }
    const unreachable = await box(() => 'throw').port.convert({ quotationNumber: '1', billRef: 'B-1', laneId: 'l', cashierId: 'c' });
    expect(!unreachable.converted && unreachable.laneMessage).toMatch(/^A quotation is rung up through head office, and head office cannot be reached now\. Nothing was rung\./);
    // Not even asked: no number, no bill.
    const { ho, port } = box(() => ({ status: 200, body: {} }));
    expect((await port.convert({ quotationNumber: 7, billRef: 'B-1', laneId: 'l', cashierId: 'c' })).converted).toBe(false);
    expect((await port.convert({ quotationNumber: '7', billRef: '', laneId: 'l', cashierId: 'c' })).converted).toBe(false);
    expect(ho.calls).toEqual([]);
  });
});

describe('OB-506 — head office\'s sale check explains a quoted price from its OWN quotation record', () => {
  const CATALOGUE = new Map(CAT.products.map((p) => [p.productId, p]));
  const sale = (unitPriceMinor: number, priceOverride: NonNullable<IncomingSale['lines'][number]['priceOverride']> | undefined): IncomingSale => ({
    saleId: 'S-Q', receiptNumber: 'R-Q', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-10-28', committedAt: '2026-10-28T10:00:00Z',
    totalMinor: unitPriceMinor, currency: 'INR', packVersion: 5, tenders: [{ kind: 'cash', amountMinor: unitPriceMinor }],
    lines: [{ productId: 'P-OIL', quantityMinor: 1, uom: 'ea', unitPriceMinor, lineTotalMinor: unitPriceMinor, ...(priceOverride === undefined ? {} : { priceOverride }) }],
  });
  const RAISED = { fromUnitPriceMinor: 180_00, approvedBy: 'quotation 48151623', activityId: 'quotation:48151623', quotationId: '48151623' };
  const QUOTE = { quotationId: '48151623', state: 'converted', lines: [{ productId: 'P-OIL', unitPriceMinor: 190_00 }] };
  const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({ catalogue: CATALOGUE, currentPackVersion: 5, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-28T12:00:00Z', ...over });
  const prices = (r: ReturnType<typeof acceptSale>) => r.exceptions.filter((e) => e.kind === 'price_differs_from_catalogue' || e.kind === 'sold_above_mrp' || e.kind.startsWith('price_cut')).map((e) => [e.kind, e.severity]);

  it('a line RAISED to a converted quotation\'s price is informational (named), not an unapproved price change', () => {
    const r = acceptSale(sale(190_00, RAISED), ctx({ quotationsNamed: [QUOTE] }));
    expect(prices(r)).toEqual([['price_differs_from_catalogue', 'informational']]);
    expect(r.exceptions.find((e) => e.kind === 'price_differs_from_catalogue')!.detail).toBe('OIL was charged at 19000, the price quotation 48151623 promised (the catalogue says 18000)');
    // Even with head office's price-cut rules looked at, a raise is no cut — no approver-limit or floor finding.
    expect(prices(acceptSale(sale(190_00, RAISED), ctx({ quotationsNamed: [QUOTE], tillOverrideRules: { floors: new Map([['P-OIL', 150_00]]), limits: new Map() } })))).toEqual([['price_differs_from_catalogue', 'informational']]);
  });

  it('a quotation head office cannot back (another price, not converted, unknown) is MATERIAL; nobody looked → judged as before', () => {
    expect(prices(acceptSale(sale(195_00, RAISED), ctx({ quotationsNamed: [QUOTE] })))).toEqual([['price_differs_from_catalogue', 'material']]);
    expect(prices(acceptSale(sale(190_00, RAISED), ctx({ quotationsNamed: [{ ...QUOTE, state: 'issued' }] })))).toEqual([['price_differs_from_catalogue', 'material']]);
    expect(prices(acceptSale(sale(190_00, RAISED), ctx({ quotationsNamed: [] })))).toEqual([['price_differs_from_catalogue', 'material']]);
    expect(prices(acceptSale(sale(190_00, RAISED), ctx()))).toEqual([['price_differs_from_catalogue', 'material']]);
    // A till that names the quotation only in its evidence id (no quotationId) is read the same way.
    const { quotationId: _q, ...older } = RAISED; void _q;
    expect(prices(acceptSale(sale(190_00, older), ctx({ quotationsNamed: [QUOTE] })))).toEqual([['price_differs_from_catalogue', 'informational']]);
  });

  it('a quotation never excuses a price above the MRP — still CRITICAL', () => {
    const r = acceptSale(sale(210_00, RAISED), ctx({ quotationsNamed: [{ ...QUOTE, lines: [{ productId: 'P-OIL', unitPriceMinor: 210_00 }] }] }));
    expect(prices(r)).toEqual([['sold_above_mrp', 'critical']]);
  });
});
