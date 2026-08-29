// API-02/POS Self-checkout, scan-and-go and price kiosk (D04 / M12 / M15 / P-01) — the tested
// `packages/self-checkout` engine, on the cloud. Its price-integrity sibling was already wired
// (`services/pricing/src/price-integrity.ts`); these are the three lane DECISIONS that were not.
//
// All three are pure and offline-first by design: the lane supplies the facts it holds (the scanned
// lines, the scale readings, its own clock, its cached price pack) and the engine decides. So these
// routes are STATELESS — no store, no persistence — and the same rule runs at the lane off its pack
// when the internet is not there (hard rule #1). Nothing here commits a sale; it decides which baskets
// need a person, whether a scan-and-go trip walks out, and what a read-only kiosk may quote.
//
// The three controls the engine keeps and these routes carry through unchanged:
//   • an intervention is ASSISTANCE, not an accusation — the customer message is always neutral;
//   • AGE verification is ALWAYS a human, at every lane, whatever any camera claims;
//   • a kiosk that cannot trust its price freshness says "check at the counter", never a stale number.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  assessSelfCheckout, decideScanAndGo, quotePrice,
  type ScannedLine, type LaneMode, type SelfCheckoutPolicy,
} from '../../../packages/self-checkout/src/self-checkout';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegNum = (v: unknown): v is number => isNum(v) && v >= 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isMode = (v: unknown): v is LaneMode => v === 'self_checkout' || v === 'scan_and_go' || v === 'assisted';
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

function readScannedLine(v: unknown): ScannedLine | undefined {
  if (!isObj(v) || !isStr(v['lineId']) || !isStr(v['productId']) || !isStr(v['name'])
    || !isNonNegNum(v['qty']) || !isNonNegInt(v['unitPriceMinor']) || !isStr(v['scannedAt'])) return undefined;
  if (v['observedGrams'] !== undefined && !isNonNegNum(v['observedGrams'])) return undefined;
  if (v['expectedGrams'] !== undefined && !isNonNegNum(v['expectedGrams'])) return undefined;
  if (v['looseProduce'] !== undefined && !isBool(v['looseProduce'])) return undefined;
  if (v['ageRestricted'] !== undefined && !isBool(v['ageRestricted'])) return undefined;
  return {
    lineId: v['lineId'] as string, productId: v['productId'] as string, name: v['name'] as string,
    qty: v['qty'] as number, unitPriceMinor: v['unitPriceMinor'] as number, scannedAt: v['scannedAt'] as string,
    ...(isNonNegNum(v['observedGrams']) ? { observedGrams: v['observedGrams'] } : {}),
    ...(isNonNegNum(v['expectedGrams']) ? { expectedGrams: v['expectedGrams'] } : {}),
    ...(isBool(v['looseProduce']) ? { looseProduce: v['looseProduce'] } : {}),
    ...(isBool(v['ageRestricted']) ? { ageRestricted: v['ageRestricted'] } : {}),
  };
}

function readLines(v: unknown): readonly ScannedLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(readScannedLine);
  return out.some((l) => l === undefined) ? undefined : (out as ScannedLine[]);
}

function readPolicy(v: unknown): SelfCheckoutPolicy | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (!isObj(v)) return 'invalid';
  const numKeys = ['weightToleranceBps', 'looseProducePatternCount', 'voidPatternCount', 'auditAboveMinor', 'auditRateBps', 'minimumAge'] as const;
  for (const k of numKeys) {
    if (v[k] !== undefined && !isNonNegInt(v[k])) return 'invalid';
  }
  const out: Record<string, number> = {};
  for (const k of numKeys) if (isNonNegInt(v[k])) out[k] = v[k] as number;
  return out as SelfCheckoutPolicy;
}

const badBody = (code: string, whatHappened: string) => apiError(400, {
  code, whatHappened, wasItSaved: 'not_saved',
  nextSafeAction: 'Correct the figures and send again — this only decides, it commits no sale.',
});

export function selfCheckoutRoutes(): readonly Route[] {
  return [
    {
      // Assess a self-checkout basket (D04): which lines need a person, and what to say. Risk is scored
      // ACROSS the basket (four loose-produce substitutions is a pattern; one mis-weigh is not), the
      // customer message is neutral, and an age-restricted line ALWAYS blocks for a human. `riskBps` is
      // for the loss-prevention office and is never shown at the lane.
      api: 'API-02', method: 'POST', path: '/v1/self-checkout/assess',
      permission: 'selfcheckout.operate', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['basketId']) || !isStr(b['laneId']) || !isMode(b['mode']) || !isStr(b['at'])) {
          throw badBody('not_readable_as_a_basket', 'A self-checkout assessment needs { basketId, laneId, mode (self_checkout|scan_and_go|assisted), lines[], at, and optional voidedLineIds[], unaccountedGrams, selectedForAudit, policy }.');
        }
        const lines = readLines(b['lines']);
        const policy = readPolicy(b['policy']);
        const voided = b['voidedLineIds'] === undefined ? undefined : strArray(b['voidedLineIds']);
        if (lines === undefined || policy === 'invalid' || (b['voidedLineIds'] !== undefined && voided === undefined)
          || (b['unaccountedGrams'] !== undefined && !isNonNegNum(b['unaccountedGrams']))
          || (b['selectedForAudit'] !== undefined && !isBool(b['selectedForAudit']))) {
          throw badBody('not_readable_as_a_basket', 'Each scanned line needs a lineId, productId, name, whole unitPriceMinor and qty and a scannedAt; policy fields, voidedLineIds, unaccountedGrams and selectedForAudit must be well-formed.');
        }
        return {
          status: 200,
          body: assessSelfCheckout({
            basketId: b['basketId'], laneId: b['laneId'], mode: b['mode'], lines, at: b['at'] as string,
            ...(voided !== undefined ? { voidedLineIds: voided } : {}),
            ...(isNonNegNum(b['unaccountedGrams']) ? { unaccountedGrams: b['unaccountedGrams'] } : {}),
            ...(isBool(b['selectedForAudit']) ? { selectedForAudit: b['selectedForAudit'] } : {}),
            ...(policy !== undefined ? { policy } : {}),
          }),
        };
      },
    },
    {
      // Decide whether a scan-and-go customer walks straight out (D04). Earned trust with an honest
      // sampling rate: trust is withdrawn on a FOUND discrepancy (not a suspicion) and the customer is
      // TOLD; an age-restricted line ends scan-and-go for that trip, full stop.
      api: 'API-02', method: 'POST', path: '/v1/self-checkout/scan-and-go',
      permission: 'selfcheckout.operate', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['basketId']) || !isStr(b['customerId'])
          || !isNonNegInt(b['tripsCompleted']) || !isNonNegInt(b['discrepanciesFound']) || !isBool(b['selectedForAudit'])) {
          throw badBody('not_readable_as_a_scan_and_go', 'A scan-and-go decision needs { basketId, customerId, lines[], whole tripsCompleted and discrepanciesFound, selectedForAudit (boolean) and optional withdrawAfter }.');
        }
        const lines = readLines(b['lines']);
        if (lines === undefined || (b['withdrawAfter'] !== undefined && !isPosInt(b['withdrawAfter']))) {
          throw badBody('not_readable_as_a_scan_and_go', 'Each scanned line must be well-formed and withdrawAfter, when given, a whole number above zero.');
        }
        return {
          status: 200,
          body: decideScanAndGo({
            basketId: b['basketId'], customerId: b['customerId'], lines,
            tripsCompleted: b['tripsCompleted'] as number, discrepanciesFound: b['discrepanciesFound'] as number,
            selectedForAudit: b['selectedForAudit'] as boolean,
            ...(isPosInt(b['withdrawAfter']) ? { withdrawAfter: b['withdrawAfter'] } : {}),
          }),
        };
      },
    },
    {
      // A price-kiosk lookup (M15): read-only, offline-capable, and it ALWAYS says how fresh it is.
      // Beyond the staleness threshold it says "check at the counter" rather than quote a number it does
      // not trust — a kiosk quoting yesterday's promotion is worse than no kiosk.
      api: 'API-02', method: 'POST', path: '/v1/self-checkout/kiosk-quote',
      permission: 'selfcheckout.operate', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['productId']) || !isStr(b['packBuiltAt']) || !isStr(b['at']) || !Array.isArray(b['pack'])) {
          throw badBody('not_readable_as_a_kiosk_quote', 'A kiosk quote needs { productId, pack[{productId,name,priceMinor?}], packBuiltAt, at, and optional staleAfterMinutes }.');
        }
        const pack: { productId: string; name: string; priceMinor?: number }[] = [];
        for (const item of b['pack']) {
          if (!isObj(item) || !isStr(item['productId']) || !isStr(item['name'])
            || (item['priceMinor'] !== undefined && !isNonNegInt(item['priceMinor']))) {
            throw badBody('not_readable_as_a_kiosk_quote', 'Each pack entry needs a productId and name, and priceMinor (when set) a whole number.');
          }
          pack.push({ productId: item['productId'] as string, name: item['name'] as string, ...(isNonNegInt(item['priceMinor']) ? { priceMinor: item['priceMinor'] } : {}) });
        }
        if (b['staleAfterMinutes'] !== undefined && !isNonNegInt(b['staleAfterMinutes'])) {
          throw badBody('not_readable_as_a_kiosk_quote', 'staleAfterMinutes, when given, must be a whole number of minutes.');
        }
        return {
          status: 200,
          body: quotePrice({
            productId: b['productId'], pack, packBuiltAt: b['packBuiltAt'] as string, at: b['at'] as string,
            ...(isNonNegInt(b['staleAfterMinutes']) ? { staleAfterMinutes: b['staleAfterMinutes'] } : {}),
          }),
        };
      },
    },
  ];
}
