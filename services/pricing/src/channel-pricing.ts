// D-19 (R3, OB-148 "A", signed sentence OB-190) — zone / channel pricing, BUILT AND SWITCHED OFF.
//
// "The till, app and delivery all charge the same shelf price. Channel prices are built but switched off. Switching one on
// needs a second person's approval, and a report lists any price difference between channels."
//
//   GET  /v1/prices/channel-pricing                              every switch and its state (all OFF until switched on)
//   POST /v1/prices/channel-pricing/requests/:requestId          ask to switch a channel (or zone pricing) on or off
//   POST /v1/prices/channel-pricing/requests/:requestId/approve  a SECOND person approves switching it on
//   POST /v1/prices/zones/:zoneId/stores/:storeId                the store → zone (cluster) register
//   GET  /v1/prices/zones
//   GET  /v1/prices/channel-differences?storeId=&at=             every product whose app / delivery / zone price differs from the shelf
//
// The rule: a switch is `channel:<name>` (one per channel, e.g. `channel:app`, `channel:delivery`) or `zone`. It is OFF
// unless an approved request turned it on. While a switch is off, a price-list entry for it is REFUSED at the write
// (`channel_pricing_switched_off`) and any such entry already on file is NOT RESOLVED — the resolver falls back to the
// shelf price, so every channel charges the shelf price. Switching ON needs a second person who holds
// `price.change.approve` and is not the person who asked (§28). Switching OFF is immediate (it returns to one price,
// the safe direction) and is recorded the same way. Every change is an append-only event (hard rule #2).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { resolvePrice, type PriceEntry, type PriceScope } from '../../../packages/price-list/src/price-list';
import type { AuditEntry } from '../../../packages/audit/src/index';

export type SwitchState = 'off' | 'on';

export interface ChannelSwitchRequest {
  readonly requestId: string;
  readonly subject: string;
  readonly to: SwitchState;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly status: 'pending' | 'applied';
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
}

export interface ZoneMembership { readonly storeId: string; readonly zoneId: string; readonly setBy: string; readonly setAt: string }

export interface ChannelPricingDeps {
  readonly now: () => string;
  readonly requests: (tenantId: string) => Promise<readonly ChannelSwitchRequest[]>;
  /** Append a state of a request (one event per state). */
  readonly recordRequest: (tenantId: string, r: ChannelSwitchRequest) => Promise<void>;
  readonly zones: (tenantId: string) => Promise<readonly ZoneMembership[]>;
  readonly recordZone: (tenantId: string, z: ZoneMembership) => Promise<void>;
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  /** Every product with a price list, and its entries. */
  readonly priceLists: (tenantId: string) => Promise<readonly { readonly productId: string; readonly entries: readonly PriceEntry[] }[]>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** The channels a report compares with the shelf (the till's in-store channel IS the shelf price). */
export const REPORTED_CHANNELS = Object.freeze(['app', 'delivery'] as const);
export const switchOf = (scope: PriceScope, scopeRef: string): string | undefined => (scope === 'channel' ? `channel:${scopeRef}` : scope === 'zone' ? 'zone' : undefined);
const SUBJECT = /^(channel:[a-z0-9_-]{1,40}|zone)$/;

/** The switches that are on: the latest APPLIED request per subject decides; none → off. */
export function switchesOn(requests: readonly ChannelSwitchRequest[]): ReadonlySet<string> {
  const latest = new Map<string, SwitchState>();
  for (const r of [...requests].filter((x) => x.status === 'applied').sort((a, b) => ((a.approvedAt ?? a.requestedAt) < (b.approvedAt ?? b.requestedAt) ? -1 : 1))) latest.set(r.subject, r.to);
  return new Set([...latest].filter(([, s]) => s === 'on').map(([k]) => k));
}

/** Only the entries the switches allow: a channel or zone entry whose switch is off is not resolved. */
export function gatedEntries(entries: readonly PriceEntry[], on: ReadonlySet<string>): readonly PriceEntry[] {
  return entries.filter((e) => { const s = switchOf(e.scope, e.scopeRef); return s === undefined || on.has(s); });
}

/** The gate the price-list routes ask: is this scope's switch on? (store and customer scopes have no switch.) */
export function channelPricingGate(deps: Pick<ChannelPricingDeps, 'requests' | 'zones'>) {
  return {
    channelPricingOn: async (tenantId: string, scope: PriceScope, scopeRef: string): Promise<boolean> => {
      const s = switchOf(scope, scopeRef);
      return s === undefined || switchesOn(await deps.requests(tenantId)).has(s);
    },
    allowedEntries: async (tenantId: string, entries: readonly PriceEntry[]): Promise<readonly PriceEntry[]> => gatedEntries(entries, switchesOn(await deps.requests(tenantId))),
    zoneOfStore: async (tenantId: string, storeId: string): Promise<string | undefined> => (await deps.zones(tenantId)).filter((z) => z.storeId === storeId).at(-1)?.zoneId,
  };
}

const latestRequests = (rs: readonly ChannelSwitchRequest[]): ChannelSwitchRequest[] => { const m = new Map<string, ChannelSwitchRequest>(); for (const r of rs) m.set(r.requestId, r); return [...m.values()]; };
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const bad = (code: string, what: string): never => { throw apiError(400, { code, whatHappened: what, wasItSaved: 'not_saved', nextSafeAction: 'Correct the request. Nothing was changed.' }); };

export function channelPricingRoutes(deps: ChannelPricingDeps): readonly Route[] {
  const audit = async (tenantId: string, actorId: string, action: string, r: ChannelSwitchRequest, branchId: string | null) => {
    await deps.recordAudit?.(tenantId, {
      actorId, action, objectType: 'channel_pricing_switch', objectId: r.subject, at: r.approvedAt ?? r.requestedAt,
      origin: { tenantId, branchId }, before: null,
      after: { to: r.to, status: r.status, requestedBy: r.requestedBy, approvedBy: r.approvedBy ?? '' }, reason: r.reason, correlationId: r.requestId,
    });
  };
  return [
    {
      api: 'API-02', method: 'GET', path: '/v1/prices/channel-pricing',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const rs = latestRequests(await deps.requests(ctx.tenantId));
        const on = switchesOn(rs);
        const subjects = [...new Set([...REPORTED_CHANNELS.map((c) => `channel:${c}`), 'zone', ...rs.map((r) => r.subject)])].sort();
        return {
          status: 200,
          body: {
            switches: subjects.map((s) => ({ subject: s, state: on.has(s) ? 'on' : 'off' })),
            pending: rs.filter((r) => r.status === 'pending'),
            samePriceEverywhere: on.size === 0,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-02', method: 'POST', path: '/v1/prices/channel-pricing/requests/:requestId',
      permission: 'price.change.propose', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (requestId === '' || !isStr(b['subject']) || !SUBJECT.test(b['subject']) || (b['to'] !== 'on' && b['to'] !== 'off') || !isStr(b['reason'])) {
          bad('not_readable_as_a_switch_request', 'A switch request needs { subject: "channel:<name>" or "zone", to: "on" | "off", reason }.');
        }
        const prior = latestRequests(await deps.requests(ctx.tenantId)).find((r) => r.requestId === requestId);
        if (prior !== undefined) return { status: 200, body: { request: prior, alreadyRecorded: true } };
        const at = deps.now();
        const to = b['to'] as SwitchState;
        // Switching OFF returns to one price everywhere — applied at once. Switching ON waits for a second person.
        const r: ChannelSwitchRequest = {
          requestId, subject: b['subject'] as string, to, reason: (b['reason'] as string).trim(), requestedBy: ctx.userId, requestedAt: at,
          status: to === 'off' ? 'applied' : 'pending', approvedBy: null, approvedAt: to === 'off' ? at : null,
        };
        await deps.recordRequest(ctx.tenantId, r);
        await audit(ctx.tenantId, ctx.userId, `channel_pricing.${to === 'off' ? 'switch_off' : 'request_on'}`, r, ctx.branchId ?? null);
        return { status: to === 'off' ? 200 : 202, body: { request: r, ...(to === 'on' ? { needs: 'a second person holding price.change.approve' } : {}) } };
      },
    },
    {
      api: 'API-02', method: 'POST', path: '/v1/prices/channel-pricing/requests/:requestId/approve',
      permission: 'price.change.approve', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) bad('not_readable_as_an_approval', 'An approval needs { reason }.');
        const r = latestRequests(await deps.requests(ctx.tenantId)).find((x) => x.requestId === requestId);
        if (r === undefined) throw apiError(404, { code: 'switch_request_unknown', whatHappened: `No switch request ${requestId} is on file.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the request id.' });
        if (r.status === 'applied') return { status: 200, body: { request: r, alreadyApplied: true } };
        if (r.requestedBy === ctx.userId) throw apiError(422, { code: 'self_approval', whatHappened: `${ctx.userId} asked for this switch and cannot approve it (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'A different person who may approve prices must approve it. Nothing was changed.' });
        const at = deps.now();
        const applied: ChannelSwitchRequest = { ...r, status: 'applied', approvedBy: ctx.userId, approvedAt: at };
        await deps.recordRequest(ctx.tenantId, applied);
        await audit(ctx.tenantId, ctx.userId, 'channel_pricing.switch_on', applied, ctx.branchId ?? null);
        return { status: 200, body: { request: applied } };
      },
    },
    {
      api: 'API-02', method: 'POST', path: '/v1/prices/zones/:zoneId/stores/:storeId',
      permission: 'price.zone.manage', idempotent: true,
      handler: async (ctx) => {
        const zoneId = (ctx.params['zoneId'] ?? '').trim(); const storeId = (ctx.params['storeId'] ?? '').trim();
        if (zoneId === '' || storeId === '') bad('not_readable_as_a_zone', 'A zone membership needs the zone and the store in the path.');
        const z: ZoneMembership = { storeId, zoneId, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordZone(ctx.tenantId, z);
        return { status: 201, body: { zone: z } };
      },
    },
    {
      api: 'API-02', method: 'GET', path: '/v1/prices/zones',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const latest = new Map<string, ZoneMembership>();
        for (const z of await deps.zones(ctx.tenantId)) latest.set(z.storeId, z);
        return { status: 200, body: { stores: [...latest.values()], asAt: deps.now() } };
      },
    },
    {
      api: 'API-02', method: 'GET', path: '/v1/prices/channel-differences',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const storeId = (ctx.query['storeId'] ?? '').trim();
        const at = ctx.query['at'] ?? deps.now();
        if (storeId === '' || Number.isNaN(Date.parse(at))) bad('not_readable_as_a_difference_query', 'The report needs ?storeId= and optionally ?at=<ISO time>.');
        const gate = channelPricingGate(deps);
        const zoneId = await gate.zoneOfStore(ctx.tenantId, storeId);
        const on = switchesOn(await deps.requests(ctx.tenantId));
        const differences: { productId: string; channel: string; shelfPriceMinor: number | null; channelPriceMinor: number; entryId: string }[] = [];
        const dormant: { productId: string; scope: string; scopeRef: string; entryId: string; priceMinor: number; switch: string }[] = [];
        for (const { productId, entries } of await deps.priceLists(ctx.tenantId)) {
          const shelf = resolvePrice(entries.filter((e) => e.scope === 'store'), { productId, at, storeId });
          const allowed = gatedEntries(entries, on);
          for (const channel of REPORTED_CHANNELS) {
            const r = resolvePrice(allowed, { productId, at, storeId, channel, ...(zoneId === undefined ? {} : { zoneId }) });
            if (r !== null && (shelf === null || r.price.minor !== shelf.price.minor)) {
              differences.push({ productId, channel, shelfPriceMinor: shelf?.price.minor ?? null, channelPriceMinor: r.price.minor, entryId: r.id });
            }
          }
          // Entries on file whose switch is off: kept, not charged anywhere — listed so nothing is hidden.
          for (const e of entries) {
            const s = switchOf(e.scope, e.scopeRef);
            if (s !== undefined && !on.has(s) && e.status === 'active') dormant.push({ productId, scope: e.scope, scopeRef: e.scopeRef, entryId: e.id, priceMinor: e.price.minor, switch: s });
          }
        }
        return { status: 200, body: { storeId, at, zoneId: zoneId ?? null, switchesOn: [...on].sort(), differences, dormantEntries: dormant, samePriceEverywhere: differences.length === 0, asAt: deps.now() } };
      },
    },
  ];
}
