// P2 · batch 18c — a PROPOSED purchase order can be REJECTED, SENT BACK or WITHDRAWN before it is issued
// (M06-FR-02 · roadmap §27.1 "rejected / cancelled" · pilot audit B-6 · OB-871, decided under OB-801).
//
// Before this an order raised by one person could only be issued by a second person (or sit for ever). Now:
//
//   • REJECT — the second person (`purchase.order.approve`, never the raiser, §28) gives a reason; the order ends.
//   • SEND BACK — the second person returns it to the raiser with a note; the raiser may change the quantities or
//     prices of the lines on it (or drop a line) and RESUBMIT it, when it waits for a second person again.
//   • WITHDRAW — the raiser takes back an order still waiting (or sent back to them); the order ends.
//
// Every step is ONE append-only event on the order's stream, pinned to the order's own write guard (read before the
// order), so two people deciding one order at the same moment cannot both land — the second is refused by name, never
// silently overwritten (hard rules #2, #10). Each step is sealed on the audit trail with who, when and why. An issued
// order is never touched here; its cancellation already exists (`…/cancellations`).
//
// Deciding a waiting order — issuing, rejecting or sending it back — needs authority over its value (OB-871): an order
// above the decider's purchase-order limit is the owner's to decide, whichever way.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, concurrentChange } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import { mayApproveValue, authorityWords } from '../../../packages/approvals/src/authority-rules';
import { money } from '../../../packages/contracts/src/money';
import { valueAtCost } from '../../../packages/contracts/src/quantity';
import type { PurchaseOrderLineInput } from '../../../packages/purchasing/src/index';
import { checkOrderAgainstBudget } from './open-to-buy';
import type { PurchaseOrderDeps, StoredPurchaseOrder } from './purchase-orders';

/** A step taken on an order before it is issued. */
export type ProposalStepKind = 'rejected' | 'sent_back' | 'withdrawn' | 'resubmitted';

/** One step on the order's record — who, when and why (P2). */
export interface ProposalStep {
  readonly step: ProposalStepKind;
  readonly by: string;
  readonly at: string;
  readonly reason: string;
}

/** What a step writes: the step, and on a resubmission the order's changed lines and what follows from them. */
export interface ProposalStepRecord extends ProposalStep {
  readonly poId: string;
  readonly stepId: string;
  readonly lines?: readonly PurchaseOrderLineInput[];
  readonly totalMinor?: number;
  readonly budgetCheck?: StoredPurchaseOrder['budgetCheck'];
  readonly routedToOwner?: StoredPurchaseOrder['routedToOwner'] | null;
}

/** The status an order is in after a step. */
export const STATUS_AFTER: Readonly<Record<ProposalStepKind, StoredPurchaseOrder['status']>> = Object.freeze({
  rejected: 'rejected', sent_back: 'sent_back', withdrawn: 'withdrawn', resubmitted: 'proposed',
});

/** The statuses each step may be taken from. */
const ALLOWED_FROM: Readonly<Record<ProposalStepKind, readonly StoredPurchaseOrder['status'][]>> = Object.freeze({
  rejected: ['proposed'], sent_back: ['proposed'], withdrawn: ['proposed', 'sent_back'], resubmitted: ['sent_back'],
});

/**
 * Fold one step onto an order (used by every reader of the order stream). A step taken from a status it is not allowed
 * from is ignored (the route refuses it first; the guard makes a race impossible) — never a silent change of an issued order.
 */
export function applyProposalStep(po: StoredPurchaseOrder, s: ProposalStepRecord): StoredPurchaseOrder {
  if (!ALLOWED_FROM[s.step].includes(po.status)) return po;
  const step: ProposalStep = { step: s.step, by: s.by, at: s.at, reason: s.reason };
  const next: StoredPurchaseOrder = { ...po, status: STATUS_AFTER[s.step], proposalSteps: [...(po.proposalSteps ?? []), step] };
  if (s.step !== 'resubmitted' || s.lines === undefined) return next;
  // The resubmitted order is re-valued: the old owner routing and budget check are dropped, and set again below if given.
  const rest: StoredPurchaseOrder = { ...next };
  delete (rest as { routedToOwner?: unknown }).routedToOwner;
  delete (rest as { budgetCheck?: unknown }).budgetCheck;
  return {
    ...rest, lines: s.lines, totalMinor: s.totalMinor ?? po.totalMinor,
    ...(s.budgetCheck === undefined ? {} : { budgetCheck: s.budgetCheck }),
    ...(s.routedToOwner === undefined || s.routedToOwner === null ? {} : { routedToOwner: s.routedToOwner }),
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const rupees = (m: number): string => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_WORDS: Readonly<Record<StoredPurchaseOrder['status'], string>> = Object.freeze({
  proposed: 'waiting for a second person', issued: 'already issued', sent_back: 'sent back to the person who raised it',
  rejected: 'rejected', withdrawn: 'withdrawn by the person who raised it',
});

const STEP_WORDS: Readonly<Record<ProposalStepKind, { readonly verb: string; readonly action: string }>> = Object.freeze({
  rejected: { verb: 'rejected', action: 'purchase.order.reject' },
  sent_back: { verb: 'sent back', action: 'purchase.order.send_back' },
  withdrawn: { verb: 'withdrawn', action: 'purchase.order.withdraw' },
  resubmitted: { verb: 'resubmitted', action: 'purchase.order.resubmit' },
});

/** A resubmitted line as sent: one of the order's own products, a whole quantity (0 drops it), optionally a new price. */
interface ResubmitLine { readonly productId: string; readonly orderedQty: number; readonly unitCostMinor?: number }

function readResubmitLines(po: StoredPurchaseOrder, raw: unknown): readonly PurchaseOrderLineInput[] | undefined {
  if (raw === undefined) return undefined;
  const bad = (detail: string) => apiError(422, {
    code: 'not_readable_as_resubmitted_lines',
    whatHappened: `${detail} A resubmitted order changes only the quantities or prices of the items already on it (a quantity of 0 takes the item off). A new item needs a new order (OB-871).`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Send lines as [{ productId, orderedQty, unitCostMinor? }] for items on this order. Nothing was changed.',
  });
  if (!Array.isArray(raw) || raw.length === 0) throw bad('The lines are not a list.');
  const byProduct = new Map(po.lines.map((l) => [l.productId, l]));
  const seen = new Set<string>();
  const out: PurchaseOrderLineInput[] = [];
  for (const v of raw) {
    if (!isObj(v) || !isStr(v['productId']) || typeof v['orderedQty'] !== 'number' || !Number.isSafeInteger(v['orderedQty']) || v['orderedQty'] < 0
      || (v['unitCostMinor'] !== undefined && (typeof v['unitCostMinor'] !== 'number' || !Number.isSafeInteger(v['unitCostMinor']) || v['unitCostMinor'] < 0))) {
      throw bad('A line is not readable.');
    }
    const l = v as unknown as ResubmitLine;
    const was = byProduct.get(l.productId);
    if (was === undefined) throw bad(`${l.productId} is not on order ${po.poId}.`);
    if (seen.has(l.productId)) throw bad(`${l.productId} is named twice.`);
    seen.add(l.productId);
    if (l.orderedQty === 0) continue;
    const priceChanged = l.unitCostMinor !== undefined && l.unitCostMinor !== was.unitCost.minor;
    out.push({
      productId: l.productId, orderedQty: l.orderedQty, ...(was.uom === undefined ? {} : { uom: was.uom }),
      // A changed price is a price per whole unit (a carried pack cost and the "by the pack" record no longer hold).
      unitCost: priceChanged ? money(l.unitCostMinor!, po.currency) : was.unitCost,
      ...(was.ordered === undefined || priceChanged || l.orderedQty !== was.orderedQty ? {} : { ordered: was.ordered }),
    });
  }
  // Lines not named stay as they were.
  for (const was of po.lines) if (!seen.has(was.productId)) out.push(was);
  if (out.length === 0) throw bad('Every item was taken off.');
  return out;
}

/** The P2 routes. Mounted with the purchase-order routes. */
export function proposalStepRoutes(deps: PurchaseOrderDeps): readonly Route[] {
  const step = (kind: ProposalStepKind, path: string, permission: string): Route => ({
    api: 'API-03', method: 'POST', path, permission, idempotent: true,
    handler: async (ctx) => {
      const poId = (ctx.params['poId'] ?? '').trim();
      const b = (ctx.body ?? {}) as Record<string, unknown>;
      const reason = isStr(b['reason']) ? b['reason'].trim() : '';
      const words = STEP_WORDS[kind];
      if (deps.recordProposalStep === undefined) {
        throw apiError(503, { code: 'not_available', whatHappened: 'Purchase orders cannot be decided here.', wasItSaved: 'not_saved', nextSafeAction: 'Use head office. Nothing was changed.' });
      }
      // The order's guard is read BEFORE the order, so a step judged on it lands only on the order as it was judged.
      const version = deps.orderVersion === undefined ? undefined : await deps.orderVersion(ctx.tenantId, poId);
      const po = await deps.order(ctx.tenantId, poId);
      if (po === undefined) throw notFound(`purchase order ${poId}`);
      if (po.status === STATUS_AFTER[kind] && kind !== 'resubmitted') {
        return { status: 200, body: { order: po, already: true } };
      }
      if (!ALLOWED_FROM[kind].includes(po.status)) {
        throw apiError(409, {
          code: 'purchase_order_not_waiting',
          whatHappened: `Purchase order ${po.documentNumber ?? po.number} is ${STATUS_WORDS[po.status]}, so it cannot be ${words.verb}.${po.status === 'issued' ? ' An issued order is cancelled instead (Cancel on the Buying page).' : ''}`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Refresh the page to see where the order stands. Nothing was changed.',
        });
      }
      if (reason === '') {
        throw apiError(422, {
          code: 'reason_required',
          whatHappened: kind === 'sent_back' ? 'Sending an order back needs a note for the person who raised it — what to change.' : `An order ${words.verb} needs a reason for the record.`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Write the reason and try again. Nothing was changed.',
        });
      }
      const raiser = ctx.userId === po.requisitionedBy;
      if (kind === 'rejected' || kind === 'sent_back') {
        if (raiser) {
          throw apiError(409, {
            code: 'proposer_cannot_decide',
            whatHappened: `${ctx.userId} raised this purchase order, so a second person decides it (§28). To take it back, withdraw it.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Have a different authorised person decide it, or press Withdraw. Nothing was changed.',
          });
        }
        // OB-871: deciding a waiting order, whichever way, needs authority over its value — above it, the owner decides.
        const authority = deps.authorityOf === undefined ? undefined : await deps.authorityOf(ctx.tenantId, ctx.userId, 'purchase_order');
        if (authority !== undefined && !mayApproveValue(authority, po.totalMinor)) {
          throw apiError(422, {
            code: 'above_your_limit_goes_to_owner',
            whatHappened: `Purchase order ${po.documentNumber ?? poId} is ${rupees(po.totalMinor)}; ${ctx.userId}'s purchase-order limit is ${authorityWords(authority)}. An order above a person's limit is the owner's to decide (OB-290, OB-871).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The owner decides it. Nothing was changed.',
          });
        }
      } else if (!raiser) {
        throw apiError(409, {
          code: 'only_the_raiser',
          whatHappened: `Only ${po.requisitionedBy}, who raised purchase order ${po.documentNumber ?? poId}, may ${kind === 'withdrawn' ? 'withdraw' : 'resubmit'} it.`,
          wasItSaved: 'not_saved',
          nextSafeAction: kind === 'withdrawn' ? 'Ask the person who raised it, or reject it with a reason if you decide orders.' : 'Ask the person who raised it. Nothing was changed.',
        });
      }
      const at = deps.now();
      let record: ProposalStepRecord = { poId, stepId: `${kind}-${(po.proposalSteps ?? []).length + 1}`, step: kind, by: ctx.userId, at, reason };
      if (kind === 'resubmitted') {
        const lines = readResubmitLines(po, b['lines']);
        if (lines !== undefined) {
          const totalMinor = lines.reduce((s, l) => s + valueAtCost(l.orderedQty, l.uom ?? 'ea', l.unitCost), 0);
          const raiserAuth = deps.authorityOf === undefined ? undefined : await deps.authorityOf(ctx.tenantId, ctx.userId, 'purchase_order');
          const routedToOwner = raiserAuth === undefined || mayApproveValue(raiserAuth, totalMinor) ? null
            : { raiserLimitMinor: raiserAuth.state === 'limit' ? raiserAuth.limitMinor : null, raiserLimitFrom: raiserAuth.fromRole, valueMinor: totalMinor, rulesVersion: raiserAuth.rulesVersion };
          const changed: StoredPurchaseOrder = { ...po, lines, totalMinor };
          const budgetCheck = deps.openToBuy === undefined ? undefined : await checkOrderAgainstBudget(deps.openToBuy, ctx.tenantId, changed);
          record = { ...record, lines, totalMinor, routedToOwner, ...(budgetCheck === undefined ? {} : { budgetCheck }) };
        }
      }
      try {
        await deps.recordProposalStep(ctx.tenantId, record, version);
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) throw concurrentChange(`purchase order ${po.documentNumber ?? poId} (someone else decided or changed it a moment ago)`);
        throw err;
      }
      await deps.recordAudit?.(ctx.tenantId, {
        actorId: ctx.userId, action: words.action, objectType: 'purchase-order', objectId: poId,
        at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
        before: { status: po.status, totalMinor: String(po.totalMinor) },
        after: { status: STATUS_AFTER[kind], totalMinor: String(record.totalMinor ?? po.totalMinor), raisedBy: po.requisitionedBy, ...(po.documentNumber === undefined ? {} : { documentNumber: po.documentNumber }) },
        reason, correlationId: poId,
      });
      const after = applyProposalStep(po, record);
      return { status: 200, body: { order: after } };
    },
  });
  return [
    step('rejected', '/v1/purchase/orders/:poId/rejection', 'purchase.order.approve'),
    step('sent_back', '/v1/purchase/orders/:poId/send-back', 'purchase.order.approve'),
    step('withdrawn', '/v1/purchase/orders/:poId/withdrawal', 'purchase.order.propose'),
    step('resubmitted', '/v1/purchase/orders/:poId/resubmission', 'purchase.order.propose'),
  ];
}
