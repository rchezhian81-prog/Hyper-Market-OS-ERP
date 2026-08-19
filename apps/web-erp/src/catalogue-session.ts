// The product and pricing surface (docs/design/screens/product-merchandising.md · M03 · M05 · D01 · D06 · §28).
//
// The rules exist and are tested: `packages/product` validates and publishes a record, checks
// barcode uniqueness and finds duplicates; `packages/price-guard` enforces the MRP ceiling and the
// margin floor; `packages/price-list` resolves an effective-dated price and reports its history;
// `packages/promotions` simulates an offer and gates its launch. What has never existed is anybody
// **making** a product or a price — the only `PriceEntry` values in this repository were test
// fixtures, so the catalogue snapshot builder has never had a real price to ship to a lane.
//
// ── The three things this screen must not let happen ────────────────────────
//
// **1. A price above MRP, ever.** It is a legal ceiling in India, not a shop policy, so there is no
// approval path and no override. It is the one refusal on this screen that nobody can authorise.
//
// **2. A margin checked against a cost nobody has.** `checkPrice` needs a landed cost. A product
// with none — a new line, a first delivery not yet booked in — has no knowable margin, and costing
// it at zero makes every price look like 100% margin: the floor check passes, confidently and
// wrongly, at exactly the moment a buyer is relying on it. So an unknown cost is its own refusal
// and goes to an approver rather than being assumed away.
//
// **3. A price set and approved by one person.** §28. The maker cannot approve their own change,
// and the screen is never handed their name to offer.
//
// ── And the thing it must not let happen quietly ────────────────────────────
//
// **A product that cannot be scored is not a product scoring zero.** An item in a department this
// screen has not been told about cannot be measured at all — nobody can say what it is missing
// without knowing what that department requires. Reported as *not knowable*, with the reason, so
// nobody is sent to fix a record that may already be finished.

import { money, type CurrencyCode, type Money } from '../../../packages/contracts/src/money';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import {
  completeness, detectDuplicateProducts, publishProduct, sellability, validateProduct, worklist,
  BarcodeRegistry, DuplicateBarcodeError, NotPublishableError,
  type Category, type CompletenessScore, type DuplicatePair, type ProductRecord,
  type SellRefusal, type ValidationResult,
} from '../../../packages/product/src/index';
import {
  activatePriceChange, priceHistory, proposePriceChange, resolvePrice, rollBackPrice,
  type CostRegister, type PriceChangeOutcome, type PriceEntry, type PriceProposal, type PriceScope,
} from '../../../packages/price-list/src/index';
import {
  ShelfMappingError,
  type ShelfAssignment, type ShelfLocation, type ShelfMap, type WalkOrdering,
} from '../../../packages/merchandising/src/index';
import {
  approveForLaunch, bestPrice, simulatePromotion,
  PromotionApprovalRequiredError,
  type BasketLine, type Promotion, type PromotionResult, type SimulationResult,
} from '../../../packages/promotions/src/index';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { queueProductPublish, type PublishQueueResult, type ProductPublishBarcode } from './catalogue-publish-command';

/** What this surface can see about the shop, and what it honestly cannot. */
export interface CataloguePorts {
  /** The tenant's own department hierarchy. Which fields matter is theirs to say, never ours. */
  categories(): readonly Category[];
  products(): readonly ProductRecord[];
  /** Every price entry ever recorded, any status — the append-only history. */
  priceEntries(): readonly PriceEntry[];
  /**
   * What one unit cost us.
   *
   * A register rather than a number: "we have never bought this" and "it cost nothing" are
   * different facts, and only one of them makes a margin computable.
   */
  costOf(productId: string): CostRegister;
  /** Barcodes already in use, so the same one cannot be given to two items (M03-FR-02). */
  barcodesInUse(): readonly { readonly barcode: string; readonly productId: string }[];
  /** Promotions this tenant has defined. */
  promotions(): readonly Promotion[];
  /**
   * The shop's shelf map, or `null` when this box has none (M04-FR-02).
   *
   * `null` is a real state and not a degraded one: a shop that has not addressed its shelves yet
   * has pick lists in whatever order the wave arrived, and the picker's screen says so. What must
   * never happen is an empty map presented as a finished one, which would report every product as
   * unmapped and read as the shelf data having been lost.
   */
  shelfMap(): ShelfMap | null;
  /**
   * The offline command queue the Save button commits a publish to (P-01, §31). Optional: a read-only
   * viewing of the catalogue (or a test that never publishes) need not provide one; `requestPublish` says so
   * plainly when it is absent rather than dropping the intent silently.
   */
  outbox?(): SyncOutbox;
}

export interface CatalogueConfig {
  readonly tenantId: string;
  readonly storeId: string;
  /** Who is using this screen. They may not approve their own price change (§28). */
  readonly userId: string;
  readonly currency: CurrencyCode;
  /** Today in the shop's own calendar, as YYYY-MM-DD. Injected — never a clock in here. */
  readonly today: string;
  /** Minimum gross margin in basis points. Per-tenant policy (M05-FR-02). */
  readonly marginFloorBps: number;
}

/** What a product record looks like to somebody deciding whether to work on it. */
export interface ProductView {
  readonly product: ProductRecord;
  readonly validation: ValidationResult | null;
  readonly score: CompletenessScore;
  /** Whether it may be sold right now, and why not when it may not. */
  readonly sellable: SellRefusal;
  /** The price running today for this store, or null when it has none. */
  readonly priceToday: PriceEntry | null;
}

export type PublishRefusal = 'not_finished' | 'recall_blocked' | 'barcode_belongs_to_another_item';

export type ShelfRefusal =
  | 'this_box_has_no_shelf_map'
  | 'no_such_shelf_in_this_shop'
  | 'a_shelf_facing_with_no_capacity_holds_nothing'
  | 'it_already_lives_somewhere_else';

const SHELF_REFUSALS: Readonly<Record<ShelfRefusal, ShelfRefusal>> = Object.freeze({
  this_box_has_no_shelf_map: 'this_box_has_no_shelf_map',
  no_such_shelf_in_this_shop: 'no_such_shelf_in_this_shop',
  a_shelf_facing_with_no_capacity_holds_nothing: 'a_shelf_facing_with_no_capacity_holds_nothing',
  it_already_lives_somewhere_else: 'it_already_lives_somewhere_else',
});

export const SHELF_REFUSAL_KINDS: readonly ShelfRefusal[] = Object.freeze(Object.values(SHELF_REFUSALS));

export type ShelfOutcome =
  | { readonly ok: true; readonly assignment: ShelfAssignment }
  | { readonly ok: false; readonly refusal: ShelfRefusal; readonly detail: string };

/** What a picker would actually walk, given the shop's shelf map. */
export interface WalkPreview {
  readonly steps: readonly { readonly productId: string; readonly name: string; readonly shelf: string | null }[];
  readonly ordering: WalkOrdering;
  /** Products with no shelf address at all — each one is a walk back across the shop. */
  readonly unmapped: readonly string[];
}

export type PublishOutcome =
  | { readonly ok: true; readonly product: ProductRecord }
  | { readonly ok: false; readonly refusal: PublishRefusal; readonly detail: string; readonly missing: readonly string[] };

const PUBLISH_REFUSALS: Readonly<Record<PublishRefusal, PublishRefusal>> = Object.freeze({
  not_finished: 'not_finished',
  recall_blocked: 'recall_blocked',
  barcode_belongs_to_another_item: 'barcode_belongs_to_another_item',
});

export const PUBLISH_REFUSAL_KINDS: readonly PublishRefusal[] = Object.freeze(Object.values(PUBLISH_REFUSALS));

/** The outcome of asking to publish to the cloud — the queue result, or `no_outbox` when there is no queue. */
export type RequestPublishResult =
  | PublishQueueResult
  | { readonly ok: false; readonly refusal: 'no_outbox'; readonly detail: string; readonly missing: readonly string[] };

export interface CatalogueSession {
  /** Every product with its completeness, sellability and today's price. */
  shelf(): readonly ProductView[];

  /** The records closest to being sellable, worst blocker first (D01). */
  needsWork(): readonly CompletenessScore[];

  /** One product, checked. Writes nothing — this is what the editor renders against. */
  inspect(product: ProductRecord): ProductView;

  /**
   * Publish a product record (M03-FR-01/03).
   *
   * Refuses with **every** missing field at once rather than one per attempt: a person filling in
   * a record at nine in the evening should not have to discover the requirements one save at a
   * time.
   */
  publish(product: ProductRecord, barcodes?: readonly ProductPublishBarcode[]): PublishOutcome;

  /**
   * Publish a product to the shared truth (M03-FR-01/03) — the Save that reaches the cloud.
   *
   * Validates through the SAME tested engine as `publish` and, if it passes, commits a durable,
   * deduplicated command to the offline outbox (P-01, §31); the sync agent drains it to the compliance-gated
   * cloud route. Never touches the network from here. `no_outbox` when this screen was built without a queue.
   */
  requestPublish(product: ProductRecord, barcodes?: readonly ProductPublishBarcode[]): RequestPublishResult;

  /**
   * Stop an item being sold or ordered anywhere, at once (D01-FR-05).
   *
   * Two taps by design — this is the control somebody reaches for when a supplier rings about
   * glass in a jar, and it is honoured offline because it travels in the catalogue pack.
   */
  setRecallBlock(product: ProductRecord, blocked: boolean): ProductRecord;

  /** Suspected duplicates, for review. Never merged automatically (M03-FR-04). */
  duplicates(): readonly DuplicatePair[];

  /** Every shelf address this shop has, in the order they are walked (M04-FR-02). */
  shelves(): readonly ShelfLocation[];

  /** Where one product lives, or `null` when nothing has said. */
  shelfOf(productId: string): ShelfLocation | null;

  /**
   * Put a product on a shelf.
   *
   * Refuses a **second** primary rather than accepting it: two primaries means the picker's route
   * and the replenishment task disagree about where an item lives, and then both are wrong.
   */
  assignShelf(input: {
    readonly productId: string;
    readonly locationId: string;
    readonly capacityMinor: number;
    readonly primary?: boolean;
  }): ShelfOutcome;

  /**
   * The order a picker would walk this shop, for the products given.
   *
   * The point of the whole shelf map, made visible to the person maintaining it: somebody
   * addressing shelves needs to see the walk change, not take it on trust.
   */
  walk(productIds?: readonly string[]): WalkPreview;

  /** Work out what a price change would do. Writes nothing, activates nothing. */
  proposePrice(input: {
    readonly id: string;
    readonly productId: string;
    readonly priceMinor: number;
    readonly effectiveFrom: string;
    readonly scope?: PriceScope;
    readonly scopeRef?: string;
  }): PriceProposal;

  /** Turn a proposal into a live price — a new entry, never an edit. */
  activatePrice(proposal: PriceProposal, approval?: DecidedRequest): PriceChangeOutcome;

  /** Withdraw a price that should not have gone live. Appends; never deletes. */
  rollBack(entry: PriceEntry): PriceEntry;

  /** Who changed this product's price, from what, to what, and when (M05-FR-01). */
  historyFor(productId: string): readonly PriceEntry[];

  /** What a promotion would do to margin before anybody launches it (M05-FR-04). */
  simulate(input: Parameters<typeof simulatePromotion>[0]): SimulationResult;

  /** Launch a promotion. A margin-losing one needs a named approver and a written reason. */
  launch(simulation: SimulationResult, approval?: Parameters<typeof approveForLaunch>[1]): {
    readonly ok: true;
    readonly approvedBy: string | null;
  } | {
    readonly ok: false;
    readonly detail: string;
  };

  /** The best price a basket would get under the approved rules — the same answer as the lane. */
  quote(lines: readonly BasketLine[], at: string): PromotionResult;
}

export function createCatalogueSession(
  config: CatalogueConfig,
  ports: CataloguePorts,
): CatalogueSession {
  const inr = (minor: number): Money => money(minor, config.currency);

  /** The price running today at this store, resolved by the same engine the lane uses. */
  const priceToday = (productId: string): PriceEntry | null =>
    resolvePrice(ports.priceEntries(), {
      productId,
      // Resolution is instant-based; midday keeps a date-only effective window unambiguous either
      // side of a timezone, and the shop's day is what `today` already encodes.
      at: `${config.today}T12:00:00.000Z`,
      storeId: config.storeId,
    });

  const inspect: CatalogueSession['inspect'] = (product) => {
    let validation: ValidationResult | null;
    try {
      validation = validateProduct(product, ports.categories());
    } catch {
      // The department is unknown to this screen. `completeness` reports that as not knowable with
      // the reason; a thrown error here would take the whole list down over one bad record.
      validation = null;
    }
    return {
      product,
      validation,
      score: completeness(product, ports.categories()),
      sellable: sellability(product),
      priceToday: priceToday(product.productId),
    };
  };

  return {
    shelf: () => ports.products().map(inspect),

    needsWork: () => worklist(ports.products(), ports.categories()),

    inspect,

    publish: (product, barcodes = []) => {
      // A recall-blocked item is not a publishing decision at all. Publishing it would put it back
      // on sale, which is the opposite of what somebody set the block for.
      if (product.recallBlocked === true) {
        return {
          ok: false,
          refusal: 'recall_blocked',
          detail: 'this item is recall-blocked. Lift the block first — publishing it would put it back on sale.',
          missing: [],
        };
      }

      // A barcode that already belongs to another item would make one scan ring up two products,
      // and which one is a matter of whichever record happened to be found first.
      if (barcodes.length > 0) {
        const registry = new BarcodeRegistry();
        for (const existing of ports.barcodesInUse()) {
          if (existing.productId === product.productId) continue;
          registry.register({ code: existing.barcode, productId: existing.productId, kind: 'internal' });
        }
        for (const barcode of barcodes) {
          try {
            registry.register({ code: barcode.code, productId: product.productId, kind: barcode.kind });
          } catch (e) {
            if (e instanceof DuplicateBarcodeError) {
              return {
                ok: false,
                refusal: 'barcode_belongs_to_another_item',
                detail: `barcode ${barcode.code} already belongs to another item. One barcode rings up one product — otherwise which one it is depends on which record was found first.`,
                missing: [barcode.code],
              };
            }
            throw e;
          }
        }
      }

      try {
        return { ok: true, product: publishProduct(product, ports.categories()) };
      } catch (e) {
        if (e instanceof NotPublishableError) {
          // Every reason at once. One per attempt is how somebody ends up saving six times.
          const missing = e.issues.map((i) => i.message);
          return {
            ok: false,
            refusal: 'not_finished',
            detail: `${missing.length} thing(s) still needed before this can be sold.`,
            missing,
          };
        }
        throw e;
      }
    },

    requestPublish: (product, barcodes = []) => {
      const queue = ports.outbox?.();
      if (queue === undefined) {
        return { ok: false, refusal: 'no_outbox', detail: 'this screen has no queue to publish through.', missing: [] };
      }
      // The tested compliance gate runs inside queueProductPublish — an invalid product never queues. The
      // command carries the record + this tenant's categories so the cloud validates against the same
      // hierarchy. `today` is the shop's day (never the device clock).
      return queueProductPublish(queue, {
        product,
        categories: ports.categories(),
        barcodes,
        requestedBy: config.userId,
        at: `${config.today}T12:00:00.000Z`,
      });
    },

    setRecallBlock: (product, blocked) => ({ ...product, recallBlocked: blocked }),

    shelves: () => ports.shelfMap()?.allLocations() ?? [],

    shelfOf: (productId) => ports.shelfMap()?.locationOf(productId) ?? null,

    assignShelf: (input) => {
      const map = ports.shelfMap();
      if (map === null) {
        return {
          ok: false,
          refusal: 'this_box_has_no_shelf_map',
          detail: 'this screen has not been told the shop\'s shelf addresses, so there is nowhere to put anything yet.',
        };
      }
      if (input.capacityMinor <= 0) {
        return {
          ok: false,
          refusal: 'a_shelf_facing_with_no_capacity_holds_nothing',
          detail: 'say how many fit on that shelf facing. A facing that holds nothing cannot be refilled.',
        };
      }
      try {
        return {
          ok: true,
          assignment: map.assign({
            storeId: config.storeId,
            productId: input.productId,
            locationId: input.locationId,
            capacityMinor: input.capacityMinor,
            primary: input.primary ?? true,
          }),
        };
      } catch (e) {
        if (e instanceof ShelfMappingError) {
          const already = e.message.includes('already has a primary location');
          return {
            ok: false,
            refusal: already ? 'it_already_lives_somewhere_else' : 'no_such_shelf_in_this_shop',
            detail: already
              ? `${e.message}. Two homes means the picker's route and the refill task disagree about where it lives, and then both are wrong.`
              : e.message,
          };
        }
        throw e;
      }
    },

    walk: (productIds) => {
      const products = ports.products();
      const wanted = productIds === undefined ? products.map((p) => p.productId) : productIds;
      const nameOf = (id: string): string => products.find((p) => p.productId === id)?.name ?? id;
      const map = ports.shelfMap();
      if (map === null) {
        return {
          steps: wanted.map((productId) => ({ productId, name: nameOf(productId), shelf: null })),
          ordering: 'the order the list arrived in — this store has no shelf map',
          unmapped: wanted,
        };
      }
      const route = map.routeFor(wanted.map((productId) => ({ productId })));
      return {
        steps: route.lines.map((line) => ({
          productId: line.productId,
          name: nameOf(line.productId),
          shelf: line.location === undefined ? null : (line.location.label ?? line.location.locationId),
        })),
        ordering: route.ordering,
        unmapped: route.unmapped,
      };
    },

    duplicates: () => detectDuplicateProducts(
      ports.products().map((p) => ({
        productId: p.productId,
        name: p.name,
        ...(p.brand === undefined ? {} : { brand: p.brand }),
        barcodes: ports.barcodesInUse().filter((b) => b.productId === p.productId).map((b) => b.barcode),
      })),
    ),

    proposePrice: (input) => {
      const product = ports.products().find((p) => p.productId === input.productId);
      // The MRP in force today, from the effective-dated history — not the newest one recorded. A
      // future MRP increase must not raise today's ceiling before the pack it is printed on ships.
      const mrp = (product?.mrpHistory ?? [])
        .filter((m) => m.effectiveFrom <= config.today)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
        .at(-1)?.value;

      return proposePriceChange(
        {
          id: input.id,
          productId: input.productId,
          scope: input.scope ?? 'store',
          scopeRef: input.scopeRef ?? config.storeId,
          price: inr(input.priceMinor),
          effectiveFrom: input.effectiveFrom,
          setBy: config.userId,
        },
        {
          today: config.today,
          ...(mrp === undefined ? {} : { mrp }),
          cost: ports.costOf(input.productId),
          marginFloorBps: config.marginFloorBps,
          existing: ports.priceEntries(),
        },
      );
    },

    activatePrice: (proposal, approval) =>
      activatePriceChange(proposal, {
        setBy: config.userId,
        ...(approval === undefined ? {} : { approval }),
      }),

    rollBack: (entry) => rollBackPrice(entry, config.today),

    historyFor: (productId) => priceHistory(ports.priceEntries(), productId),

    simulate: (input) => simulatePromotion(input),

    launch: (simulation, approval) => {
      try {
        const result = approveForLaunch(simulation, approval, config.userId);
        return { ok: true, approvedBy: result.approvedBy ?? null };
      } catch (e) {
        if (e instanceof PromotionApprovalRequiredError) return { ok: false, detail: e.message };
        throw e;
      }
    },

    // Only ACTIVE promotions, and `bestPrice` checks the window again itself. A draft or stopped
    // offer that quoted here would show a price no lane would ever charge.
    quote: (lines, at) => bestPrice(
      lines,
      ports.promotions().filter((p) => p.status === 'active'),
      { at, currency: config.currency },
    ),
  };
}
