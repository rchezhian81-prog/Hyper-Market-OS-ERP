import { describe, it, expect } from 'vitest';
import {
  createCatalogueSession, priceChangeDetails, priceChangeRequestBody, promotionLaunchBody, promotionLaunchDetails,
  sameDetails, presentAskOutcome, presentUseOutcome, useOutcomeOfRefusal,
  APPROVAL_COPY_KEYS, APPROVAL_REFUSAL_CODES, CATALOGUE_APPROVAL_COPY, PRICE_APPROVAL_KIND, PROMOTION_APPROVAL_KIND,
  type ApprovalAskOutcome, type ApprovalUseOutcome, type CatalogueConfig, type CataloguePorts,
  type PriceChangeBody, type PriceChangeCloudOutcome, type PriceChangeCloudPort,
  type PromotionLaunchInput, type PromotionLaunchOutcome, type PromotionLaunchPort, type PromotionSimulationInput,
} from '../../apps/web-erp/src/catalogue-session';
import type { ApprovalAsk, ApprovalRequestView, AskResult, InboxRead } from '../../apps/web-erp/src/approvals-session';
import { bootCatalogue, catalogueGaps, openPriceChangePort, openPromotionLaunchPort, CATALOGUE_GAPS } from '../../apps/web-erp/src/browser-entry';
import { actionDetails, fingerprintOf, takeApproval, type ApprovalState } from '../../services/identity/src/approval-requests';
import type { Category, ProductRecord } from '../../packages/product/src/index';
import { money } from '../../packages/contracts/src/money';

/**
 * **A loss-making price, or an offer that loses margin, needs a second person's OWN approval (ADR-0024 · §28 ·
 * M05-FR-02/03/04 · audit PA-03).**
 *
 * The Products & prices screen used to open a panel where the person setting the price PICKED an approver's name
 * and typed a reason, and sent that name as the approval. A name in a box is not an approval. Now:
 *
 *   1. the setter presses **Ask for approval** with a reason — head office's engine records a request for EXACTLY the
 *      change the screen will send (the same function builds both), in the setter's own session;
 *   2. a different person who may approve prices approves or rejects it on their Approvals page;
 *   3. **Save it** / **Start this offer** sends the change naming the setter's own APPROVED request for exactly those
 *      details — and when it is not approved yet, rejected, expired, used, or the figures changed, says so in plain
 *      words (English and Tamil) and sends nothing.
 *
 * A change that needs no approval goes straight through as before; with no head office behind the page, a change
 * that needs one is refused in plain words and nothing is saved.
 */

const TODAY = '2026-10-07';

const CATEGORIES: Category[] = [
  { categoryId: 'grocery', name: 'Grocery', parentId: null, attributes: [{ key: 'packSize', label: 'a pack size', type: 'text', required: true }] },
];

const DAL: ProductRecord = {
  productId: 'p1', tenantId: 't1', sku: 'SKU-1', name: 'Toor dal 1kg', brand: 'Aachi',
  primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '0713',
  attributes: { packSize: '1kg' },
  mrpHistory: [{ value: money(160_00, 'INR'), effectiveFrom: '2026-01-01' }],
  lifecycle: 'active',
};

const CONFIG: CatalogueConfig = {
  tenantId: 't1', storeId: 'store-1', userId: 'u-manager', currency: 'INR', today: TODAY, marginFloorBps: 2000,
};

/** The figures the screen sends for "Toor dal to ₹90" — below the ₹100 cost. */
const BELOW_COST: PriceChangeBody = { productId: 'p1', priceMinor: 90_00, mrpMinor: 160_00, costMinor: 100_00, currency: 'INR', marginFloorBps: 2000 };

/** A margin-LOSING offer: ₹80 against a ₹100 cost. */
const LOSS_LEADER: PromotionSimulationInput = {
  promotionId: 'loss-leader', description: 'loss-leader',
  normalPrice: money(145_00, 'INR'), promoPrice: money(80_00, 'INR'), unitCost: money(100_00, 'INR'),
  baselineUnits: 100, expectedUnits: 400,
};
/** A margin-IMPROVING offer. */
const GOOD_OFFER: PromotionSimulationInput = { ...LOSS_LEADER, promotionId: 'pongal-dal', description: 'pongal-dal', promoPrice: money(130_00, 'INR'), expectedUnits: 200 };

/** A request as head office's inbox hands it back (JSON round-tripped, like the wire). */
const row = (over: Omit<Partial<ApprovalRequestView>, 'details'> & Pick<ApprovalRequestView, 'requestId'> & { readonly details: object }): ApprovalRequestView => ({
  kind: PRICE_APPROVAL_KIND, label: 'Set a price below cost or below the margin floor', subjectRef: 'p1', valueMinor: 90_00,
  summary: 'Price of Toor dal 1kg to ₹90.00 (below cost ₹100.00)', reason: 'clearing short-dated stock',
  requestedBy: 'u-manager', requestedAt: '2026-10-07T04:00:00.000Z', status: 'waiting',
  ...over,
  details: JSON.parse(JSON.stringify(over.details)) as Record<string, unknown>,
});

/** A stub head office: the approval engine (ask + inbox) and the two governed routes, recording what each was sent. */
function office(opts: {
  mine?: ApprovalRequestView[];
  inbox?: InboxRead;
  ask?: AskResult;
  price?: PriceChangeCloudOutcome;
  launch?: PromotionLaunchOutcome;
} = {}) {
  const asks: ApprovalAsk[] = [];
  const priceCalls: Parameters<PriceChangeCloudPort['post']>[0][] = [];
  const launchCalls: PromotionLaunchInput[] = [];
  let inboxReads = 0;
  const changePort: PriceChangeCloudPort = { post: async (input) => { priceCalls.push(input); return opts.price ?? { saved: true, verdict: 'below_cost', approvedBy: 'u-owner' }; } };
  const launchPort: PromotionLaunchPort = { post: async (input) => { launchCalls.push(input); return opts.launch ?? { launched: true, verdict: 'below_cost', approvedBy: 'u-owner' }; } };
  const ports: Partial<CataloguePorts> = {
    changePrice: () => changePort,
    launchPromotion: () => launchPort,
    askApproval: async (ask) => {
      asks.push(ask);
      return opts.ask ?? { result: 'asked', request: row({ requestId: 'areq-new', kind: ask.kind, subjectRef: ask.subjectRef, details: ask.details, valueMinor: ask.valueMinor, summary: ask.summary, reason: ask.reason }) };
    },
    approvalInbox: async () => { inboxReads += 1; return opts.inbox ?? { result: 'read', inbox: { waitingForMe: [], mine: opts.mine ?? [], asAt: null } }; },
  };
  return { ports, asks, priceCalls, launchCalls, inboxReads: () => inboxReads };
}

function ports(over: Partial<CataloguePorts> = {}): CataloguePorts {
  return {
    categories: () => CATEGORIES,
    products: () => [DAL],
    priceEntries: () => [],
    costOf: () => ({ known: true, cost: money(100_00, 'INR') }),
    barcodesInUse: () => [],
    promotions: () => [],
    shelfMap: () => null,
    ...over,
  };
}

const session = (over: Partial<CataloguePorts> = {}) => createCatalogueSession(CONFIG, ports(over));

// ── What the approval is FOR is exactly what the change sends ────────────────────────────────────────────────

describe('the details asked for are exactly what the route will fingerprint (ADR-0024 actionDetails)', () => {
  it('a price change: the six figures — the body less its approvalId — and nothing else', () => {
    expect(priceChangeDetails(BELOW_COST)).toEqual(BELOW_COST);
    const sent = JSON.parse(JSON.stringify(priceChangeRequestBody(BELOW_COST, 'areq-1'))) as unknown;
    expect(fingerprintOf(actionDetails(sent))).toBe(fingerprintOf(priceChangeDetails(BELOW_COST)));
    // A typed approver smuggled into a body is not part of what was approved (and the route refuses it by name).
    expect(actionDetails({ ...BELOW_COST, approval: { decidedBy: 'u-owner' } })).toEqual(priceChangeDetails(BELOW_COST));
  });

  it('an offer\'s launch: the simulation input plus the offer\'s id from the route\'s path', () => {
    const sent = JSON.parse(JSON.stringify(promotionLaunchBody({ input: LOSS_LEADER, approvalId: 'areq-2' }))) as unknown;
    expect(fingerprintOf(actionDetails(sent, { promotionId: 'loss-leader' }))).toBe(fingerprintOf(promotionLaunchDetails(LOSS_LEADER)));
    expect(promotionLaunchDetails(LOSS_LEADER)['promotionId']).toBe('loss-leader');
    expect(promotionLaunchDetails(LOSS_LEADER)).not.toHaveProperty('approvalId');
  });

  it('the same details compare equal whatever order their keys arrive in; any changed figure does not', () => {
    const reordered = { marginFloorBps: 2000, currency: 'INR', costMinor: 100_00, mrpMinor: 160_00, priceMinor: 90_00, productId: 'p1' };
    expect(sameDetails(reordered, priceChangeDetails(BELOW_COST))).toBe(true);
    expect(sameDetails({ ...reordered, priceMinor: 95_00 }, priceChangeDetails(BELOW_COST))).toBe(false);
    expect(sameDetails({ ...reordered, extra: 1 }, priceChangeDetails(BELOW_COST))).toBe(false);
  });

  it('end to end through the real browser ports: what the screen asked for, the real route accepts from what the screen sent', async () => {
    // The screen asks (recorded), a DIFFERENT person approves it, and the screen saves through the REAL port. The
    // engine's own `takeApproval` then judges the body that port actually put on the wire — and accepts it.
    const sentBodies: unknown[] = [];
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async (_url: string, init: { body?: string }) => {
      sentBodies.push(JSON.parse(init.body ?? '{}'));
      return { status: 201, json: async () => ({ productId: 'p1', priceMinor: 90_00, verdict: 'below_cost', approvedBy: 'u-owner' }) };
    }) as unknown as typeof fetch;
    try {
      let asked: ApprovalAsk | undefined;
      const s = createCatalogueSession(CONFIG, ports({
        changePrice: () => openPriceChangePort(),
        launchPromotion: () => openPromotionLaunchPort(),
        askApproval: async (ask) => { asked = ask; return { result: 'asked', request: row({ requestId: 'areq-1', details: ask.details }) }; },
        approvalInbox: async () => ({ result: 'read', inbox: { waitingForMe: [], mine: [row({ requestId: 'areq-1', details: asked!.details, status: 'approved', decidedBy: 'u-owner', decisionReason: 'fine' })], asAt: null } }),
      }));
      expect((await s.askPriceApproval('en', { productId: 'p1', priceMinor: 90_00, why: 'clearing short-dated stock' })).kind).toBe('asked');
      expect((await s.savePriceWithApproval({ productId: 'p1', priceMinor: 90_00 })).kind).toBe('done');

      const body = sentBodies[0] as Record<string, unknown>;
      expect(body['approvalId']).toBe('areq-1');
      const state: ApprovalState = {
        request: {
          requestId: 'areq-1', kind: asked!.kind, subjectRef: asked!.subjectRef, valueMinor: asked!.valueMinor,
          fingerprint: fingerprintOf(asked!.details), details: asked!.details, summary: asked!.summary, reason: asked!.reason,
          requestedBy: 'u-manager', requestedAt: '2026-10-07T04:00:00.000Z',
        },
        decision: { requestId: 'areq-1', decision: 'approved', decidedBy: 'u-owner', reason: 'fine', decidedAt: '2026-10-07T04:30:00.000Z', expiresAt: '2026-10-08T04:30:00.000Z' },
      };
      const decision = await takeApproval({
        state, kind: 'price_change', subjectRef: String(body['productId']), details: actionDetails(body),
        valueMinor: body['priceMinor'] as number, maker: 'u-manager', usedBy: 'price-change:p1', now: '2026-10-07T05:00:00.000Z',
        checkerHolds: () => true,
      });
      expect(decision.decidedBy).toBe('u-owner');
    } finally {
      if (originalFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
      else (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
  });
});

// ── Asking ────────────────────────────────────────────────────────────────────────────────────────────────

describe('Ask for approval — the setter\'s own request, for exactly this change; nothing is saved', () => {
  it('a below-cost price: kind price_change, about the product, exactly the six figures, the new price, a plain summary and why', async () => {
    const o = office();
    const outcome = await session(o.ports).askPriceApproval('en', { productId: 'p1', priceMinor: 90_00, why: '  clearing short-dated stock  ' });
    expect(outcome.kind).toBe('asked');
    expect(o.asks).toEqual([{
      kind: 'price_change', subjectRef: 'p1', details: BELOW_COST, valueMinor: 90_00,
      summary: 'Price of Toor dal 1kg to ₹90.00 (below cost ₹100.00)', reason: 'clearing short-dated stock',
    }]);
    // Asking saves nothing.
    expect(o.priceCalls).toEqual([]);
    expect(o.asks[0]).not.toHaveProperty('approvedBy');
  });

  it('a below-floor (not below-cost) price says so, and the summary is in the reader\'s language', async () => {
    const o = office();
    await session(o.ports).askPriceApproval('en', { productId: 'p1', priceMinor: 110_00, why: 'matching the shop next door' });
    expect(o.asks[0]?.summary).toBe('Price of Toor dal 1kg to ₹110.00 (below the margin floor; cost ₹100.00)');
    await session(o.ports).askPriceApproval('ta', { productId: 'p1', priceMinor: 90_00, why: 'clearing short-dated stock' });
    expect(o.asks[1]?.summary).toBe('Toor dal 1kg விலையை ₹90.00 ஆக்குதல் (அடக்க விலை ₹100.00-ஐ விடக் குறைவு)');
  });

  it('a margin-losing offer: kind promotion_launch, about the offer, exactly the launch body plus its id, no amount', async () => {
    const o = office();
    const outcome = await session(o.ports).askLaunchApproval('en', { input: LOSS_LEADER, why: 'footfall driver for Pongal weekend' });
    expect(outcome.kind).toBe('asked');
    expect(o.asks).toHaveLength(1);
    expect(o.asks[0]).toMatchObject({ kind: 'promotion_launch', subjectRef: 'loss-leader', valueMinor: null, reason: 'footfall driver for Pongal weekend' });
    expect(o.asks[0]?.details).toEqual({ ...LOSS_LEADER, promotionId: 'loss-leader' });
    expect(o.asks[0]?.summary).toBe('Launch offer loss-leader — loses margin (₹80.00 instead of ₹145.00; it costs us ₹100.00)');
    expect(o.launchCalls).toEqual([]);
  });

  it('refuses locally — nothing asked — without a reason someone can read', async () => {
    const o = office();
    for (const why of ['', '   ', 'cheap']) {
      expect(await session(o.ports).askPriceApproval('en', { productId: 'p1', priceMinor: 90_00, why })).toEqual({ kind: 'needs_why' });
      expect(await session(o.ports).askLaunchApproval('en', { input: LOSS_LEADER, why })).toEqual({ kind: 'needs_why' });
    }
    expect(o.asks).toEqual([]);
  });

  it('refuses locally — nothing asked — when the MRP or the cost is not known (the figures could not be checked)', async () => {
    const o = office();
    const noMrp = await session({ ...o.ports, products: () => [{ ...DAL, mrpHistory: [] }] }).askPriceApproval('en', { productId: 'p1', priceMinor: 90_00, why: 'clearing short-dated stock' });
    const noCost = await session({ ...o.ports, costOf: () => ({ known: false, why: 'never received' }) }).askPriceApproval('en', { productId: 'p1', priceMinor: 90_00, why: 'clearing short-dated stock' });
    expect(noMrp).toEqual({ kind: 'cannot_check', missing: 'mrp' });
    expect(noCost).toEqual({ kind: 'cannot_check', missing: 'cost' });
    expect(o.asks).toEqual([]);
  });

  it('says head office\'s own words when it refuses the ask, and "no connection" when there was no answer', async () => {
    const refused = office({ ask: { result: 'refused', code: 'not_permitted_for_this_approval', whatHappened: 'u-manager may not set a price below cost.' } });
    const r = await session(refused.ports).askPriceApproval('en', { productId: 'p1', priceMinor: 90_00, why: 'clearing short-dated stock' });
    expect(r).toEqual({ kind: 'refused', code: 'not_permitted_for_this_approval', whatHappened: 'u-manager may not set a price below cost.' });
    expect(presentAskOutcome('en', 'price', r).label).toBe('Not asked: u-manager may not set a price below cost.');
    const lost = office({ ask: { result: 'lost_link' } });
    const l = await session(lost.ports).askPriceApproval('en', { productId: 'p1', priceMinor: 90_00, why: 'clearing short-dated stock' });
    expect(presentAskOutcome('en', 'price', l).label).toBe('No connection — nothing was asked. Try again.');
  });

  it('says it is waiting for a second person who may approve prices, and that nothing is saved yet', async () => {
    const o = office();
    const asked = await session(o.ports).askPriceApproval('en', { productId: 'p1', priceMinor: 90_00, why: 'clearing short-dated stock' });
    const words = presentAskOutcome('en', 'price', asked);
    expect(words.label.startsWith('Asked. Waiting for a second person who may approve prices to approve it on the Approvals page.')).toBe(true);
    expect(words.label).toContain('Nothing is saved yet.');
    expect(words.label).toContain('Price of Toor dal 1kg to ₹90.00 (below cost ₹100.00)');
    expect(words.icon).toBe('…');
    expect(presentAskOutcome('ta', 'price', asked).label).toContain('கேட்கப்பட்டது.');
  });
});

// ── Saving / launching with the approval ───────────────────────────────────────────────────────────────────

describe('Save it — only with the setter\'s OWN APPROVED request for exactly these figures', () => {
  const save = async (mine: ApprovalRequestView[], over: Parameters<typeof office>[0] = {}) => {
    const o = office({ mine, ...over });
    const outcome = await session(o.ports).savePriceWithApproval({ productId: 'p1', priceMinor: 90_00 });
    return { o, outcome };
  };

  it('approved → sends the change naming that approval, and only the six figures with it', async () => {
    const { o, outcome } = await save([row({ requestId: 'areq-1', details: BELOW_COST, status: 'approved', decidedBy: 'u-owner', decisionReason: 'fine', expiresAt: '2026-10-08T04:00:00.000Z' })]);
    expect(outcome).toEqual({ kind: 'done', verdict: 'below_cost', approvedBy: 'u-owner' });
    expect(o.priceCalls).toEqual([{ ...BELOW_COST, approvalId: 'areq-1' }]);
    expect(o.priceCalls[0]).not.toHaveProperty('approval');
    expect(presentUseOutcome('en', 'price', outcome, '₹90.00').label).toBe('Price saved: ₹90.00. The approval has now been used — another change needs a new approval.');
  });

  it('uses the NEWEST approved request for exactly this, past an older rejection', async () => {
    const { o } = await save([
      row({ requestId: 'areq-1', details: BELOW_COST, status: 'rejected', decidedBy: 'u-owner', decisionReason: 'not yet', requestedAt: '2026-10-07T03:00:00.000Z' }),
      row({ requestId: 'areq-2', details: BELOW_COST, status: 'approved', decidedBy: 'u-owner', decisionReason: 'ok now', requestedAt: '2026-10-07T04:00:00.000Z' }),
    ]);
    expect(o.priceCalls[0]?.approvalId).toBe('areq-2');
  });

  it('nobody asked → says so, and sends nothing (another product\'s or another kind\'s request does not count)', async () => {
    const { o, outcome } = await save([
      row({ requestId: 'areq-1', subjectRef: 'p2', details: { ...BELOW_COST, productId: 'p2' }, status: 'approved', decidedBy: 'u-owner' }),
      row({ requestId: 'areq-2', kind: 'price_list_entry', details: BELOW_COST, status: 'approved', decidedBy: 'u-owner' }),
    ]);
    expect(outcome).toEqual({ kind: 'not_asked' });
    expect(o.priceCalls).toEqual([]);
  });

  it('still waiting → says so, and sends nothing', async () => {
    const { o, outcome } = await save([row({ requestId: 'areq-1', details: BELOW_COST })]);
    expect(outcome).toEqual({ kind: 'waiting' });
    expect(o.priceCalls).toEqual([]);
  });

  it('rejected → says who and why, and sends nothing', async () => {
    const { o, outcome } = await save([row({ requestId: 'areq-1', details: BELOW_COST, status: 'rejected', decidedBy: 'u-owner', decisionReason: 'dal is not short-dated' })]);
    expect(outcome).toEqual({ kind: 'rejected', decidedBy: 'u-owner', reason: 'dal is not short-dated' });
    expect(o.priceCalls).toEqual([]);
    expect(presentUseOutcome('en', 'price', outcome).label).toBe('Not saved — u-owner rejected it: “dal is not short-dated”. Change what they said and ask again.');
    expect(presentUseOutcome('ta', 'price', outcome).label).toBe('சேமிக்கப்படவில்லை — u-owner மறுத்தார்: “dal is not short-dated”. அவர் சொன்னதை மாற்றி மீண்டும் கேளுங்கள்.');
  });

  it('expired or already used → says so, and sends nothing', async () => {
    const expired = await save([row({ requestId: 'areq-1', details: BELOW_COST, status: 'expired', decidedBy: 'u-owner' })]);
    const used = await save([row({ requestId: 'areq-1', details: BELOW_COST, status: 'used', decidedBy: 'u-owner', usedBy: 'price-change:p1' })]);
    expect(expired.outcome).toEqual({ kind: 'expired' });
    expect(used.outcome).toEqual({ kind: 'used' });
    expect(expired.o.priceCalls).toEqual([]);
    expect(used.o.priceCalls).toEqual([]);
  });

  it('the figures changed since asking (another price, or the cost moved) → says so, and sends nothing', async () => {
    const otherPrice = await save([row({ requestId: 'areq-1', details: { ...BELOW_COST, priceMinor: 95_00 }, valueMinor: 95_00, status: 'approved', decidedBy: 'u-owner' })]);
    expect(otherPrice.outcome).toEqual({ kind: 'changed' });
    expect(otherPrice.o.priceCalls).toEqual([]);
    // The approved request names the old cost; the box now says the item costs ₹98, so this is not what was approved.
    const o = office({ mine: [row({ requestId: 'areq-1', details: BELOW_COST, status: 'approved', decidedBy: 'u-owner' })] });
    const movedCost = await session({ ...o.ports, costOf: () => ({ known: true, cost: money(98_00, 'INR') }) }).savePriceWithApproval({ productId: 'p1', priceMinor: 90_00 });
    expect(movedCost).toEqual({ kind: 'changed' });
    expect(o.priceCalls).toEqual([]);
  });

  it('a rejection for an earlier version still says who and why, even when the figures changed since', async () => {
    const { outcome } = await save([row({ requestId: 'areq-1', details: { ...BELOW_COST, priceMinor: 85_00 }, valueMinor: 85_00, status: 'rejected', decidedBy: 'u-owner', decisionReason: 'too low' })]);
    expect(outcome).toEqual({ kind: 'rejected', decidedBy: 'u-owner', reason: 'too low' });
  });

  it('cannot read the inbox → says so (no connection, or head office\'s words), and sends nothing', async () => {
    const lost = await save([], { inbox: { result: 'lost_link' } });
    expect(lost.outcome).toEqual({ kind: 'lost_link' });
    const refused = await save([], { inbox: { result: 'refused', code: 'not_permitted', whatHappened: 'Sign in again.' } });
    expect(refused.outcome).toEqual({ kind: 'refused', code: 'not_permitted', whatHappened: 'Sign in again.' });
    expect(lost.o.priceCalls).toEqual([]);
    expect(refused.o.priceCalls).toEqual([]);
  });

  it('every approval refusal head office can give comes back in the same plain words', async () => {
    const approved = [row({ requestId: 'areq-1', details: BELOW_COST, status: 'approved', decidedBy: 'u-owner' })];
    const expected: Record<(typeof APPROVAL_REFUSAL_CODES)[number], ApprovalUseOutcome['kind']> = {
      approval_unknown: 'not_asked', approval_does_not_match: 'changed', approval_still_waiting: 'waiting',
      approval_rejected: 'rejected', approval_expired: 'expired', approval_already_used: 'used',
      checker_may_not_approve: 'checker_may_not_approve', approver_named_without_approval: 'named_not_approved',
    };
    for (const code of APPROVAL_REFUSAL_CODES) {
      const { outcome } = await save(approved, { price: { saved: false, reason: 'head office said no', code } });
      expect(outcome.kind, code).toBe(expected[code]);
      for (const lang of ['en', 'ta'] as const) {
        const label = presentUseOutcome(lang, 'price', outcome).label;
        expect(label.length, `${code} has no ${lang} words`).toBeGreaterThan(20);
        expect(label, `${code} leaks its code in ${lang}`).not.toContain(code);
      }
    }
    // Rejected at the last moment: the engine's own sentence says who and why.
    const late = await save(approved, { price: { saved: false, reason: 'That request was rejected by u-owner: not today', code: 'approval_rejected' } });
    expect(presentUseOutcome('en', 'price', late.outcome).label).toBe('Not saved — it was rejected: That request was rejected by u-owner: not today Change what they said and ask again.');
    // A typed approver is refused by name — in plain words, not a code.
    const named = await save(approved, { price: { saved: false, reason: 'This names u-owner…', code: 'approver_named_without_approval' } });
    expect(presentUseOutcome('en', 'price', named.outcome).label).toBe('Not saved — naming a person is not their approval. Ask for approval, and wait for a second person to approve it on their Approvals page.');
    // Any other refusal (an above-MRP price, say) is head office's own words.
    const other = await save(approved, { price: { saved: false, reason: 'The price is above the printed MRP.', code: 'price_above_mrp' } });
    expect(presentUseOutcome('en', 'price', other.outcome).label).toBe('Not saved: The price is above the printed MRP.');
    const lost = await save(approved, { price: { saved: false, reason: 'no connection', code: 'lost_link' } });
    expect(lost.outcome).toEqual({ kind: 'lost_link' });
  });

  it('maps an unknown or missing code to head office\'s own words, never to silence', () => {
    expect(useOutcomeOfRefusal(undefined, 'head office did not change the price')).toEqual({ kind: 'refused', code: 'refused', whatHappened: 'head office did not change the price' });
    expect(presentUseOutcome('en', 'price', useOutcomeOfRefusal('x', '')).label).toBe('Not saved — head office refused it.');
  });
});

describe('Start this offer — only with the proposer\'s OWN APPROVED request for exactly this offer', () => {
  const approvedFor = (input: PromotionSimulationInput, over: Partial<ApprovalRequestView> = {}) => row({
    requestId: 'areq-9', kind: PROMOTION_APPROVAL_KIND, subjectRef: input.promotionId, valueMinor: null,
    details: promotionLaunchDetails(input), status: 'approved', decidedBy: 'u-owner', decisionReason: 'Pongal', ...over,
  });

  it('approved → launches naming that approval, with the simulation input and nothing else', async () => {
    const o = office({ mine: [approvedFor(LOSS_LEADER)] });
    const outcome = await session(o.ports).launchWithApproval(LOSS_LEADER);
    expect(outcome).toEqual({ kind: 'done', verdict: 'below_cost', approvedBy: 'u-owner' });
    expect(o.launchCalls).toEqual([{ input: LOSS_LEADER, approvalId: 'areq-9' }]);
    expect(presentUseOutcome('en', 'offer', outcome, 'loss-leader').label).toBe('Offer started: loss-leader. The approval has now been used — another launch needs a new approval.');
  });

  it('waiting, rejected, or the offer changed since asking → says so, and launches nothing', async () => {
    const waiting = office({ mine: [approvedFor(LOSS_LEADER, { status: 'waiting', decidedBy: undefined })] });
    expect(await session(waiting.ports).launchWithApproval(LOSS_LEADER)).toEqual({ kind: 'waiting' });
    const rejected = office({ mine: [approvedFor(LOSS_LEADER, { status: 'rejected', decisionReason: 'too deep a cut' })] });
    const r = await session(rejected.ports).launchWithApproval(LOSS_LEADER);
    expect(presentUseOutcome('en', 'offer', r).label).toBe('Not started — u-owner rejected it: “too deep a cut”. Change what they said and ask again.');
    expect(presentUseOutcome('ta', 'offer', r).label.startsWith('தொடங்கப்படவில்லை — u-owner மறுத்தார்')).toBe(true);
    const changed = office({ mine: [approvedFor(LOSS_LEADER)] });
    expect(await session(changed.ports).launchWithApproval({ ...LOSS_LEADER, promoPrice: money(75_00, 'INR') })).toEqual({ kind: 'changed' });
    expect([...waiting.launchCalls, ...rejected.launchCalls, ...changed.launchCalls]).toEqual([]);
  });
});

// ── No approval needed: unchanged ──────────────────────────────────────────────────────────────────────────

describe('a price or an offer that needs NO approval goes straight through, as before', () => {
  it('a clean price is sent with the six figures and no approval; the engine is never asked', async () => {
    const o = office({ price: { saved: true, verdict: 'ok', approvedBy: null } });
    const s = session(o.ports);
    expect(s.proposePrice({ id: 'pc', productId: 'p1', priceMinor: 150_00, effectiveFrom: TODAY }).cleanToActivate).toBe(true);
    expect(await s.changePriceInCloud({ productId: 'p1', priceMinor: 150_00 })).toEqual({ saved: true, verdict: 'ok', approvedBy: null });
    expect(o.priceCalls).toEqual([{ productId: 'p1', priceMinor: 150_00, mrpMinor: 160_00, costMinor: 100_00, currency: 'INR', marginFloorBps: 2000 }]);
    expect(o.asks).toEqual([]);
    expect(o.inboxReads()).toBe(0);
  });

  it('a margin-improving offer launches with its input alone; the engine is never asked', async () => {
    const o = office({ launch: { launched: true, verdict: 'improves_margin', approvedBy: null } });
    const s = session(o.ports);
    expect(s.simulate(GOOD_OFFER).blocksApproval).toBe(false);
    expect(await s.launchToCloud({ input: GOOD_OFFER })).toEqual({ launched: true, verdict: 'improves_margin', approvedBy: null });
    expect(o.launchCalls).toEqual([{ input: GOOD_OFFER }]);
    expect(o.asks).toEqual([]);
    expect(o.inboxReads()).toBe(0);
  });
});

// ── Not connected to head office ───────────────────────────────────────────────────────────────────────────

describe('with no head office behind the page, nothing that needs approval is saved — and it says so', () => {
  it('cannot ask, cannot save, cannot launch — and never calls the change or launch route', async () => {
    const priceCalls: unknown[] = [];
    const launchCalls: unknown[] = [];
    // Even with the change routes wired, there is no approval engine: nothing that needs a second person moves.
    const s = session({
      changePrice: () => ({ post: async (i) => { priceCalls.push(i); return { saved: true, verdict: 'x', approvedBy: null }; } }),
      launchPromotion: () => ({ post: async (i) => { launchCalls.push(i); return { launched: true, verdict: 'x', approvedBy: null }; } }),
    });
    expect(s.canAskForApproval).toBe(false);
    const asks: ApprovalAskOutcome[] = [
      await s.askPriceApproval('en', { productId: 'p1', priceMinor: 90_00, why: 'clearing short-dated stock' }),
      await s.askLaunchApproval('en', { input: LOSS_LEADER, why: 'footfall driver for Pongal' }),
    ];
    const uses: ApprovalUseOutcome[] = [
      await s.savePriceWithApproval({ productId: 'p1', priceMinor: 90_00 }),
      await s.launchWithApproval(LOSS_LEADER),
    ];
    for (const o of [...asks, ...uses]) expect(o).toEqual({ kind: 'not_connected' });
    expect(priceCalls).toEqual([]);
    expect(launchCalls).toEqual([]);
    expect(presentUseOutcome('en', 'price', uses[0]!).label).toBe('Not saved — this price needs a second person’s approval at head office, and this screen is not connected to head office. Nothing was saved.');
    expect(presentUseOutcome('ta', 'price', uses[0]!).label).toContain('எதுவும் சேமிக்கப்படவில்லை');
    expect(presentUseOutcome('en', 'offer', uses[1]!).label).toContain('this offer needs a second person’s approval at head office');
  });

  it('the local activation refuses a below-floor price when no approval is handed to it — and the screen never hands one', () => {
    const s = session();
    const proposal = s.proposePrice({ id: 'pc', productId: 'p1', priceMinor: 110_00, effectiveFrom: TODAY });
    expect(proposal.needsApproval).toBe(true);
    const outcome = s.activatePrice(proposal);
    expect(outcome.ok).toBe(false);
    expect(s.launch(s.simulate(LOSS_LEADER)).ok).toBe(false);
  });

  it('the box wires the engine: with it the screen can ask; without it, it cannot', () => {
    const data = { userId: 'u-manager', today: TODAY, marginFloorBps: 2000, products: [DAL], costsMinor: { p1: 100_00 } };
    const engine = { askApproval: async () => ({ result: 'lost_link' as const }), approvalInbox: async () => ({ result: 'lost_link' as const }) };
    expect(bootCatalogue(data as never, undefined, openPromotionLaunchPort(), openPriceChangePort(), engine)!.canAskForApproval).toBe(true);
    expect(bootCatalogue(data as never, undefined, openPromotionLaunchPort(), openPriceChangePort())!.canAskForApproval).toBe(false);
  });

  it('no longer reports "who may approve" as something the box failed to tell it — nobody is named here any more', () => {
    expect(CATALOGUE_GAPS as readonly string[]).not.toContain('who_may_approve');
    expect(catalogueGaps({ products: [], categories: [], costsMinor: {}, priceEntries: [], barcodes: [], shelfLocations: [], zoneOrder: [] })).toEqual([]);
  });
});

// ── Every word, in both languages ──────────────────────────────────────────────────────────────────────────

describe('every outcome is said in plain words, in English and in Tamil', () => {
  const asks: ApprovalAskOutcome[] = [
    { kind: 'asked', request: row({ requestId: 'areq-1', details: BELOW_COST }) }, { kind: 'needs_why' }, { kind: 'not_connected' },
    { kind: 'cannot_check', missing: 'mrp' }, { kind: 'cannot_check', missing: 'cost' },
    { kind: 'refused', code: 'x', whatHappened: 'words' }, { kind: 'refused', code: 'x', whatHappened: '' }, { kind: 'lost_link' },
  ];
  const uses: ApprovalUseOutcome[] = [
    { kind: 'done', verdict: 'below_cost', approvedBy: 'u-owner' }, { kind: 'not_connected' }, { kind: 'cannot_check', missing: 'mrp' },
    { kind: 'not_asked' }, { kind: 'waiting' }, { kind: 'rejected', decidedBy: 'u-owner', reason: 'why' },
    { kind: 'rejected', decidedBy: null, reason: 'why' }, { kind: 'expired' }, { kind: 'used' }, { kind: 'changed' },
    { kind: 'checker_may_not_approve' }, { kind: 'named_not_approved' }, { kind: 'refused', code: 'x', whatHappened: 'words' },
    { kind: 'lost_link' },
  ];

  it('has every key in both languages, and the Tamil is Tamil', () => {
    for (const key of APPROVAL_COPY_KEYS) {
      expect(CATALOGUE_APPROVAL_COPY.ta[key], `${key} has no Tamil`).toBeTruthy();
      // A template that is only placeholders and punctuation ("{not}: {words}") is the same in both languages.
      if (!/[A-Za-z]/.test(CATALOGUE_APPROVAL_COPY.en[key].replace(/\{\w+\}/g, ''))) continue;
      expect(CATALOGUE_APPROVAL_COPY.ta[key], `${key} is English in the Tamil table`).not.toBe(CATALOGUE_APPROVAL_COPY.en[key]);
      expect(/[஀-௿]/.test(CATALOGUE_APPROVAL_COPY.ta[key]), `${key} has no Tamil letters`).toBe(true);
    }
  });

  it('says every outcome in each language, with words and an icon, never a placeholder left unfilled', () => {
    for (const subject of ['price', 'offer'] as const) {
      for (const lang of ['en', 'ta'] as const) {
        for (const o of asks) {
          const p = presentAskOutcome(lang, subject, o);
          expect(p.label.length, `${o.kind}`).toBeGreaterThan(10);
          expect(p.icon).not.toBe('');
          expect(p.label).not.toMatch(/\{\w+\}/);
        }
        for (const o of uses) {
          const p = presentUseOutcome(lang, subject, o, subject === 'price' ? '₹90.00' : 'loss-leader');
          expect(p.label.length, `${o.kind}`).toBeGreaterThan(10);
          expect(p.icon).not.toBe('');
          expect(p.label, `${subject}/${lang}/${o.kind}`).not.toMatch(/\{\w+\}/);
        }
      }
    }
  });

  it('a waiting state reads as waiting (a person must come back to it), a saved one as done, a refusal as needing attention', () => {
    expect(presentUseOutcome('en', 'price', { kind: 'waiting' }).icon).toBe('…');
    expect(presentUseOutcome('en', 'price', { kind: 'done', verdict: 'x', approvedBy: 'u-owner' }, '₹90.00').tone).toBe('ok');
    expect(presentUseOutcome('en', 'price', { kind: 'rejected', decidedBy: 'u-owner', reason: 'no' }).tone).toBe('error');
    expect(presentUseOutcome('en', 'price', { kind: 'not_asked' }).needsAttention).toBe(true);
  });
});
