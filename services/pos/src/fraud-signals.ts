// API-05 cross-domain fraud signals (M15-FR-02 / A07 / AI-NFR-12). Where the anomaly rules watch the
// till, this watches the four places value leaves the business with no cashier touching anything —
// coupons, loyalty points, cash on delivery, and what suppliers charge. Two constraints are the whole
// point and they are the engine's:
//   • A SIGNAL IS NOT A VERDICT — every finding is a reason to look, carrying its evidence and the
//     transactions behind it; nothing is blocked, suspended, cancelled or reversed (hard rule #5).
//   • THE THRESHOLD IS ALWAYS THE TENANT'S — the defaults keep a new store safe, and every one is
//     overridable; this surface persists the store's own thresholds and applies them on every evaluate.
//
// The rules are the pure detectors + `prioritiseSignals` in `packages/loss-prevention/src/fraud-signals`
// (a complete engine nothing fed). This surface stores the thresholds and runs a DETECT-ONLY what-if over
// already-synced data, returning the whole fraud layer's output: a single sorted list to read.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  detectCouponAbuse, detectLoyaltyManipulation, detectCodAnomalies, detectSupplierAnomalies, prioritiseSignals,
  type FraudThresholds, type FraudSignal,
  type CouponUse, type LoyaltyMovement, type CodRecord, type SupplierInvoiceLine,
} from '../../../packages/loss-prevention/src/fraud-signals';
import {
  detectDuplicateBankAccounts, holdersBlockedForDuplicate, type BankAccountHolder,
} from '../../../packages/bank-controls/src/duplicate-bank';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isDateLike = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export interface FraudSignalsDeps {
  readonly thresholds: (tenantId: string) => Promise<FraudThresholds> | FraudThresholds;
  readonly recordThresholds: (tenantId: string, thresholds: FraudThresholds) => Promise<void> | void;
  /**
   * The current holder→account references for duplicate-bank detection (M15-FR-03) — folded from
   * the already-captured bank details, each holder's CURRENT account. Masked/tokenised refs only,
   * never a raw account number (PRV).
   */
  readonly bankHolders: (tenantId: string) => Promise<readonly BankAccountHolder[]> | readonly BankAccountHolder[];
  readonly now: () => string;
}

const THRESHOLD_KEYS: readonly (keyof FraudThresholds)[] = [
  'couponUsesPerAccount', 'couponConcentrationPercent', 'couponConcentrationMinimumTotal',
  'loyaltyBurnSpikeMultiple', 'codShortCount', 'codBankingHours',
  'supplierPriceDriftPercent', 'supplierQuantityDriftPercent', 'minimumHistory',
];

const bad = (code: string, whatHappened: string): never => {
  throw apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Fix the request and re-send. Nothing was changed.' });
};

/** Map each raw item through a reader; returns null if any item is malformed. */
function readEach<T>(v: unknown, one: (r: Record<string, unknown>) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const raw of v) {
    const r = rec(raw);
    if (r === null) return null;
    const item = one(r);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}

const readCoupon = (r: Record<string, unknown>): CouponUse | null =>
  isStr(r['useId']) && isStr(r['couponCode']) && isStr(r['accountRef']) && isStr(r['saleId']) && isInt(r['discountMinor']) && isDateLike(r['at'])
    && (r['limitPerAccount'] === undefined || isNonNegInt(r['limitPerAccount']))
    ? { useId: r['useId'], couponCode: r['couponCode'], accountRef: r['accountRef'], saleId: r['saleId'], discountMinor: r['discountMinor'] as number, at: r['at'], ...(isNonNegInt(r['limitPerAccount']) ? { limitPerAccount: r['limitPerAccount'] } : {}) }
    : null;

const readLoyalty = (r: Record<string, unknown>): LoyaltyMovement | null =>
  isStr(r['movementId']) && isStr(r['accountRef']) && (r['kind'] === 'earn' || r['kind'] === 'burn' || r['kind'] === 'reverse') && isInt(r['points']) && isDateLike(r['at'])
    && (r['saleId'] === undefined || isStr(r['saleId'])) && (r['staffId'] === undefined || isStr(r['staffId']))
    ? { movementId: r['movementId'], accountRef: r['accountRef'], kind: r['kind'], points: r['points'] as number, at: r['at'], ...(isStr(r['saleId']) ? { saleId: r['saleId'] } : {}), ...(isStr(r['staffId']) ? { staffId: r['staffId'] } : {}) }
    : null;

const readCod = (r: Record<string, unknown>): CodRecord | null =>
  isStr(r['stopId']) && isStr(r['driverRef']) && isStr(r['orderId']) && isInt(r['expectedMinor']) && isInt(r['collectedMinor']) && isDateLike(r['collectedAt'])
    && (r['bankedAt'] === undefined || isDateLike(r['bankedAt']))
    ? { stopId: r['stopId'], driverRef: r['driverRef'], orderId: r['orderId'], expectedMinor: r['expectedMinor'] as number, collectedMinor: r['collectedMinor'] as number, collectedAt: r['collectedAt'], ...(isDateLike(r['bankedAt']) ? { bankedAt: r['bankedAt'] } : {}) }
    : null;

const readSupplierLine = (r: Record<string, unknown>): SupplierInvoiceLine | null =>
  isStr(r['invoiceId']) && isStr(r['supplierId']) && isStr(r['productId']) && isInt(r['unitPriceMinor']) && isInt(r['quantityMinor']) && isDateLike(r['at'])
    ? { invoiceId: r['invoiceId'], supplierId: r['supplierId'], productId: r['productId'], unitPriceMinor: r['unitPriceMinor'] as number, quantityMinor: r['quantityMinor'] as number, at: r['at'] }
    : null;

export function fraudSignalsRoutes(deps: FraudSignalsDeps): readonly Route[] {
  return [
    {
      // Set the store's own thresholds — the defaults protect a new store, and every one is overridable.
      api: 'API-05', method: 'POST', path: '/v1/fraud-signals/thresholds',
      permission: 'lp.rule.manage', idempotent: true,
      handler: async (ctx) => {
        const b = rec(ctx.body) ?? {};
        const chosen: FraudThresholds = {};
        for (const key of THRESHOLD_KEYS) {
          const v = b[key];
          if (v === undefined) continue;
          if (!isNonNegInt(v)) bad('threshold_not_whole', `Threshold "${key}" must be a whole, non-negative number.`);
          (chosen as Record<string, number>)[key] = v as number;
        }
        await deps.recordThresholds(ctx.tenantId, chosen);
        return { status: 201, body: chosen };
      },
    },
    {
      // The store's thresholds as last set (empty ⇒ the engine's safe defaults apply).
      api: 'API-05', method: 'GET', path: '/v1/fraud-signals/thresholds',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        return { status: 200, body: { thresholds: await deps.thresholds(ctx.tenantId), asAt: deps.now() } };
      },
    },
    {
      // Evaluate whichever already-synced datasets are supplied against the store's thresholds, and return
      // the whole fraud layer's output: one prioritised, detect-only list to read. It computes, never commits.
      api: 'API-05', method: 'POST', path: '/v1/fraud-signals/evaluate',
      permission: 'lp.case.read', idempotent: true,
      handler: async (ctx) => {
        const b = rec(ctx.body);
        if (b === null) bad('not_readable_as_an_evaluation', 'Send the datasets to evaluate (coupons, loyalty, cod and/or supplier).');
        const body = b as Record<string, unknown>;
        const t = await deps.thresholds(ctx.tenantId);
        const signals: FraudSignal[] = [];

        if (body['coupons'] !== undefined) {
          const coupons = readEach(body['coupons'], readCoupon);
          if (coupons === null) bad('not_readable_as_coupons', 'Each coupon use needs a useId, couponCode, accountRef, saleId, whole discountMinor and an "at".');
          signals.push(...detectCouponAbuse(coupons as CouponUse[], t));
        }
        if (body['loyalty'] !== undefined) {
          const loyalty = readEach(body['loyalty'], readLoyalty);
          if (loyalty === null) bad('not_readable_as_loyalty', 'Each loyalty movement needs a movementId, accountRef, kind (earn/burn/reverse), whole points and an "at".');
          signals.push(...detectLoyaltyManipulation(loyalty as LoyaltyMovement[], t));
        }
        if (body['cod'] !== undefined) {
          const cod = readEach(body['cod'], readCod);
          if (cod === null) bad('not_readable_as_cod', 'Each COD record needs a stopId, driverRef, orderId, whole expected/collected minor and a collectedAt.');
          if (!isDateLike(body['at'])) bad('cod_needs_an_at', 'Evaluating COD needs an "at" time, since an unbanked delay is measured against it.');
          signals.push(...detectCodAnomalies(cod as CodRecord[], body['at'] as string, t));
        }
        if (body['supplier'] !== undefined) {
          const s = rec(body['supplier']);
          const lines = s === null ? null : readEach(s['lines'], readSupplierLine);
          const history = s === null ? null : readEach(s['history'] ?? [], readSupplierLine);
          if (lines === null || history === null) bad('not_readable_as_supplier', 'Supplier evaluation needs { lines, history }, each an invoice line with invoiceId, supplierId, productId, whole unit price/quantity and an "at".');
          signals.push(...detectSupplierAnomalies({ lines: lines as SupplierInvoiceLine[], history: history as SupplierInvoiceLine[] }, t));
        }

        return { status: 200, body: { signals: prioritiseSignals(signals), asAt: deps.now() } };
      },
    },
    {
      // Duplicate bank-account detection over the ALREADY-CAPTURED bank details (M15-FR-03) — a
      // mandatory fraud control. Where `evaluate` runs a what-if over data the caller supplies,
      // this runs over the store's real holder→account references: two distinct holders (suppliers)
      // sharing one account is flagged and the money is BLOCKED PENDING REVIEW. Detect-and-hold, not
      // reverse — the block is released by a person, never silently (hard rule #5, §28). The same
      // holder listing an account twice is not a duplicate; only cross-holder sharing is.
      api: 'API-05', method: 'GET', path: '/v1/fraud-signals/duplicate-bank',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const flags = detectDuplicateBankAccounts(await deps.bankHolders(ctx.tenantId));
        return {
          status: 200,
          body: { flags, blocked: [...holdersBlockedForDuplicate(flags)].sort(), asAt: deps.now() },
        };
      },
    },
  ];
}
