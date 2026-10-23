// OB-288 wave 3 · customer, loyalty, CRM and the online cart — head office's wiring for this package. One line in
// `main.ts` calls `customerCommerceSurface(surface, …)`; everything below adds routes or rebuilds an existing route in
// place with more of the shop's own facts behind it. Each rebuilt route keeps its path and permission; a target route
// that is missing throws at start-up — a step that silently does not happen is the failure P-08 forbids.
//
//   • M16-FR-04 — the customer's record shows the service desk's own cases (complaints first), and segmentation counts
//     the complaints the desk actually recorded, not only ones typed in by hand.
//   • M17-FR-01 (OB-295) — the loyalty programme's tiers and points expiry: owner settings kept as facts, OFF and "not set"
//     until entered; the tier multiplier applied when a bill earns (`withLoyaltyTiers`, one wrap in main.ts); the expiry
//     run on the ops worker's timer (`customerCommerceSweep`) and on demand.

import { createHash } from 'node:crypto';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { LoyaltyTier, LedgerMovement } from '../../../packages/loyalty/src/index';
import { loyaltyProgrammeRoutes, runPointsExpiry, tierMultiplierAt, type LoyaltyProgrammeDeps, type ProgrammeSetting } from '../../customer/src/loyalty-programme';
import type { LoyaltyEffectsDeps } from '../../customer/src/loyalty-effects';
import type { MemberRecord } from '../../customer/src/loyalty-members';
import type { RecordedPointsMovement } from '../../customer/src/index';
import type { Route } from '../../kernel/src/index';
import { customer360Routes, complaintFactsOf, type ServiceCaseFact } from '../../customer/src/customer-360';
import { segmentRoutes } from '../../customer/src/segments';
import type { ComplaintFact } from '../../../packages/customer/src/index';
import { customer360Adapter, segmentDataAdapter, serviceCaseAdapter, customerAdapter, STREAM, streamName } from './adapters';
import { customerOverviewRoutes } from '../../customer/src/customer-overview';
import { customerOverviewAdapter } from './r4-insight-adapters';

export interface CustomerCommerceInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
}

const unwiredProgramme = (now: () => string): LoyaltyProgrammeDeps => ({
  now, tiers: async () => undefined, recordTiers: async () => {}, expiry: async () => undefined, recordExpiry: async () => {},
  allMembers: async () => [], spendBetween: async () => 0, movements: async () => [], pointsVersion: async () => 0, recordExpiryMovement: async () => {},
});

function replace(surface: Route[], method: string, path: string, change: (r: Route) => Route): void {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`customer-commerce wiring cannot find ${method} ${path} — the step it adds would silently not happen`);
  surface[at] = change(surface[at]!);
}

/** Every route of `fresh` replaces the route with the same method and path on the surface (keeping its permission). */
function rebuildInPlace(surface: Route[], fresh: readonly Route[], only?: (r: Route) => boolean): void {
  for (const f of fresh) {
    if (only !== undefined && !only(f)) continue;
    replace(surface, f.method, f.path, (r) => ({ ...f, permission: r.permission, ...(r.entitlement === undefined ? {} : { entitlement: r.entitlement }) }));
  }
}

// ── M16-FR-04 · the service desk's cases on the customer's record ───────────────────────────────────────────────────

/** The desk's cases naming one customer, as the record shows them. */
export function casesOfCustomer(input: { readonly store: EventStore; readonly now: () => string }) {
  return async (tenantId: string, customerRef: string): Promise<readonly ServiceCaseFact[]> =>
    (await serviceCaseAdapter(input).serviceCases(tenantId))
      .filter((c) => c.customerRef === customerRef)
      .map((c): ServiceCaseFact => ({
        caseId: c.caseId, customerRef: c.customerRef, kind: c.kind, state: c.state, priority: c.priority, summary: c.summary, openedAt: c.openedAt,
        ...(c.orderRef === undefined ? {} : { orderRef: c.orderRef }),
        ...(c.resolvedAt === undefined ? {} : { resolvedAt: c.resolvedAt }),
        ...(c.resolution === undefined ? {} : { resolution: c.resolution }),
      }));
}

/** The complaint facts segmentation reads: the ones typed in (kept) and the desk's own complaints, one per case. */
export function complaintFactsWithCases(input: { readonly store: EventStore; readonly now: () => string }) {
  return async (tenantId: string): Promise<readonly ComplaintFact[]> => {
    const typed = await segmentDataAdapter(input).complaintFacts(tenantId);
    const fromDesk = complaintFactsOf(await serviceCaseAdapter(input).serviceCases(tenantId));
    const seen = new Set(typed.map((c) => c.caseId));
    return [...typed, ...fromDesk.filter((c) => !seen.has(c.caseId))];
  };
}

// ── small event-sourced registers ────────────────────────────────────────────────────────────────────────────────────

type Base = { readonly store: EventStore; readonly now: () => string };
const keyed = (prefix: string, key: string): string => `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;

/** An append-only list of facts of one type on one stream: read oldest first, appended once per key. */
function factList<T>(store: EventStore, stream: string, type: string) {
  return {
    all: async (tenantId: string): Promise<readonly T[]> => (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T),
    append: async (tenantId: string, key: string, payload: T, at: string): Promise<void> => {
      await store.append(tenantId, stream, makeEvent({ id: keyed(type, `${tenantId}|${key}`), type, occurredAt: at, idempotencyKey: `${type}-${tenantId}-${key}`, source: 'api/customer-commerce', payload }));
    },
  };
}

// ── M17-FR-01 · OB-295 · tiers and points expiry ─────────────────────────────────────────────────────────────────────

const PROGRAMME = streamName(STREAM.loyalty, 'programme');
const MEMBERS = streamName(STREAM.loyalty, 'members');

export function loyaltyProgrammeAdapter(input: Base): LoyaltyProgrammeDeps {
  const { store, now } = input;
  const tiers = factList<ProgrammeSetting<readonly LoyaltyTier[]>>(store, PROGRAMME, 'LoyaltyTiersSet');
  const expiry = factList<ProgrammeSetting<number | null>>(store, PROGRAMME, 'LoyaltyPointsExpirySet');
  const customers = customerAdapter(input);
  const c360 = customer360Adapter(input);
  const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
  return {
    now,
    tiers: async (t) => last(await tiers.all(t)),
    recordTiers: (t, v) => tiers.append(t, `v${v.version}`, v, v.setAt),
    expiry: async (t) => last(await expiry.all(t)),
    recordExpiry: (t, v) => expiry.append(t, `v${v.version}`, v, v.setAt),
    allMembers: async (t) => (await store.readStream(t, MEMBERS, { type: 'LoyaltyMember' })).map((e) => e.event.payload as MemberRecord),
    // The member's own bills and what came back against them, from the customer facts derived from the banked sales.
    spendBetween: async (t, memberRef, from, to) => {
      await c360.catchUp(t);
      const bought = (await c360.purchasesOf(t, memberRef)).filter((p) => p.at >= from && p.at < to).reduce((n, p) => n + p.grossMinor, 0);
      const back = (await c360.returnsOf(t, memberRef)).filter((r) => r.at >= from && r.at < to).reduce((n, r) => n + r.refundMinor, 0);
      return Math.max(0, bought - back);
    },
    movements: async (t, memberRef) => (await store.readStream(t, streamName(STREAM.loyalty, memberRef), { type: 'PointsMovement' }))
      .map((e) => e.event.payload as RecordedPointsMovement)
      .map((m): LedgerMovement => ({ movementId: m.movementId, delta: m.delta, reason: m.reason, at: m.at, sourceRef: m.sourceRef })),
    pointsVersion: (t, memberRef) => store.guardVersion(t, `points:${memberRef}`),
    recordExpiryMovement: async (t, memberRef, m, version) => customers.recordPointsMovement(t, memberRef, { movementId: m.movementId, customerId: memberRef, delta: m.delta, reason: 'expiry', sourceRef: m.sourceRef, at: m.at }, version),
  };
}

/** OB-295: a bill earns its tier's multiplier — the one wrap `main.ts` puts round the loyalty effects. */
export function withLoyaltyTiers<D extends LoyaltyEffectsDeps>(effects: D, input: Base): D {
  const programme = loyaltyProgrammeAdapter(input);
  return { ...effects, tierAt: (t: string, memberRef: string, at: string) => tierMultiplierAt(programme, t, memberRef, at) };
}

/**
 * The package's work on the ops worker's timer, for one shop: the points expiry (OB-295; nothing moves while it is off).
 * Answers how many things it did.
 */
export function customerCommerceSweep(input: Base): (tenantId: string, at: string) => Promise<number> {
  return async (tenantId) => {
    const expired = await runPointsExpiry(loyaltyProgrammeAdapter(input), tenantId);
    return expired.expired.length;
  };
}

/** The package on the head-office surface. Called once by `buildSurface`, before the API manifest is taken. */
export function customerCommerceSurface(surface: Route[], input: CustomerCommerceInput): void {
  const { store, now } = input;
  if (store !== undefined) {
    const base = { store, now };
    // M16-FR-04: the record shows the desk's cases; segments count the desk's complaints.
    rebuildInPlace(surface, customer360Routes({ ...customer360Adapter(base), casesOf: casesOfCustomer(base) }), (r) => r.path === '/v1/customers/:customerRef/profile');
    rebuildInPlace(surface, segmentRoutes({
      now, ...segmentDataAdapter(base),
      orderFacts: async (t: string) => { await customer360Adapter(base).catchUp(t); return segmentDataAdapter(base).orderFacts(t); },
      complaintFacts: complaintFactsWithCases(base),
    }), (r) => r.method === 'GET');
    rebuildInPlace(surface, customerOverviewRoutes({ ...customerOverviewAdapter(base), complaintFacts: complaintFactsWithCases(base) }));
  }
  // M17-FR-01 · OB-295: the programme's two owner settings, a member's standing, and the expiry run.
  surface.push(...loyaltyProgrammeRoutes(store === undefined ? unwiredProgramme(now) : loyaltyProgrammeAdapter({ store, now })));
}
