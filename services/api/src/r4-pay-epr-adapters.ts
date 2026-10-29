// R4 Lane 1 — pay and EPR registers (C19 · C15 · C16 · B20 · B21 · B22). Head-office wiring only; the rules live in the
// packages (`packages/payroll` legal settings, contributions, overtime, minimum wage, particulars and the statutory
// payslip; `packages/epr`). Every register is append-only on its own stream (hard rules #2, #6); reads fold the streams.
// `r4PayEprRoutes` is the lane's one registration in main.ts; `r4PayslipHooks` is spread into the existing payslip-issue
// registration it extends (the C15 particulars check).
//
// Nothing here approves, locks or releases a pay run or builds a bank file (OB-209), and nothing is filed on the CPCB
// portal (OB-212).

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import {
  foldPayrollLegalSettings, localDate, payslipsLateForPayDate,
  type PayrollLegalSettings, type PayrollLegalSettingChange, type RecordedContributionTotals, type PayslipLateException, type ParticularsList,
} from '../../../packages/payroll/src/index';
import type { OwnBrandDeclaration, UnitsMovement, EprSettingChange, Recycler, TakeBack, Handover, TakeBackCount, AssetNotEWaste, DisposedAsset } from '../../../packages/epr/src/index';
import { statutoryPayRoutes, type StatutoryPayDeps, type PreparedPayslip } from '../../finance/src/statutory-pay';
import type { IssuedPayslip } from '../../finance/src/payslip-store';
import { foldAssets, type FixedAssetFact } from '../../finance/src/budgets-assets';
import { eprRoutes, type EprDeps } from '../../compliance/src/epr-store';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import type { Movement } from '../../inventory/src/index';
import { STREAM, streamName, rosterStoreAdapter, auditTrailAdapter, alertLifecycleAdapter, effectiveGrants, allIssuedPayslips } from './adapters';
import { hrComplianceAdapter } from './r2-hr-adapters';
import { OWNER_ROLE_ID } from './roles';

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 24);
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
/** Append one fact keyed by `id`; answers the payload as stored (the first under its key stands). */
const put = async <T>(store: EventStore, tenantId: string, stream: string, type: string, id: string, occurredAt: string, payload: T, source: string): Promise<T> => {
  const r = await store.append(tenantId, stream, makeEvent({ id: `${type}-${digest(id)}`, type, occurredAt, idempotencyKey: `${type}-${tenantId}-${digest(id)}`, source, payload }));
  return r.record.event.payload as T;
};

// ── C15 · C16 · C19 · the payroll legal settings and the statutory pay checks ───────────────────────────────────────

const LEGAL_STREAM = streamName(STREAM.payroll, 'legal-settings');
const PREPARED_STREAM = streamName(STREAM.payroll, 'prepared-payslips');
const CONTRIBUTIONS_STREAM = streamName(STREAM.payroll, 'contribution-totals');
const LATE_PAYSLIP_ALERT = 'payslip-late:';

/** The CA's settings as they stand — the latest per figure, class and list over the unset defaults (OB-208). */
export async function payrollLegalSettingsOf(store: EventStore, tenantId: string): Promise<PayrollLegalSettings> {
  return foldPayrollLegalSettings(await all<PayrollLegalSettingChange>(store, tenantId, LEGAL_STREAM, 'PayrollLegalSettingChanged'));
}

/** The store's offset from UTC, as the working-time pack holds it (India +330). */
const offsetOf = async (store: EventStore, now: () => string, tenantId: string): Promise<number> =>
  (await hrComplianceAdapter({ store, now }).settings(tenantId)).utcOffsetMinutes;

/** C15: put each late payslip in every owner's alert inbox, once per payslip (a re-raise of an open alert is the same). */
async function raiseLatePayslipAlerts(store: EventStore, now: () => string, t: string, raise: readonly PayslipLateException[], by: string, at: string) {
  const lifecycle = alertLifecycleAdapter({ store, now });
  const owners = [...new Set((await effectiveGrants(store, t)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
  const live = await lifecycle.alerts(t);
  let raised = 0;
  let alreadyOpen = 0;
  if (owners.length > 0) {
    for (const e of raise) {
      const alertId = `${LATE_PAYSLIP_ALERT}${e.period}:${e.employeeId}`;
      const current = live.find((a) => a.alert.alertId === alertId);
      if (current !== undefined && current.state !== 'cleared') { alreadyOpen += 1; continue; }
      const event: AlertLifecycleEvent = {
        alertId, change: 'raised', by, at,
        alert: {
          alertId, component: `Payslip ${e.period} — ${e.employeeId}`, status: 'degraded',
          ownerUserId: owners[0]!, ownerName: owners[0]!, detail: e.detail, raisedAt: at, ackDueBy: at,
          ...(owners.length > 1 ? { alsoToUserIds: owners.slice(1) } : {}),
        },
      };
      await lifecycle.recordAlertEvent(t, event, `${alertId}|${e.kind}|${current?.clearedAt ?? 'first'}`);
      raised += 1;
    }
  }
  return { raised, alreadyOpen, owners: owners.length };
}

export function statutoryPayAdapter(input: { readonly store: EventStore; readonly now: () => string }): StatutoryPayDeps {
  const { store, now } = input;
  const roster = rosterStoreAdapter({ store, now });
  const hr = hrComplianceAdapter({ store, now });
  const auditTrail = auditTrailAdapter({ store });
  return {
    now,
    settings: (tenantId) => payrollLegalSettingsOf(store, tenantId),
    recordSettingChange: async (tenantId, change, key) => {
      await put(store, tenantId, LEGAL_STREAM, 'PayrollLegalSettingChanged', `${change.target}|${key}`, change.at, change, 'api/hr');
    },
    staff: async (tenantId) => (await roster.roster(tenantId)).employees,
    hoursBetween: async (tenantId, employeeId, from, to) =>
      (await hr.attendanceBetween(tenantId, from, to)).filter((r) => r.employeeId === employeeId).map((r) => ({ date: r.date, hours: r.hours })),
    prepared: async (tenantId, period) => {
      const latest = new Map<string, PreparedPayslip>();
      for (const p of await all<PreparedPayslip>(store, tenantId, PREPARED_STREAM, 'StatutoryPayslipPrepared')) if (p.period === period) latest.set(p.employeeId, p);
      return [...latest.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId));
    },
    recordPrepared: async (tenantId, p, key) => {
      await put(store, tenantId, PREPARED_STREAM, 'StatutoryPayslipPrepared', `${p.employeeId}|${p.period}|${key}`, p.preparedAt, p, 'api/hr');
    },
    issued: async (tenantId, period): Promise<readonly IssuedPayslip[]> => (await allIssuedPayslips(store, tenantId)).filter((p) => p.period === period),
    contributionTotals: async (tenantId, period) =>
      (await all<RecordedContributionTotals>(store, tenantId, CONTRIBUTIONS_STREAM, 'ContributionTotalsRecorded')).filter((t) => t.period === period).at(-1),
    recordContributionTotals: async (tenantId, t, key) => {
      await put(store, tenantId, CONTRIBUTIONS_STREAM, 'ContributionTotalsRecorded', `${t.period}|${key}`, t.at, t, 'api/hr');
    },
    utcOffsetMinutes: (tenantId) => offsetOf(store, now, tenantId),
    raiseOwnerAlerts: (tenantId, exceptions, by, at) => raiseLatePayslipAlerts(store, now, tenantId, exceptions, by, at),
    recordAudit: (tenantId, entry) => auditTrail.recordAudit(tenantId, entry),
  };
}

/**
 * C15 on a timer: raise every payslip late for its pay date — over every month with a payslip prepared — into each
 * owner's alert inbox, once per payslip, exactly as POST /v1/hr/payroll/payslip-exceptions/raise does. Answers how many
 * alerts it newly raised. Shaped for the ops-alert worker's `alsoEachPass` hook (`(tenantId, at) => Promise<number>`);
 * wiring it there is one line in main.ts / ops-alert-sweeps.ts (the coordinator's), until then the raise route does it.
 */
export function payslipLateSweep(input: { readonly store: EventStore; readonly now: () => string }) {
  const deps = statutoryPayAdapter(input);
  return async (tenantId: string, at: string): Promise<number> => {
    const periods = [...new Set((await all<PreparedPayslip>(input.store, tenantId, PREPARED_STREAM, 'StatutoryPayslipPrepared')).map((p) => p.period))].sort();
    const offset = await deps.utcOffsetMinutes(tenantId);
    const today = localDate(input.now(), offset);
    let raised = 0;
    for (const period of periods) {
      const [prepared, issued] = await Promise.all([deps.prepared(tenantId, period), deps.issued(tenantId, period)]);
      const issuedAt = new Map(issued.map((i) => [i.employeeId, i.issuedAt] as const));
      const late = payslipsLateForPayDate({
        today, utcOffsetMinutes: offset,
        expected: prepared.filter((p) => !issued.some((i) => i.employeeId === p.employeeId && i.issuedAt === undefined)).map((p) => ({
          employeeId: p.employeeId, period, payDate: p.payslip.onDate, ...(issuedAt.get(p.employeeId) === undefined ? {} : { issuedAt: issuedAt.get(p.employeeId)! }),
        })),
      });
      raised += (await raiseLatePayslipAlerts(input.store, input.now, tenantId, late, 'system:payslip-pay-date', at)).raised;
    }
    return raised;
  };
}

/**
 * The hook spread into the existing payslip-issue registration (`payslipStoreRoutes` in main.ts): the CA's particulars
 * list, so a payslip missing a listed particular is refused at issue (C15).
 */
export function r4PayslipHooks(input: { readonly store: EventStore }): { readonly particularsList: (tenantId: string) => Promise<ParticularsList> } {
  return { particularsList: async (tenantId) => (await payrollLegalSettingsOf(input.store, tenantId)).particulars };
}

// ── B20 · B21 · B22 · the EPR registers ─────────────────────────────────────────────────────────────────────────────

const EPR_STREAM = streamName(STREAM.compliance, 'epr');
const ASSETS_STREAM = streamName(STREAM.finance, 'fixed-assets');

export function eprAdapter(input: { readonly store: EventStore; readonly now: () => string }): EprDeps {
  const { store, now } = input;
  const auditTrail = auditTrailAdapter({ store });
  const src = 'api/compliance';
  return {
    now,
    today: async (tenantId) => localDate(now(), await offsetOf(store, now, tenantId)),
    settingChanges: (tenantId) => all<EprSettingChange>(store, tenantId, EPR_STREAM, 'EprSettingChanged'),
    recordSetting: async (tenantId, c, key) => { await put(store, tenantId, EPR_STREAM, 'EprSettingChanged', `${c.key}|${key}`, c.at, c, src); },
    declarations: (tenantId) => all<OwnBrandDeclaration>(store, tenantId, EPR_STREAM, 'OwnBrandDeclared'),
    recordDeclaration: async (tenantId, d, key) => { await put(store, tenantId, EPR_STREAM, 'OwnBrandDeclared', `${d.productId}|${key}`, d.at, d, src); },
    unitsMovements: async (tenantId): Promise<readonly UnitsMovement[]> => {
      // Receipts and production outputs from the stock ledger — the units put on the market. Read only; this register
      // never writes to the stock ledger.
      const offset = await offsetOf(store, now, tenantId);
      return (await all<Movement>(store, tenantId, STREAM.inventory, 'InventoryMoved'))
        .filter((m) => m.kind === 'received' || m.kind === 'produced')
        .map((m) => ({ productId: m.productId, kind: m.kind as 'received' | 'produced', quantityMinor: m.quantityMinor, uom: m.uom, date: localDate(m.occurredAt, offset) }));
    },
    recyclers: (tenantId) => all<Recycler>(store, tenantId, EPR_STREAM, 'EprRecyclerRecorded'),
    recordRecycler: async (tenantId, r, key) => { await put(store, tenantId, EPR_STREAM, 'EprRecyclerRecorded', `${r.recyclerId}|${key}`, r.at, r, src); },
    takeBacks: (tenantId) => all<TakeBack>(store, tenantId, EPR_STREAM, 'EprTakeBackRecorded'),
    recordTakeBack: (tenantId, t) => put(store, tenantId, EPR_STREAM, 'EprTakeBackRecorded', t.takeBackId, t.at, t, src),
    handovers: (tenantId) => all<Handover>(store, tenantId, EPR_STREAM, 'EprHandoverRecorded'),
    recordHandover: (tenantId, h) => put(store, tenantId, EPR_STREAM, 'EprHandoverRecorded', h.handoverId, h.at, h, src),
    counts: (tenantId) => all<TakeBackCount>(store, tenantId, EPR_STREAM, 'EprTakeBackCounted'),
    recordCount: (tenantId, c) => put(store, tenantId, EPR_STREAM, 'EprTakeBackCounted', c.countId, c.at, c, src),
    disposedAssets: async (tenantId): Promise<readonly DisposedAsset[]> =>
      foldAssets(await all<FixedAssetFact>(store, tenantId, ASSETS_STREAM, 'FixedAssetFact'))
        .filter((a) => a.disposal !== null)
        .map((a) => ({ assetId: a.assetId, name: a.name, category: a.category, disposedOn: a.disposal!.on })),
    notEWaste: (tenantId) => all<AssetNotEWaste>(store, tenantId, EPR_STREAM, 'EprAssetNotEWaste'),
    recordNotEWaste: (tenantId, n) => put(store, tenantId, EPR_STREAM, 'EprAssetNotEWaste', n.assetId, n.at, n, src),
    recordAudit: (tenantId, entry) => auditTrail.recordAudit(tenantId, entry),
  };
}

// ── the lane's routes, registered once in main.ts ───────────────────────────────────────────────────────────────────

export function r4PayEprRoutes(input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): readonly Route[] {
  const { store, now } = input;
  const audit = input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit };
  if (store === undefined) {
    // No durable store: the routes are still declared (so the surface documents them), but every read and write answers
    // 503 by name — never a silent empty register or a write that pretends it was kept (P-08).
    const absent = <T extends object>(): T => new Proxy({ now } as object, {
      get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop] : () => {
        throw apiError(503, { code: 'register_store_not_available', whatHappened: 'Head office is running without its durable store, so the pay and EPR registers cannot be read or written.', wasItSaved: 'not_saved', nextSafeAction: 'Start head office with its database. Nothing was read or saved.' });
      }),
    }) as T;
    return [...statutoryPayRoutes(absent<StatutoryPayDeps>()), ...eprRoutes(absent<EprDeps>())];
  }
  return [
    ...statutoryPayRoutes({ ...statutoryPayAdapter({ store, now }), ...audit }),
    ...eprRoutes({ ...eprAdapter({ store, now }), ...audit }),
  ];
}
