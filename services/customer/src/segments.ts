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
  buildAudience, rankByValue, assembleProfiles,
  type OrderFact, type ComplaintFact, type CustomerConsent, type CustomerProfile,
  type ConsentPurpose, type SegmentName, type SegmentPolicy,
} from '../../../packages/customer/src/index';
import type { ConsentRecord, Channel } from './index';

const CONTACT_CHANNELS = ['whatsapp', 'sms', 'email', 'push', 'post'] as const;

/**
 * Collapse a customer's per-(purpose,channel) consent ledger into the purpose-level shape segmentation
 * reads (M16-FR-02). The ledger is channel-specific (a customer may agree to marketing by SMS but not
 * email); segmentation asks a purpose-level "may we analyse / may we contact for this purpose".
 *
 * The owner-chosen rule: when a `channel` is named, a purpose counts as granted only if the customer's
 * LATEST record for that (purpose, channel) is `given` — so the audience is exactly who is reachable on
 * THAT channel; when no channel is named, it counts as granted if ANY channel's latest record for the
 * purpose is `given` — a general "reachable somehow" targeting view. The binding per-channel check still
 * runs at send time (`mayWeSend`), so this is a pre-filter, never the final permission. Only the two
 * purposes segmentation uses (marketing, profiling) are collapsed; a purpose withdrawn on its own does
 * NOT set `withdrawnAt` (which segmentation treats as a GLOBAL block) — it is simply absent from `granted`.
 */
export function collapseConsent(customerRef: string, records: readonly ConsentRecord[], channel?: Channel): CustomerConsent {
  const purposes: readonly ConsentPurpose[] = ['marketing', 'profiling'];
  const grantedFor = (purpose: ConsentPurpose): boolean => {
    const forPurpose = records.filter((r) => r.purpose === purpose && (channel === undefined || r.channel === channel));
    if (forPurpose.length === 0) return false;
    // Latest-wins per channel, then: this channel is granted iff its latest record is `given`.
    const byChannel = new Map<string, ConsentRecord>();
    for (const r of forPurpose) {
      const seen = byChannel.get(r.channel);
      if (seen === undefined || r.recordedAt >= seen.recordedAt) byChannel.set(r.channel, r);
    }
    // A named channel has at most one entry; without one, ANY channel currently `given` grants it.
    return [...byChannel.values()].some((r) => r.given);
  };
  return { customerRef, granted: purposes.filter(grantedFor) };
}

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
  return assembleProfiles({ orders, complaints, consents, purpose, asOf, policy });
}

export interface SegmentDeps {
  readonly now: () => string;
  /**
   * The tenant's stored segmentation policy (M16-FR-02), or `undefined` when none is set (the engine
   * defaults then apply). An audience/ranking query with no `policy` in its body reads THIS, so a shop
   * segments to its own definition of new/loyal/lapsing rather than re-supplying it on every call.
   */
  readonly policy: (tenantId: string) => Promise<SegmentPolicy | undefined> | SegmentPolicy | undefined;
  /** Record the tenant's segmentation policy — latest applies. */
  readonly recordPolicy: (tenantId: string, policy: SegmentPolicy) => Promise<void> | void;
  /** Every stored order fact for the tenant — the customer BEHAVIOUR the stateful segmentation reads (M16-FR-02). */
  readonly orderFacts: (tenantId: string) => Promise<readonly OrderFact[]> | readonly OrderFact[];
  /** Every stored complaint fact for the tenant. */
  readonly complaintFacts: (tenantId: string) => Promise<readonly ComplaintFact[]> | readonly ComplaintFact[];
  /** Persist an order fact (latest-per-orderId). */
  readonly recordOrderFact: (tenantId: string, fact: OrderFact) => Promise<void> | void;
  /** Persist a complaint fact (latest-per-caseId). */
  readonly recordComplaintFact: (tenantId: string, fact: ComplaintFact) => Promise<void> | void;
  /** A customer's consent ledger (per purpose+channel) — the SAME record the send-gate reads (P-02). */
  readonly consentFor: (tenantId: string, customerRef: string) => Promise<readonly ConsentRecord[]> | readonly ConsentRecord[];
}

/** Gather the CustomerConsent for every customer named in the facts, folded from the stored ledger. */
async function consentsFor(deps: SegmentDeps, tenantId: string, refs: readonly string[], channel?: Channel): Promise<readonly CustomerConsent[]> {
  return Promise.all(refs.map(async (ref) => collapseConsent(ref, await deps.consentFor(tenantId, ref), channel)));
}

/**
 * The effective policy for a request: the body's own policy when it supplied one, otherwise the tenant's
 * STORED policy, otherwise the engine defaults ({}). Returns `undefined` only when the body carried a
 * policy that could not be read — the one case the route must refuse.
 */
async function effectivePolicy(deps: SegmentDeps, tenantId: string, body: Record<string, unknown>): Promise<SegmentPolicy | 'invalid'> {
  if (body['policy'] !== undefined) {
    const p = readPolicy(body['policy']);
    return p === undefined ? 'invalid' : p;
  }
  return (await deps.policy(tenantId)) ?? {};
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
        const policy = await effectivePolicy(deps, ctx.tenantId, b);
        if (!SEGMENTS.includes(b['segment'] as SegmentName) || !PURPOSES.includes(b['purpose'] as ConsentPurpose)
          || orders === undefined || consents === undefined || complaints === undefined || policy === 'invalid'
          || (b['asOf'] !== undefined && !isDate(b['asOf']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_audience_request',
            whatHappened: 'An audience needs { segment, purpose (marketing/profiling/service), orders[], consents[], complaints?, policy?, asOf? }. Omit policy to use the tenant\'s stored one.',
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
        const policy = await effectivePolicy(deps, ctx.tenantId, b);
        const top = b['top'];
        if (orders === undefined || consents === undefined || complaints === undefined || policy === 'invalid'
          || (top !== undefined && (!isInt(top) || (top as number) <= 0))
          || (b['purpose'] !== undefined && !PURPOSES.includes(b['purpose'] as ConsentPurpose))
          || (b['asOf'] !== undefined && !isDate(b['asOf']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_ranking_request',
            whatHappened: 'A value ranking needs { orders[], consents?, complaints?, top? (>0), purpose?, policy?, asOf? }. Omit policy to use the tenant\'s stored one.',
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
    {
      // Set the tenant's segmentation policy (M16-FR-02) — the boundaries every audience/ranking reads
      // when a request omits its own. A management decision (what counts as loyal for THIS shop), so it is
      // gated one rung above the read: `customer.segment.manage`. Latest applies; an omitted field is the
      // engine default, not zero. Idempotent.
      api: 'API-06', method: 'POST', path: '/v1/customer/segments/policy',
      permission: 'customer.segment.manage', idempotent: true,
      handler: async (ctx) => {
        const policy = readPolicy(ctx.body);
        if (policy === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_segment_policy',
            whatHappened: 'A segmentation policy is { newBelowOrders?, loyalAtOrders?, lapsingAfterDays?, lapsedAfterDays?, minimumHistory? } — each a non-negative whole number. Omit a field to keep the engine default.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the boundaries you want to change. Nothing was set.',
          });
        }
        await deps.recordPolicy(ctx.tenantId, policy);
        return { status: 201, body: { policy, note: 'This applies to every audience and value ranking that does not carry its own policy.' } };
      },
    },
    {
      // Read the tenant's stored segmentation policy — {} (all engine defaults) when none is set. A read.
      api: 'API-06', method: 'GET', path: '/v1/customer/segments/policy',
      permission: 'customer.segment.read',
      handler: async (ctx) => {
        const policy = (await deps.policy(ctx.tenantId)) ?? {};
        return { status: 200, body: { policy, set: (await deps.policy(ctx.tenantId)) !== undefined } };
      },
    },
    {
      // Record a customer's order as a segmentation FACT (M16-FR-02) — the behaviour the stateful buckets
      // read. `orderId` from the path (a re-send supersedes on it); the customer, value, MARGIN, channel
      // and time from the body. Manager-gated (customer.segment.manage). Idempotent.
      api: 'API-06', method: 'POST', path: '/v1/customer/facts/orders/:orderId',
      permission: 'customer.segment.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const fact = { orderId: ctx.params['orderId'] ?? '', customerRef: b['customerRef'], at: b['at'], netMinor: b['netMinor'], marginMinor: b['marginMinor'], channel: b['channel'] };
        if (!isOrder(fact)) {
          throw apiError(400, { code: 'not_readable_as_an_order_fact', whatHappened: 'An order fact needs { customerRef, at (date), netMinor (whole), marginMinor (whole), channel (store/app/web/phone) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the order fields. Nothing was recorded.' });
        }
        await deps.recordOrderFact(ctx.tenantId, fact);
        return { status: 201, body: { orderId: fact.orderId, customerRef: fact.customerRef } };
      },
    },
    {
      // Record a customer complaint as a segmentation fact — an unresolved complaint tempers a value ranking.
      api: 'API-06', method: 'POST', path: '/v1/customer/facts/complaints/:caseId',
      permission: 'customer.segment.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const fact = { caseId: ctx.params['caseId'] ?? '', customerRef: b['customerRef'], at: b['at'], resolved: b['resolved'] };
        if (!isComplaint(fact)) {
          throw apiError(400, { code: 'not_readable_as_a_complaint_fact', whatHappened: 'A complaint fact needs { customerRef, at (date), resolved (boolean) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the complaint fields. Nothing was recorded.' });
        }
        await deps.recordComplaintFact(ctx.tenantId, fact);
        return { status: 201, body: { caseId: fact.caseId, customerRef: fact.customerRef } };
      },
    },
    {
      // The STATEFUL audience (M16-FR-02) — the counterpart to the POST what-if. Runs over the tenant's
      // STORED order/complaint facts + STORED policy + the STORED consent ledger, so a shop asks "who is
      // my loyal-customer audience?" of its own data. Consent is collapsed per the owner-chosen rule
      // (`?channel=` → that contact channel exactly; omit → reachable on any channel). Gated segment.read.
      api: 'API-06', method: 'GET', path: '/v1/customer/segments/audience',
      permission: 'customer.segment.read',
      handler: async (ctx) => {
        const rawChannel = ctx.query['channel'];
        if (!SEGMENTS.includes(ctx.query['segment'] as SegmentName) || !PURPOSES.includes(ctx.query['purpose'] as ConsentPurpose)
          || (ctx.query['asOf'] !== undefined && !isDate(ctx.query['asOf']))
          || (rawChannel !== undefined && !(CONTACT_CHANNELS as readonly string[]).includes(rawChannel))) {
          throw apiError(400, { code: 'not_readable_as_an_audience_query', whatHappened: 'Query: ?segment=&purpose=(marketing/profiling/service)&channel=(whatsapp/sms/email/push/post, optional)&asOf=(optional).', wasItSaved: 'not_saved', nextSafeAction: 'A read never writes; correct the query.' });
        }
        const channel = rawChannel as Channel | undefined;
        const purpose = ctx.query['purpose'] as ConsentPurpose;
        const asOf = isDate(ctx.query['asOf']) ? ctx.query['asOf'] : deps.now();
        const orders = await deps.orderFacts(ctx.tenantId);
        const complaints = await deps.complaintFacts(ctx.tenantId);
        const refs = [...new Set(orders.map((o) => o.customerRef))];
        const consents = await consentsFor(deps, ctx.tenantId, refs, channel);
        const profiles = profilesFrom(orders, consents, complaints, purpose, asOf, (await deps.policy(ctx.tenantId)) ?? {});
        return { status: 200, body: buildAudience({ segment: ctx.query['segment'] as SegmentName, purpose, profiles, consents }) };
      },
    },
    {
      // The STATEFUL value ranking — most valuable customers by MARGIN (not revenue), over the STORED
      // facts + consent (profiling) + policy. Non-profiled customers are excluded. Gated segment.read.
      api: 'API-06', method: 'GET', path: '/v1/customer/segments/value-ranking',
      permission: 'customer.segment.read',
      handler: async (ctx) => {
        const top = ctx.query['top'];
        if ((top !== undefined && !(Number.isInteger(Number(top)) && Number(top) > 0))
          || (ctx.query['asOf'] !== undefined && !isDate(ctx.query['asOf']))) {
          throw apiError(400, { code: 'not_readable_as_a_ranking_query', whatHappened: 'Query: ?top=(>0, optional)&asOf=(optional).', wasItSaved: 'not_saved', nextSafeAction: 'A read never writes; correct the query.' });
        }
        const asOf = isDate(ctx.query['asOf']) ? ctx.query['asOf'] : deps.now();
        const orders = await deps.orderFacts(ctx.tenantId);
        const complaints = await deps.complaintFacts(ctx.tenantId);
        const refs = [...new Set(orders.map((o) => o.customerRef))];
        const consents = await consentsFor(deps, ctx.tenantId, refs);
        const profiles = profilesFrom(orders, consents, complaints, 'profiling', asOf, (await deps.policy(ctx.tenantId)) ?? {});
        const ranking = rankByValue(profiles, top !== undefined ? Number(top) : 10);
        return { status: 200, body: { ranking, count: ranking.length } };
      },
    },
  ];
}
