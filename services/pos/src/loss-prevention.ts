// API-05 loss-prevention investigation cases (M15-FR-04). A case is opened when somebody may have
// taken something, and a case file is read in two adversarial places — a disciplinary meeting and a
// court — so the controls are strict and they are the engine's, not this file's:
//
//   • EVIDENCE IS APPEND-ONLY and each item is SEALED to the one before it, so a removal or an edit is
//     detectable, not merely forbidden (hard rule #6). There is no remove/update route, by design.
//   • CHAIN OF CUSTODY IS PART OF THE EVIDENCE — who collected it and from where, or it is not evidence.
//   • A CASE CANNOT CLOSE WITHOUT AN OUTCOME, and "unfounded" is a first-class outcome; a PROVEN outcome
//     needs someone other than the investigator to sign it (§28), evidence on file, and a verifying chain.
//   • OUTCOMES TUNE THE RULES — closed cases feed `ruleFeedback` so a rule that is always unfounded is
//     retired rather than left to spend the manager's attention.
//
// The rules are the pure `openCase` / `addEvidence` / `verifyEvidence` / `closeCase` / `ruleFeedback` in
// `packages/loss-prevention` (a complete engine nothing fed). This surface gives them persistence — the
// append-only event stream that IS the chain of custody — an authorization split and reads.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  openCase, addEvidence, verifyEvidence, closeCase, ruleFeedback,
  type InvestigationCase, type EvidenceItem, type EvidenceKind, type CaseOutcome,
} from '../../../packages/loss-prevention/src/cases';
import { buildOpenCaseWorklist } from '../../../packages/loss-prevention/src/worklist';
import {
  evaluateLossPrevention, type LpRule, type ActivityEvent, type SignalKind, type LpException,
} from '../../../packages/loss-prevention/src/loss-prevention';

const KINDS: readonly EvidenceKind[] = ['transaction_record', 'cctv_reference', 'witness_statement', 'stock_count', 'settlement_record', 'note'];
const OUTCOMES: readonly CaseOutcome[] = ['proven', 'unfounded', 'inconclusive', 'process_failure', 'referred_to_police'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export interface LpCasesDeps {
  readonly cases: (tenantId: string) => Promise<readonly InvestigationCase[]> | readonly InvestigationCase[];
  readonly case: (tenantId: string, caseId: string) => Promise<InvestigationCase | undefined> | InvestigationCase | undefined;
  readonly recordOpened: (tenantId: string, investigation: InvestigationCase) => Promise<void> | void;
  readonly recordEvidence: (tenantId: string, caseId: string, item: EvidenceItem) => Promise<void> | void;
  readonly recordClosed: (tenantId: string, c: InvestigationCase) => Promise<void> | void;
  readonly now: () => string;
}

const refuse = (code: string, whatHappened: string, status = 422): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
};

export function lpCasesRoutes(deps: LpCasesDeps): readonly Route[] {
  return [
    {
      // Open a case — it must come from a raised exception/signal and name an investigator who is not
      // the subject. Open-once.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/cases/:caseId',
      permission: 'lp.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const b = (ctx.body ?? {}) as { raisedFromRef?: unknown; subjectRef?: unknown; summary?: unknown; valueMinor?: unknown; assignedTo?: unknown };
        if (!isStr(b.raisedFromRef) || !isStr(b.subjectRef) || !isStr(b.summary) || !isStr(b.assignedTo) || !Number.isInteger(b.valueMinor) || (b.valueMinor as number) < 0) {
          refuse('not_readable_as_a_case', 'A case needs the reference it was raised from, a subject, a summary, a whole non-negative value, and a named investigator.', 400);
        }
        if ((await deps.case(ctx.tenantId, caseId)) !== undefined) {
          refuse('case_already_open', `Case ${caseId} already exists — evidence is added to it, a case is not reopened by redefining.`, 409);
        }
        const result = openCase({
          caseId, tenantId: ctx.tenantId,
          raisedFromRef: b.raisedFromRef as string, subjectRef: b.subjectRef as string,
          summary: b.summary as string, valueMinor: b.valueMinor as number,
          openedBy: ctx.userId, assignedTo: b.assignedTo as string, at: deps.now(),
        });
        if (!result.opened || result.case === undefined) refuse('case_refused', result.detail);
        await deps.recordOpened(ctx.tenantId, result.case as InvestigationCase);
        return { status: 201, body: { caseId, subjectRef: (result.case as InvestigationCase).subjectRef, assignedTo: (result.case as InvestigationCase).assignedTo, state: 'open' } };
      },
    },
    {
      // Add evidence — append-only, sealed to the chain, with a mandatory chain of custody.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/cases/:caseId/evidence/:evidenceId',
      permission: 'lp.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const evidenceId = ctx.params['evidenceId'] ?? '';
        const b = (ctx.body ?? {}) as { kind?: unknown; ref?: unknown; description?: unknown; collectedBy?: unknown; collectedFrom?: unknown };
        if (typeof b.kind !== 'string' || !(KINDS as readonly string[]).includes(b.kind) || !isStr(b.ref) || !isStr(b.description) || !isStr(b.collectedBy) || !isStr(b.collectedFrom)) {
          refuse('not_readable_as_evidence', 'Evidence needs a kind, a reference, a description, and a chain of custody (collectedBy and collectedFrom).', 400);
        }
        const investigation = await deps.case(ctx.tenantId, caseId);
        if (investigation === undefined) throw notFound(`case ${caseId}`);

        const result = addEvidence(investigation, {
          evidenceId, kind: b.kind as EvidenceKind, ref: b.ref as string, description: b.description as string,
          collectedBy: b.collectedBy as string, collectedAt: deps.now(), collectedFrom: b.collectedFrom as string,
        });
        if (!result.added) refuse('evidence_refused', result.detail);
        const sealed = result.case.evidence[result.case.evidence.length - 1] as EvidenceItem;
        await deps.recordEvidence(ctx.tenantId, caseId, sealed);
        return { status: 201, body: { caseId, evidenceId, kind: sealed.kind, seal: sealed.seal, items: result.case.evidence.length } };
      },
    },
    {
      // Close a case with an outcome. Unfounded is first-class; proven needs someone other than the
      // investigator (§28), evidence on file, and a chain that verifies.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/cases/:caseId/close',
      permission: 'lp.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const b = (ctx.body ?? {}) as { outcome?: unknown; note?: unknown };
        if (typeof b.outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(b.outcome) || !isStr(b.note)) {
          refuse('not_readable_as_a_close', 'Closing a case needs an outcome (proven/unfounded/inconclusive/process_failure/referred_to_police) and a note.', 400);
        }
        const investigation = await deps.case(ctx.tenantId, caseId);
        if (investigation === undefined) throw notFound(`case ${caseId}`);

        const result = closeCase({ case: investigation, outcome: b.outcome as CaseOutcome, note: b.note as string, closedBy: ctx.userId, at: deps.now() });
        if (!result.closed) refuse('close_refused', result.detail);
        await deps.recordClosed(ctx.tenantId, result.case);
        return { status: 200, body: { caseId, state: 'closed', outcome: result.case.outcome, closedBy: result.case.closedBy } };
      },
    },
    {
      // The manager's open-investigations worklist (M15-FR-04 / P-03). Every OPEN case, highest value
      // first, so an auto-opened shortage investigation cannot be opened and forgotten; `?mine=true`
      // narrows it to the caller's own assignments. Read-only, a summary per case (not the sealed
      // evidence). Registered before the `:caseId` read — both paths are anchored and mutually exclusive.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/cases',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const mine = ctx.query['mine'] === 'true' || ctx.query['assignedToMe'] === 'true';
        const worklist = buildOpenCaseWorklist(await deps.cases(ctx.tenantId), mine ? { assignedTo: ctx.userId } : {});
        return { status: 200, body: { ...worklist, scope: mine ? 'assigned_to_me' : 'all_open', asAt: deps.now() } };
      },
    },
    {
      // Read a case, with a live verification of its evidence chain.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/cases/:caseId',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const investigation = await deps.case(ctx.tenantId, caseId);
        if (investigation === undefined) throw notFound(`case ${caseId}`);
        return { status: 200, body: { ...investigation, chain: verifyEvidence(investigation) } };
      },
    },
    {
      // The feedback loop: closed outcomes measurably retire/relax/tighten the rules that raised them.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/rule-feedback',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const all = await deps.cases(ctx.tenantId);
        return { status: 200, body: { adjustments: ruleFeedback(all), asAt: deps.now() } };
      },
    },
  ];
}

// ── Anomaly rules & detection (M15-FR-01) ─────────────────────────────────────────────────────────
// "Control by exception" (P-03): a store configures its own thresholds as DATA (no code), and activity
// — voids, refunds, discounts, no-sales, cash variances, already synced from the lanes — is evaluated
// against them to surface risky patterns as exceptions that LINK back to the transactions. DETECT-ONLY:
// nothing is blocked, suspended or sanctioned (AI-NFR-12); a raised exception is what OPENS a case.

const SIGNAL_KINDS: readonly SignalKind[] = ['void', 'refund', 'discount', 'no_sale', 'cash_variance'];
const isSignalKind = (v: unknown): v is SignalKind => typeof v === 'string' && (SIGNAL_KINDS as readonly string[]).includes(v);

export interface LpRulesDeps {
  readonly rules: (tenantId: string) => Promise<readonly LpRule[]> | readonly LpRule[];
  readonly recordRule: (tenantId: string, rule: LpRule) => Promise<void> | void;
  readonly now: () => string;
}

/** Read the activity events to evaluate, or null if any is malformed. */
function readActivity(v: unknown): ActivityEvent[] | null {
  if (!Array.isArray(v)) return null;
  const events: ActivityEvent[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    if (!isStr(e['txnId']) || !isSignalKind(e['kind']) || !isStr(e['cashierId']) || !isStr(e['at'])) return null;
    if (e['valueMinor'] !== undefined && !Number.isInteger(e['valueMinor'])) return null;
    events.push({
      txnId: e['txnId'] as string, kind: e['kind'], cashierId: e['cashierId'] as string, at: e['at'] as string,
      ...(Number.isInteger(e['valueMinor']) ? { valueMinor: e['valueMinor'] as number } : {}),
    });
  }
  return events;
}

export function lpRulesRoutes(deps: LpRulesDeps): readonly Route[] {
  return [
    {
      // Configure a rule for a signal kind — thresholds are DATA, tuned without code. Latest per kind wins.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/rules/:kind',
      permission: 'lp.rule.manage', idempotent: true,
      handler: async (ctx) => {
        const kind = ctx.params['kind'] ?? '';
        if (!isSignalKind(kind)) throw notFound(`signal kind ${kind}`);
        const b = (ctx.body ?? {}) as { maxCount?: unknown; maxTotalValueMinor?: unknown; maxSingleValueMinor?: unknown; escalateAtMultiple?: unknown };
        const nonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
        for (const [k, v] of Object.entries(b)) {
          if (v !== undefined && !nonNegInt(v)) refuse('not_readable_as_a_rule', `A rule limit (${k}) must be a whole, non-negative number.`, 400);
        }
        if (b.escalateAtMultiple !== undefined && (b.escalateAtMultiple as number) < 1) {
          refuse('not_readable_as_a_rule', 'escalateAtMultiple must be at least 1.', 400);
        }
        if (b.maxCount === undefined && b.maxTotalValueMinor === undefined && b.maxSingleValueMinor === undefined) {
          refuse('rule_has_no_limit', 'A rule needs at least one limit (maxCount, maxTotalValueMinor or maxSingleValueMinor), or it never fires.', 400);
        }
        const rule: LpRule = {
          kind,
          ...(nonNegInt(b.maxCount) ? { maxCount: b.maxCount } : {}),
          ...(nonNegInt(b.maxTotalValueMinor) ? { maxTotalValueMinor: b.maxTotalValueMinor } : {}),
          ...(nonNegInt(b.maxSingleValueMinor) ? { maxSingleValueMinor: b.maxSingleValueMinor } : {}),
          ...(nonNegInt(b.escalateAtMultiple) ? { escalateAtMultiple: b.escalateAtMultiple } : {}),
        };
        await deps.recordRule(ctx.tenantId, rule);
        return { status: 201, body: rule };
      },
    },
    {
      // The store's configured rules — latest per kind.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/rules',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        return { status: 200, body: { rules: await deps.rules(ctx.tenantId), asAt: deps.now() } };
      },
    },
    {
      // PREVIEW: evaluate SUPPLIED activity against the store's rules — detect-only, exceptions link back to the
      // transactions. A what-if; it computes, it never commits, and it is labelled so (audit PF-07).
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/evaluate',
      permission: 'lp.case.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { events?: unknown };
        const events = readActivity(b.events);
        if (events === null) {
          refuse('not_readable_as_activity', 'Activity is a list of events, each with a txnId, a kind, a cashierId and an "at" time (valueMinor where the kind has a value).', 400);
        }
        const rules = await deps.rules(ctx.tenantId);
        // A PREVIEW (audit PF-07): it judges the activity in the request, not the shop's record. The control is
        // GET /v1/loss-prevention/exceptions, which runs the same rules over the voids and refunds head office holds.
        return { status: 200, body: { preview: true, note: 'A what-if over the activity you supplied — not the shop\'s record. The shop\'s own exceptions are at GET /v1/loss-prevention/exceptions.', exceptions: evaluateLossPrevention(events as ActivityEvent[], rules), asAt: deps.now() } };
      },
    },
  ];
}

// ── The till's own record, and the rules run on it (Wave 4 · audit PF-07 · M15-FR-01 · M12-FR-04 · P-03 · P-08) ──────────
// The audit: a void at the till left no evidence once the basket moved on, and the broad rule evaluation above runs only
// over activity somebody SUPPLIES — a what-if, not a control. Now every void reaches head office through the store box
// (`TillActivityRecorded`, durable on the box first, the cashier the box verified), is kept on its own append-only stream,
// and the store's rules run over the AUTHORITATIVE record — the voids head office holds and the refunds it banked — per
// day. What breaches a rule is RAISED once (and again only when it grows or escalates), linked to the transactions, and
// listed for the owner with the case opened from it, if any. The evaluate route above stays, labelled a preview.

/**
 * One till action head office keeps as loss-prevention evidence: a VOID (a line taken off a bill), a NO-SALE (the drawer
 * opened with no sale) or a PRICE OVERRIDE (a line's price lowered at the till). A no-sale and an override carry the
 * manager who approved them on the box (the one-use till approval, PF-02); a void needs none.
 */
export interface TillActivity {
  readonly activityId: string;
  readonly kind: 'void' | 'no_sale' | 'price_override';
  readonly laneId: string;
  readonly cashierId: string;
  /** The bill (a void and an override always; a no-sale only when one was open). */
  readonly billRef?: string;
  readonly lineId?: string;
  readonly productId?: string;
  readonly description?: string;
  /** A void: the line's value; an override: what it took off the line; a no-sale: 0. */
  readonly valueMinor: number;
  /** A price override: the unit price before and after, and the quantity it applied to. */
  readonly fromUnitMinor?: number;
  readonly toUnitMinor?: number;
  readonly quantityMinor?: number;
  readonly reason: string;
  readonly at: string;
  /** The shop's trading day the box dated it by (its cut-off); absent on a box that predates it. */
  readonly tradingDay?: string;
  /** The manager the box verified for a no-sale or an override, and the approval spent. */
  readonly approvedBy?: string;
  readonly approvalId?: string;
  /** Whether head office's own grants say the approver holds the override authority (false = surfaced, P-08). */
  readonly approverAuthorityHeld?: boolean;
  /** How the box verified the cashier (pin / verified sign-in), when it said. */
  readonly via?: string;
  readonly relayedBy: string;
}

/** An exception the rules raised from the shop's own record. */
export interface RaisedException {
  readonly exceptionId: string;
  readonly day: string;
  readonly cashierId: string;
  readonly kind: SignalKind;
  readonly breach: string;
  readonly observed: number;
  readonly limit: number;
  readonly severity: string;
  readonly linkedTxnIds: readonly string[];
  readonly raisedAt: string;
}

export interface LpActivityDeps {
  readonly activity: (tenantId: string, activityId: string) => Promise<TillActivity | undefined> | TillActivity | undefined;
  readonly recordActivity: (tenantId: string, a: TillActivity) => Promise<void> | void;
  /** The till actions head office holds for one trading day — voids, no-sales and price overrides. */
  readonly heldOn: (tenantId: string, day: string) => Promise<readonly TillActivity[]> | readonly TillActivity[];
  /** The refunds head office banked that trading day, as rule activity — processed by whom, for how much. */
  readonly refundsOn: (tenantId: string, day: string) => Promise<readonly ActivityEvent[]> | readonly ActivityEvent[];
  readonly rules: (tenantId: string) => Promise<readonly LpRule[]> | readonly LpRule[];
  readonly raised: (tenantId: string) => Promise<readonly RaisedException[]> | readonly RaisedException[];
  readonly recordRaised: (tenantId: string, r: RaisedException) => Promise<void> | void;
  readonly cases: (tenantId: string) => Promise<readonly InvestigationCase[]> | readonly InvestigationCase[];
  /** Whether a person holds the override authority (`pos.override.approve`) in head office's own grants. */
  readonly mayApproveOverride?: (tenantId: string, userId: string) => Promise<boolean> | boolean;
  /** The shop's trading day an instant belongs to (its time zone and cut-off); absent = the UTC date. */
  readonly tradingDayOf?: (tenantId: string, atIso: string) => Promise<string> | string;
  readonly now: () => string;
}

const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const exceptionIdOf = (day: string, e: { cashierId: string; kind: string; breach: string }): string => `lpx-${day}-${e.cashierId}-${e.kind}-${e.breach}`;

/** How a till action counts for the rules: a void as a void, a no-sale as a no-sale, a price override as a discount. */
export function asRuleActivity(a: TillActivity): ActivityEvent {
  const txnId = a.kind === 'no_sale' ? a.activityId : `${a.billRef ?? a.activityId}:${a.lineId ?? a.activityId}`;
  if (a.kind === 'no_sale') return { txnId, kind: 'no_sale', cashierId: a.cashierId, at: a.at };
  return { txnId, kind: a.kind === 'void' ? 'void' : 'discount', cashierId: a.cashierId, at: a.at, valueMinor: a.valueMinor };
}

/** Run the store's rules over the day's authoritative record — and surface any override head office cannot stand behind. */
async function exceptionsOn(deps: LpActivityDeps, tenantId: string, day: string) {
  const held = await deps.heldOn(tenantId, day);
  const activity = [...held.map(asRuleActivity), ...await deps.refundsOn(tenantId, day)];
  const judged: (LpException | (Omit<LpException, 'breach'> & { readonly breach: 'approver_without_authority' }))[] = evaluateLossPrevention(activity, await deps.rules(tenantId));
  // An override approved by someone head office's grants say may NOT approve one is never a rule question: it is raised
  // whatever the thresholds (§28 · P-08) — linked to each such override.
  const unauthorised = held.filter((a) => a.kind !== 'void' && a.approverAuthorityHeld === false);
  for (const cashierId of [...new Set(unauthorised.map((a) => a.cashierId))]) {
    for (const kind of ['no_sale', 'discount'] as const) {
      const mine = unauthorised.filter((a) => a.cashierId === cashierId && asRuleActivity(a).kind === kind);
      if (mine.length === 0) continue;
      judged.push({ cashierId, kind, breach: 'approver_without_authority', observed: mine.length, limit: 0, severity: 'escalate', linkedTxnIds: mine.map((a) => asRuleActivity(a).txnId) });
    }
  }
  return judged.map((x) => ({ ...x, exceptionId: exceptionIdOf(day, x), day }));
}

const dayOf = async (deps: LpActivityDeps, tenantId: string, atIso: string): Promise<string> =>
  deps.tradingDayOf === undefined ? atIso.slice(0, 10) : await deps.tradingDayOf(tenantId, atIso);

/** Read a relayed till action, or say why not. */
function readTillActivity(activityId: string, b: Record<string, unknown>): Omit<TillActivity, 'relayedBy' | 'approverAuthorityHeld'> | undefined {
  const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const kind = b['kind'];
  if (activityId === '' || b['activityId'] !== activityId || !isStr(b['laneId']) || !isStr(b['cashierId']) || !isStr(b['reason'])
    || typeof b['at'] !== 'string' || Number.isNaN(Date.parse(b['at'])) || !whole(b['valueMinor'])
    || (b['tradingDay'] !== undefined && !isIsoDay(b['tradingDay']))) return undefined;
  const common = {
    activityId, laneId: b['laneId'] as string, cashierId: b['cashierId'] as string, valueMinor: b['valueMinor'] as number,
    reason: b['reason'] as string, at: b['at'] as string,
    ...(isIsoDay(b['tradingDay']) ? { tradingDay: b['tradingDay'] } : {}),
    ...(isStr(b['via']) ? { via: b['via'] as string } : {}),
  };
  const line = isStr(b['billRef']) && isStr(b['lineId']) && isStr(b['productId']) && typeof b['description'] === 'string'
    ? { billRef: b['billRef'] as string, lineId: b['lineId'] as string, productId: b['productId'] as string, description: b['description'] as string }
    : undefined;
  if (kind === 'void') return line === undefined ? undefined : { ...common, kind, ...line };
  // A no-sale and an override name the manager who approved them on the box, and that is never the cashier (§28).
  if (!isStr(b['approvedBy']) || !isStr(b['approvalId']) || b['approvedBy'] === b['cashierId']) return undefined;
  const approval = { approvedBy: b['approvedBy'] as string, approvalId: b['approvalId'] as string };
  if (kind === 'no_sale') {
    if (b['valueMinor'] !== 0) return undefined;
    return { ...common, kind, ...approval, ...(isStr(b['billRef']) ? { billRef: b['billRef'] as string } : {}) };
  }
  if (kind === 'price_override') {
    if (line === undefined || !whole(b['fromUnitMinor']) || !whole(b['toUnitMinor']) || !whole(b['quantityMinor'])
      || (b['toUnitMinor'] as number) >= (b['fromUnitMinor'] as number) || (b['quantityMinor'] as number) <= 0 || (b['valueMinor'] as number) <= 0) return undefined;
    return {
      ...common, kind, ...line, ...approval,
      fromUnitMinor: b['fromUnitMinor'] as number, toUnitMinor: b['toUnitMinor'] as number, quantityMinor: b['quantityMinor'] as number,
    };
  }
  return undefined;
}

export function lpActivityRoutes(deps: LpActivityDeps): readonly Route[] {
  return [
    {
      // A till action RELAYED by the store box (`TillActivityRecorded`): kept, then the day is judged against the rules
      // and whatever breaches is raised. Idempotent on the activity id. `lp.activity.sync` is the box's hop — it grants
      // nothing else.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/activity/:activityId/synced',
      permission: 'lp.activity.sync', idempotent: true,
      handler: async (ctx) => {
        const activityId = (ctx.params['activityId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const read = readTillActivity(activityId, b);
        if (read === undefined) {
          refuse('not_readable_as_till_activity', 'This could not be read as a till action — a void needs the activityId matching the path, the lane, the cashier, the bill, the line, the product, its value, the reason and when; a no-sale and a price override also need the manager who approved them (never the cashier), and an override the price before and after and the quantity.', 400);
        }
        const prior = await deps.activity(ctx.tenantId, activityId);
        if (prior !== undefined) return { status: 200, body: { activityId, recorded: true, alreadyRecorded: true } };
        // The approver is checked against head office's OWN grants. One who may not approve is kept as evidence and
        // raised — never dropped (hard rule #6) and never silently believed (P-08).
        const authority = read!.approvedBy === undefined || deps.mayApproveOverride === undefined
          ? {} : { approverAuthorityHeld: await deps.mayApproveOverride(ctx.tenantId, read!.approvedBy) };
        const a: TillActivity = { ...read!, ...authority, relayedBy: ctx.userId };
        await deps.recordActivity(ctx.tenantId, a);

        // Judge the day on the shop's own record and RAISE what breaches — once, and again only when it grows or escalates.
        const day = a.tradingDay ?? await dayOf(deps, ctx.tenantId, a.at);
        const raisedBefore = new Map((await deps.raised(ctx.tenantId)).map((r) => [r.exceptionId, r] as const));
        const raisedNow: string[] = [];
        for (const x of await exceptionsOn(deps, ctx.tenantId, day)) {
          const before = raisedBefore.get(x.exceptionId);
          if (before !== undefined && before.observed >= x.observed && before.severity === x.severity) continue;
          await deps.recordRaised(ctx.tenantId, {
            exceptionId: x.exceptionId, day, cashierId: x.cashierId, kind: x.kind, breach: x.breach, observed: x.observed,
            limit: x.limit, severity: x.severity, linkedTxnIds: x.linkedTxnIds, raisedAt: deps.now(),
          });
          raisedNow.push(x.exceptionId);
        }
        return { status: 201, body: { activityId, recorded: true, raised: raisedNow } };
      },
    },
    {
      // The till actions head office holds, for a trading day — the evidence itself, with who, why, how much and (for a
      // no-sale or an override) which manager approved it.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/activity',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const day = isIsoDay(ctx.query['day']) ? ctx.query['day'] : await dayOf(deps, ctx.tenantId, deps.now());
        const held = await deps.heldOn(ctx.tenantId, day);
        const voids = held.filter((a) => a.kind === 'void').map(asRuleActivity);
        const noSales = held.filter((a) => a.kind === 'no_sale');
        const overrides = held.filter((a) => a.kind === 'price_override');
        return { status: 200, body: { day, count: held.length, voids, noSales, overrides, asAt: deps.now() } };
      },
    },
    {
      // The exceptions on the SHOP'S OWN RECORD for a day (voids held + refunds banked, against the current rules) — each
      // with when it was raised and the case opened from it, if any. This is the control; `evaluate` is the preview.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/exceptions',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const day = isIsoDay(ctx.query['day']) ? ctx.query['day'] : await dayOf(deps, ctx.tenantId, deps.now());
        const raised = new Map((await deps.raised(ctx.tenantId)).map((r) => [r.exceptionId, r] as const));
        const cases = await deps.cases(ctx.tenantId);
        const exceptions = (await exceptionsOn(deps, ctx.tenantId, day)).map((x) => {
          const r = raised.get(x.exceptionId);
          const c = cases.find((k) => k.raisedFromRef === x.exceptionId);
          return { ...x, ...(r === undefined ? {} : { raisedAt: r.raisedAt }), ...(c === undefined ? {} : { caseId: c.caseId, caseState: c.state }) };
        });
        return { status: 200, body: { day, count: exceptions.length, exceptions, source: 'the shop\'s own record — voids, no-sales and price overrides held, refunds banked', asAt: deps.now() } };
      },
    },
  ];
}
