// API-02 Catalogue pack ASSEMBLY / preview (M03 → M05 → the lane, §31, slice 2) — folds the four cloud
// master-data stores this session built (the product master M03-FR-01, the price lists M05, the barcode
// register M03-FR-02, and the tax-class GST-rate schedules M03-FR-03/A6) into ONE catalogue snapshot for a
// named store, through the tested `buildCatalogueSnapshot` engine. It is the join the pack build has waited
// for: until now the cloud pack carried the previous set forward because the master data had nowhere to live.
//
// This is the READ-ONLY assembly + preview: it shows exactly what the signed pack WOULD contain for a store
// on a date, and — the honest half (P-08) — which products are LEFT OUT and why (no price, no tax class, or
// a price above MRP; a lane must never be handed a product it cannot price safely or that breaks the MRP
// ceiling). Flipping the signed publish path to build from this is the deliberate next slice; keeping the
// assembly read-only first proves the fold without touching the working publish contract.
//
// Gated `catalogue.pack.read` — it is a preview of the catalogue, not a change to it. Stateless over the
// tested engines (`buildCatalogueSnapshot`, `resolveGstRate`, `mrpOn`): this file maps the stored shapes to
// the engine's inputs and reports its output.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  buildCatalogueSnapshot, type MasterProduct, type BuildSnapshotResult,
} from '../../../packages/catalogue/src/snapshot-builder';
import type { CatalogueBarcode, ProductStatus } from '../../../packages/catalogue/src/catalogue';
import { mrpOn, isTobacco, warningStanding, type ProductRecord, type BarcodeAssignment } from '../../../packages/product/src/index';
import type { PriceEntry } from '../../../packages/price-list/src/price-list';
import type { Promotion } from '../../../packages/promotions/src/promotions';
import { resolveGstRate, InvalidRateSchedule, type GstRatePeriod } from '../../../packages/finance/src/rate';
import { TOBACCO_MINIMUM_AGE } from '../../../packages/restricted-sales/src/till-gate';
import { knowsBlockedBatches } from '../../inventory/src/sale-blocks';
import { cessRateOn, type CessRate, type CessRatePeriod } from '../../../packages/finance/src/cess';

export interface CataloguePreviewDeps {
  readonly products: (tenantId: string) => Promise<readonly ProductRecord[]> | readonly ProductRecord[];
  readonly priceEntries: (tenantId: string, productId: string) => Promise<readonly PriceEntry[]> | readonly PriceEntry[];
  /** SF-01 — the tenant's offers as head office holds them; only LAUNCHED (active), not-yet-ended ones go in a pack. */
  readonly promotions?: (tenantId: string) => Promise<readonly Promotion[]> | readonly Promotion[];
  readonly barcodes: (tenantId: string) => Promise<readonly BarcodeAssignment[]> | readonly BarcodeAssignment[];
  readonly taxSchedule: (tenantId: string, hsnCode: string) => Promise<readonly GstRatePeriod[]> | readonly GstRatePeriod[];
  /** SF-08 — the products with a batch under open recall or on quality hold; each goes in the pack `recallBlock`, so
   *  every till refuses it, offline (owner decision "C": the whole product until the batch block lands in R3). */
  readonly blockedProducts?: (tenantId: string) => Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /**
   * D-19 (R3, OB-148 / OB-190): zone / channel pricing as the owner's switches allow it. `allowedEntries` leaves out every
   * channel or zone entry whose switch is off; `zoneOfStore` names the store's zone only while zone pricing is switched
   * on. With every switch off the pack is exactly what it was before D-19 (one shelf price). Absent: nothing gated.
   */
  readonly pricing?: {
    readonly allowedEntries: (tenantId: string, entries: readonly PriceEntry[]) => Promise<readonly PriceEntry[]>;
    readonly zoneOfStore: (tenantId: string, storeId: string) => Promise<string | undefined>;
  };
  /**
   * A7: the compensation-cess schedule per HSN (`cess-rates.ts`). The cess in force on the build date rides the pack on each
   * product of that HSN, signed. Absent → no product carries a cess (a deployment that has not wired it).
   */
  readonly cessSchedule?: (tenantId: string, hsnCode: string) => Promise<readonly CessRatePeriod[]> | readonly CessRatePeriod[];
  readonly now: () => string;
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A published product master is 'new' when first published; in catalogue terms that is a sellable, active
 * product (the snapshot builder only distinguishes draft/active/clearance/discontinued). */
const statusOf = (lifecycle: ProductRecord['lifecycle']): ProductStatus =>
  lifecycle === 'new' ? 'active' : lifecycle;

/**
 * The restriction a product master carries into the pack (E1b · M03-FR-03 → M12-FR-04). The product engine makes a
 * product in an age-restricted category declare `safety.minimumAge` before it may publish; THIS is where that
 * declaration becomes the pack contract's `regulatedFlags` — `{ minimumAge }`, the one field the lane's age gate reads
 * (`Catalogue.scan(...).requiresAgeCheck`) and the field the publish step-up treats as SENSITIVE. Only a positive whole
 * number of years is a restriction: absent → no flag; zero or malformed → no flag here, and the authoring route refuses
 * it, so a product never publishes as "age-restricted" and reaches the lane unflagged (P-08). Other controlled-sale
 * controls (KYC, PAN, serial capture, a blocked category) are category policy the lane resolves by category, not
 * per-product flags — they are not invented here.
 */
export function regulatedFlagsFor(r: Pick<ProductRecord, 'safety'>): Readonly<Record<string, unknown>> | undefined {
  const s = r.safety;
  const age = s?.minimumAge;
  const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  // B14 · B19 (roadmap v2.1): the till's legal gates read these from the signed pack (`till-gate.ts`). A tobacco product
  // always carries an age of at least 18; only well-formed values travel (the publish route refuses the rest).
  const flags: Record<string, unknown> = {
    ...(s?.tobacco === true ? { tobacco: true, minimumAge: Math.max(TOBACCO_MINIMUM_AGE, posInt(age) ? age : 0) } : posInt(age) ? { minimumAge: age } : {}),
    ...(s?.tobacco === true && posInt(s.packMinimumMinor) ? { packMinimumMinor: s.packMinimumMinor } : {}),
    ...(s?.carryBag === true ? { carryBag: true } : {}),
    ...(typeof s?.plasticMaterial === 'string' && s.plasticMaterial.trim() !== '' ? { plasticMaterial: s.plasticMaterial } : {}),
    ...(posInt(s?.plasticThicknessMicrons) ? { plasticThicknessMicrons: s.plasticThicknessMicrons } : {}),
    ...(s?.bannedSingleUsePlastic === true ? { bannedSingleUsePlastic: true } : {}),
    // B13 (OB-138): a gold piece and its hallmark HUID — the till refuses a gold line with none, or with one already sold.
    ...(s?.gold === true ? { gold: true, ...(typeof s.huid === 'string' && s.huid !== '' ? { huid: s.huid } : {}) } : {}),
    // B12 (OB-325): a BIS-controlled product, its BIS licence number and the licence's last valid day — the till refuses it
    // offline when either is missing or the licence has run out by its own clock.
    ...(s?.bisControlled === true ? {
      bisControlled: true,
      ...(typeof s.bisLicenceNo === 'string' && s.bisLicenceNo.trim() !== '' ? { bisLicenceNo: s.bisLicenceNo.trim() } : {}),
      ...(typeof s.bisLicenceValidUntil === 'string' && s.bisLicenceValidUntil !== '' ? { bisLicenceValidUntil: s.bisLicenceValidUntil } : {}),
    } : {}),
    // B8 (OB-298): a perishable — the cashier confirms the date printed on the pack before the line is added.
    ...(s?.perishable === true ? { perishable: true } : {}),
  };
  return Object.keys(flags).length === 0 ? undefined : flags;
}

export function toMaster(r: ProductRecord, asOf: string): MasterProduct {
  const mrp = mrpOn(r, asOf); // the MRP in force on the build date (a future MRP does not apply early)
  const regulatedFlags = regulatedFlagsFor(r);
  return {
    productId: r.productId,
    sku: r.sku,
    name: r.name,
    baseUom: r.baseUom,
    // OB-263: the department rides the pack, so the store computer can keep the pilot department's items (MG-05).
    ...(r.primaryCategoryId === null || r.primaryCategoryId.trim() === '' ? {} : { categoryId: r.primaryCategoryId }),
    taxClassId: r.taxClass ?? '', // null/absent → no rate resolvable → excluded 'no_tax_class' by the engine
    status: statusOf(r.lifecycle),
    ...(mrp !== undefined ? { mrpMinor: mrp.minor } : {}),
    ...(r.recallBlocked !== undefined ? { recallBlock: r.recallBlocked } : {}),
    ...(regulatedFlags !== undefined ? { regulatedFlags } : {}),
    // HA-2: the handling class rides the pack as the master holds it — absent stays absent, never 'ambient' by default.
    ...(r.handling !== undefined ? { handling: r.handling } : {}),
  };
}

/**
 * Assemble a catalogue snapshot for a store as of a date, from the four master-data stores, through the
 * tested `buildCatalogueSnapshot`. Shared by the read-only preview route AND the signed pack publish
 * (`catalogueAdapter.buildSnapshot`), so there is ONE fold path: the same products reach a preview and a
 * published pack. `version` is the version the snapshot will carry (0 for a preview; previous+1 when publishing).
 */
export async function assembleCatalogueSnapshot(
  deps: CataloguePreviewDeps,
  opts: { readonly tenantId: string; readonly storeId: string; readonly asOf: string; readonly version: number },
): Promise<BuildSnapshotResult> {
  const asOfDate = opts.asOf.slice(0, 10); // date part, for the effective-dated tax + MRP lookups
  const all = await deps.products(opts.tenantId);
  // B16 (COTPA s.7 · OB-140 "A"): a tobacco product reaches the pack only with a named person's confirmation for the
  // warning picture in force on the build date. One never confirmed, or confirmed only for an earlier picture, is LEFT
  // OUT and said — so a new picture coming into force takes it off sale on the next pack. One that is confirmed carries
  // the last day its confirmation stays good (the day before the next notified picture), so a till that gets no new pack
  // stops selling it on that day by its own clock, offline.
  const asOfDay = opts.asOf.slice(0, 10);
  const unconfirmed = all.filter((r) => isTobacco(r) && !warningStanding(r.tobaccoWarning, asOfDay).sellable);
  const records = all.filter((r) => !unconfirmed.includes(r));
  const confirmedUntil = new Map(records.filter(isTobacco).flatMap((r) => {
    const standing = warningStanding(r.tobaccoWarning, asOfDay);
    return standing.sellable && standing.goodUntil !== undefined ? [[r.productId, standing.goodUntil] as const] : [];
  }));

  // Prices: every entry for every product (the engine resolves the one that applies at this store/date) — D-19: only the
  // entries the owner's channel / zone switches allow, and the store's zone only while zone pricing is on.
  const stored: PriceEntry[] = [];
  for (const r of records) stored.push(...(await deps.priceEntries(opts.tenantId, r.productId)));
  const priceEntries = deps.pricing === undefined ? stored : await deps.pricing.allowedEntries(opts.tenantId, stored);
  const zoneId = deps.pricing === undefined ? undefined : await deps.pricing.zoneOfStore(opts.tenantId, opts.storeId);

  // Tax rates: resolve each distinct tax class's rate in force on the date. An HSN with no schedule (or a
  // gap before its earliest rate) is left unset — the engine then excludes its products as 'no_tax_class'
  // rather than shipping an untaxed line (never a guessed rate).
  const taxClasses: Record<string, number> = {};
  for (const hsn of new Set(records.map((r) => r.taxClass).filter((c): c is string => isStr(c)))) {
    const schedule = await deps.taxSchedule(opts.tenantId, hsn);
    if (schedule.length === 0) continue;
    try {
      taxClasses[hsn] = resolveGstRate({ schedule, supplyDate: asOfDate }).rateBps;
    } catch (err) {
      if (!(err instanceof InvalidRateSchedule)) throw err; // a gap → leave unset; anything else is a real fault
    }
  }

  // A7: the compensation cess each HSN carries on the build date — none when no schedule says so.
  const taxClassCess: Record<string, CessRate> = {};
  if (deps.cessSchedule !== undefined) {
    for (const hsn of new Set(records.map((r) => r.taxClass).filter((c): c is string => isStr(c)))) {
      const cess = cessRateOn(await deps.cessSchedule(opts.tenantId, hsn), asOfDate);
      if (cess !== undefined) taxClassCess[hsn] = cess;
    }
  }

  // Barcodes: the register, mapped to the snapshot shape (the engine drops any whose product is excluded).
  // The register records SYMBOLOGY (gtin/ean/upc/internal/case/embedded); the catalogue `kind` is how the
  // LANE reads the code, where a plain product code is 'standard'. Embedded weight/price barcodes are driven
  // by per-tenant `EmbeddedBarcodeRule` (a separate pack input not yet sourced on the cloud), so every
  // register code is carried here as 'standard' for now.
  const barcodes: CatalogueBarcode[] = (await deps.barcodes(opts.tenantId)).map((b) => ({
    code: b.code, productId: b.productId, kind: 'standard' as const,
  }));

  // SF-08: what head office's recall and quality-hold registers say must not be sold.
  const blocked = deps.blockedProducts === undefined ? new Set<string>() : await deps.blockedProducts(opts.tenantId);

  const built = buildCatalogueSnapshot({
    // A store's own pack is the till's (in-store) channel: no channel is named, so an app or delivery price never resolves.
    scope: { tenantId: opts.tenantId, storeId: opts.storeId, ...(zoneId === undefined ? {} : { zoneId }) },
    version: opts.version,
    asOf: opts.asOf,
    products: records.map((r) => {
      const plain = toMaster(r, opts.asOf);
      const until = confirmedUntil.get(r.productId);
      const master = until === undefined ? plain : { ...plain, regulatedFlags: { ...(plain.regulatedFlags ?? {}), tobaccoWarningConfirmedUntil: until } };
      if (!blocked.has(r.productId)) return master;
      // SF-08 · OB-139 "A" (R3): the pack says WHICH batches block the product, so a 2D code carrying a sibling batch sells.
      // A recall flag on the product itself (`recallBlocked`) blocks every batch — no batch list is sent for it.
      const batches = knowsBlockedBatches(blocked) ? blocked.batchesOf(r.productId) : [];
      return master.recallBlock === true || batches.length === 0
        ? { ...master, recallBlock: true }
        : { ...master, recallBlock: true, blockedBatches: batches };
    }),
    barcodes,
    priceEntries,
    taxClasses,
    ...(Object.keys(taxClassCess).length === 0 ? {} : { taxClassCess }),
  });
  // SF-01: the launched offers the lanes apply — active and not yet ended at build time (one starting later rides along:
  // the lane checks each offer's window against its own clock). A draft or stopped offer never reaches a lane.
  const at = Date.parse(opts.asOf.length === 10 ? `${opts.asOf}T00:00:00Z` : opts.asOf);
  const promotions = (deps.promotions === undefined ? [] : await deps.promotions(opts.tenantId))
    .filter((p) => p.status === 'active' && Date.parse(p.endsAt) >= at)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const withTobacco = unconfirmed.length === 0 ? built : {
    ...built,
    excluded: [...built.excluded, ...unconfirmed.map((r) => ({ productId: r.productId, sku: r.sku, reason: 'tobacco_warning_not_confirmed' as const }))],
  };
  return promotions.length === 0 ? withTobacco : { ...withTobacco, snapshot: { ...withTobacco.snapshot, promotions } };
}

export function cataloguePreviewRoutes(deps: CataloguePreviewDeps): readonly Route[] {
  return [
    {
      // Assemble the pack for a store as of a date (?storeId= required, ?asOf= optional, defaults to now).
      // Body-less read: returns the snapshot that WOULD be published + the products left out, each with a reason.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/pack/preview',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const storeId = ctx.query['storeId'];
        if (!isStr(storeId)) {
          throw apiError(400, {
            code: 'not_readable_as_a_pack_preview',
            whatHappened: 'Assembling a catalogue pack needs the store it is for: ?storeId=. A pack carries the price each lane in that store should charge, which is resolved per store.',
            wasItSaved: 'unknown',
            nextSafeAction: 'Add ?storeId=<the store> (optionally ?asOf=YYYY-MM-DD) to the request.',
          });
        }
        const asOfQ = ctx.query['asOf'];
        if (asOfQ !== undefined && !isDate(asOfQ)) {
          throw apiError(400, {
            code: 'not_readable_as_a_pack_preview',
            whatHappened: 'asOf must be a valid YYYY-MM-DD date — the pack is assembled as of a moment (prices and tax rates are effective-dated).',
            wasItSaved: 'unknown',
            nextSafeAction: 'Send ?asOf=2026-08-18, or omit it to build as of today.',
          });
        }
        const asOf = asOfQ ?? deps.now();
        const result = await assembleCatalogueSnapshot(deps, { tenantId: ctx.tenantId, storeId, asOf, version: 0 });
        return {
          status: 200,
          body: {
            storeId,
            asOf,
            snapshot: result.snapshot,
            includedCount: result.includedCount,
            excluded: result.excluded, // each with productId + sku + reason (no_price / no_tax_class / price_above_mrp)
            droppedBarcodes: result.droppedBarcodes,
          },
        };
      },
    },
  ];
}
