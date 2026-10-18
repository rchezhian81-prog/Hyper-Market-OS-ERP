// API-09 GST controls (R3 lane 1) — the three switches and the one number the GST returns run under, and the CA's list of
// reverse-charge heads. Each is an append-only fact with who changed it, when and why (hard rule #2, P-04); the latest
// stands. Every change is sealed into the audit trail.
//
//   • Reverse charge (A14, OB-143 "A") — SWITCHED OFF until the owner switches it on; the CA fills the heads first.
//   • The 30-day e-invoice reporting guard (A21, OB-149 "A") — SWITCHED OFF (the shop's turnover band is ₹5–10 crore,
//     D2; the guard applies at ₹10 crore). One setting; the owner turns it on.
//   • The time-bar warning window N (A19) — how many days before the 3-year bar an unfiled return reaches the owner.
//     The owner decided its value in writing (OB-191, 18 Oct 2026): 180 days. That is the value in force until he
//     changes it, and the page says so — "180 days (owner's decision OB-191)" — never "not set".
//   • The reverse-charge heads (A14) — the CA's call alone (`finance.rcm.configure`, the chartered-accountant role): code,
//     name, rate and the notification entry. A head is retired, never deleted.
//
//   GET  /v1/finance/gst/controls                              — every switch, the number and the heads, with who set each.
//   PUT  /v1/finance/gst/controls/reverse-charge               — owner: { switchedOn, reason }.
//   PUT  /v1/finance/gst/controls/einvoice-30-day-guard        — owner: { switchedOn, reason }.
//   PUT  /v1/finance/gst/controls/time-bar-warning-days        — owner: { days, reason }.
//   GET  /v1/finance/rcm/heads                                 — the heads in force and retired.
//   POST /v1/finance/rcm/heads/:headCode                       — CA: { name, rateBps, notifiedUnder } (a new version).
//   POST /v1/finance/rcm/heads/:headCode/retire                — CA: { reason }.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import { validateRcmHead, InvalidRcmInput, isValidNearBarDays, TIME_BAR_YEARS, type RcmHead } from '../../../packages/finance/src/index';

export type GstControlName = 'reverse_charge' | 'einvoice_30_day_guard' | 'time_bar_warning_days';

/** One change of a control — an append-only fact. */
export interface GstControlChange {
  readonly control: GstControlName;
  /** boolean for the two switches; whole days for the warning window. */
  readonly value: boolean | number;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

/** One change of a reverse-charge head — added/changed (a new version) or retired. */
export interface RcmHeadChange {
  readonly headCode: string;
  readonly change: 'set' | 'retired';
  readonly head?: RcmHead;
  readonly reason?: string;
  readonly by: string;
  readonly at: string;
}

export interface ControlState<T> {
  readonly value: T;
  /** The owner's written decision the built value comes from (e.g. OB-191) — present only while it is unchanged. */
  readonly decision?: string;
  /** Absent: never changed — the built state. */
  readonly changedBy?: string;
  readonly changedAt?: string;
  readonly reason?: string;
}

export interface GstControls {
  readonly reverseCharge: ControlState<boolean>;
  readonly einvoice30DayGuard: ControlState<boolean>;
  /** N in days: the owner's OB-191 value (180) until he changes it. */
  readonly timeBarWarningDays: ControlState<number>;
  readonly rcmHeads: readonly (RcmHead & { readonly setBy: string; readonly setAt: string })[];
  readonly retiredHeads: readonly { readonly headCode: string; readonly reason: string; readonly by: string; readonly at: string }[];
}

/** OB-191 (owner, 18 Oct 2026, in writing): an unfiled return reaches the owner 180 days before its 3-year bar. */
export const OB191_TIME_BAR_WARNING_DAYS = 180;
export const OB191 = 'OB-191';

/** N as the page says it: "180 days (owner's decision OB-191)" while it is the decided value, else "N days". */
export function timeBarWindowSaid(c: ControlState<number>): string {
  return c.decision !== undefined ? `${c.value} days (owner's decision ${c.decision})` : `${c.value} days`;
}

/** Fold the control facts into the controls in force. Off / off / 180 days (OB-191) / no heads until changed. Pure. */
export function foldGstControls(changes: readonly GstControlChange[], heads: readonly RcmHeadChange[]): GstControls {
  const latest = new Map<GstControlName, GstControlChange>();
  for (const c of changes) latest.set(c.control, c);
  const state = <T>(name: GstControlName, built: T, decision?: string): ControlState<T> => {
    const c = latest.get(name);
    if (c === undefined) return decision === undefined ? { value: built } : { value: built, decision };
    return { value: c.value as T, changedBy: c.by, changedAt: c.at, reason: c.reason };
  };
  const inForce = new Map<string, RcmHead & { setBy: string; setAt: string }>();
  const retired = new Map<string, { headCode: string; reason: string; by: string; at: string }>();
  for (const h of heads) {
    if (h.change === 'set' && h.head !== undefined) { inForce.set(h.headCode, { ...h.head, setBy: h.by, setAt: h.at }); retired.delete(h.headCode); }
    if (h.change === 'retired') { inForce.delete(h.headCode); retired.set(h.headCode, { headCode: h.headCode, reason: h.reason ?? '', by: h.by, at: h.at }); }
  }
  return {
    reverseCharge: state('reverse_charge', false),
    einvoice30DayGuard: state('einvoice_30_day_guard', false),
    timeBarWarningDays: state<number>('time_bar_warning_days', OB191_TIME_BAR_WARNING_DAYS, OB191),
    rcmHeads: [...inForce.values()].sort((a, b) => a.headCode.localeCompare(b.headCode)),
    retiredHeads: [...retired.values()].sort((a, b) => a.headCode.localeCompare(b.headCode)),
  };
}

export interface GstControlsDeps {
  readonly controlChanges: (tenantId: string) => Promise<readonly GstControlChange[]>;
  readonly headChanges: (tenantId: string) => Promise<readonly RcmHeadChange[]>;
  readonly recordControl: (tenantId: string, change: GstControlChange) => Promise<void>;
  readonly recordHead: (tenantId: string, change: RcmHeadChange) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

export async function gstControlsOf(deps: Pick<GstControlsDeps, 'controlChanges' | 'headChanges'>, tenantId: string): Promise<GstControls> {
  return foldGstControls(await deps.controlChanges(tenantId), await deps.headChanges(tenantId));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const reasonOf = (b: Record<string, unknown>): string | undefined => (typeof b['reason'] === 'string' && b['reason'].trim() !== '' ? b['reason'].trim() : undefined);

async function audit(deps: GstControlsDeps, ctx: RequestContext, action: string, objectId: string, before: Record<string, string> | null, after: Record<string, string>, reason: string): Promise<void> {
  await deps.recordAudit?.(ctx.tenantId, {
    actorId: ctx.userId, action, objectType: 'gst_control', objectId, at: deps.now(),
    origin: { tenantId: ctx.tenantId, branchId: null }, before, after, reason, correlationId: ctx.traceId,
  });
}

/** What the GST page says about each control, in plain words. */
export function describeControls(c: GstControls): { readonly reverseCharge: string; readonly einvoice30DayGuard: string; readonly timeBarWarningDays: string } {
  return {
    reverseCharge: c.reverseCharge.value
      ? `Reverse charge is ON — ${c.rcmHeads.length} head(s) configured by the CA`
      : `Reverse charge is SWITCHED OFF (OB-143) — ${c.rcmHeads.length === 0 ? 'the CA has not listed any head yet' : `the CA has listed ${c.rcmHeads.length} head(s)`}; the owner switches it on`,
    einvoice30DayGuard: c.einvoice30DayGuard.value
      ? 'The 30-day e-invoice reporting guard is ON — a B2B document not reported within 30 days is blocked'
      : 'The 30-day e-invoice reporting guard is SWITCHED OFF (OB-149) — it applies at ₹10 crore turnover; nothing is blocked',
    timeBarWarningDays: c.timeBarWarningDays.decision !== undefined
      ? `An unfiled return reaches the owner ${timeBarWindowSaid(c.timeBarWarningDays)} before it is barred; the owner can change it`
      : `An unfiled return reaches the owner ${timeBarWindowSaid(c.timeBarWarningDays)} before it is barred (set by ${c.timeBarWarningDays.changedBy ?? 'the owner'})`,
  };
}

export function gstControlsRoutes(deps: GstControlsDeps): readonly Route[] {
  const setSwitch = (control: 'reverse_charge' | 'einvoice_30_day_guard', path: string, permission: string): Route => ({
    api: 'API-09', method: 'PUT', path, permission, idempotent: true,
    handler: async (ctx) => {
      const b = (ctx.body ?? {}) as Record<string, unknown>;
      const reason = reasonOf(b);
      if (typeof b['switchedOn'] !== 'boolean' || reason === undefined) {
        throw apiError(400, { code: 'switch_needs_state_and_reason', whatHappened: 'Changing this switch needs switchedOn (true or false) and a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Send { switchedOn, reason }.' });
      }
      const before = await gstControlsOf(deps, ctx.tenantId);
      const was = control === 'reverse_charge' ? before.reverseCharge.value : before.einvoice30DayGuard.value;
      if (was === b['switchedOn']) {
        return { status: 200, body: { control, switchedOn: was, unchanged: true, controls: before, said: describeControls(before) } };
      }
      const at = deps.now();
      await deps.recordControl(ctx.tenantId, { control, value: b['switchedOn'], reason, by: ctx.userId, at });
      await audit(deps, ctx, `gst.control.${control}`, control, { switchedOn: String(was) }, { switchedOn: String(b['switchedOn']) }, reason);
      const after = await gstControlsOf(deps, ctx.tenantId);
      return { status: 200, body: { control, switchedOn: b['switchedOn'], controls: after, said: describeControls(after) } };
    },
  });

  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/gst/controls',
      permission: 'finance.gstr.read',
      handler: async (ctx) => {
        const c = await gstControlsOf(deps, ctx.tenantId);
        return { status: 200, body: { controls: c, said: describeControls(c) } };
      },
    },
    // OB-143: the owner alone switches reverse charge on (or off again).
    setSwitch('reverse_charge', '/v1/finance/gst/controls/reverse-charge', 'finance.rcm.switch'),
    // OB-149: the owner alone switches the 30-day e-invoice guard on (or off again).
    setSwitch('einvoice_30_day_guard', '/v1/finance/gst/controls/einvoice-30-day-guard', 'finance.einvoice.guard.switch'),
    {
      // A19: the owner's N — whole days, 1 to 3 years.
      api: 'API-09', method: 'PUT', path: '/v1/finance/gst/controls/time-bar-warning-days',
      permission: 'finance.gst.timebar.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reason = reasonOf(b);
        if (!isValidNearBarDays(b['days']) || reason === undefined) {
          throw apiError(400, { code: 'warning_days_need_days_and_reason', whatHappened: `The warning window needs days (a whole number from 1 to ${365 * TIME_BAR_YEARS}) and a reason.`, wasItSaved: 'not_saved', nextSafeAction: 'Send { days, reason }.' });
        }
        const before = await gstControlsOf(deps, ctx.tenantId);
        const at = deps.now();
        await deps.recordControl(ctx.tenantId, { control: 'time_bar_warning_days', value: b['days'], reason, by: ctx.userId, at });
        await audit(deps, ctx, 'gst.control.time_bar_warning_days', 'time_bar_warning_days', { days: String(before.timeBarWarningDays.value), ...(before.timeBarWarningDays.decision !== undefined ? { decision: before.timeBarWarningDays.decision } : {}) }, { days: String(b['days']) }, reason);
        const after = await gstControlsOf(deps, ctx.tenantId);
        return { status: 200, body: { days: b['days'], controls: after, said: describeControls(after) } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/rcm/heads',
      permission: 'finance.rcm.read',
      handler: async (ctx) => {
        const c = await gstControlsOf(deps, ctx.tenantId);
        return { status: 200, body: { switchedOn: c.reverseCharge.value, heads: c.rcmHeads, retired: c.retiredHeads, said: describeControls(c).reverseCharge } };
      },
    },
    {
      // A14: the CA lists a head (or changes one — a new version; the old is kept on the ledger).
      api: 'API-09', method: 'POST', path: '/v1/finance/rcm/heads/:headCode',
      permission: 'finance.rcm.configure', idempotent: true,
      handler: async (ctx) => {
        const headCode = ctx.params['headCode'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const head: RcmHead = { headCode, name: typeof b['name'] === 'string' ? b['name'].trim() : '', rateBps: b['rateBps'] as number, notifiedUnder: typeof b['notifiedUnder'] === 'string' ? b['notifiedUnder'].trim() : '' };
        try { validateRcmHead(head); } catch (e) {
          if (e instanceof InvalidRcmInput) throw apiError(422, { code: 'invalid_rcm_head', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Send { name, rateBps, notifiedUnder } for a head code of capital letters and digits.' });
          throw e;
        }
        const before = (await gstControlsOf(deps, ctx.tenantId)).rcmHeads.find((h) => h.headCode === headCode);
        if (before !== undefined && before.name === head.name && before.rateBps === head.rateBps && before.notifiedUnder === head.notifiedUnder) {
          return { status: 200, body: { head: before, unchanged: true } };
        }
        const at = deps.now();
        await deps.recordHead(ctx.tenantId, { headCode, change: 'set', head, by: ctx.userId, at });
        await audit(deps, ctx, 'gst.rcm.head.set', headCode, before === undefined ? null : { name: before.name, rateBps: String(before.rateBps), notifiedUnder: before.notifiedUnder }, { name: head.name, rateBps: String(head.rateBps), notifiedUnder: head.notifiedUnder }, 'reverse-charge head set by the CA');
        return { status: before === undefined ? 201 : 200, body: { head: { ...head, setBy: ctx.userId, setAt: at } } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/rcm/heads/:headCode/retire',
      permission: 'finance.rcm.configure', idempotent: true,
      handler: async (ctx) => {
        const headCode = ctx.params['headCode'] ?? '';
        const b = (isObj(ctx.body) ? ctx.body : {}) as Record<string, unknown>;
        const reason = reasonOf(b);
        if (reason === undefined) throw apiError(400, { code: 'retire_needs_reason', whatHappened: 'Retiring a head needs a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Send { reason }.' });
        const before = (await gstControlsOf(deps, ctx.tenantId)).rcmHeads.find((h) => h.headCode === headCode);
        if (before === undefined) throw notFound(`a reverse-charge head ${headCode} in force`);
        await deps.recordHead(ctx.tenantId, { headCode, change: 'retired', reason, by: ctx.userId, at: deps.now() });
        await audit(deps, ctx, 'gst.rcm.head.retire', headCode, { name: before.name, rateBps: String(before.rateBps) }, { retired: 'true' }, reason);
        return { status: 200, body: { headCode, retired: true } };
      },
    },
  ];
}
