// API-06 Customer segmentation & value ranking (M16-FR-02 · PRV/DPDP). Two truths this exists to keep:
//
//   • CONSENT IS TWO PERMISSIONS. Agreeing to be analysed (profiling) is not agreeing to be messaged
//     (marketing). A marketing audience needs BOTH, and a customer who consented to neither is listed as
//     `not_profiled` — present, with the reason — never silently dropped, so a campaign's reach is honest
//     and nobody later "fixes" the smaller list by removing the consent check.
//   • VALUE IS MARGIN, NOT REVENUE. A ₹50,000 cigarette customer at 4% is worth less than a ₹20,000 fresh
//     customer at 30%; the ranking states both so the shop does not chase the wrong one.
//
// The rules are the tested `buildProfile` / `buildAudience` / `rankByValue` in `@sre/customer` (the
// services-run-on-their-tested-engine guardrail). A pure compute over the facts supplied by the caller —
// it writes nothing, and the excluded-for-consent count travels in the answer. Gated `customer.segment.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  buildProfile, buildAudience, rankByValue,
  type OrderFact, type ComplaintFact, type CustomerConsent, type CustomerProfile,
  type ConsentPurpose, type SegmentName, type SegmentPolicy,
} from '../../../packages/customer/src/index';

const PURPOSES: readonly ConsentPurpose[] = ['marketing', 'profiling', 'service'];
const SEGMENTS: readonly SegmentName[] = ['new', 'regular', 'loyal', 'lapsing', 'lapsed', 'not_profiled', 'insufficient_history'];
const CHANNELS = ['store', 'app', 'web', 'phone'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Date.parse(v));

const isOrder = (v: unknown): v is OrderFact =>
  isObj(v) && isStr(v['orderId']) && isStr(v['customerRef']) && isDate(v['at'])
  && isInt(v['netMinor']) && isInt(v['marginMinor']) && (CHANNELS as readonly string[]).includes(v['channel'] as string);
const isComplaint = (v: unknown): v is ComplaintFact =>
  isObj(v) && isStr(v['caseId']) && isStr(v['customerRef']) && isDate(v['at']) && typeof v['resolved'] === 'boolean';
const isConsent = (v: unknown): v is CustomerConsent =>
  isObj(v) && isStr(v['customerRef']) && Array.isArray(v['granted']) && v['granted'].every((g) => PURPOSES.includes(g as ConsentPurpose))
  && (v['withdrawnAt'] === undefined || isDate(v['withdrawnAt']));

// Per-tenant boundaries; each field optional and validated as a non-negative whole number.
function readPolicy(v: unknown): SegmentPolicy | undefined {
  if (v === undefined) return {};
  if (!isObj(v)) return undefined;
  const keys: readonly (keyof SegmentPolicy)[] = ['newBelowOrders', 'loyalAtOrders', 'lapsingAfterDays', 'lapsedAfterDays', 'minimumHistory'];
  const out: Record<string, number> = {};
  for (const k of keys) {
    if (v[k] === undefined) continue;
    if (!isInt(v[k]) || (v[k] as number) < 0) return undefined;
    out[k] = v[k] as number;
  }
  return out as SegmentPolicy;
}

const arrayOf = <T,>(v: unknown, guard: (x: unknown) => x is T): readonly T[] | undefined =>
  v === undefined ? [] : Array.isArray(v) && v.every(guard) ? (v as T[]) : undefined;

// Build one profile per distinct customer named in the facts. `purpose` decides what may be computed —
// the engine returns a non-consenting customer as `not_profiled` for any non-service purpose.
function profilesFrom(orders: readonly OrderFact[], consents: readonly CustomerConsent[], complaints: readonly ComplaintFact[], purpose: ConsentPurpose, asOf: string, policy: SegmentPolicy): readonly CustomerProfile[] {
  const consentByRef = new Map(consents.map((c) => [c.customerRef, c]));
  const refs = [...new Set([...orders.map((o) => o.customerRef), ...consents.map((c) => c.customerRef)])];
  return refs.map((customerRef) => buildProfile({
    customerRef, orders, complaints, ...(consentByRef.get(customerRef) !== undefined ? { consent: consentByRef.get(customerRef) } : {}),
    purpose, asOf, policy,
  }));
}

export interface SegmentDeps {
  readonly now: () => string;
}

export function segmentRoutes(deps: SegmentDeps): readonly Route[] {
  return [
    {
      // A consent-gated campaign audience. Body: { segment, purpose, orders[], consents[], complaints?,
      // policy?, asOf? }. The excluded-for-consent count is ALWAYS in the answer. A pure compute.
      api: 'API-06', method: 'POST', path: '/v1/customer/segments/audience',
      permission: 'customer.segment.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const orders = arrayOf(b['orders'], isOrder);
        const consents = arrayOf(b['consents'], isConsent);
        const complaints = arrayOf(b['complaints'], isComplaint);
        const policy = readPolicy(b['policy']);
        if (!SEGMENTS.includes(b['segment'] as SegmentName) || !PURPOSES.includes(b['purpose'] as ConsentPurpose)
          || orders === undefined || consents === undefined || complaints === undefined || policy === undefined
          || (b['asOf'] !== undefined && !isDate(b['asOf']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_audience_request',
            whatHappened: 'An audience needs { segment, purpose (marketing/profiling/service), orders[], consents[], complaints?, policy?, asOf? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the facts to segment over. A read never writes.',
          });
        }
        const purpose = b['purpose'] as ConsentPurpose;
        const asOf = isDate(b['asOf']) ? b['asOf'] as string : deps.now();
        const profiles = profilesFrom(orders, consents, complaints, purpose, asOf, policy);
        const audience = buildAudience({ segment: b['segment'] as SegmentName, purpose, profiles, consents });
        return { status: 200, body: audience };
      },
    },
    {
      // The most valuable customers by MARGIN, not revenue (both stated). Body: { orders[], consents?,
      // complaints?, top?, purpose?, policy?, asOf? }. Non-profiled customers are excluded from the rank.
      api: 'API-06', method: 'POST', path: '/v1/customer/segments/value-ranking',
      permission: 'customer.segment.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const orders = arrayOf(b['orders'], isOrder);
        const consents = arrayOf(b['consents'], isConsent);
        const complaints = arrayOf(b['complaints'], isComplaint);
        const policy = readPolicy(b['policy']);
        const top = b['top'];
        if (orders === undefined || consents === undefined || complaints === undefined || policy === undefined
          || (top !== undefined && (!isInt(top) || (top as number) <= 0))
          || (b['purpose'] !== undefined && !PURPOSES.includes(b['purpose'] as ConsentPurpose))
          || (b['asOf'] !== undefined && !isDate(b['asOf']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_ranking_request',
            whatHappened: 'A value ranking needs { orders[], consents?, complaints?, top? (>0), purpose?, policy?, asOf? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the order facts to rank over.',
          });
        }
        const purpose = (b['purpose'] as ConsentPurpose | undefined) ?? 'profiling';
        const asOf = isDate(b['asOf']) ? b['asOf'] as string : deps.now();
        const profiles = profilesFrom(orders, consents, complaints, purpose, asOf, policy);
        const ranking = rankByValue(profiles, isInt(top) ? top : 10);
        return { status: 200, body: { ranking, count: ranking.length } };
      },
    },
  ];
}
