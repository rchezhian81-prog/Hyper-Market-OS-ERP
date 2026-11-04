// API-08 / API-07 — a substitute that needs the customer's yes is ANSWERED BY THE CUSTOMER (OB-687, owner, 4 Nov 2026 ·
// FUL-14 · M19-FR-02 · M19-FR-01 · P-05 · P-08 · hard rules #2 #6 #10).
//
// The picker's phone used to record a swap only when the customer had ALREADY agreed somewhere, with a reference typed in.
// Now, on a line whose customer asked to be asked first ("contact me"), the phone PROPOSES the swap and the customer answers:
//
//   POST /v1/fulfilment/waves/:waveId/lines/:lineId/substitution-proposal/synced   the phone's proposal, relayed by the store
//                                                   computer — kept once (append-only), the picker re-verified, the shop's own
//                                                   rules run on it (a swap they refuse is said, never offered)
//   GET  /v1/orders/:orderId/substitution-proposals the proposals on an order, each with where it stands — the desk's read
//   POST /v1/orders/:orderId/substitution-proposals/:lineId/answer
//                                                   staff record the customer's yes or no given by phone (or WhatsApp, SMS, in
//                                                   person), naming how they were reached — it counts the same as the app's
//   GET  /v1/fulfilment/substitution-wait           how long the picker waits — the OWNER's number, "not set" until he sets it
//   POST /v1/fulfilment/substitution-wait           the owner sets it (its own permission), every change kept
//
// The customer's own answer is the storefront's `POST /v1/storefront/orders/:orderId/substitutions/:lineId`, which asks this
// module first (`customerProposalPort`). The answer is read back by the store computer on the wave it already pulls
// (`substitutionsForWave`), and the picker packs by it. When the picker's packed outcome for the line arrives, the swap is put
// on the ORDER through the one substitution path (`POST /v1/orders/:orderId/substitute`'s own code) — a yes as `confirmed`
// (the yes is on record, so the consent rule passes), a no or a refused swap as `declined`, no answer as `no_answer` — so the
// order, the bill and any refund match what was packed (`settleOnPick`). A failure there is kept on the record, never dropped.
//
// With no wait set the picker does not wait (the phone sends nothing and the line goes short). With a wait set, no answer by
// the proposal's time + the wait → too late: the app refuses a late answer and the phone packs the line short.

import type { Route } from '../../kernel/src/index';
import { apiError, ApiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { assessSubstitution, type ProductAttributes, type CustomerSubstitutionRules, type SubstitutionEligibility } from '../../../packages/orders/src/substitution-policy';
import type { WaveLineOutcome } from './waves';

/** Why the picker offers a swap — the phone's chosen reason (apps/picker-app PROPOSAL_REASONS). */
export const PROPOSAL_REASONS = Object.freeze(['out_of_stock', 'not_found'] as const);
export type ProposalReason = (typeof PROPOSAL_REASONS)[number];

/** The reason in the customer's words, both languages (the app shows it beside the product and the price). */
export const REASON_WORDS: Readonly<Record<ProposalReason, { readonly en: string; readonly ta: string }>> = Object.freeze({
  out_of_stock: { en: 'We have none left on the shelf.', ta: 'அலமாரியில் இது தீர்ந்துவிட்டது.' },
  not_found: { en: 'Our picker could not find it in the shop.', ta: 'எங்கள் ஊழியரால் இதைக் கடையில் கண்டுபிடிக்க முடியவில்லை.' },
});

/** Where a proposal stands. `closed`: the picker settled the line before any answer; `too_late`: past the owner's wait. */
export const PROPOSAL_STATES = Object.freeze(['waiting', 'yes', 'no', 'refused', 'too_late', 'closed'] as const);
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** The permission the owner's wait is set under — its own (OB-687), never borrowed from another number. */
export const SUBSTITUTION_WAIT_PERMISSION = 'fulfilment.substitution_wait.set';
/** Whole minutes, 1 to 240 — at most the picker's four-hour sign-in (OB-184); the owner chooses within it. */
export const WAIT_MINUTES_MAX = 240;

/** The person who proposes must be one who may pick (the crate's recorder) — the same grant the wave register checks. */
const PICK_PERMISSION = 'fulfilment.pack.record';

export interface SubstitutionProposal {
  readonly proposalId: string;
  readonly waveId: string;
  readonly lineId: string;
  readonly orderId: string;
  readonly orderedProductId: string;
  readonly orderedName: string;
  readonly substituteProductId: string;
  readonly substituteName: string | null;
  /** The substitute's published price per unit when head office received the proposal; null when none is published. */
  readonly substituteUnitPriceMinor: number | null;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly why: ProposalReason;
  readonly proposedBy: string | null;
  readonly relayedBy: string;
  /** When the picker asked (the phone's clock) — the owner's wait counts from here. */
  readonly proposedAt: string;
  readonly receivedAt: string;
  /** The owner's wait in force when head office received it; null: not set — nothing is put to the customer. */
  readonly waitMinutes: number | null;
  readonly answerBy: string | null;
  /** What the shop's own substitution rules say about this swap, run here (never on the phone). */
  readonly eligibility: SubstitutionEligibility;
  /** When refused: why, in head office's words. */
  readonly refusedBecause: string | null;
  readonly governanceFlags: readonly string[];
}

/** How a proposal ended when the picker's packed outcome for the line arrived — kept, success or refusal (P-08). */
export interface ProposalSettlement {
  readonly proposalId: string;
  readonly orderId: string;
  readonly lineId: string;
  /** What the crate holds for the line: the swap, nothing (short), the product ordered after all, or another swap. */
  readonly packed: 'swapped' | 'short' | 'picked_as_ordered' | 'another_swap';
  /** The decision put on the order through the substitution path; null when nothing was put on it. */
  readonly decision: 'confirmed' | 'declined' | 'no_answer' | null;
  readonly onOrder: boolean;
  /** What the substitution path recorded on the order — the bill and any refund, as it said them. */
  readonly onOrderAs?: { readonly outcome: string; readonly pickProductId: string | null; readonly pickQuantityMinor: number; readonly chargeMinor: number; readonly refundMinor: number };
  readonly refusal: { readonly code: string; readonly whatHappened: string } | null;
  readonly at: string;
}

/** One change of the owner's wait (append-only). */
export interface SubstitutionWaitChange {
  readonly version: number;
  readonly minutes: number;
  readonly reason: string | null;
  readonly setBy: string;
  readonly setAt: string;
}

/** A recorded yes or no (the storefront's `SubstitutionConsent`, read structurally). */
export interface ConsentFact {
  readonly orderId: string;
  readonly lineId: string;
  readonly substituteProductId: string;
  readonly decision: 'confirmed' | 'declined';
  readonly acceptsHigherPrice: boolean;
  readonly given: 'customer' | 'staff_contact';
  readonly by: string;
  readonly contact?: { readonly method: string; readonly reference: string };
  readonly at: string;
}

type Permissions = (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;

export interface SubstitutionProposalDeps {
  readonly permissionsOfUser: Permissions;
  readonly proposalsOfOrder: (tenantId: string, orderId: string) => Promise<readonly SubstitutionProposal[]>;
  readonly proposalsOfWave: (tenantId: string, waveId: string) => Promise<readonly SubstitutionProposal[]>;
  /** Kept on the order's and the wave's registers in one write; keyed on the proposal, so a replay lands once. */
  readonly recordProposal: (tenantId: string, p: SubstitutionProposal) => Promise<void>;
  readonly settlements: (tenantId: string, orderId: string) => Promise<readonly ProposalSettlement[]>;
  readonly recordSettlement: (tenantId: string, s: ProposalSettlement) => Promise<void>;
  readonly waitHistory: (tenantId: string) => Promise<readonly SubstitutionWaitChange[]>;
  readonly recordWait: (tenantId: string, c: SubstitutionWaitChange) => Promise<void>;
  /** The order as placed: its lines (by product) and state. Undefined: no such order. */
  readonly order: (tenantId: string, orderId: string) => Promise<{ readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[]; readonly state: string } | undefined>;
  /** FUL-14's stored truth: the published price and the product master's attributes. */
  readonly product: (tenantId: string, productId: string) => Promise<{ readonly unitPriceMinor?: number; readonly attrs?: ProductAttributes; readonly name?: string } | undefined>;
  readonly rulesFor: (tenantId: string, orderId: string) => Promise<{ readonly rules: CustomerSubstitutionRules } | undefined>;
  readonly consents: (tenantId: string, orderId: string) => Promise<readonly ConsentFact[]>;
  readonly recordConsent: (tenantId: string, c: ConsentFact) => Promise<void>;
  /** The ONE substitution path (`recordSubstitutionDecision`) — the composition wires it; a refusal comes back as an ApiError. */
  readonly applyDecision: (tenantId: string, input: {
    readonly userId: string; readonly orderId: string; readonly decision: 'confirmed' | 'declined' | 'no_answer';
    readonly offer: {
      readonly lineId: string; readonly orderedProductId: string; readonly orderedName: string; readonly orderedUnitPriceMinor: number; readonly orderedQuantityMinor: number;
      readonly substituteProductId: string; readonly substituteName: string; readonly substituteUnitPriceMinor: number; readonly substituteQuantityMinor: number; readonly offeredAt: string;
    };
  }) => Promise<unknown>;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const CONTACT_METHODS: readonly string[] = ['phone', 'whatsapp', 'sms', 'in_person'];

/** The owner's wait as it stands: his latest change, or "not set". Pure. */
export function waitInForce(history: readonly SubstitutionWaitChange[]): { readonly minutes: number | null; readonly state: 'set' | 'not_set'; readonly setBy: string | null; readonly setAt: string | null } {
  const last = history.at(-1);
  return last === undefined ? { minutes: null, state: 'not_set', setBy: null, setAt: null } : { minutes: last.minutes, state: 'set', setBy: last.setBy, setAt: last.setAt };
}

/** A customer rule as the phone carries it (no PII): ask first, never, or the shop may choose. */
export function lineRuleOf(rules: CustomerSubstitutionRules | undefined): 'ask_first' | 'never' | 'best_match' | undefined {
  if (rules === undefined) return undefined;
  return rules.preference === 'contact_me' ? 'ask_first' : rules.preference === 'no_substitution' ? 'never' : 'best_match';
}

/**
 * Where a proposal stands — pure. The FIRST yes or no recorded for this line and substitute after head office received the
 * proposal is the answer (answered once); the shop's own refusal comes before any answer; past the owner's wait it is too
 * late; a line the picker already settled (before the time ran out) is closed; otherwise it waits.
 */
export function proposalStanding(p: SubstitutionProposal, consents: readonly ConsentFact[], settled: ProposalSettlement | undefined, now: string): {
  readonly state: ProposalState; readonly answer?: ConsentFact;
} {
  if (p.eligibility === 'refused') return { state: 'refused' };
  const answer = consents.find((c) => c.lineId === p.lineId && c.substituteProductId === p.substituteProductId && Date.parse(c.at) >= Date.parse(p.receivedAt));
  if (answer !== undefined) return { state: answer.decision === 'confirmed' ? 'yes' : 'no', answer };
  if (p.answerBy === null) return { state: 'closed' };
  if (Date.parse(now) > Date.parse(p.answerBy)) return { state: 'too_late' };
  if (settled !== undefined) return { state: 'closed' };
  return { state: 'waiting' };
}

/** The phone's read-back of one proposal (the store computer carries it on the wave). */
export function answerForPhone(p: SubstitutionProposal, standing: ReturnType<typeof proposalStanding>): Record<string, unknown> {
  const a = standing.answer;
  return {
    proposalId: p.proposalId, lineId: p.lineId, state: standing.state, substituteProductId: p.substituteProductId,
    ...(p.substituteName === null ? {} : { substituteName: p.substituteName }), substituteUnitPriceMinor: p.substituteUnitPriceMinor,
    ...(p.answerBy === null ? {} : { answerBy: p.answerBy }),
    ...(a === undefined ? {} : { via: a.given === 'customer' ? 'app' : 'staff', ...(a.contact === undefined ? {} : { reference: `${a.contact.method}: ${a.contact.reference}` }) }),
    ...(standing.state === 'refused' && p.refusedBecause !== null ? { reason: p.refusedBecause } : {}),
  };
}

/** One proposal as the customer (or the desk) reads it: the product, the price, why, and where it stands. */
export function proposalView(p: SubstitutionProposal, standing: ReturnType<typeof proposalStanding>, settled: ProposalSettlement | undefined): Record<string, unknown> {
  return {
    proposalId: p.proposalId, lineId: p.lineId, orderId: p.orderId,
    orderedProductId: p.orderedProductId, orderedName: p.orderedName,
    substituteProductId: p.substituteProductId, substituteName: p.substituteName ?? p.substituteProductId,
    substituteUnitPriceMinor: p.substituteUnitPriceMinor, quantityMinor: p.quantityMinor, uom: p.uom,
    why: p.why, whySay: REASON_WORDS[p.why], state: standing.state, answerBy: p.answerBy, proposedAt: p.proposedAt,
    ...(standing.answer === undefined ? {} : { answeredAt: standing.answer.at, answeredVia: standing.answer.given === 'customer' ? 'app' : 'staff', ...(standing.answer.contact === undefined ? {} : { contact: standing.answer.contact }) }),
    ...(standing.state === 'refused' ? { refusedBecause: p.refusedBecause } : {}),
    ...(settled === undefined ? {} : { settled: { packed: settled.packed, decision: settled.decision, onOrder: settled.onOrder, ...(settled.onOrderAs === undefined ? {} : { onOrderAs: settled.onOrderAs }), refusal: settled.refusal } }),
  };
}

interface RelayedProposal {
  readonly proposalId: string; readonly orderRef: string; readonly orderedProductId: string; readonly description: string;
  readonly substituteProductId: string; readonly quantity: number; readonly uom: string; readonly why: ProposalReason;
  readonly proposedAt: string; readonly proposedBy: string | null;
}

/** The proposal as the phone queued it (`SubstitutionProposed`), read strictly; undefined when it cannot be read. */
function readRelayedProposal(body: unknown, waveId: string, lineId: string): RelayedProposal | undefined {
  if (!isObj(body)) return undefined;
  if (body['waveId'] !== waveId || body['lineId'] !== lineId) return undefined;
  if (!isStr(body['proposalId']) || !isStr(body['orderRef']) || !isStr(body['orderedProductId']) || !isStr(body['substituteProductId'])
    || !isPosInt(body['quantity']) || !isStr(body['why']) || !(PROPOSAL_REASONS as readonly string[]).includes(body['why']) || !isIso(body['proposedAt'])) return undefined;
  if (body['substituteProductId'] === body['orderedProductId']) return undefined;
  return {
    proposalId: body['proposalId'], orderRef: body['orderRef'], orderedProductId: body['orderedProductId'],
    description: isStr(body['description']) ? body['description'] : body['orderedProductId'],
    substituteProductId: body['substituteProductId'], quantity: body['quantity'], uom: isStr(body['uom']) ? body['uom'] : 'ea',
    why: body['why'] as ProposalReason, proposedAt: body['proposedAt'], proposedBy: isStr(body['proposedBy']) ? body['proposedBy'] : null,
  };
}

/** Everything about one order's proposals the reads need, in one fetch. */
async function orderPicture(deps: SubstitutionProposalDeps, tenantId: string, orderId: string) {
  const [proposals, consents, settlements] = await Promise.all([deps.proposalsOfOrder(tenantId, orderId), deps.consents(tenantId, orderId), deps.settlements(tenantId, orderId)]);
  const now = deps.now();
  return proposals.map((p) => {
    const settled = settlements.find((s) => s.proposalId === p.proposalId);
    const standing = proposalStanding(p, consents, settled, now);
    return { p, settled, standing };
  });
}

/**
 * Check an answer about to be recorded against the proposal on that line (the customer's in the app, or staff's). `none`: no
 * proposal on that line (the answer is recorded as before); `already`: the SAME answer is on record (answered once — nothing
 * new is written); `open`: record it. A different answer, a different product, the shop's own refusal, a closed line or a
 * late answer is refused by name.
 */
export async function checkAnswer(deps: SubstitutionProposalDeps, tenantId: string, orderId: string, lineId: string, substituteProductId: string, decision: 'confirmed' | 'declined'): Promise<
  { readonly kind: 'none' } | { readonly kind: 'already'; readonly answer: ConsentFact } | { readonly kind: 'open'; readonly proposal: SubstitutionProposal }
> {
  const all = (await orderPicture(deps, tenantId, orderId)).filter((x) => x.p.lineId === lineId);
  const it = all.at(-1);
  if (it === undefined) return { kind: 'none' };
  const refuse = (code: string, whatHappened: string): never => { throw apiError(409, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' }); };
  if (it.p.substituteProductId !== substituteProductId) refuse('not_the_proposed_substitute', `The shop offered ${it.p.substituteName ?? it.p.substituteProductId} for this line, not ${substituteProductId}.`);
  if (it.standing.state === 'yes' || it.standing.state === 'no') {
    if ((it.standing.state === 'yes') === (decision === 'confirmed')) return { kind: 'already', answer: it.standing.answer! };
    refuse('already_answered', `This swap was already answered ${it.standing.state === 'yes' ? 'yes' : 'no'} — an answer is given once.`);
  }
  if (it.standing.state === 'refused') refuse('swap_refused_by_the_shop', `The shop's own rules do not allow this swap: ${it.p.refusedBecause ?? 'no reason given'}. The line goes short.`);
  if (it.standing.state === 'closed') refuse('swap_closed', 'The picker has already packed this line, so the answer can no longer change it.');
  if (it.standing.state === 'too_late') refuse('answer_too_late', `The time to answer ran out at ${it.p.answerBy}; the line was packed short.`);
  return { kind: 'open', proposal: it.p };
}

/** The storefront's port (structural — services/orders/src/storefront.ts declares it). */
export function customerProposalPort(deps: SubstitutionProposalDeps) {
  return {
    forCustomer: async (tenantId: string, orderId: string) => (await orderPicture(deps, tenantId, orderId)).map(({ p, settled, standing }) => proposalView(p, standing, settled)),
    checkAnswer: (tenantId: string, orderId: string, lineId: string, substituteProductId: string, decision: 'confirmed' | 'declined') =>
      checkAnswer(deps, tenantId, orderId, lineId, substituteProductId, decision),
  };
}

/**
 * What the store computer carries to the picker with a wave: the owner's wait, each line's customer rule (no PII), and head
 * office's word on every proposal on the wave. Read when the box pulls its assignments (`openAssignments`).
 */
export async function substitutionsForWave(deps: SubstitutionProposalDeps, tenantId: string, waveId: string, orderRefs: readonly string[]): Promise<{
  readonly waitMinutes: number | null;
  readonly ruleOf: ReadonlyMap<string, 'ask_first' | 'never' | 'best_match'>;
  readonly answers: readonly Record<string, unknown>[];
}> {
  const wait = waitInForce(await deps.waitHistory(tenantId));
  const ruleOf = new Map<string, 'ask_first' | 'never' | 'best_match'>();
  for (const orderId of new Set(orderRefs)) {
    const r = lineRuleOf((await deps.rulesFor(tenantId, orderId))?.rules);
    if (r !== undefined) ruleOf.set(orderId, r);
  }
  const answers: Record<string, unknown>[] = [];
  const proposals = await deps.proposalsOfWave(tenantId, waveId);
  for (const orderId of new Set(proposals.map((p) => p.orderId))) {
    for (const { p, standing } of await orderPicture(deps, tenantId, orderId)) if (p.waveId === waveId) answers.push(answerForPhone(p, standing));
  }
  return { waitMinutes: wait.minutes, ruleOf, answers };
}

/**
 * OB-687: the picker's packed outcome for a line that carried a proposal settles it ON THE ORDER through the one substitution
 * path — a yes that was packed as `confirmed` (the yes is on record), a no / a refused swap as `declined`, no answer as
 * `no_answer` (silence is never a yes) — so the order, the bill and any refund match the crate. The settlement is kept either
 * way; a refusal from the path is kept with it, by name (P-08), and never undoes the line outcome already recorded.
 */
export async function settleOnPick(deps: SubstitutionProposalDeps, tenantId: string, outcome: WaveLineOutcome): Promise<ProposalSettlement | undefined> {
  const picture = (await orderPicture(deps, tenantId, outcome.orderRef)).filter((x) => x.p.waveId === outcome.waveId && x.p.lineId === outcome.lineId);
  const it = picture.at(-1);
  if (it === undefined || it.settled !== undefined) return undefined;
  const { p, standing } = it;
  const at = deps.now();
  const packed: ProposalSettlement['packed'] = outcome.state === 'substituted'
    ? (outcome.productId === p.substituteProductId ? 'swapped' : 'another_swap')
    : outcome.state === 'picked' ? 'picked_as_ordered' : 'short';
  const decision: ProposalSettlement['decision'] = packed === 'swapped'
    ? (standing.state === 'yes' ? 'confirmed' : null)
    : packed === 'short' ? (standing.state === 'no' || standing.state === 'refused' ? 'declined' : 'no_answer') : null;
  let refusal: ProposalSettlement['refusal'] = null;
  let onOrder = false;
  let onOrderAs: ProposalSettlement['onOrderAs'];
  if (packed === 'swapped' && decision === null) {
    refusal = { code: 'swapped_without_a_yes', whatHappened: `The crate holds ${p.substituteProductId} for ${p.lineId}, but no yes from the customer is on record. Nothing was put on the order — a person must look.` };
  } else if (decision !== null) {
    const ordered = await deps.product(tenantId, p.orderedProductId);
    const quantity = packed === 'swapped' ? Math.max(1, outcome.pickedQty) : p.quantityMinor;
    try {
      const recorded = await deps.applyDecision(tenantId, {
        userId: outcome.pickedBy ?? outcome.relayedBy, orderId: p.orderId, decision,
        offer: {
          lineId: p.lineId, orderedProductId: p.orderedProductId, orderedName: p.orderedName, orderedUnitPriceMinor: ordered?.unitPriceMinor ?? 0, orderedQuantityMinor: p.quantityMinor,
          substituteProductId: p.substituteProductId, substituteName: p.substituteName ?? p.substituteProductId, substituteUnitPriceMinor: p.substituteUnitPriceMinor ?? 0,
          substituteQuantityMinor: quantity, offeredAt: p.proposedAt,
        },
      });
      onOrder = true;
      const b = (recorded as { body?: Record<string, unknown> } | undefined)?.body ?? {};
      const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
      onOrderAs = { outcome: String(b['outcome'] ?? ''), pickProductId: typeof b['pickProductId'] === 'string' ? b['pickProductId'] : null, pickQuantityMinor: num(b['pickQuantityMinor']), chargeMinor: num(b['chargeMinor']), refundMinor: num(b['refundMinor']) };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      refusal = { code: e.body.code, whatHappened: e.body.whatHappened };
    }
  }
  const s: ProposalSettlement = { proposalId: p.proposalId, orderId: p.orderId, lineId: p.lineId, packed, decision, onOrder, ...(onOrderAs === undefined ? {} : { onOrderAs }), refusal, at };
  await deps.recordSettlement(tenantId, s);
  await deps.recordAudit?.(tenantId, {
    actorId: outcome.pickedBy ?? outcome.relayedBy, action: 'order.substitution_proposal.settle', objectType: 'online_order', objectId: p.orderId,
    at, origin: { tenantId, branchId: null }, before: { state: standing.state },
    after: { proposalId: p.proposalId, packed, decision: decision ?? '', onOrder: String(onOrder), refusal: refusal?.code ?? '' },
    correlationId: p.proposalId,
  });
  return s;
}

function readContact(v: unknown): { readonly method: string; readonly reference: string } | undefined {
  if (!isObj(v) || typeof v['method'] !== 'string' || !CONTACT_METHODS.includes(v['method']) || !isStr(v['reference'])) return undefined;
  return { method: v['method'], reference: v['reference'].trim() };
}

export function substitutionProposalRoutes(deps: SubstitutionProposalDeps): readonly Route[] {
  return [
    {
      // The picker's proposal, relayed by the store computer. Idempotent on the proposal (the line and the substitute).
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/waves/:waveId/lines/:lineId/substitution-proposal/synced',
      permission: 'fulfilment.pick.sync', idempotent: true,
      handler: async (ctx) => {
        const waveId = (ctx.params['waveId'] ?? '').trim();
        const lineId = (ctx.params['lineId'] ?? '').trim();
        const r = waveId === '' || lineId === '' ? undefined : readRelayedProposal(ctx.body, waveId, lineId);
        if (r === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_substitution_proposal',
            whatHappened: 'This could not be read as a swap proposed on the picker phone — it needs waveId and lineId matching the path, proposalId, orderRef, orderedProductId, a different substituteProductId, a whole quantity above nought, why (out_of_stock | not_found) and proposedAt.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it and raise it — the picker asked, and the customer has not been asked.',
          });
        }
        const onWave = await deps.proposalsOfWave(ctx.tenantId, waveId);
        const prior = onWave.find((p) => p.proposalId === r.proposalId);
        if (prior !== undefined) return { status: 200, body: { proposalId: prior.proposalId, recorded: true, alreadyRecorded: true, eligibility: prior.eligibility, answerBy: prior.answerBy } };
        if (onWave.some((p) => p.lineId === lineId)) {
          throw apiError(422, {
            code: 'line_already_proposed',
            whatHappened: `Line ${lineId} of wave ${waveId} already has a swap put to the customer — one swap is asked per line.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Keep it at the store and raise it: two different swaps were asked for one line.',
          });
        }
        const order = await deps.order(ctx.tenantId, r.orderRef);
        if (order === undefined || !order.lines.some((l) => l.productId === r.orderedProductId)) {
          throw apiError(422, {
            code: order === undefined ? 'order_unknown' : 'not_on_the_order',
            whatHappened: order === undefined ? `No order ${r.orderRef} is held at head office.` : `${r.orderedProductId} is not on order ${r.orderRef}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Keep it at the store and raise it — the swap names an order line head office does not hold.',
          });
        }
        const flags: string[] = [];
        if (r.proposedBy === null) flags.push('picker_unnamed');
        else {
          const held = await deps.permissionsOfUser(ctx.tenantId, r.proposedBy);
          if (held === undefined) flags.push('picker_unknown');
          else if (!held.includes(PICK_PERMISSION)) flags.push('picker_lacks_authority');
        }
        const [ordered, substitute, rules] = await Promise.all([
          deps.product(ctx.tenantId, r.orderedProductId), deps.product(ctx.tenantId, r.substituteProductId), deps.rulesFor(ctx.tenantId, r.orderRef),
        ]);
        // The shop's own rules, run here — a swap they refuse is never put to the customer (FUL-14 · M19-FR-01).
        let eligibility: SubstitutionEligibility;
        let refusedBecause: string | null = null;
        if (substitute?.unitPriceMinor === undefined) { eligibility = 'refused'; refusedBecause = `the shop has no published price for ${r.substituteProductId}`; }
        else if (rules === undefined) { eligibility = 'refused'; refusedBecause = `the customer's substitution rules are not on record for ${r.orderRef}`; }
        else if (ordered?.attrs === undefined || substitute.attrs === undefined) { eligibility = 'refused'; refusedBecause = `the product master does not hold ${ordered?.attrs === undefined ? r.orderedProductId : r.substituteProductId}`; }
        else {
          const assessed = assessSubstitution({ lineId, ordered: ordered.attrs, substitute: substitute.attrs, rules: rules.rules });
          eligibility = assessed.eligibility;
          if (assessed.eligibility === 'refused') refusedBecause = assessed.detail;
        }
        if (flags.includes('picker_unknown') || flags.includes('picker_lacks_authority') || flags.includes('picker_unnamed')) {
          eligibility = 'refused';
          refusedBecause = refusedBecause ?? 'the person who asked is not one head office lets pick';
        }
        const wait = waitInForce(await deps.waitHistory(ctx.tenantId));
        const receivedAt = deps.now();
        const p: SubstitutionProposal = {
          proposalId: r.proposalId, waveId, lineId, orderId: r.orderRef, orderedProductId: r.orderedProductId,
          orderedName: ordered?.name ?? r.description, substituteProductId: r.substituteProductId, substituteName: substitute?.name ?? null,
          substituteUnitPriceMinor: substitute?.unitPriceMinor ?? null, quantityMinor: r.quantity, uom: r.uom, why: r.why,
          proposedBy: r.proposedBy, relayedBy: ctx.userId, proposedAt: r.proposedAt, receivedAt,
          waitMinutes: wait.minutes, answerBy: wait.minutes === null ? null : new Date(Date.parse(r.proposedAt) + wait.minutes * 60_000).toISOString(),
          eligibility, refusedBecause, governanceFlags: flags,
        };
        await deps.recordProposal(ctx.tenantId, p);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: r.proposedBy ?? ctx.userId, action: 'order.substitution_proposal.record', objectType: 'online_order', objectId: r.orderRef,
          at: receivedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { proposalId: p.proposalId, lineId, substituteProductId: p.substituteProductId, eligibility, answerBy: p.answerBy ?? '', relayedBy: ctx.userId, flags: flags.join(',') },
          correlationId: p.proposalId,
        });
        return { status: 202, body: { proposalId: p.proposalId, recorded: true, eligibility, answerBy: p.answerBy, flags } };
      },
    },
    {
      // The proposals on one order, each with where it stands — the Online orders desk's read.
      api: 'API-07', method: 'GET', path: '/v1/orders/:orderId/substitution-proposals',
      permission: 'order.read',
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const picture = await orderPicture(deps, ctx.tenantId, orderId);
        const wait = waitInForce(await deps.waitHistory(ctx.tenantId));
        return { status: 200, body: { orderId, proposals: picture.map(({ p, settled, standing }) => proposalView(p, standing, settled)), wait, asAt: deps.now() } };
      },
    },
    {
      // Staff record the customer's yes or no given by phone (or WhatsApp, SMS, in person) — with how they were reached and a
      // reference a person can look up. It counts the same as the customer's own answer in the app.
      api: 'API-07', method: 'POST', path: '/v1/orders/:orderId/substitution-proposals/:lineId/answer',
      permission: 'order.lifecycle.manage', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const lineId = (ctx.params['lineId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const contact = readContact(b['contact']);
        if ((b['decision'] !== 'confirmed' && b['decision'] !== 'declined') || contact === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_substitution_answer',
            whatHappened: 'Recording the customer\'s answer needs { decision: confirmed | declined, contact: { method: phone | whatsapp | sms | in_person, reference } } — what they said and how you reached them.',
            wasItSaved: 'not_saved', nextSafeAction: 'Say what the customer said and how you reached them. Nothing was changed.',
          });
        }
        const decision = b['decision'];
        const proposals = await deps.proposalsOfOrder(ctx.tenantId, orderId);
        const p = proposals.filter((x) => x.lineId === lineId).at(-1);
        if (p === undefined) {
          throw apiError(404, { code: 'no_proposal_on_this_line', whatHappened: `No swap has been put to the customer for line ${lineId} of order ${orderId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the order and the line. Nothing was changed.' });
        }
        const checked = await checkAnswer(deps, ctx.tenantId, orderId, lineId, p.substituteProductId, decision);
        if (checked.kind === 'already') return { status: 200, body: { ...checked.answer, alreadyAnswered: true } };
        const c: ConsentFact = {
          orderId, lineId, substituteProductId: p.substituteProductId, decision, acceptsHigherPrice: b['acceptsHigherPrice'] === true,
          given: 'staff_contact', by: ctx.userId, contact, at: deps.now(),
        };
        await deps.recordConsent(ctx.tenantId, c);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'order.substitution_answer.record', objectType: 'online_order', objectId: orderId,
          at: c.at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { state: 'waiting' },
          after: { proposalId: p.proposalId, decision, method: contact.method, reference: contact.reference, given: 'staff_contact' },
          correlationId: p.proposalId,
        });
        return { status: 201, body: c };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/fulfilment/substitution-wait',
      permission: 'order.read',
      handler: async (ctx) => {
        const history = await deps.waitHistory(ctx.tenantId);
        return { status: 200, body: { ...waitInForce(history), maxMinutes: WAIT_MINUTES_MAX, history, asAt: deps.now() } };
      },
    },
    {
      // The owner sets how long the picker waits for a customer's answer: { minutes (whole, 1 to 240), reason? }.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/substitution-wait',
      permission: SUBSTITUTION_WAIT_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const minutes = b['minutes'];
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > WAIT_MINUTES_MAX
          || (b['reason'] !== undefined && b['reason'] !== null && typeof b['reason'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_wait',
            whatHappened: `Send { minutes, reason? } — whole minutes, 1 to ${WAIT_MINUTES_MAX} (the picker's sign-in lasts four hours).`,
            wasItSaved: 'not_saved', nextSafeAction: 'Enter the minutes again. Nothing was changed.',
          });
        }
        const history = await deps.waitHistory(ctx.tenantId);
        const before = waitInForce(history);
        if (before.minutes === minutes) return { status: 200, body: { ...before, alreadySet: true, history } };
        const c: SubstitutionWaitChange = {
          version: history.length + 1, minutes, reason: typeof b['reason'] === 'string' && b['reason'].trim() !== '' ? b['reason'].trim() : null, setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordWait(ctx.tenantId, c);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'fulfilment.substitution_wait.set', objectType: 'substitution_wait', objectId: 'shop',
          at: c.setAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { minutes: before.minutes === null ? 'not set' : String(before.minutes) }, after: { minutes: String(minutes), version: String(c.version) },
          ...(c.reason === null ? {} : { reason: c.reason }), correlationId: 'substitution-wait',
        });
        const after = await deps.waitHistory(ctx.tenantId);
        return { status: history.length === 0 ? 201 : 200, body: { ...waitInForce(after), alreadySet: false, history: after } };
      },
    },
  ];
}
