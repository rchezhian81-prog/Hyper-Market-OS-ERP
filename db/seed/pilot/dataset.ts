// Controlled pilot SEED dataset (Phase 4 of pilot preparation) — a single, reproducible,
// clearly NON-REAL dataset for the non-production pilot / UAT environment.
//
// Why this exists: the pilot and the 12-role UAT need something realistic to exercise, but
// nothing real may be used (hard rule #7 — never touch production data from dev/test, and the
// owner's pilot authorisation is non-production only). This module is the source of truth for the
// demo data; `apply.ts` lays it down by driving the REAL cloud API routes, so seeded data passes
// exactly the same validation, permission and idempotency guards as real data and can never reach a
// state the real system would reject.
//
// The demo marker is STRUCTURAL, not a flag that can be forgotten: every record is scoped to the
// demo tenant `PILOT_DEMO_TENANT`. Because the whole platform is tenant-isolated (P-02 — truth is
// per-tenant), demo data cannot mix with a real tenant's data or exports. Names are obviously
// non-real ("… (demo)") and the GSTIN is a synthetic, checksum-valid Tamil-Nadu number that belongs
// to no real business.
//
// This file is Slice 4a: the FOUNDATION (identity + entitlements + org structure). Later slices
// extend the dataset (catalogue + tax + prices, then stock + suppliers, then trading transactions)
// on the same applier framework.
//
// Pure data + types: no clock, no I/O.

/** The one demo tenant every pilot-seed record lives in. Tenant isolation is the demo marker. */
export const PILOT_DEMO_TENANT = 'pilot-demo';

/** A stamp carried into the seed report, docs and any operator output so nobody mistakes this for
 *  real data. Mirrors the platform's existing `syntheticDataOnly` convention (partner sandboxes). */
export const SEED_MARKER = {
  tenantId: PILOT_DEMO_TENANT,
  syntheticDataOnly: true as const,
  label: 'SRE PILOT DEMO — synthetic data, non-production pilot/UAT only',
} as const;

export type SeedRoleId =
  | 'owner'
  | 'store_manager'
  | 'cashier'
  | 'accountant'
  | 'chartered_accountant'
  | 'platform_admin';

export interface SeedUser {
  /** Stable, obviously-demo user id (the pilot uses the local/test IdP; no real identity). */
  readonly userId: string;
  readonly displayName: string;
  readonly role: SeedRoleId;
}

export interface SeedGstRegistration {
  /** Synthetic, checksum-valid GSTIN (state 33 = Tamil Nadu). Belongs to no real business. */
  readonly gstin: string;
  readonly companyId: string;
  readonly legalName: string;
}

export type SeedOrgKind = 'company' | 'branch' | 'warehouse' | 'department';

export interface SeedOrgNode {
  readonly nodeId: string;
  readonly kind: SeedOrgKind;
  readonly name: string;
  readonly parentId: string | null;
  readonly companyId?: string;
  readonly gstin?: string;
  /** true → activate after creation (branch/warehouse/company become tradeable); nodes are always
   *  created as drafts first so the real activation guard is exercised. */
  readonly activate: boolean;
}

/** The pilot foundation: who logs in, what is turned on, and the org skeleton everything hangs on. */
export interface PilotFoundation {
  readonly tenantId: string;
  /** The tenant's first owner — laid down via the guarded genesis path (once-only). */
  readonly genesisOwner: SeedUser;
  /** Additional role logins for the pilot/UAT cast (provisioned as tenant onboarding seeds admins). */
  readonly users: readonly SeedUser[];
  /** Optional/paid features the pilot exercises (must be in the platform's OPTIONAL_FEATURES list). */
  readonly entitlements: readonly string[];
  readonly gstRegistrations: readonly SeedGstRegistration[];
  /** Org nodes in dependency order: company before branch before warehouse. */
  readonly org: readonly SeedOrgNode[];
}

const COMPANY_ID = 'pilot-demo-co';
const BRANCH_ID = 'pilot-demo-branch';
const WAREHOUSE_ID = 'pilot-demo-wh';
/** Synthetic checksum-valid GSTIN (state 33 Tamil Nadu) — verified against packages/org validateGstin. */
export const PILOT_DEMO_GSTIN = '33AABCS1429B1Z1';
const LEGAL_NAME = 'SRE Pilot Demo Retail Pvt Ltd (demo)';

export const PILOT_FOUNDATION: PilotFoundation = {
  tenantId: PILOT_DEMO_TENANT,
  genesisOwner: { userId: 'pilot-owner', displayName: 'Pilot Owner (demo)', role: 'owner' },
  users: [
    { userId: 'pilot-manager', displayName: 'Pilot Store Manager (demo)', role: 'store_manager' },
    { userId: 'pilot-cashier', displayName: 'Pilot Cashier (demo)', role: 'cashier' },
    { userId: 'pilot-accountant', displayName: 'Pilot Accountant (demo)', role: 'accountant' },
    { userId: 'pilot-ca', displayName: 'Pilot Chartered Accountant (demo)', role: 'chartered_accountant' },
    { userId: 'pilot-platform-admin', displayName: 'Pilot Platform Admin (demo)', role: 'platform_admin' },
  ],
  entitlements: ['loyalty', 'delivery', 'dept.concession'],
  gstRegistrations: [
    { gstin: PILOT_DEMO_GSTIN, companyId: COMPANY_ID, legalName: LEGAL_NAME },
  ],
  org: [
    { nodeId: COMPANY_ID, kind: 'company', name: LEGAL_NAME, parentId: null, activate: true },
    {
      nodeId: BRANCH_ID, kind: 'branch', name: 'SRE Pilot Demo Hypermarket — Branch 1 (demo)',
      parentId: COMPANY_ID, companyId: COMPANY_ID, gstin: PILOT_DEMO_GSTIN, activate: true,
    },
    {
      nodeId: WAREHOUSE_ID, kind: 'warehouse', name: 'Pilot Demo Backstore Warehouse (demo)',
      parentId: BRANCH_ID, companyId: COMPANY_ID, activate: true,
    },
  ],
};

/** The pilot branch id later slices scope stock, tills and orders to. */
export const PILOT_DEMO_BRANCH = BRANCH_ID;
export const PILOT_DEMO_WAREHOUSE = WAREHOUSE_ID;
export const PILOT_DEMO_COMPANY = COMPANY_ID;

// ── Slice 4b: catalogue + tax/HSN + prices ────────────────────────────────────
// A small, realistic mini-catalogue: a non-regulated household category and a
// regulated food category (so the food-safety publish gate is exercised), each HSN
// carrying a tax-rate schedule, each product carrying a barcode and a governed price
// (below MRP, above cost — no approval needed), and two products a pack hierarchy.

export type SeedRegulatedKind = 'food' | 'packed' | 'weighed' | 'age_restricted' | 'drug' | 'hazardous';

/** Mirrors the catalogue `Category` shape passed inline to the product-publish route. */
export interface SeedCategory {
  readonly categoryId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly regulated?: readonly SeedRegulatedKind[];
}

export interface SeedTaxRate {
  readonly hsnCode: string;
  /** YYYY-MM-DD. */
  readonly effectiveFrom: string;
  /** Basis points, e.g. 500 = 5%. */
  readonly rateBps: number;
}

export interface SeedSafety {
  readonly allergens?: readonly string[];
  readonly countryOfOrigin?: string;
  readonly storageConditions?: string;
  readonly netQuantity?: string;
  readonly packerDetails?: string;
  readonly minimumAge?: number;
}

export interface SeedBarcode {
  readonly code: string;
  readonly kind: 'gtin' | 'ean' | 'upc' | 'internal' | 'case' | 'embedded';
}

export interface SeedPackLevel {
  readonly level: string;
  /** Count of the level below (the base level is 1). */
  readonly containsMinor: number;
}

export interface SeedPrice {
  readonly priceMinor: number;
  readonly mrpMinor: number;
  readonly costMinor: number;
  readonly currency: string;
  readonly marginFloorBps: number;
}

export interface SeedProduct {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly baseUom: string;
  readonly primaryCategoryId: string;
  /** HSN / tax class code — matches one of the tax-rate schedules below. */
  readonly taxClass: string;
  readonly lifecycle: 'new' | 'active' | 'clearance';
  readonly brand?: string;
  readonly safety?: SeedSafety;
  readonly barcode?: SeedBarcode;
  readonly pack?: { readonly baseUom: string; readonly levels: readonly SeedPackLevel[] };
  readonly price: SeedPrice;
}

export interface PilotCatalogue {
  readonly tenantId: string;
  readonly taxRates: readonly SeedTaxRate[];
  readonly categories: readonly SeedCategory[];
  readonly products: readonly SeedProduct[];
}

const INR = 'INR';
const TAX_FROM = '2026-01-01';

export const PILOT_CATALOGUE: PilotCatalogue = {
  tenantId: PILOT_DEMO_TENANT,
  taxRates: [
    { hsnCode: '34011190', effectiveFrom: TAX_FROM, rateBps: 1800 }, // toiletries 18%
    { hsnCode: '10063020', effectiveFrom: TAX_FROM, rateBps: 500 },  // rice 5%
    { hsnCode: '19053100', effectiveFrom: TAX_FROM, rateBps: 1800 }, // biscuits 18%
    { hsnCode: '15079010', effectiveFrom: TAX_FROM, rateBps: 500 },  // edible oil 5%
  ],
  categories: [
    { categoryId: 'cat-household', name: 'Household (demo)', parentId: null },
    { categoryId: 'cat-food', name: 'Grocery — Food (demo)', parentId: null, regulated: ['food'] },
  ],
  products: [
    {
      productId: 'prod-soap', sku: 'DEMO-SOAP-100', name: 'Demo Bath Soap 100g (demo)',
      baseUom: 'each', primaryCategoryId: 'cat-household', taxClass: '34011190', lifecycle: 'active',
      brand: 'DemoBrand', barcode: { code: '8900000000017', kind: 'ean' },
      pack: { baseUom: 'each', levels: [{ level: 'each', containsMinor: 1 }, { level: 'case', containsMinor: 48 }] },
      price: { priceMinor: 3500, mrpMinor: 4000, costMinor: 2000, currency: INR, marginFloorBps: 0 },
    },
    {
      productId: 'prod-brush', sku: 'DEMO-BRUSH-1', name: 'Demo Toothbrush (demo)',
      baseUom: 'each', primaryCategoryId: 'cat-household', taxClass: '34011190', lifecycle: 'active',
      brand: 'DemoBrand', barcode: { code: '8900000000116', kind: 'ean' },
      price: { priceMinor: 2500, mrpMinor: 3000, costMinor: 1500, currency: INR, marginFloorBps: 0 },
    },
    {
      productId: 'prod-rice', sku: 'DEMO-RICE-1KG', name: 'Demo Ponni Rice 1kg (demo)',
      baseUom: 'kg', primaryCategoryId: 'cat-food', taxClass: '10063020', lifecycle: 'active',
      brand: 'DemoBrand',
      safety: { allergens: [], countryOfOrigin: 'India', storageConditions: 'Store in a cool, dry place' },
      barcode: { code: '8900000000123', kind: 'ean' },
      price: { priceMinor: 6800, mrpMinor: 7500, costMinor: 5000, currency: INR, marginFloorBps: 0 },
    },
    {
      productId: 'prod-biscuit', sku: 'DEMO-BISCUIT-200', name: 'Demo Marie Biscuits 200g (demo)',
      baseUom: 'each', primaryCategoryId: 'cat-food', taxClass: '19053100', lifecycle: 'active',
      brand: 'DemoBrand',
      safety: { allergens: ['wheat', 'milk'], countryOfOrigin: 'India', storageConditions: 'Store in a cool, dry place' },
      barcode: { code: '8900000000130', kind: 'ean' },
      pack: { baseUom: 'each', levels: [{ level: 'each', containsMinor: 1 }, { level: 'case', containsMinor: 24 }] },
      price: { priceMinor: 3000, mrpMinor: 3500, costMinor: 1800, currency: INR, marginFloorBps: 0 },
    },
    {
      productId: 'prod-oil', sku: 'DEMO-OIL-1L', name: 'Demo Sunflower Oil 1L (demo)',
      baseUom: 'litre', primaryCategoryId: 'cat-food', taxClass: '15079010', lifecycle: 'active',
      brand: 'DemoBrand',
      safety: { allergens: [], countryOfOrigin: 'India', storageConditions: 'Store away from direct sunlight' },
      barcode: { code: '8900000000147', kind: 'ean' },
      price: { priceMinor: 12000, mrpMinor: 13500, costMinor: 9000, currency: INR, marginFloorBps: 0 },
    },
  ],
};
