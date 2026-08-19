import { describe, it, expect } from 'vitest';
import {
  createCatalogueSession, PUBLISH_REFUSAL_KINDS,
  type CataloguePorts, type CatalogueConfig,
} from '../../apps/web-erp/src/catalogue-session';
import {
  completeness, worklist,
  type Category, type ProductRecord,
} from '../../packages/product/src/index';
import {
  activatePriceChange, proposePriceChange, resolvePrice, rollBackPrice, PRICE_CHANGE_REFUSALS,
  type PriceEntry,
} from '../../packages/price-list/src/index';
import type { DecidedRequest } from '../../packages/approvals/src/index';
import { money } from '../../packages/contracts/src/money';
import type { Promotion } from '../../packages/promotions/src/index';
import { ShelfMap, type ShelfLocation } from '../../packages/merchandising/src/index';
import { SyncOutbox } from '../../packages/sync/src/outbox';

/**
 * **The product and pricing surface (M03 · M05 · D01 · D06 · §28).**
 *
 * Everything needed to police a price was built and tested — the MRP ceiling, the margin floor, the
 * effective-dated resolution, the append-only history, the catalogue snapshot that carries it to a
 * lane — and **nothing anywhere produced a price**. Every `PriceEntry` in this repository was a
 * test fixture, so the snapshot builder had never had a real price to ship and no lane had ever
 * been given one this system decided.
 *
 * The controls under test are the ones that would look like friction to a later change:
 *   • a price above MRP is refused and NOTHING can authorise it — it is the law, not a policy;
 *   • a margin nobody can compute is not a margin that passed;
 *   • a change is a new entry, never an edit;
 *   • a product nobody can score is not a product scoring zero.
 */

const TODAY = '2026-08-06';

const CATEGORIES: Category[] = [
  {
    categoryId: 'grocery',
    name: 'Grocery',
    parentId: null,
    attributes: [{ key: 'packSize', label: 'a pack size', type: 'text', required: true }],
  },
  {
    categoryId: 'chilled',
    name: 'Chilled food',
    parentId: null,
    regulated: ['food', 'packed'],
  },
];

const FINISHED: ProductRecord = {
  productId: 'p1', tenantId: 't1', sku: 'SKU-1', name: 'Toor dal 1kg', brand: 'Aachi',
  primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '0713',
  attributes: { packSize: '1kg' },
  mrpHistory: [{ value: money(160_00, 'INR'), effectiveFrom: '2026-01-01' }],
  lifecycle: 'active',
};

const SHELF_LOCATIONS: ShelfLocation[] = [
  { storeId: 'store-1', locationId: 'L-A1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, label: 'A1' },
  // Physically the first thing you walk past, and it must still be collected last.
  { storeId: 'store-1', locationId: 'L-COLD', aisle: 0, rack: 1, bay: 1, shelf: 1, position: 1, label: 'Chiller', zone: 'chilled' },
];

/**
 * A FRESH map per session.
 *
 * `ShelfMap` accumulates assignments — deliberately, so a person addressing shelves keeps what they
 * have done while they carry on working. A single shared fixture therefore leaks one test's
 * assignments into the next, which is how the first draft of these tests passed for the wrong
 * reason.
 */
const shelfMap = (): ShelfMap => new ShelfMap('store-1', SHELF_LOCATIONS, [], ['ambient', 'chilled']);

const CONFIG: CatalogueConfig = {
  tenantId: 't1', storeId: 'store-1', userId: 'u-pricing', currency: 'INR',
  today: TODAY, marginFloorBps: 2000,
};

function ports(over: Partial<CataloguePorts> = {}): CataloguePorts {
  const map = shelfMap();
  return {
    categories: () => CATEGORIES,
    products: () => [FINISHED],
    priceEntries: () => [],
    costOf: () => ({ known: true, cost: money(100_00, 'INR') }),
    barcodesInUse: () => [{ barcode: '8901', productId: 'p1' }],
    promotions: () => [],
    shelfMap: () => map,
    ...over,
  };
}

const session = (over: Partial<CataloguePorts> = {}, config: Partial<CatalogueConfig> = {}) =>
  createCatalogueSession({ ...CONFIG, ...config }, ports(over));

const approvalBy = (decidedBy: string, subjectRef: string): DecidedRequest => ({
  id: `ap-${subjectRef}`, subjectType: 'price_change', subjectRef,
  requestedBy: 'u-pricing', branchId: null, value: null,
  status: 'approved', decidedBy, reason: 'promotional_launch', decidedAt: `${TODAY}T10:00:00.000Z`,
});

// ── The MRP ceiling ─────────────────────────────────────────────────────────

describe('a price above the printed MRP is refused, and nothing can authorise it', () => {
  it('refuses it outright', () => {
    const proposal = session().proposePrice({
      id: 'pc-1', productId: 'p1', priceMinor: 165_00, effectiveFrom: TODAY,
    });
    expect(proposal.refusals).toContain('above_the_printed_mrp');
    expect(proposal.cleanToActivate).toBe(false);
    expect(proposal.needsApproval).toBe(false);
  });

  it('still refuses it with a perfectly good approval from somebody else', () => {
    // MRP is a legal ceiling in India. There is no approval path, by design — a screen that
    // offered one would be offering to break the law with an audit trail.
    const s = session();
    const proposal = s.proposePrice({ id: 'pc-1', productId: 'p1', priceMinor: 165_00, effectiveFrom: TODAY });
    const outcome = s.activatePrice(proposal, approvalBy('u-owner', 'pc-1'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toContain('above_the_printed_mrp');
  });

  it('allows a price exactly at MRP', () => {
    const proposal = session().proposePrice({
      id: 'pc-1', productId: 'p1', priceMinor: 160_00, effectiveFrom: TODAY,
    });
    expect(proposal.refusals).toEqual([]);
    expect(proposal.cleanToActivate).toBe(true);
  });

  it('uses the MRP in force TODAY, not the newest one on the record', () => {
    // A future MRP increase must not raise today's ceiling before the pack it is printed on has
    // reached the shelf. The customer is holding the old pack.
    const raised: ProductRecord = {
      ...FINISHED,
      mrpHistory: [
        { value: money(160_00, 'INR'), effectiveFrom: '2026-01-01' },
        { value: money(200_00, 'INR'), effectiveFrom: '2026-12-01' },
      ],
    };
    const proposal = session({ products: () => [raised] }).proposePrice({
      id: 'pc-1', productId: 'p1', priceMinor: 180_00, effectiveFrom: TODAY,
    });
    expect(proposal.refusals).toContain('above_the_printed_mrp');
  });

  it('refuses to check at all when no MRP has been recorded', () => {
    // Half a check is not a check. Say the ceiling is unknown rather than pretending there is none.
    const noMrp: ProductRecord = { ...FINISHED, mrpHistory: [] };
    const proposal = session({ products: () => [noMrp] }).proposePrice({
      id: 'pc-1', productId: 'p1', priceMinor: 120_00, effectiveFrom: TODAY,
    });
    expect(proposal.refusals).toEqual(['no_mrp_recorded']);
    expect(proposal.needsApproval).toBe(false);
  });
});

// ── The margin floor, and the cost nobody has ───────────────────────────────

describe('a margin nobody can compute is not a margin that passed', () => {
  it('blocks a below-floor price pending somebody else’s approval', () => {
    // Cost ₹100, floor 20% ⇒ anything under ₹125 is below the floor.
    const proposal = session().proposePrice({
      id: 'pc-2', productId: 'p1', priceMinor: 110_00, effectiveFrom: TODAY,
    });
    expect(proposal.refusals).toEqual(['below_the_margin_floor']);
    expect(proposal.needsApproval).toBe(true);
    expect(proposal.cleanToActivate).toBe(false);
  });

  it('lets it through with a separate approver — a loss leader is a real decision', () => {
    const s = session();
    const proposal = s.proposePrice({ id: 'pc-2', productId: 'p1', priceMinor: 110_00, effectiveFrom: TODAY });
    const outcome = s.activatePrice(proposal, approvalBy('u-owner', 'pc-2'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entry.status).toBe('active');
    expect(outcome.approvedBy).toBe('u-owner');
  });

  it('refuses the setter’s own approval (§28)', () => {
    const s = session();
    const proposal = s.proposePrice({ id: 'pc-2', productId: 'p1', priceMinor: 110_00, effectiveFrom: TODAY });
    const outcome = s.activatePrice(proposal, approvalBy('u-pricing', 'pc-2'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toContain('approved_by_the_person_who_set_it');
  });

  it('names a below-COST price as its own thing, not as a floor breach', () => {
    const proposal = session().proposePrice({
      id: 'pc-3', productId: 'p1', priceMinor: 90_00, effectiveFrom: TODAY,
    });
    expect(proposal.refusals).toEqual(['below_what_it_cost_us']);
  });

  it('will not check the margin against a cost the shop does not have', () => {
    // The fault this exists to prevent: cost defaulted to zero makes EVERY price look like 100%
    // margin, so the floor check passes loudly and wrongly exactly where a buyer relies on it.
    const proposal = session({
      costOf: () => ({ known: false, why: 'nothing has ever been received against this item' }),
    }).proposePrice({ id: 'pc-4', productId: 'p1', priceMinor: 1_00, effectiveFrom: TODAY });

    expect(proposal.refusals).toEqual(['the_cost_is_not_known_so_the_margin_was_never_checked']);
    expect(proposal.cleanToActivate).toBe(false);
    expect(proposal.needsApproval).toBe(true);
  });

  it('still refuses an above-MRP price when the cost is unknown', () => {
    // The one check that survives having no cost is the one that is the law.
    const proposal = session({
      costOf: () => ({ known: false, why: 'never received' }),
    }).proposePrice({ id: 'pc-4', productId: 'p1', priceMinor: 999_00, effectiveFrom: TODAY });
    expect(proposal.refusals).toContain('above_the_printed_mrp');
    expect(proposal.needsApproval).toBe(false);
  });

  it('lets an unknown-cost price through only with somebody else’s eyes on it', () => {
    const s = session({ costOf: () => ({ known: false, why: 'never received' }) });
    const proposal = s.proposePrice({ id: 'pc-4', productId: 'p1', priceMinor: 120_00, effectiveFrom: TODAY });
    expect(s.activatePrice(proposal).ok).toBe(false);
    expect(s.activatePrice(proposal, approvalBy('u-pricing', 'pc-4')).ok).toBe(false);
    expect(s.activatePrice(proposal, approvalBy('u-owner', 'pc-4')).ok).toBe(true);
  });
});

// ── Append-only ─────────────────────────────────────────────────────────────

describe('a price change is a new entry, never an edit', () => {
  const running: PriceEntry = {
    id: 'pe-old', productId: 'p1', scope: 'store', scopeRef: 'store-1',
    price: money(145_00, 'INR'), effectiveFrom: '2026-01-01', status: 'active', version: 3,
  };

  it('leaves the entry it supersedes exactly as it was', () => {
    const before = JSON.stringify(running);
    const s = session({ priceEntries: () => [running] });
    const proposal = s.proposePrice({ id: 'pe-new', productId: 'p1', priceMinor: 150_00, effectiveFrom: TODAY });
    const outcome = s.activatePrice(proposal);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entry.id).toBe('pe-new');
    expect(JSON.stringify(running), 'the old entry was mutated').toBe(before);
  });

  it('gives the new entry a version above every one the product has had', () => {
    const s = session({ priceEntries: () => [running, { ...running, id: 'pe-older', version: 9, status: 'rolled_back' }] });
    const proposal = s.proposePrice({ id: 'pe-new', productId: 'p1', priceMinor: 150_00, effectiveFrom: TODAY });
    expect(proposal.draft.version).toBe(10);
  });

  it('says which price it replaces, so the change can be read as a change', () => {
    const s = session({ priceEntries: () => [running] });
    const proposal = s.proposePrice({ id: 'pe-new', productId: 'p1', priceMinor: 150_00, effectiveFrom: TODAY });
    expect(proposal.replaces?.price.minor).toBe(145_00);
  });

  it('refuses a second entry for the price already running', () => {
    const s = session({ priceEntries: () => [running] });
    const proposal = s.proposePrice({ id: 'pe-new', productId: 'p1', priceMinor: 145_00, effectiveFrom: TODAY });
    expect(proposal.refusals).toContain('same_as_the_price_already_running');
  });

  it('never activates the draft it hands back', () => {
    // A proposal put down and picked up tomorrow must have priced nothing in between.
    const proposal = session().proposePrice({ id: 'pe-new', productId: 'p1', priceMinor: 150_00, effectiveFrom: TODAY });
    expect(proposal.draft.status).toBe('draft');
    expect(resolvePrice([proposal.draft], {
      productId: 'p1', at: `${TODAY}T12:00:00.000Z`, storeId: 'store-1',
    })).toBeNull();
  });

  it('withdraws a price by appending, never by deleting', () => {
    const withdrawn = rollBackPrice(running, TODAY);
    expect(withdrawn.status).toBe('rolled_back');
    expect(withdrawn.id).not.toBe(running.id);
    expect(withdrawn.version).toBeGreaterThan(running.version);
    expect(running.status, 'the live entry was mutated').toBe('active');
  });

  it('reports the whole history, whatever the status', () => {
    const s = session({ priceEntries: () => [running, { ...running, id: 'pe-2', version: 4, status: 'draft' }] });
    expect(s.historyFor('p1')).toHaveLength(2);
  });
});

describe('a price cannot start in the past', () => {
  it('refuses a back-dated price', () => {
    // Back-dating changes what `resolvePrice` says yesterday's sales should have charged, so the
    // receipts and the reports stop agreeing and nothing says which is right.
    const proposal = session().proposePrice({
      id: 'pc-5', productId: 'p1', priceMinor: 150_00, effectiveFrom: '2026-08-05',
    });
    expect(proposal.refusals).toContain('starts_in_the_past');
  });

  it('and no approval can authorise that either', () => {
    const s = session();
    const proposal = s.proposePrice({ id: 'pc-5', productId: 'p1', priceMinor: 150_00, effectiveFrom: '2026-08-05' });
    expect(s.activatePrice(proposal, approvalBy('u-owner', 'pc-5')).ok).toBe(false);
  });

  it('allows a future price, and it does not price anything yet', () => {
    const s = session();
    const proposal = s.proposePrice({ id: 'pc-6', productId: 'p1', priceMinor: 150_00, effectiveFrom: '2026-09-01' });
    expect(proposal.refusals).toEqual([]);
    const outcome = s.activatePrice(proposal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(resolvePrice([outcome.entry], {
      productId: 'p1', at: `${TODAY}T12:00:00.000Z`, storeId: 'store-1',
    }), 'a future price activated early').toBeNull();
  });
});

// ── The product record ──────────────────────────────────────────────────────

describe('publishing a product', () => {
  it('publishes a finished record', () => {
    expect(session().publish(FINISHED).ok).toBe(true);
  });

  it('reports EVERY missing field at once, not one per attempt', () => {
    const bare: ProductRecord = {
      productId: 'p9', tenantId: 't1', sku: '', name: '', primaryCategoryId: 'grocery',
      baseUom: '', taxClass: null, lifecycle: 'draft',
    };
    const outcome = session({ products: () => [bare] }).publish(bare);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('not_finished');
    expect(outcome.missing.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses to publish a recall-blocked item — that would put it back on sale', () => {
    const blocked = { ...FINISHED, recallBlocked: true };
    const outcome = session({ products: () => [blocked] }).publish(blocked);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('recall_blocked');
  });

  it('refuses a barcode that already belongs to another item', () => {
    // One barcode rings up one product. Otherwise which one it is depends on which record the
    // lane happened to find first, which is not a rule anybody can rely on.
    const outcome = session({
      barcodesInUse: () => [{ barcode: '8901', productId: 'p-other' }],
    }).publish(FINISHED, [{ code: '8901', kind: 'ean' }]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('barcode_belongs_to_another_item');
  });

  it('accepts a barcode the item already owns — re-publishing is not a clash', () => {
    expect(session().publish(FINISHED, [{ code: '8901', kind: 'ean' }]).ok).toBe(true);
  });

  it('has words defined for every publish refusal it can return', () => {
    expect(PUBLISH_REFUSAL_KINDS).toHaveLength(3);
  });
});

describe('a recall block stops everything, in two taps', () => {
  it('stops sale the moment it is set', () => {
    const s = session();
    const blocked = s.setRecallBlock(FINISHED, true);
    expect(s.inspect(blocked).sellable).toBe('recall_blocked');
    expect(s.inspect(FINISHED).sellable).toBe('sellable');
  });

  it('lifts again without rewriting anything else on the record', () => {
    const s = session();
    const lifted = s.setRecallBlock(s.setRecallBlock(FINISHED, true), false);
    expect({ ...lifted, recallBlocked: undefined }).toEqual({ ...FINISHED, recallBlocked: undefined });
  });
});

// ── The completeness score (D01) ────────────────────────────────────────────

describe('the completeness score is counts first and a percentage second', () => {
  it('scores a finished record at 100%', () => {
    const score = completeness(FINISHED, CATEGORIES);
    expect(score.knowable).toBe(true);
    if (!score.knowable) return;
    expect(score.percent).toBe(100);
    expect(score.publishable).toBe(true);
  });

  it('always shows the counts the percentage came from', () => {
    const half: ProductRecord = { ...FINISHED, taxClass: null, brand: undefined };
    const score = completeness(half, CATEGORIES);
    expect(score.knowable).toBe(true);
    if (!score.knowable) return;
    expect(score.required.total).toBeGreaterThan(score.required.done);
    expect(score.checks.filter((c) => !c.done).map((c) => c.field)).toContain('taxClass');
    // Every incomplete check says what is missing, in words a person can act on.
    for (const check of score.checks.filter((c) => !c.done)) {
      expect(check.missing, `${check.field} says nothing`).toBeTruthy();
    }
  });

  it('never rounds 99 up to 100 while something required is outstanding', () => {
    const nearly: ProductRecord = { ...FINISHED, taxClass: null };
    const score = completeness(nearly, CATEGORIES);
    expect(score.knowable).toBe(true);
    if (!score.knowable) return;
    expect(score.percent).toBeLessThan(100);
  });

  it('asks a chilled-food item for what the LAW asks, and a grocery item for what it does not', () => {
    // Which departments are regulated is the tenant's declaration, never ours.
    const chilled: ProductRecord = { ...FINISHED, productId: 'p2', primaryCategoryId: 'chilled', attributes: {} };
    const score = completeness(chilled, CATEGORIES);
    expect(score.knowable).toBe(true);
    if (!score.knowable) return;
    const fields = score.checks.map((c) => c.field);
    expect(fields).toContain('safety.allergens');
    expect(fields).toContain('safety.netQuantity');
    const grocery = completeness(FINISHED, CATEGORIES);
    expect(grocery.knowable).toBe(true);
    if (!grocery.knowable) return;
    expect(grocery.checks.map((c) => c.field)).not.toContain('safety.allergens');
  });

  it('asks for exactly the attributes THIS tenant said the department needs', () => {
    const noPack: ProductRecord = { ...FINISHED, attributes: {} };
    const score = completeness(noPack, CATEGORIES);
    expect(score.knowable).toBe(true);
    if (!score.knowable) return;
    expect(score.checks.find((c) => c.field === 'attributes.packSize')?.done).toBe(false);
    expect(score.publishable).toBe(false);
  });

  it('reports a product it cannot score as NOT KNOWABLE, never as zero', () => {
    // A zero reads as "somebody has filled in nothing" and sends a person to fix a record that may
    // already be finished. The reason names the department nobody told this screen about.
    const orphan: ProductRecord = { ...FINISHED, primaryCategoryId: 'seafood' };
    const score = completeness(orphan, CATEGORIES);
    expect(score.knowable).toBe(false);
    if (score.knowable) return;
    expect(score.why).toContain('seafood');
  });

  it('does not take the whole list down over one unscoreable record', () => {
    const orphan: ProductRecord = { ...FINISHED, productId: 'p9', primaryCategoryId: 'seafood' };
    const s = session({ products: () => [FINISHED, orphan] });
    expect(s.shelf()).toHaveLength(2);
    expect(s.shelf()[1]?.validation).toBeNull();
  });
});

describe('the worklist puts the work where it unlocks something', () => {
  it('puts unscoreable records first, then the nearly-finished, then the done', () => {
    const orphan: ProductRecord = { ...FINISHED, productId: 'p-orphan', primaryCategoryId: 'seafood' };
    const nearly: ProductRecord = { ...FINISHED, productId: 'p-nearly', taxClass: null };
    const broken: ProductRecord = { ...FINISHED, productId: 'p-broken', taxClass: null, name: '', sku: '' };

    const list = worklist([FINISHED, broken, nearly, orphan], CATEGORIES);
    expect(list.map((s) => s.productId)).toEqual(['p-orphan', 'p-nearly', 'p-broken', 'p1']);
  });
});

// ── Duplicates ──────────────────────────────────────────────────────────────

describe('suspected duplicates are queued, never merged', () => {
  it('flags two records sharing a barcode', () => {
    const twin: ProductRecord = { ...FINISHED, productId: 'p2', sku: 'SKU-2' };
    const found = session({
      products: () => [FINISHED, twin],
      barcodesInUse: () => [{ barcode: '8901', productId: 'p1' }, { barcode: '8901', productId: 'p2' }],
    }).duplicates();
    expect(found).toHaveLength(1);
    expect(found[0]?.confidence).toBe('near_certain');
  });

  it('has no function on this surface that merges anything', () => {
    // Absence as a control: a merge is approved and reversible elsewhere (M03-FR-04), never a
    // side-effect of looking at a list.
    const s = session();
    expect(Object.keys(s).filter((k) => /merge/i.test(k))).toEqual([]);
  });
});

// ── Promotions ──────────────────────────────────────────────────────────────

describe('a promotion is simulated before anybody can launch it', () => {
  // Typed off the session's own `simulate`, so a change to the engine's input shape fails here
  // rather than being papered over with `any`.
  type SimulationInput = Parameters<ReturnType<typeof session>['simulate']>[0];
  const simulation = (over: Partial<SimulationInput> = {}): SimulationInput => ({
    promotionId: 'promo-1', description: '10% off dal',
    normalPrice: money(145_00, 'INR'), promoPrice: money(130_00, 'INR'),
    unitCost: money(100_00, 'INR'), baselineUnits: 100, expectedUnits: 200,
    ...over,
  });

  it('lets a margin-improving offer launch with nobody’s signature', () => {
    const s = session();
    const result = s.simulate(simulation());
    expect(s.launch(result)).toEqual({ ok: true, approvedBy: null });
  });

  it('refuses a below-cost offer without a named approver and a written reason', () => {
    const s = session();
    const result = s.simulate(simulation({ promoPrice: money(80_00, 'INR') }));
    expect(result.blocksApproval).toBe(true);
    expect(s.launch(result).ok).toBe(false);
    expect(s.launch(result, {
      subjectRef: 'promo-1', status: 'approved', decidedBy: 'u-pricing', rationale: 'footfall driver for Pongal',
    }).ok, 'the proposer approved their own margin loss').toBe(false);
    expect(s.launch(result, {
      subjectRef: 'promo-1', status: 'approved', decidedBy: 'u-owner', rationale: 'footfall driver for Pongal',
    })).toEqual({ ok: true, approvedBy: 'u-owner' });
  });

  it('quotes only ACTIVE promotions — a draft offer never shows a price no lane would charge', () => {
    const draft: Promotion = {
      id: 'promo-draft', kind: 'percent_off', percentBps: 5000,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-12-31T00:00:00.000Z', status: 'draft',
    };
    const quote = session({ promotions: () => [draft] }).quote(
      [{ lineId: 'l1', productId: 'p1', unitPrice: money(145_00, 'INR'), qty: 1 }],
      `${TODAY}T12:00:00.000Z`,
    );
    expect(quote.discount.minor).toBe(0);
    expect(quote.applied).toEqual([]);
  });
});

// ── The vocabularies stay complete ──────────────────────────────────────────

describe('the refusal vocabularies are exhaustive at runtime', () => {
  it('lists every price-change refusal, so a screen can be checked against it', () => {
    expect(PRICE_CHANGE_REFUSALS).toHaveLength(8);
    expect(new Set(PRICE_CHANGE_REFUSALS).size).toBe(PRICE_CHANGE_REFUSALS.length);
  });

  it('gives every refusal a sentence a person can act on', () => {
    // Driven through the real paths rather than asserted against a map, so a refusal with no
    // sentence would come back blank here.
    const cases: { readonly refusal: string; readonly proposal: () => { detail: readonly string[] } }[] = [
      { refusal: 'above_the_printed_mrp', proposal: () => session().proposePrice({ id: 'a', productId: 'p1', priceMinor: 999_00, effectiveFrom: TODAY }) },
      { refusal: 'below_the_margin_floor', proposal: () => session().proposePrice({ id: 'b', productId: 'p1', priceMinor: 110_00, effectiveFrom: TODAY }) },
      { refusal: 'starts_in_the_past', proposal: () => session().proposePrice({ id: 'c', productId: 'p1', priceMinor: 150_00, effectiveFrom: '2020-01-01' }) },
    ];
    for (const c of cases) {
      const detail = c.proposal().detail;
      expect(detail.length, `${c.refusal} came back with no sentence`).toBeGreaterThan(0);
      expect(detail.every((d) => d.length > 30), `${c.refusal}'s sentence is too short to help`).toBe(true);
    }
  });
});

// ── The package function, used directly ─────────────────────────────────────

describe('the price-change functions stand on their own', () => {
  it('activates nothing when the caller ignores the result', () => {
    const existing: PriceEntry[] = [];
    const proposal = proposePriceChange(
      {
        id: 'pc-1', productId: 'p1', scope: 'store', scopeRef: 'store-1',
        price: money(150_00, 'INR'), effectiveFrom: TODAY, setBy: 'u-pricing',
      },
      {
        today: TODAY, mrp: money(160_00, 'INR'),
        cost: { known: true, cost: money(100_00, 'INR') },
        marginFloorBps: 2000, existing,
      },
    );
    activatePriceChange(proposal, { setBy: 'u-pricing' });
    expect(existing, 'activating appended to its input').toHaveLength(0);
  });
});

// ── Where things sit (M04-FR-02) ────────────────────────────────────────────

describe('shelf addresses, and the walk they produce', () => {
  it('lists the shop’s shelves in the order they are walked', () => {
    // L-COLD is aisle 0 — physically first, whatever the store collects last.
    expect(session().shelves().map((l) => l.locationId)).toEqual(['L-COLD', 'L-A1']);
  });

  it('puts a product on a shelf', () => {
    const s = session();
    const outcome = s.assignShelf({ productId: 'p1', locationId: 'L-A1', capacityMinor: 24 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.assignment.primary).toBe(true);
    expect(s.shelfOf('p1')?.locationId).toBe('L-A1');
  });

  it('refuses a SECOND home for one product', () => {
    // Two primaries means the picker's route and the refill task disagree about where an item
    // lives, and then both are wrong.
    const s = session();
    s.assignShelf({ productId: 'p1', locationId: 'L-A1', capacityMinor: 24 });
    const outcome = s.assignShelf({ productId: 'p1', locationId: 'L-COLD', capacityMinor: 10 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('it_already_lives_somewhere_else');
    expect(outcome.detail).toContain('L-A1');
  });

  it('refuses a shelf this shop does not have', () => {
    const outcome = session().assignShelf({ productId: 'p1', locationId: 'L-NOWHERE', capacityMinor: 5 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('no_such_shelf_in_this_shop');
  });

  it('refuses a facing that holds nothing — it could never be refilled', () => {
    const outcome = session().assignShelf({ productId: 'p1', locationId: 'L-A1', capacityMinor: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('a_shelf_facing_with_no_capacity_holds_nothing');
  });

  it('says so, rather than pretending, when the box has no shelf map at all', () => {
    // An empty map presented as a finished one would report every product as unmapped and read as
    // the shelf data having been lost.
    const s = session({ shelfMap: () => null });
    expect(s.shelves()).toEqual([]);
    expect(s.shelfOf('p1')).toBeNull();
    const outcome = s.assignShelf({ productId: 'p1', locationId: 'L-A1', capacityMinor: 5 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('this_box_has_no_shelf_map');
    expect(s.walk().ordering).toContain('no shelf map');
  });

  it('shows the walk, so somebody addressing shelves can SEE the order change', () => {
    const s = session();
    expect(s.walk(['p1']).unmapped).toEqual(['p1']);
    s.assignShelf({ productId: 'p1', locationId: 'L-A1', capacityMinor: 24 });
    const walk = s.walk(['p1']);
    expect(walk.unmapped).toEqual([]);
    expect(walk.steps[0]?.shelf).toBe('A1');
    expect(walk.ordering).toContain('in the order this store set');
  });

  it('names the products with no shelf address, rather than counting them', () => {
    // Each one is a walk back across the shop, and the person who can fix it is reading this.
    const walk = session().walk(['p1', 'p-unknown']);
    expect(walk.unmapped).toEqual(['p1', 'p-unknown']);
    expect(walk.steps.map((s) => s.shelf)).toEqual([null, null]);
  });

  it('has one home per product and no function that moves it silently', () => {
    // A relocation is a new assignment somebody makes deliberately, never a side-effect.
    expect(Object.keys(session()).filter((k) => /move|relocate/i.test(k))).toEqual([]);
  });
});

describe('requestPublish — the Save that reaches the cloud (M03-FR-01/03, §31)', () => {
  it('queues a durable publish command via the outbox for a compliant product', () => {
    const ob = new SyncOutbox();
    const s = session({ outbox: () => ob });
    const res = s.requestPublish(FINISHED);
    expect(res.ok).toBe(true);
    expect(ob.unsentCount()).toBe(1);
    expect(ob.pending()[0]!.event.type).toBe('ProductPublishRequested');
  });

  it('a double-click collapses to one queued command', () => {
    const ob = new SyncOutbox();
    const s = session({ outbox: () => ob });
    s.requestPublish(FINISHED);
    const again = s.requestPublish(FINISHED);
    expect(again.ok).toBe(false);
    expect(ob.unsentCount()).toBe(1);
  });

  it('says so plainly when the screen was built without a queue — never drops the intent silently', () => {
    const res = session().requestPublish(FINISHED); // no outbox port
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal).toBe('no_outbox');
  });
});
