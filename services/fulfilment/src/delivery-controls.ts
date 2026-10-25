// API-08 — the owner's delivery numbers and the contribution rule (D09-FR-05/06 · M19-FR-04 · OB-313 · P-08 · hard rules #2/#6).
//
//   GET  /v1/delivery/controls                       every number, each "not set" until the owner enters it
//   POST /v1/delivery/controls                       the owner enters or changes one or more (append-only, each change named)
//   GET  /v1/delivery/contribution?storeId=          every open delivery order judged against the contribution rule
//   POST /v1/delivery/contribution/:orderId/decision a manager approves (or declines) an order held below the threshold
//
// The rule (OB-313, owner, 23 Oct 2026): "below the owner's threshold, a new order for that slot or zone needs a manager's
// approval". While the threshold is not set the rule only FLAGS. An order is judged ONCE, the first time head office's
// fulfilment sees it after it is placed — the numbers it was judged on are kept with the judgement, and a later change of
// a number never re-writes an earlier judgement (append-only). A held order is not put on a wave or a route until a
// manager approves it; a declined one stays held, said so, for the online store desk to cancel or turn into a collection.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { contributionGate, CONTROL_KEYS, type ContributionGate, type DeliveryControls, type FleetRate } from '../../../packages/fulfilment/src/index';

/** One change the owner made, as kept. */
export interface ControlsChange {
  readonly changes: Partial<DeliveryControls>;
  readonly setBy: string;
  readonly setAt: string;
}

/**
 * The shop's DEFAULTS — a number the owner decided in writing, in force until he enters another (append-only: his change is
 * a new record, and the default stays as the floor beneath it). OB-343 (owner, 24 Oct 2026): the proof-location radius is
 * 250 metres; a hand-over farther away is FLAGGED on the dispatch board, never refused. Every other number has no default
 * and reads "not set" until he enters it.
 */
export const DELIVERY_CONTROL_DEFAULTS: Readonly<Partial<DeliveryControls>> = Object.freeze({ geofenceRadiusMetres: 250 });
/** Where each default came from — said beside the number, so nobody mistakes it for one the owner typed. */
export const DEFAULT_DECIDED_BY: Readonly<Record<string, string>> = Object.freeze({ geofenceRadiusMetres: 'OB-343' });

/** Fold the owner's changes: the latest value of each number, with who set it and when — over the shop's defaults. */
export function foldControls(history: readonly ControlsChange[]): { readonly values: DeliveryControls; readonly setBy: Readonly<Record<string, { readonly by: string; readonly at: string }>> } {
  const values: Record<string, unknown> = { ...DELIVERY_CONTROL_DEFAULTS };
  const setBy: Record<string, { by: string; at: string }> = {};
  for (const c of history) {
    for (const [k, v] of Object.entries(c.changes)) {
      if (v === undefined) continue;
      values[k] = v;
      setBy[k] = { by: c.setBy, at: c.setAt };
    }
  }
  return { values: values as DeliveryControls, setBy };
}

/** The words for each number, in both languages — the screen and the API say the same thing. */
export const CONTROL_WORDS: Readonly<Record<(typeof CONTROL_KEYS)[number], { readonly en: string; readonly ta: string }>> = Object.freeze({
  geofenceRadiusMetres: { en: 'Proof-location radius (metres)', ta: 'நிரூபண இட ஆரம் (மீட்டர்)' },
  contributionThresholdMinor: { en: 'Least an order should contribute (paise)', ta: 'ஒரு ஆர்டர் தர வேண்டிய குறைந்தபட்ச பங்களிப்பு (பைசா)' },
  costPerDropMinor: { en: 'Cost of one drop (paise)', ta: 'ஒரு டெலிவரியின் செலவு (பைசா)' },
  costPerKmMinor: { en: 'Cost per kilometre (paise)', ta: 'ஒரு கிலோமீட்டர் செலவு (பைசா)' },
  fleetRate: { en: 'Own-fleet settlement rate', ta: 'சொந்த வாகனக் கணக்குத் தீர்வு விகிதம்' },
  // OB-369: the wait before the delivery desk may enter an app customer's till delivery for them.
  appChoiceWaitHours: { en: 'Hours an app customer has to choose before the delivery desk may enter it', ta: 'டெலிவரி மேசை உள்ளிடும் முன் செயலி வாடிக்கையாளர் தேர்வு செய்ய வேண்டிய மணிநேரம்' },
});

/** What the contribution rule found for one order, as kept — the first judgement stands. */
export interface ContributionRecord {
  readonly orderId: string;
  readonly storeId: string;
  readonly gate: ContributionGate;
  /** The numbers the order was judged on, so a later change never re-writes this judgement. */
  readonly judgedOn: { readonly thresholdMinor: number | null; readonly costPerDropMinor: number | null; readonly costPerKmMinor: number | null };
  readonly at: string;
}

export interface ContributionDecision {
  readonly orderId: string;
  readonly decision: 'approve' | 'decline';
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

export type ContributionStanding = 'clear' | 'flag_only' | 'not_assessed' | 'held' | 'approved' | 'declined';

/** What a judged order may do now: picked and sent, or held for a manager. */
export function standingOf(record: ContributionRecord | undefined, decisions: readonly ContributionDecision[]): ContributionStanding {
  if (record === undefined) return 'not_assessed';
  if (record.gate.outcome !== 'needs_manager_approval') return record.gate.outcome === 'clear' ? 'clear' : record.gate.outcome;
  const last = decisions.filter((d) => d.orderId === record.orderId).at(-1);
  return last === undefined ? 'held' : last.decision === 'approve' ? 'approved' : 'declined';
}

/** True when the order may go on a wave or a route — everything except held and declined. */
export const mayGoOut = (s: ContributionStanding): boolean => s !== 'held' && s !== 'declined';

/** The facts the rule needs about one delivery order. Undefined: not a delivery order head office can judge. */
export interface ContributionFacts {
  readonly orderId: string;
  readonly storeId: string;
  readonly orderValueMinor: number;
  readonly itemsMarginMinor: number | undefined;
  readonly deliveryFeeMinor: number;
  readonly distanceMetres: number | undefined;
}

export interface DeliveryControlsDeps {
  readonly controlsHistory: (tenantId: string) => Promise<readonly ControlsChange[]>;
  readonly recordControls: (tenantId: string, change: ControlsChange) => Promise<void>;
  /** The delivery orders still to go out at a store (confirmed, picking or packed). */
  readonly openDeliveryOrders: (tenantId: string, storeId: string) => Promise<readonly string[]>;
  readonly contributionFacts: (tenantId: string, orderId: string) => Promise<ContributionFacts | undefined>;
  readonly contributionRecord: (tenantId: string, orderId: string) => Promise<ContributionRecord | undefined>;
  /** Append the first judgement — a second for the same order is the same record (idempotent on the order). */
  readonly recordContribution: (tenantId: string, record: ContributionRecord) => Promise<void>;
  readonly decisions: (tenantId: string, orderId: string) => Promise<readonly ContributionDecision[]>;
  readonly recordDecision: (tenantId: string, d: ContributionDecision) => Promise<void>;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const wholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function readChanges(b: unknown): Partial<DeliveryControls> | undefined {
  if (!isObj(b)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(b)) if (!(CONTROL_KEYS as readonly string[]).includes(k)) return undefined;
  for (const k of ['geofenceRadiusMetres', 'contributionThresholdMinor', 'costPerDropMinor', 'costPerKmMinor'] as const) {
    if (b[k] === undefined) continue;
    if (!wholeNonNeg(b[k])) return undefined;
    // A radius of nothing would put every door outside the fence; the owner's radius is a real distance.
    if (k === 'geofenceRadiusMetres' && b[k] === 0) return undefined;
    out[k] = b[k];
  }
  if (b['appChoiceWaitHours'] !== undefined) {
    // OB-369: whole hours, at least one and at most a week.
    const h = b['appChoiceWaitHours'];
    if (!wholeNonNeg(h) || h < 1 || h > 168) return undefined;
    out['appChoiceWaitHours'] = h;
  }
  if (b['fleetRate'] !== undefined) {
    const r = b['fleetRate'];
    if (!isObj(r) || (r['basis'] !== 'per_drop' && r['basis'] !== 'per_run') || !wholeNonNeg(r['rateMinor'])) return undefined;
    out['fleetRate'] = { basis: r['basis'], rateMinor: r['rateMinor'] } satisfies FleetRate;
  }
  return Object.keys(out).length === 0 ? undefined : (out as Partial<DeliveryControls>);
}

/** Present the numbers: each with its value or null ("not set"), who set it, and its words. */
export function presentControls(history: readonly ControlsChange[]): Record<string, unknown> {
  const { values, setBy } = foldControls(history);
  const numbers = CONTROL_KEYS.map((key) => ({
    key, value: (values as Record<string, unknown>)[key] ?? null, words: CONTROL_WORDS[key],
    ...(setBy[key] !== undefined ? { state: 'set' as const, setBy: setBy[key]!.by, setAt: setBy[key]!.at }
      : DEFAULT_DECIDED_BY[key] !== undefined ? { state: 'default' as const, decidedBy: DEFAULT_DECIDED_BY[key]! }
        : { state: 'not_set' as const }),
  }));
  return { numbers, notSet: numbers.filter((n) => n.state === 'not_set').map((n) => n.key) };
}

/** Judge an order once (the first judgement stands) and say where it stands now. Undefined: not a delivery order. */
export async function judgeOnce(deps: DeliveryControlsDeps, tenantId: string, orderId: string): Promise<{ readonly record: ContributionRecord; readonly standing: ContributionStanding } | undefined> {
  let record = await deps.contributionRecord(tenantId, orderId);
  if (record === undefined) {
    const facts = await deps.contributionFacts(tenantId, orderId);
    if (facts === undefined) return undefined;
    const { values } = foldControls(await deps.controlsHistory(tenantId));
    const gate = contributionGate({
      orderId, itemsMarginMinor: facts.itemsMarginMinor, deliveryFeeMinor: facts.deliveryFeeMinor,
      orderValueMinor: facts.orderValueMinor, distanceMetres: facts.distanceMetres, controls: values,
    });
    const candidate: ContributionRecord = {
      orderId, storeId: facts.storeId, gate,
      judgedOn: { thresholdMinor: values.contributionThresholdMinor ?? null, costPerDropMinor: values.costPerDropMinor ?? null, costPerKmMinor: values.costPerKmMinor ?? null },
      at: deps.now(),
    };
    await deps.recordContribution(tenantId, candidate);
    // Whoever wrote first, that judgement stands.
    record = (await deps.contributionRecord(tenantId, orderId)) ?? candidate;
  }
  return { record, standing: standingOf(record, await deps.decisions(tenantId, orderId)) };
}

export function deliveryControlsRoutes(deps: DeliveryControlsDeps): readonly Route[] {
  return [
    {
      api: 'API-08', method: 'GET', path: '/v1/delivery/controls',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => ({ status: 200, body: { ...presentControls(await deps.controlsHistory(ctx.tenantId)), asAt: deps.now() } }),
    },
    {
      // The owner enters or changes his numbers. Body: any of { geofenceRadiusMetres, contributionThresholdMinor,
      // costPerDropMinor, costPerKmMinor, fleetRate: { basis: per_drop | per_run, rateMinor } } — whole numbers.
      api: 'API-08', method: 'POST', path: '/v1/delivery/controls',
      permission: 'delivery.controls.set', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const changes = readChanges(ctx.body);
        if (changes === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_delivery_controls',
            whatHappened: `Send one or more of ${CONTROL_KEYS.join(', ')} — whole numbers (paise, metres; a radius above zero; the app-choice wait in hours, 1 to 168), and a fleetRate as { basis: per_drop | per_run, rateMinor }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Enter the number again. Nothing was changed.',
          });
        }
        const before = foldControls(await deps.controlsHistory(ctx.tenantId)).values;
        const change: ControlsChange = { changes, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordControls(ctx.tenantId, change);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'delivery.controls.set', objectType: 'delivery_controls', objectId: 'delivery',
          at: change.setAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: Object.fromEntries(Object.keys(changes).map((k) => [k, JSON.stringify((before as Record<string, unknown>)[k] ?? null)])),
          after: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, JSON.stringify(v)])),
          correlationId: 'delivery-controls',
        });
        return { status: 200, body: presentControls(await deps.controlsHistory(ctx.tenantId)) };
      },
    },
    {
      // Every open delivery order at a store, judged against the rule — the held ones first.
      api: 'API-08', method: 'GET', path: '/v1/delivery/contribution',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => {
        const storeId = (ctx.query['storeId'] ?? '').trim();
        if (storeId === '') throw apiError(400, { code: 'store_needed', whatHappened: 'Say which store: ?storeId=.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store. Nothing was changed.' });
        const rows: { orderId: string; standing: ContributionStanding; gate: ContributionGate; judgedOn: ContributionRecord['judgedOn']; at: string; decisions: readonly ContributionDecision[] }[] = [];
        for (const orderId of await deps.openDeliveryOrders(ctx.tenantId, storeId)) {
          const j = await judgeOnce(deps, ctx.tenantId, orderId);
          if (j === undefined) continue;
          rows.push({ orderId, standing: j.standing, gate: j.record.gate, judgedOn: j.record.judgedOn, at: j.record.at, decisions: await deps.decisions(ctx.tenantId, orderId) });
        }
        const rank: Record<ContributionStanding, number> = { held: 0, declined: 1, flag_only: 2, not_assessed: 3, approved: 4, clear: 5 };
        rows.sort((a, b) => rank[a.standing] - rank[b.standing] || a.orderId.localeCompare(b.orderId));
        const { values } = foldControls(await deps.controlsHistory(ctx.tenantId));
        return { status: 200, body: { storeId, thresholdMinor: values.contributionThresholdMinor ?? null, thresholdState: values.contributionThresholdMinor === undefined ? 'not_set' : 'set', orders: rows, asAt: deps.now() } };
      },
    },
    {
      // A manager decides on an order held below the threshold. Body: { decision: approve | decline, reason }.
      api: 'API-08', method: 'POST', path: '/v1/delivery/contribution/:orderId/decision',
      permission: 'delivery.contribution.approve', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (orderId === '' || (b['decision'] !== 'approve' && b['decision'] !== 'decline') || !isStr(b['reason']) || b['reason'].trim().length < 5) {
          throw apiError(400, { code: 'not_readable_as_a_contribution_decision', whatHappened: 'A decision needs { decision: approve | decline, reason } — the reason in a few words.', wasItSaved: 'not_saved', nextSafeAction: 'Say why, and send it again. Nothing was changed.' });
        }
        const j = await judgeOnce(deps, ctx.tenantId, orderId);
        if (j === undefined) throw apiError(404, { code: 'not_a_delivery_order', whatHappened: `${orderId} is not a delivery order head office can judge.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the order. Nothing was changed.' });
        if (j.record.gate.outcome !== 'needs_manager_approval') {
          throw apiError(409, { code: 'not_held', whatHappened: `${orderId} is not held for approval — it is ${j.standing.replace(/_/g, ' ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to decide. Nothing was changed.' });
        }
        if (j.standing === 'approved' && b['decision'] === 'approve') return { status: 200, body: { orderId, standing: j.standing, alreadyDecided: true } };
        const d: ContributionDecision = { orderId, decision: b['decision'], reason: (b['reason'] as string).trim(), by: ctx.userId, at: deps.now() };
        await deps.recordDecision(ctx.tenantId, d);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'delivery.contribution.decide', objectType: 'online_order', objectId: orderId,
          at: d.at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { standing: j.standing }, after: { decision: d.decision, reason: d.reason, contributionMinor: String(j.record.gate.assessment?.contributionMinor ?? ''), thresholdMinor: String(j.record.gate.thresholdMinor ?? '') },
          correlationId: orderId,
        });
        return { status: 201, body: { orderId, standing: d.decision === 'approve' ? 'approved' : 'declined', decision: d } };
      },
    },
  ];
}
