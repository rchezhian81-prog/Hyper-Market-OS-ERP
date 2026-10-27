// OB-288 P4 — multi-tenant SaaS and controlled rollout: head office's wiring (M36-FR-01/03 · D12-FR-05/06 · R8-2 · R8-9 ·
// C8 · C9 · owner decisions OB-316, OB-321 and OB-324 of 23 Oct 2026).
//
//   1. ROLLOUT SWITCHES per branch and per till lane (R8-9 · OB-316): governed like the shop's other switches (reason,
//      version, preview, one-step rollback, the owner's approval when high-impact), and carried in each store's signed
//      pack (`rolloutPackSection`) so the till reads its own lane's switch offline.
//   2. USAGE METERING per shop for information (M36-FR-01 · OB-321): stores, lanes, users and AI spend, recorded hourly by
//      the ops-alert worker (`saasRolloutSweep`); price "not set". A plan change is judged before it happens, and one that
//      switches features off needs them named.
//   3. TENANT CLOSURE (M36-FR-03 · D12-FR-05): every export a person takes is recorded; closure needs a complete one, is
//      asked by IT and approved by the owner, and revokes every grant in the same atomic write — nothing is deleted.
//   4. CONSENT-MANAGER EXPORT/IMPORT (C8) over the one consent ledger, and the CUSTOMER-DATA VOLUME WATCH (C9) with the
//      CA's threshold ("not set" until entered; never fires unset), raised to every owner on the worker's timer.
//
// Composition: `saasRolloutSurface(surface, …)` is the one line in `main.ts`; it adds the routes and wraps two existing
// ones in place (the subscribe route — the plan-change guard; the export route — the export is recorded). A wrapped
// route that is missing throws at start-up: a control that silently guards nothing is the failure P-08 forbids.

import { createHash } from 'node:crypto';
import { InMemoryEventStore, type EventStore, type BatchEntry } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { Plan } from '../../../packages/platform/src/plans';
import { rolloutSection, type RolloutChange, type RolloutSection } from '../../../packages/platform/src/rollout';
import type { TenantExport } from '../../../packages/platform/src/lifecycle';
import type { LedgerConsent } from '../../../packages/customer/src/consent-manager-format';
import { SandboxRecurringBillingProvider } from '../../../packages/platform/src/billing-provider';
import { rolloutRoutes } from '../../platform/src/rollout';
import { meteringRoutes, guardPlanChange, recordUsageHour, type MeteringDeps, type UsageSnapshot, type LiveFigures } from '../../platform/src/metering';
import { tenantLifecycleRoutes, exportTakenOf, type ExportTaken, type TenantClosedRecord, type TenantLifecycleDeps } from '../../platform/src/tenant-lifecycle';
import { consentManagerRoutes, type ConsentImportException } from '../../customer/src/consent-manager';
import { dataVolumeWatchRoutes, runVolumeWatch, VOLUME_ALERT_PREFIX, type DataVolumeDeps, type VolumeThreshold } from '../../customer/src/data-volume-watch';
import type { ConsentRecord } from '../../customer/src/index';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import type { MemberRecord } from '../../customer/src/loyalty-members';
import { MACHINE_ROLE_IDS } from '../../identity/src/separation-of-duties';
import {
  STREAM, streamName, effectiveGrants, ROLE_REVOKED, orgStructureAdapter, deviceRegistryAdapter, approvalRequestsAdapter,
  alertLifecycleAdapter, legalHoldsAdapter, customerAdapter, segmentDataAdapter, billingAdapter,
} from './adapters';
import { OWNER_ROLE_ID } from './roles';
import { twoSignatureAdapter } from './gates-adapters'; // OB-407: the OB-330 security-reviewer register
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
export interface SaasRolloutInput {
  readonly store?: EventStore;
  readonly now: () => string;
  /** R1b · R1c (M01-FR-02): the tenant calendar — every business date these routes read is the shop's. */
  readonly calendar?: ShopCalendarOf;
  /** The subscription plans on offer (main.ts's, the owner's OA-12 plans). */
  readonly plans: readonly Plan[];
  readonly recordAudit?: Recorder;
}
type Base = { readonly store: EventStore; readonly now: () => string; readonly plans: readonly Plan[]; readonly recordAudit?: Recorder };

export const ROLLOUT_STREAM = streamName(STREAM.platform, 'rollout');
const METERING_STREAM = streamName(STREAM.platform, 'metering');
const LIFECYCLE_STREAM = streamName(STREAM.platform, 'tenant-lifecycle');
const CM_EXCEPTIONS_STREAM = streamName(STREAM.customer, 'consent-manager-exceptions');
const VOLUME_STREAM = streamName(STREAM.privacy, 'data-volume-thresholds');
const LOYALTY_MEMBERS_STREAM = streamName(STREAM.loyalty, 'members');
const ORDER_FACTS_STREAM = streamName(STREAM.customer, 'order-facts');
/** Roles held by parties outside the business: not the shop's staff users (M36 metering counts staff). */
const OUTSIDE_PARTY_ROLES: ReadonlySet<string> = new Set(['customer', 'supplier', 'b2b_customer']);

/** OB-321: the fields white-label may set — the name, the logo, the colours (tenantId is the caller's, never the body's). */
export const WHITE_LABEL_FIELDS: ReadonlySet<string> = new Set(['tenantId', 'productName', 'legalName', 'logoRef', 'faviconRef', 'colours']);

const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 20);

// ── 1. rollout ─────────────────────────────────────────────────────────────────────────────────────────────────────

const rolloutChanges = (store: EventStore, tenantId: string) => payloads<RolloutChange>(store, tenantId, ROLLOUT_STREAM, 'RolloutSwitchSet');

/** The store pack's rollout section for a store — always sent once wired, so a till can tell "nothing on" from "not told". */
export function rolloutPackSection(input: { readonly store: EventStore }): (tenantId: string, storeId: string) => Promise<RolloutSection> {
  return async (tenantId, storeId) => rolloutSection(await rolloutChanges(input.store, tenantId), storeId);
}

function rolloutAdapter(input: Base) {
  const { store, now } = input;
  const reviewerRegister = twoSignatureAdapter({ store, now }).twoSignature;
  return {
    changes: (tenantId: string) => rolloutChanges(store, tenantId),
    recordChange: async (tenantId: string, change: RolloutChange & { readonly version: number }) => {
      const place = `${change.key}:${change.branchId}:${change.laneId ?? ''}`;
      await store.append(tenantId, ROLLOUT_STREAM, makeEvent({
        id: `rollout-${digest(place)}-v${change.version}`, type: 'RolloutSwitchSet', occurredAt: change.changedAt,
        // The place and its version: two people setting the same place's version N at once are one fact, not two.
        idempotencyKey: `rollout-${tenantId}-${digest(place)}-v${change.version}`, source: 'api/platform', payload: change as unknown as Record<string, unknown>,
      }));
    },
    branches: async (tenantId: string) => (await orgStructureAdapter({ store, now }).nodes(tenantId)).filter((n) => n.kind === 'branch').map((n) => ({ branchId: n.nodeId, status: n.status })),
    lanes: async (tenantId: string) => (await deviceRegistryAdapter({ store, now }).fleet(tenantId))
      .filter((d) => d.kind === 'pos_lane' && d.status !== 'retired' && d.branchId !== '').map((d) => ({ branchId: d.branchId, laneId: d.deviceId })),
    approvals: approvalRequestsAdapter({ store, now }),
    // OB-407: the security reviewer named under OB-330 — read from the very register the risk acceptance reads — and whether
    // the person who approved holds the owner's role, from their own grants (never the request).
    securityReviewer: (tenantId: string) => reviewerRegister.reviewer(tenantId),
    isOwner: (tenantId: string, userId: string) => reviewerRegister.isOwner(tenantId, userId),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    now,
  };
}

// ── 2. metering ────────────────────────────────────────────────────────────────────────────────────────────────────

async function liveFigures(input: Base, tenantId: string, month: string): Promise<LiveFigures> {
  const { store, now } = input;
  const [nodes, fleet, grants, costs] = await Promise.all([
    orgStructureAdapter({ store, now }).nodes(tenantId),
    deviceRegistryAdapter({ store, now }).fleet(tenantId),
    effectiveGrants(store, tenantId),
    store.readStream(tenantId, STREAM.ai, { type: 'AiRunCosted' }),
  ]);
  return {
    stores: nodes.filter((n) => n.kind === 'branch' && n.status === 'active').length,
    lanes: fleet.filter((d) => d.kind === 'pos_lane' && d.status !== 'retired').length,
    users: new Set(grants.filter((g) => !MACHINE_ROLE_IDS.includes(g.roleId) && !OUTSIDE_PARTY_ROLES.has(g.roleId)).map((g) => g.userId)).size,
    aiSpendMinor: costs.filter((e) => e.event.occurredAt.startsWith(month)).reduce((t, e) => t + ((e.event.payload as { costMinor?: number }).costMinor ?? 0), 0),
  };
}

function meteringAdapter(input: Base): MeteringDeps {
  const { store, now } = input;
  return {
    live: (tenantId, month) => liveFigures(input, tenantId, month),
    snapshots: (tenantId) => payloads<UsageSnapshot>(store, tenantId, METERING_STREAM, 'UsageMetered'),
    recordSnapshot: async (tenantId, s) => {
      await store.append(tenantId, METERING_STREAM, makeEvent({
        id: `usage-${s.hour}`, type: 'UsageMetered', occurredAt: s.at,
        idempotencyKey: `usage-${tenantId}-${s.hour}`, source: 'api/platform', payload: s as unknown as Record<string, unknown>,
      }));
    },
    // The plan the shop is on: the SAME billing adapter and fold the subscription route reads (P-02); no provider call.
    currentPlanId: async (tenantId) => {
      const snap = await billingAdapter({ store, now, provider: new SandboxRecurringBillingProvider(), plans: input.plans }).subscription(tenantId);
      return snap === undefined || (snap.endsOn !== undefined && snap.endsOn < shopDateIn(now())) ? undefined : snap.planId;
    },
    plans: () => input.plans,
    now,
  };
}

// ── 3. closure ─────────────────────────────────────────────────────────────────────────────────────────────────────

function lifecycleAdapter(input: Base): TenantLifecycleDeps {
  const { store, now } = input;
  return {
    exports: (tenantId) => payloads<ExportTaken>(store, tenantId, LIFECYCLE_STREAM, 'TenantExportTaken'),
    closure: async (tenantId) => (await payloads<TenantClosedRecord>(store, tenantId, LIFECYCLE_STREAM, 'TenantClosed'))[0],
    lastBusinessRecordOn: async (tenantId) => {
      // The newest sale the shop holds, or — conservatively — today when it holds none (books are kept from the close).
      const sale = await store.latestOfType(tenantId, STREAM.sales, 'SaleCommitted');
      return shopDateIn(sale?.event.occurredAt ?? now()); // R1c: the shop's date
    },
    liveHolds: async (tenantId) => (await legalHoldsAdapter({ store, now }).holds(tenantId)).filter((h) => h.liftedAt === undefined).map((h) => ({ holdId: h.holdId, reason: h.reason })),
    recordClosure: async (tenantId, record) => {
      const grants = await effectiveGrants(store, tenantId);
      const entries: BatchEntry[] = [
        { stream: LIFECYCLE_STREAM, event: makeEvent({ id: record.closureId, type: 'TenantClosed', occurredAt: record.at, idempotencyKey: `tenant-closed-${tenantId}`, source: 'api/platform', payload: { ...record, grantsRevoked: grants.length } as unknown as Record<string, unknown> }) },
        // Every grant revoked in the SAME write: access ends on the next request, through the one fold every check reads.
        ...grants.map((g, i) => ({ stream: STREAM.identity, event: makeEvent({
          id: `revoke-closure-${tenantId}-${i}`, type: ROLE_REVOKED, occurredAt: record.at,
          idempotencyKey: `revoke-${tenantId}-closure-${i}`, source: 'api/platform',
          payload: { userId: g.userId, roleId: g.roleId, branchScope: g.branchScope, provenance: { kind: 'tenant_closure', closureId: record.closureId, approvedBy: record.approvedBy } },
        }) })),
      ];
      await store.appendBatch(tenantId, entries);
      return grants.length;
    },
    approvals: approvalRequestsAdapter({ store, now }),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    now,
  };
}

// ── 4. consent manager (C8) and the volume watch (C9) ──────────────────────────────────────────────────────────────

/** Every consent fact the shop holds (one principal's stream, or — for a whole-shop export — every principal's). */
async function consentLedger(store: EventStore, tenantId: string, ref?: string): Promise<readonly LedgerConsent[]> {
  const toFact = (e: { readonly event: { readonly id: string; readonly payload: unknown } }): LedgerConsent => ({ eventId: e.event.id, ...(e.event.payload as ConsentRecord) });
  if (ref !== undefined) return (await store.readStream(tenantId, streamName(STREAM.consent, ref), { type: 'ConsentRecorded' })).map(toFact);
  // A whole-shop export is a deliberate full read (consent lives in one stream per customer); it removes nothing.
  return (await store.exportTenant(tenantId)).filter((r) => r.event.type === 'ConsentRecorded' && r.stream.startsWith(streamName(STREAM.consent, ''))).map(toFact);
}

function volumeAdapter(input: Base): DataVolumeDeps {
  const { store, now } = input;
  const lifecycle = alertLifecycleAdapter({ store, now });
  return {
    thresholds: (tenantId) => payloads<VolumeThreshold>(store, tenantId, VOLUME_STREAM, 'DataVolumeThresholdSet'),
    recordThreshold: async (tenantId, t) => {
      await store.append(tenantId, VOLUME_STREAM, makeEvent({ id: `data-volume-threshold-v${t.version}`, type: 'DataVolumeThresholdSet', occurredAt: t.setAt, idempotencyKey: `data-volume-threshold-${tenantId}-v${t.version}`, source: 'api/customer', payload: t as unknown as Record<string, unknown> }));
    },
    sources: async (tenantId) => {
      const members = new Map<string, MemberRecord>();
      for (const m of await payloads<MemberRecord>(store, tenantId, LOYALTY_MEMBERS_STREAM, 'LoyaltyMember')) members.set(m.memberRef, m);
      // Online customers on the order record — the erased ones read as anonymous references and are not counted.
      const online = (await segmentDataAdapter({ store, now }).orderFacts(tenantId)).map((o) => o.customerRef);
      const raw = new Set((await payloads<{ customerRef: string }>(store, tenantId, ORDER_FACTS_STREAM, 'CustomerOrderFactRecorded')).map((o) => o.customerRef));
      return [
        { source: 'loyalty members (not left)', refs: [...members.values()].filter((m) => m.status === 'member').map((m) => m.memberRef) },
        { source: 'online customers on the order record', refs: online.filter((r) => raw.has(r)) },
      ];
    },
    raiseOwnerAlert: async (tenantId, a) => {
      const owners = [...new Set((await effectiveGrants(store, tenantId)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
      if (owners.length === 0) return false;
      const live = (await lifecycle.alerts(tenantId)).find((x) => x.alert.alertId === a.alertId);
      if (live !== undefined && live.state !== 'cleared') return false;
      const event: AlertLifecycleEvent = {
        alertId: a.alertId, change: 'raised', by: 'system:data-volume-watch', at: a.at,
        alert: { alertId: a.alertId, component: 'Customer data volume (DPDP)', status: 'degraded', ownerUserId: owners[0]!, ownerName: owners[0]!, detail: a.detail, raisedAt: a.at, ackDueBy: a.at, ...(owners.length > 1 ? { alsoToUserIds: owners.slice(1) } : {}) },
      };
      await lifecycle.recordAlertEvent(tenantId, event, `${a.alertId}|${live?.clearedAt ?? 'first'}`);
      return true;
    },
    clearOwnerAlert: async (tenantId, prefix, at, detail) => {
      let cleared = 0;
      for (const x of await lifecycle.alerts(tenantId)) {
        if (!x.alert.alertId.startsWith(prefix) || x.state === 'cleared') continue;
        await lifecycle.recordAlertEvent(tenantId, { alertId: x.alert.alertId, change: 'cleared', by: 'system:data-volume-watch', at, detail }, `${x.alert.alertId}|cleared|${at}`);
        cleared += 1;
      }
      return cleared;
    },
    now,
  };
}

// ── the composition ────────────────────────────────────────────────────────────────────────────────────────────────

function indexOf(surface: readonly Route[], method: string, path: string): number {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`P4 SaaS wiring cannot find ${method} ${path} — the control it adds would silently not happen`);
  return at;
}
const wrap = (surface: Route[], method: string, path: string, around: (inner: Route['handler']) => Route['handler']): void => {
  const at = indexOf(surface, method, path);
  surface[at] = { ...surface[at]!, handler: around(surface[at]!.handler) };
};

export function saasRolloutSurface(surface: Route[], raw: SaasRolloutInput): void {
  const input: Base = { store: raw.store ?? new InMemoryEventStore(), now: raw.now, plans: raw.plans, ...(raw.recordAudit === undefined ? {} : { recordAudit: raw.recordAudit }) };
  const { store, now } = input;
  const metering = meteringAdapter(input);
  surface.push(...rolloutRoutes(rolloutAdapter(input)));
  surface.push(...meteringRoutes(metering));
  surface.push(...tenantLifecycleRoutes({ ...lifecycleAdapter(input), ...(raw.calendar === undefined ? {} : { calendar: raw.calendar }) }));
  surface.push(...consentManagerRoutes({
    ledger: (t, ref) => consentLedger(store, t, ref),
    appendConsent: async (t, r) => { await customerAdapter({ store, now }).appendConsent(t, r); },
    exceptions: (t) => payloads<ConsentImportException>(store, t, CM_EXCEPTIONS_STREAM, 'ConsentImportException'),
    recordException: async (t, e) => {
      await store.append(t, CM_EXCEPTIONS_STREAM, makeEvent({ id: `cm-exception-${digest(e.exceptionId)}`, type: 'ConsentImportException', occurredAt: e.at, idempotencyKey: `cm-exception-${t}-${digest(e.exceptionId)}`, source: 'api/customer', payload: e as unknown as Record<string, unknown> }));
    },
    fiduciaryName: async (t) => [...(await orgStructureAdapter({ store, now }).registrations(t))].sort((a, b) => a.gstin.localeCompare(b.gstin))[0]?.legalName,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    now,
  }));
  surface.push(...dataVolumeWatchRoutes(volumeAdapter(input)));

  // OB-321 (owner, 23 Oct 2026, in writing): white-label covers the NAME, the LOGO and the COLOURS only — terminology,
  // document wording and the rest are refused by name before anything is validated or stored (M36-FR-02 · D12-FR-06).
  wrap(surface, 'PUT', '/v1/platform/branding', (inner) => async (ctx) => {
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const outside = Object.keys(b).filter((k) => !WHITE_LABEL_FIELDS.has(k)).sort();
    if (outside.length > 0) {
      throw apiError(422, {
        code: 'outside_the_white_label_scope',
        whatHappened: `White-label covers the name, the logo and the colours only (OB-321); ${outside.join(', ')} cannot be changed here.`,
        wasItSaved: 'not_saved', nextSafeAction: 'Send only productName, legalName, logoRef, faviconRef and colours. Nothing was stored.',
      });
    }
    return inner(ctx);
  });
  // A plan change that switches features off goes through only with those features named (M36-FR-01).
  wrap(surface, 'POST', '/v1/platform/subscription', (inner) => guardPlanChange(inner, metering));
  // Every export a person takes is recorded (manifest only) — the closure reads the latest (M36-FR-03).
  wrap(surface, 'GET', '/v1/platform/export', (inner) => async (ctx) => {
    const out = await inner(ctx);
    const manifest = (out.body as { export?: TenantExport } | null)?.export;
    if (out.status === 200 && manifest !== undefined) {
      const taken = exportTakenOf(manifest);
      await store.append(ctx.tenantId, LIFECYCLE_STREAM, makeEvent({
        id: `export-taken-${digest(taken.exportId)}`, type: 'TenantExportTaken', occurredAt: now(),
        idempotencyKey: `export-taken-${ctx.tenantId}-${digest(taken.exportId)}`, source: 'api/platform', payload: taken as unknown as Record<string, unknown>,
      }));
    }
    return out;
  });
}

/** The ops-alert worker's pass for this package: the hourly usage record, and the customer-data volume watch. */
export function saasRolloutSweep(raw: { readonly store: EventStore; readonly now: () => string; readonly plans: readonly Plan[] }): (tenantId: string, at: string) => Promise<number> {
  const input: Base = { store: raw.store, now: raw.now, plans: raw.plans };
  const metering = meteringAdapter(input);
  const volume = volumeAdapter(input);
  return async (tenantId, at) => {
    const recorded = await recordUsageHour(metering, tenantId, at);
    const watch = await runVolumeWatch(volume, tenantId, at);
    return (recorded ? 1 : 0) + (watch.raised ? 1 : 0) + watch.cleared;
  };
}

export { VOLUME_ALERT_PREFIX };
