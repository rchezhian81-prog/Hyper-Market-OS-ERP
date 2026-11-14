// Owner-set auto-approve limits for AI drafts — CR-01 OI-12 (OB-712 option A · P-05 · hard rule 5 · §28).
//
// P-05 says AI recommends or drafts, and DETERMINISTIC RULES and authorised humans commit critical actions. This file is
// that deterministic rule, and nothing else: a pure function of (the draft, the rules two people set, the switch) that
// answers "approved by rule R" or "waits for a person, because …". It never calls a model, never reads a clock it was not
// given, and never executes anything — the assistant still only drafts, and the ordinary route still does the act.
//
//   • KINDS ARE AN ALLOWLIST. A rule can be set only for a kind of act on `AUTO_APPROVE_KINDS`, each drafted by one named
//     assistant. Anything else — including any kind invented later — has no rule and waits for a person (default-deny).
//   • `NEVER_AUTO_APPROVE` IS A CLOSED LIST WITH NO OVERRIDE: a permission change, a refund, a payment to a new payee
//     (CR-01 OI-12 · hard rule 5). No setting, tenant option or parameter can put a rule on them; a draft of one always
//     waits — checked FIRST, before anything else.
//   • SETTING OR CHANGING A LIMIT IS A TWO-PERSON ACT (§28): one person asks, a DIFFERENT person confirms; an assistant can
//     be neither. A request is asked against the rule's version as it was read; if the rule changed since, the request is
//     refused, never silently overwrites (hard rule 10). Every request and every decision is kept (hard rules 2, 6).
//   • ONE SWITCH STOPS ALL AUTO-APPROVAL. It starts STOPPED (silence is not approval); one person may stop it at once with a
//     reason (a control that needs two people does not work at 8pm); starting it again is a two-person act, like a limit.
//   • THE RULE IS THE APPROVER, NEVER THE ASSISTANT. An auto-approval names the rule, its version, the two people who set
//     it, the limit and the measured value; the assistant is recorded only as the drafter.
//
// Pure and deterministic. Tested in tests/unit/ai-auto-approve.test.ts; guarded by
// tests/guardrails/auto-approve-never-for-refunds-permissions-or-new-payees.test.ts.

import type { AgentId } from './authority';
import { FORBIDDEN_TOOLS } from './authority';

export type AutoApproveKind = 'reorder_from_approved_supplier' | 'markdown_short_dated' | 'stock_transfer';

/** How a kind's limit is measured: money in paise, or a percentage in basis points (100 = 1%). */
export type LimitMeasure = 'value_minor' | 'percent_bps';

export interface AutoApproveKindDefinition {
  readonly kind: AutoApproveKind;
  /** The one assistant whose drafts of this kind a rule may approve. */
  readonly agent: AgentId;
  /** The assistant's drafting tool this kind comes from (packages/ai/src/authority.ts). */
  readonly tool: string;
  readonly measure: LimitMeasure;
  readonly nameEn: string;
  readonly nameTa: string;
  /** What makes a draft of this kind "usual" — anything else waits for a person. Said on the owner's screen. */
  readonly usualEn: string;
  readonly usualTa: string;
  /** The ordinary route the act goes through — its own permissions, price guard and checks still apply. */
  readonly ordinaryRoute: string;
}

/** Short-dated, as the near-expiry list already means it (A03's near-expiry window, services/api/src/ai-adapters.ts). */
export const SHORT_DATED_DAYS = 7;
/** A draft older than this is regenerated against fresh figures, never approved against old ones (authority.ts default). */
export const DRAFT_STALE_AFTER_MINUTES = 60;

export const AUTO_APPROVE_KINDS: Readonly<Record<AutoApproveKind, AutoApproveKindDefinition>> = Object.freeze({
  reorder_from_approved_supplier: {
    kind: 'reorder_from_approved_supplier', agent: 'A02', tool: 'draft_purchase_order', measure: 'value_minor',
    nameEn: 'A reorder from an approved supplier', nameTa: 'அங்கீகரிக்கப்பட்ட சப்ளையரிடமிருந்து மறு ஆர்டர்',
    usualEn: 'The supplier is approved on the supplier list, and the order has at least one line and a value above nothing.',
    usualTa: 'சப்ளையர் அங்கீகரிக்கப்பட்ட பட்டியலில் உள்ளார்; ஆர்டரில் குறைந்தது ஒரு வரியும் பூஜ்ஜியத்திற்கு மேல் மதிப்பும் உள்ளது.',
    ordinaryRoute: 'POST /v1/purchase/orders/:poId',
  },
  markdown_short_dated: {
    kind: 'markdown_short_dated', agent: 'A03', tool: 'suggest_markdown', measure: 'percent_bps',
    nameEn: 'A markdown on short-dated stock', nameTa: 'காலாவதி நெருங்கும் சரக்கிற்கு விலைக் குறைப்பு',
    usualEn: `The batch expires within ${SHORT_DATED_DAYS} days and has not expired yet; the cut is above nothing.`,
    usualTa: `தொகுப்பு ${SHORT_DATED_DAYS} நாட்களுக்குள் காலாவதியாகும், இன்னும் காலாவதியாகவில்லை; குறைப்பு பூஜ்ஜியத்திற்கு மேல்.`,
    ordinaryRoute: 'POST /v1/prices/changes',
  },
  stock_transfer: {
    kind: 'stock_transfer', agent: 'A03', tool: 'suggest_transfer', measure: 'value_minor',
    nameEn: 'A stock transfer between our own places', nameTa: 'நமது சொந்த இடங்களுக்கு இடையே சரக்கு மாற்றம்',
    usualEn: 'From one of our places to a different one of our places, a quantity and a value above nothing.',
    usualTa: 'நமது ஒரு இடத்திலிருந்து வேறொரு இடத்திற்கு; அளவும் மதிப்பும் பூஜ்ஜியத்திற்கு மேல்.',
    ordinaryRoute: 'POST /v1/warehouse/transfers/:transferId',
  },
});

/**
 * Kinds of act NO rule may ever be set for (CR-01 OI-12 · hard rule 5). **There is no override anywhere** — not a flag, not
 * a tenant setting, not a parameter. Frozen, and checked first, both when a rule is asked for and when a draft is decided.
 */
export const NEVER_AUTO_APPROVE: readonly string[] = Object.freeze(['permission_change', 'refund', 'payment_to_new_payee']);

/** Exactly what the assistant proposes to do — the only thing a rule can measure. A draft without one waits. */
export type DraftAct =
  | {
    readonly kind: 'reorder_from_approved_supplier'; readonly supplierId: string; readonly supplierApproved: boolean; readonly valueMinor: number;
    /** Each line in the product's own smallest step (grams for kg), at the supplier's last price per whole unit (OB-761). */
    readonly lines: readonly { readonly productId: string; readonly qty: number; readonly unitCostMinor?: number; readonly uom?: string }[];
    /** CR-01 step 6b: where the order is delivered (the store the reorder settings are for) — needed to place it. */
    readonly deliverToLocationId?: string;
    /** In plain words, how the quantity and price were worked out (settings version, max level, pack, last price). */
    readonly basis?: string;
  }
  | {
    readonly kind: 'markdown_short_dated'; readonly productId: string; readonly batchId: string; readonly percentOffBps: number; readonly daysToExpiry: number;
    /** CR-01 step 6b (OB-762): the price change the ladder gives, as `POST /v1/prices/changes` takes it. */
    readonly storeId?: string; readonly currentPriceMinor?: number; readonly newPriceMinor?: number;
    readonly mrpMinor?: number; readonly costMinor?: number; readonly surplusQty?: number; readonly basis?: string;
  }
  | {
    readonly kind: 'stock_transfer'; readonly productId: string; readonly fromLocationId: string; readonly toLocationId: string; readonly qty: number; readonly valueMinor: number;
    readonly uom?: string; readonly basis?: string;
  };

export type ChangeAction = 'set_limit' | 'remove_limit' | 'resume';

/** One person asking for a change. Nothing changes until a DIFFERENT person confirms it. */
export interface AutoApproveRequest {
  readonly requestId: string;
  readonly action: ChangeAction;
  /** The kind for set_limit / remove_limit; absent for resume. */
  readonly kind?: AutoApproveKind;
  /** The new limit for set_limit (paise, or basis points for a markdown). */
  readonly limit?: number;
  /** The rule version (or, for resume, the switch version) the asker read. A change since refuses the request. */
  readonly basedOnVersion: number;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

export interface AutoApproveConfirmation {
  readonly requestId: string;
  readonly decision: 'confirmed' | 'refused';
  readonly by: string;
  readonly at: string;
  readonly reason?: string;
}

/** The one switch, pulled: instant, one person, with a reason. */
export interface AutoApproveStop {
  readonly stopId: string;
  readonly by: string;
  readonly at: string;
  readonly reason: string;
}

export interface AutoApproveRule {
  readonly ruleId: string;
  readonly kind: AutoApproveKind;
  readonly limit: number;
  readonly measure: LimitMeasure;
  readonly version: number;
  readonly askedBy: string;
  readonly confirmedBy: string;
  readonly askedAt: string;
  readonly confirmedAt: string;
  readonly reason: string;
}

export interface SettledChange {
  readonly requestId: string;
  readonly action: ChangeAction;
  readonly kind?: AutoApproveKind;
  readonly limit?: number;
  readonly decision: 'confirmed' | 'refused';
  readonly askedBy: string;
  readonly askedAt: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
  readonly decisionReason?: string;
  /** The rule version (or switch version) this change made — only for a confirmed change. */
  readonly version?: number;
}

export interface AutoApproveState {
  /** The rules in force, one per kind at most. */
  readonly rules: readonly AutoApproveRule[];
  /** Requests nobody has confirmed or refused yet. */
  readonly pending: readonly AutoApproveRequest[];
  /** Every confirmed or refused change, oldest first. Never pruned. */
  readonly history: readonly SettledChange[];
  /** Every stop ever pulled. Never pruned. */
  readonly stops: readonly AutoApproveStop[];
  /** Is auto-approval running now? False until two people start it, and after any stop until two people start it again. */
  readonly running: boolean;
  /** The switch's version: raised by every stop and every confirmed start. A start request asked against an older one is refused. */
  readonly switchVersion: number;
  readonly stoppedBy?: AutoApproveStop;
  readonly startedBy?: { readonly askedBy: string; readonly confirmedBy: string; readonly at: string };
  /** The current version per kind (0 = never set). */
  readonly versionOf: Readonly<Record<AutoApproveKind, number>>;
}

const KINDS = Object.keys(AUTO_APPROVE_KINDS) as AutoApproveKind[];
const isKind = (k: unknown): k is AutoApproveKind => typeof k === 'string' && (KINDS as string[]).includes(k);
const byTime = <T>(at: (x: T) => string) => (a: T, b: T): number => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0);

/**
 * Fold the append-only facts into the state in force. A confirmation counts only when it is by a DIFFERENT person than the
 * asker and the request was asked against the version current when it is confirmed — so even a confirmation that reached the
 * store by some other path cannot widen anything.
 */
export function foldAutoApprove(input: {
  readonly requests: readonly AutoApproveRequest[];
  readonly confirmations: readonly AutoApproveConfirmation[];
  readonly stops: readonly AutoApproveStop[];
}): AutoApproveState {
  const requestOf = new Map<string, AutoApproveRequest>();
  for (const r of input.requests) if (!requestOf.has(r.requestId)) requestOf.set(r.requestId, r);
  const firstDecision = new Map<string, AutoApproveConfirmation>();
  for (const c of [...input.confirmations].sort(byTime((x) => x.at))) if (!firstDecision.has(c.requestId)) firstDecision.set(c.requestId, c);

  const versionOf: Record<AutoApproveKind, number> = { reorder_from_approved_supplier: 0, markdown_short_dated: 0, stock_transfer: 0 };
  const rules = new Map<AutoApproveKind, AutoApproveRule>();
  const history: SettledChange[] = [];
  let switchVersion = 0;
  let running = false;
  let stoppedBy: AutoApproveStop | undefined;
  let startedBy: AutoApproveState['startedBy'];

  // Replay stops and decisions in time order, so a stop after a start stops, and a start after a stop starts.
  type Step = { readonly at: string; readonly stop?: AutoApproveStop; readonly decision?: AutoApproveConfirmation };
  const steps: Step[] = [
    ...input.stops.map((s): Step => ({ at: s.at, stop: s })),
    ...[...firstDecision.values()].map((d): Step => ({ at: d.at, decision: d })),
  ].sort(byTime((x) => x.at));

  for (const step of steps) {
    if (step.stop !== undefined) {
      switchVersion += 1; running = false; stoppedBy = step.stop;
      continue;
    }
    const d = step.decision!;
    const r = requestOf.get(d.requestId);
    if (r === undefined) continue;
    const settled = { requestId: r.requestId, action: r.action, ...(r.kind === undefined ? {} : { kind: r.kind }), ...(r.limit === undefined ? {} : { limit: r.limit }), askedBy: r.requestedBy, askedAt: r.requestedAt, decidedBy: d.by, decidedAt: d.at, reason: r.reason, ...(d.reason === undefined ? {} : { decisionReason: d.reason }) };
    if (d.decision === 'refused') { history.push({ ...settled, decision: 'refused' }); continue; }
    // A confirmation that does not hold — the same person, a stale version, a kind never allowed — changes nothing.
    if (d.by === r.requestedBy) continue;
    if (r.action === 'resume') {
      if (r.basedOnVersion !== switchVersion) continue;
      switchVersion += 1; running = true; stoppedBy = undefined;
      startedBy = { askedBy: r.requestedBy, confirmedBy: d.by, at: d.at };
      history.push({ ...settled, decision: 'confirmed', version: switchVersion });
      continue;
    }
    if (!isKind(r.kind) || NEVER_AUTO_APPROVE.includes(r.kind)) continue;
    if (r.basedOnVersion !== versionOf[r.kind]) continue;
    if (r.action === 'set_limit' && !limitReadable(r.kind, r.limit)) continue;
    versionOf[r.kind] += 1;
    const version = versionOf[r.kind];
    if (r.action === 'remove_limit') rules.delete(r.kind);
    else {
      rules.set(r.kind, {
        ruleId: `${r.kind}-v${version}`, kind: r.kind, limit: r.limit!, measure: AUTO_APPROVE_KINDS[r.kind].measure, version,
        askedBy: r.requestedBy, confirmedBy: d.by, askedAt: r.requestedAt, confirmedAt: d.at, reason: r.reason,
      });
    }
    history.push({ ...settled, decision: 'confirmed', version });
  }

  const pending = [...requestOf.values()].filter((r) => !firstDecision.has(r.requestId)).sort(byTime((x) => x.requestedAt));
  return {
    rules: KINDS.flatMap((k) => (rules.has(k) ? [rules.get(k)!] : [])),
    pending, history, stops: [...input.stops].sort(byTime((x) => x.at)),
    running, switchVersion, versionOf,
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
    ...(startedBy === undefined || !running ? {} : { startedBy }),
  };
}

function limitReadable(kind: AutoApproveKind, limit: unknown): limit is number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) return false;
  return AUTO_APPROVE_KINDS[kind].measure === 'percent_bps' ? limit <= 10_000 : true;
}

export type ChangeRefusal =
  | 'never_auto_approvable'
  | 'not_an_auto_approvable_kind'
  | 'limit_not_readable'
  | 'reason_needed'
  | 'agent_cannot_ask'
  | 'agent_cannot_confirm'
  | 'same_person'
  | 'rule_changed_since_asked'
  | 'already_running'
  | 'no_rule_to_remove';

export type ChangeCheck = { readonly ok: true } | { readonly ok: false; readonly code: ChangeRefusal; readonly detail: string };

const no = (code: ChangeRefusal, detail: string): ChangeCheck => ({ ok: false, code, detail });

/** May this request be recorded at all? (It still changes nothing until a different person confirms it.) */
export function checkChangeRequest(r: AutoApproveRequest, state: AutoApproveState, agentIdentities: readonly string[] = []): ChangeCheck {
  // The closed list first, before anything else — including before the kind allowlist.
  if (r.kind !== undefined && (NEVER_AUTO_APPROVE.includes(r.kind) || FORBIDDEN_TOOLS.includes(r.kind))) {
    return no('never_auto_approvable', `No rule can ever be set for "${String(r.kind)}": a permission change, a refund and a payment to a new payee always wait for a person (CR-01 OI-12, hard rule 5).`);
  }
  if (agentIdentities.includes(r.requestedBy)) return no('agent_cannot_ask', 'An assistant cannot ask for a limit. Only people set the limits the assistants work within (P-05).');
  if (r.reason.trim() === '') return no('reason_needed', 'Say in a few words why — the reason is kept with the rule.');
  if (r.action === 'resume') {
    if (state.running) return no('already_running', 'Auto-approval is already running.');
    if (r.basedOnVersion !== state.switchVersion) return no('rule_changed_since_asked', 'The switch was stopped or started since you read it. Read it again.');
    return { ok: true };
  }
  if (!isKind(r.kind)) return no('not_an_auto_approvable_kind', `"${String(r.kind)}" is not a kind of act a rule can be set for. Only: ${KINDS.join(', ')}.`);
  if (r.basedOnVersion !== state.versionOf[r.kind]) return no('rule_changed_since_asked', `The rule for ${AUTO_APPROVE_KINDS[r.kind].nameEn.toLowerCase()} changed since you read it (now version ${state.versionOf[r.kind]}). Read it again and ask on what is there now.`);
  if (r.action === 'remove_limit') {
    return state.rules.some((x) => x.kind === r.kind) ? { ok: true } : no('no_rule_to_remove', 'There is no rule for this kind to remove.');
  }
  if (!limitReadable(r.kind, r.limit)) {
    return no('limit_not_readable', AUTO_APPROVE_KINDS[r.kind].measure === 'percent_bps'
      ? 'A markdown limit is a whole percentage above 0 and at most 100.'
      : 'A limit is an amount in rupees above nothing.');
  }
  return { ok: true };
}

/** May THIS person confirm THIS request now? */
export function confirmChange(input: {
  readonly request: AutoApproveRequest;
  readonly by: string;
  readonly state: AutoApproveState;
  readonly agentIdentities: readonly string[];
}): ChangeCheck {
  const { request: r, by, state } = input;
  if (input.agentIdentities.includes(by)) return no('agent_cannot_confirm', 'An assistant can never confirm a limit — no identity in this system both drafts and approves (P-05).');
  if (by === r.requestedBy) return no('same_person', `${by} asked for this change, so a different person must confirm it (two people, §28).`);
  // Everything the asker was checked against is checked again now: the world may have moved since.
  return checkChangeRequest({ ...r, requestedBy: r.requestedBy }, state, input.agentIdentities);
}

export type WaitReason =
  | 'never_auto_approvable'
  | 'no_exact_act'
  | 'not_an_auto_approvable_kind'
  | 'not_this_assistants_kind'
  | 'ai_stopped'
  | 'auto_approval_stopped'
  | 'no_rule_for_this_kind'
  | 'no_evidence'
  | 'stale_draft'
  | 'unusual'
  | 'over_the_limit'
  /** CR-01 step 6b (OB-760): inside the limit, but the ordinary route refused it — a person decides, with the route's reason. */
  | 'refused_by_route';

export interface DraftForDecision {
  readonly proposalId: string;
  readonly agent: AgentId;
  readonly act?: DraftAct;
  readonly evidenceCount: number;
  readonly createdAt: string;
}

export type AutoApproveDecision =
  | {
    readonly outcome: 'auto_approved';
    readonly proposalId: string;
    readonly kind: AutoApproveKind;
    /** The RULE is the approver — `rule:<ruleId>`. Never an assistant, never a person who did not set the rule. */
    readonly approvedBy: `rule:${string}`;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly ruleSetBy: { readonly askedBy: string; readonly confirmedBy: string };
    readonly limit: number;
    readonly measured: number;
    readonly measure: LimitMeasure;
    readonly draftedBy: AgentId;
    readonly ordinaryRoute: string;
    readonly at: string;
    readonly detail: string;
    /** CR-01 step 6b (OB-760): what the ordinary route placed — present once the act is placed. */
    readonly placed?: { readonly route: string; readonly reference: string; readonly by: string };
  }
  | {
    readonly outcome: 'waits_for_a_person';
    readonly proposalId: string;
    readonly kind?: string;
    readonly because: WaitReason;
    readonly draftedBy: AgentId;
    readonly at: string;
    readonly detail: string;
    /** CR-01 step 6b: for `refused_by_route` — which route refused, its code, and the rule that had approved the draft. */
    readonly refusedBy?: { readonly route: string; readonly code: string; readonly ruleId: string; readonly reference?: string };
  };

export function rupeesOf(minor: number): string {
  return `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function percentOf(bps: number): string {
  return `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
}
const measureWords = (m: LimitMeasure, v: number): string => (m === 'percent_bps' ? percentOf(v) : rupeesOf(v));

function measured(act: DraftAct): number {
  return act.kind === 'markdown_short_dated' ? act.percentOffBps : act.valueMinor;
}

/** Is this draft "usual" for its kind? Anything else waits for a person. Returns why not, or undefined. */
function unusualBecause(act: DraftAct): string | undefined {
  switch (act.kind) {
    case 'reorder_from_approved_supplier':
      if (!act.supplierApproved) return `${act.supplierId} is not an approved supplier on the supplier list`;
      if (act.lines.length === 0 || act.lines.some((l) => !Number.isInteger(l.qty) || l.qty <= 0)) return 'the order has no line, or a line with no quantity';
      if (!Number.isInteger(act.valueMinor) || act.valueMinor <= 0) return 'the order has no value';
      return undefined;
    case 'markdown_short_dated':
      if (!Number.isInteger(act.daysToExpiry) || act.daysToExpiry < 1) return 'the batch has already expired — that is a disposal, not a markdown';
      if (act.daysToExpiry > SHORT_DATED_DAYS) return `the batch expires in ${act.daysToExpiry} days — not short-dated (within ${SHORT_DATED_DAYS})`;
      if (!Number.isInteger(act.percentOffBps) || act.percentOffBps <= 0 || act.percentOffBps > 10_000) return 'the cut is not a percentage above nothing';
      return undefined;
    case 'stock_transfer':
      if (act.fromLocationId === act.toLocationId) return 'it moves stock to the place it is already in';
      if (!Number.isInteger(act.qty) || act.qty <= 0 || !Number.isInteger(act.valueMinor) || act.valueMinor <= 0) return 'it moves no quantity or no value';
      return undefined;
    default:
      return 'it is not a kind this rule knows';
  }
}

/**
 * Decide ONE draft: approved by the rule, or waits for a person — and why, in plain words. Deterministic: the same draft,
 * rules and switch always give the same answer. The order of checks is deliberate: the closed list first, then whether there
 * is an exact act, the kind, the assistant, the switches, the rule, the evidence, the age, the usual checks, the limit.
 */
export function decideDraft(input: {
  readonly draft: DraftForDecision;
  readonly state: AutoApproveState;
  /** The AI kill switch (shop-wide or for this assistant). When on, nothing is auto-approved either. */
  readonly aiStopped: boolean;
  readonly now: string;
}): AutoApproveDecision {
  const { draft, state, now } = input;
  const act = draft.act as (DraftAct & { readonly kind: string }) | undefined;
  const wait = (because: WaitReason, detail: string): AutoApproveDecision => ({
    outcome: 'waits_for_a_person', proposalId: draft.proposalId, ...(act?.kind === undefined ? {} : { kind: act.kind }),
    because, draftedBy: draft.agent, at: now, detail,
  });

  if (act !== undefined && (NEVER_AUTO_APPROVE.includes(act.kind) || FORBIDDEN_TOOLS.includes(act.kind))) {
    return wait('never_auto_approvable', 'A permission change, a refund or a payment to a new payee always waits for a person. No rule can ever approve it.');
  }
  if (act === undefined) return wait('no_exact_act', 'The draft does not say exactly what would be done (who, what, how much), so no rule can measure it. A person decides.');
  if (!isKind(act.kind)) return wait('not_an_auto_approvable_kind', `"${act.kind}" is not a kind of act a rule can approve. A person decides.`);
  const def = AUTO_APPROVE_KINDS[act.kind];
  if (def.agent !== draft.agent) return wait('not_this_assistants_kind', `${def.nameEn} is drafted by ${def.agent}, not ${draft.agent}. A person decides.`);
  if (input.aiStopped) return wait('ai_stopped', 'The AI is stopped, so nothing it drafted is auto-approved. A person decides.');
  if (!state.running) {
    return wait('auto_approval_stopped', state.stoppedBy === undefined
      ? 'Auto-approval has not been started. A person decides.'
      : `Auto-approval was stopped by ${state.stoppedBy.by} (${state.stoppedBy.reason}). A person decides.`);
  }
  const rule = state.rules.find((r) => r.kind === act.kind);
  if (rule === undefined) return wait('no_rule_for_this_kind', `No limit is set for ${def.nameEn.toLowerCase()}. A person decides.`);
  if (draft.evidenceCount <= 0) return wait('no_evidence', 'The draft cites no records, so nobody could check it. A person decides.');
  const ageMinutes = Math.floor((Date.parse(now) - Date.parse(draft.createdAt)) / 60_000);
  if (!Number.isFinite(ageMinutes) || ageMinutes > DRAFT_STALE_AFTER_MINUTES) {
    return wait('stale_draft', `The draft is ${Number.isFinite(ageMinutes) ? `${ageMinutes} minutes` : 'of unknown age and'} old; figures may have moved. Run the assistant again, or a person decides.`);
  }
  const odd = unusualBecause(act);
  if (odd !== undefined) return wait('unusual', `Unusual: ${odd}. A person decides.`);
  const value = measured(act);
  if (value > rule.limit) {
    return wait('over_the_limit', `${measureWords(def.measure, value)} is above the ${measureWords(def.measure, rule.limit)} limit for ${def.nameEn.toLowerCase()}. A person decides.`);
  }
  return {
    outcome: 'auto_approved', proposalId: draft.proposalId, kind: act.kind, approvedBy: `rule:${rule.ruleId}`,
    ruleId: rule.ruleId, ruleVersion: rule.version, ruleSetBy: { askedBy: rule.askedBy, confirmedBy: rule.confirmedBy },
    limit: rule.limit, measured: value, measure: def.measure, draftedBy: draft.agent, ordinaryRoute: def.ordinaryRoute, at: now,
    detail: `${measureWords(def.measure, value)} is within the ${measureWords(def.measure, rule.limit)} limit for ${def.nameEn.toLowerCase()} set by ${rule.askedBy} and confirmed by ${rule.confirmedBy} (rule ${rule.ruleId}). Approved by the rule, drafted by ${draft.agent}.`,
  };
}
