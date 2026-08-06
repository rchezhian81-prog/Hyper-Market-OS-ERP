// The customer service and returns desk (M13-FR-01…04 · M21-FR-03/04 · API-05/API-06 · §28 · P-01).
//
// The till has been sending people here for as long as it has had a refund button. Press it and the
// lane says, in both languages: *"Refunds against a receipt need the original sale, and this lane
// cannot look one up yet. Send the customer to the service desk."* There was no service desk.
//
// ── The control that was written, tested, and fed by nobody ─────────────────
//
// `commitReturn` has enforced **a line is returned at most once** since it was written. It enforces
// it against `alreadyReturnedMinor`, supplied by the caller — and outside a single unit test,
// nothing in this system ever supplied it. Every return was therefore judged against *nothing
// already returned*, so the same receipt could be refunded today, again tomorrow, and again the day
// after, each refund passing a rule written specifically to stop it.
//
// `packages/returns/src/return-register.ts` is that producer, and this surface is what feeds it in.
// It is the same fault as the uncounted shelf and the blank shrinkage report, in the one place
// where it is money going out of the door rather than a wrong number on a screen.
//
// ── Offline, because the desk is inside the shop ────────────────────────────
//
// A receipted return **works with the network cable out** (M13-FR-01 acceptance). The bill is found
// in the box's own log, the register is projected from the box's own returns, and the refund is
// committed locally and queued. Nothing here waits on the cloud.
//
// The one thing that genuinely cannot happen offline is a card reversal: the provider has to move
// the money. So a card refund is recorded **pending** and the customer is told exactly that, rather
// than being shown a completed refund for money that has not moved (M13-FR-04). The reversal itself
// belongs to the service that can reach the provider — `packages/reversal` — and is deliberately
// not called from a browser, which has no business holding a provider credential.
//
// ── And the desk's other half ───────────────────────────────────────────────
//
// Complaints, enquiries, warranty and lost-and-found, with the SLA clock running and compensation
// under maker-checker: **money leaving the business, decided by the person the customer is
// currently shouting at** (M21-FR-03). `packages/service-desk` has held those rules, tested, called
// by nothing outside its own tests, since it was written.

import { money, type Money } from '../../../packages/contracts/src/money';
import type { TenderKind } from '../../../packages/contracts/src/enums';
import type { Ledger } from '../../../packages/ledger/src/ledger';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import {
  commitReturn, returnRegister, returnableLines, overReturned, alreadyRefundedMinor,
  type CommittedReturn, type Disposition, type OriginalSale, type RecordedReturn,
  type ReturnableLine,
} from '../../../packages/returns/src/index';
import {
  assessSla, assessFirstResponse, grantCompensation, approveDraft, serviceReport,
  type AiDraft, type CompensationKind, type CompensationResult,
  type SatisfactionScore, type ServiceCase, type SlaPolicy, type SlaView,
} from '../../../packages/service-desk/src/index';

/** What the desk can see, and what it honestly cannot. */
export interface ServicePorts {
  /**
   * Every bill this box holds — **the whole log, not today**.
   *
   * A customer brings back a receipt from last Tuesday, which is the ordinary case and the one the
   * whole screen exists for. Slicing this to the trading day would make the desk unable to find any
   * bill except one rung this morning.
   */
  sales(): readonly OriginalSale[];
  /**
   * Every return already recorded — this box's own durable log plus whatever history the cloud
   * pack carried. Both: the cloud alone leaves the guard blind exactly when the line is down.
   */
  returns(): readonly RecordedReturn[];
  /** Refund values already given per bill, so a second refund cannot exceed what is left. */
  refunds(): readonly { readonly returnId: string; readonly originalSaleId: string | null; readonly refundMinor: number }[];
  /** Open and recent cases. */
  cases(): readonly ServiceCase[];
  /** The tenant's SLA targets. Absent means the shop has never set them. */
  slaPolicy(): SlaPolicy | undefined;
  /**
   * Satisfaction responses. Reported WITH their response rate, never as a bare average — 4.8 from
   * six replies out of four hundred cases is six people, and the six who reply are rarely the ones
   * who left quietly.
   */
  satisfaction(): readonly SatisfactionScore[];
  /** Where returned stock is written, append-only. */
  stockLedger(): Ledger;
  /** Where the return is queued for the cloud. */
  outbox(): SyncOutbox;
}

export interface ServiceConfig {
  readonly tenantId: string;
  readonly storeId: string;
  readonly laneId: string;
  /** Who is at the desk. `null` means the box was not told — nothing may be committed under a name nobody holds. */
  readonly userId: string | null;
  readonly now: string;
  readonly tradingDay: string;
  /** How many days after the sale a return may still be taken. Per-tenant, never a constant. */
  readonly returnWindowDays: number;
  /** Refund value at or above which a separate approver is required (M13-FR-03). */
  readonly approvalThresholdMinor: number;
  /** The ceiling on a no-receipt return, which always needs approval too (M13-FR-01). */
  readonly noReceiptCapMinor: number;
  /** This agent's own authority for compensation; above it, a second signature (M21-FR-03). */
  readonly agentAuthorityMinor: number;
  /** The desk's absolute ceiling for compensation, whoever signs. */
  readonly compensationCapMinor: number;
}

export type LookupRefusal =
  | 'no_such_receipt'
  | 'outside_the_return_window'
  | 'nothing_left_to_return';

export type RefundRefusal =
  | 'nobody_is_named_at_this_desk'
  | 'no_such_receipt'
  | 'outside_the_return_window'
  | 'nothing_selected'
  | 'more_than_was_sold'
  | 'more_than_was_paid'
  | 'needs_a_reason'
  | 'needs_a_second_person'
  | 'no_receipt_over_the_cap';

const LOOKUP_REFUSAL_VALUES: Readonly<Record<LookupRefusal, LookupRefusal>> = Object.freeze({
  no_such_receipt: 'no_such_receipt',
  outside_the_return_window: 'outside_the_return_window',
  nothing_left_to_return: 'nothing_left_to_return',
});
export const LOOKUP_REFUSAL_KINDS: readonly LookupRefusal[] = Object.freeze(Object.values(LOOKUP_REFUSAL_VALUES));

const REFUND_REFUSAL_VALUES: Readonly<Record<RefundRefusal, RefundRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  no_such_receipt: 'no_such_receipt',
  outside_the_return_window: 'outside_the_return_window',
  nothing_selected: 'nothing_selected',
  more_than_was_sold: 'more_than_was_sold',
  more_than_was_paid: 'more_than_was_paid',
  needs_a_reason: 'needs_a_reason',
  needs_a_second_person: 'needs_a_second_person',
  no_receipt_over_the_cap: 'no_receipt_over_the_cap',
});
export const REFUND_REFUSAL_KINDS: readonly RefundRefusal[] = Object.freeze(Object.values(REFUND_REFUSAL_VALUES));

/** A bill found at the desk, with what may still come back off it. */
export interface FoundReceipt {
  readonly sale: OriginalSale;
  readonly lines: readonly ReturnableLine[];
  /** Days since the bill. Shown, so the person can see how close to the window it is. */
  readonly ageDays: number;
  readonly windowDays: number;
  /** What has already gone back in money against this bill, and what is left of it. */
  readonly alreadyRefundedMinor: number;
  readonly refundableMinor: number;
  /**
   * Products where MORE has come back than went out. Should be impossible; surfaced rather than
   * hidden, because it means a return went against the wrong bill or was refunded twice before
   * the register existed. Both are money and both need a person.
   */
  readonly overReturned: readonly { readonly productId: string; readonly soldMinor: number; readonly returnedMinor: number }[];
}

export type LookupOutcome =
  | { readonly ok: true; readonly receipt: FoundReceipt }
  | { readonly ok: false; readonly refusal: LookupRefusal; readonly detail: string };

/** What the person at the desk is putting through. */
export interface RefundRequest {
  readonly returnId: string;
  readonly number: string;
  /** The receipt number. Absent means a no-receipt return, which is capped and always approved. */
  readonly receiptNumber?: string;
  readonly reasonCode: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantityMinor: number;
    readonly disposition: Disposition;
  }[];
  readonly refundMinor: number;
  readonly refundTender: TenderKind;
  readonly approval?: DecidedRequest;
}

export type RefundOutcome =
  | {
    readonly ok: true;
    readonly committed: CommittedReturn;
    /** The true state of the money, in a sentence for the customer. Never "refunded" for a pending reversal. */
    readonly tellTheCustomer: string;
  }
  | { readonly ok: false; readonly refusal: RefundRefusal; readonly detail: string };

/** A case with its SLA, as the desk sees it. */
export interface CaseView {
  readonly serviceCase: ServiceCase;
  readonly resolution: SlaView;
  readonly firstResponse: SlaView;
  /** True when the shop has never set its own targets, so these are the product's defaults. */
  readonly targetsAreDefaults: boolean;
}

export interface ServiceSession {
  /** Find a bill by its receipt number, from this box's own log. Works with no network. */
  lookUp(receiptNumber: string): LookupOutcome;
  /** Put a return through, or refuse and say which rule stopped it. */
  refund(request: RefundRequest): RefundOutcome;
  /** Open and recent cases, worst SLA first — the desk's actual work queue. */
  caseList(): readonly CaseView[];
  /** Compensation on a case, under the authority limit and the second signature (M21-FR-03). */
  compensate(input: {
    readonly caseId: string;
    readonly kind: CompensationKind;
    readonly amountMinor: number;
    readonly reason: string;
    readonly approval?: Parameters<typeof grantCompensation>[0]['approval'];
  }): CompensationResult | { readonly granted: false; readonly outcome: 'no_such_case' | 'nobody_is_named_at_this_desk'; readonly detail: string };
  /** An AI-drafted reply, which a human accepts, edits or rejects. AI never sends (hard rule #5). */
  useDraft(input: { readonly draft: AiDraft; readonly decision: Parameters<typeof approveDraft>[0]['decision']; readonly editedBody?: string }): ReturnType<typeof approveDraft>;
  /** How the desk is doing (M21-FR-04). */
  report(): ReturnType<typeof serviceReport>;
}

const DAY_MS = 86_400_000;

/** Whole days between two instants, floored — nine days and 23 hours is nine days, not ten. */
export function ageInDays(from: string, to: string): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

export function createServiceSession(config: ServiceConfig, ports: ServicePorts): ServiceSession {
  const inr = (minor: number): Money => money(minor, 'INR');

  const registerNow = (): ReadonlyMap<string, ReadonlyMap<string, number>> =>
    returnRegister(ports.returns());

  const find = (receiptNumber: string): OriginalSale | undefined =>
    ports.sales().find((s) => s.number === receiptNumber);

  const look = (receiptNumber: string): LookupOutcome => {
    const sale = find(receiptNumber);
    if (sale === undefined) {
      return {
        ok: false,
        refusal: LOOKUP_REFUSAL_VALUES.no_such_receipt,
        detail: `no bill on this store box carries the number "${receiptNumber}". Check the number on the receipt, or take it as a no-receipt return.`,
      };
    }

    const register = registerNow();
    const lines = returnableLines(sale, register);
    const ageDays = ageInDays(sale.committedAt, config.now);
    const already = alreadyRefundedMinor(sale.saleId, ports.refunds());

    // Out of window is a refusal, but the bill is still SHOWN in the detail, because the person at
    // the desk has to be able to tell the customer how far outside it is rather than "computer
    // says no". The window is the tenant's, never a constant.
    if (ageDays > config.returnWindowDays) {
      return {
        ok: false,
        refusal: LOOKUP_REFUSAL_VALUES.outside_the_return_window,
        detail: `this bill is ${ageDays} days old and this shop takes returns for ${config.returnWindowDays} days. A manager can still approve it as a no-receipt return.`,
      };
    }
    if (lines.every((l) => l.returnableMinor === 0)) {
      return {
        ok: false,
        refusal: LOOKUP_REFUSAL_VALUES.nothing_left_to_return,
        detail: 'everything on this bill has already been returned. Returning it again would be a second refund for the same goods.',
      };
    }

    return {
      ok: true,
      receipt: {
        sale,
        lines,
        ageDays,
        windowDays: config.returnWindowDays,
        alreadyRefundedMinor: already,
        refundableMinor: Math.max(0, sale.totalMinor - already),
        overReturned: overReturned(sale, register),
      },
    };
  };

  const session: ServiceSession = {
    lookUp: look,

    refund: (request) => {
      // Nobody named, nothing committed. A return puts stock back and money out, and both carry
      // the name of whoever did it into an audit record that is the only evidence afterwards.
      if (config.userId === null) {
        return {
          ok: false,
          refusal: REFUND_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is on the desk, so nothing can be put through. A refund has to carry the name of the person who gave it.',
        };
      }
      if (request.reasonCode.trim() === '') {
        return {
          ok: false,
          refusal: REFUND_REFUSAL_VALUES.needs_a_reason,
          detail: 'a return needs a reason. "Returned" explains nothing three months later when a pattern is being looked at.',
        };
      }
      if (request.lines.length === 0) {
        return {
          ok: false,
          refusal: REFUND_REFUSAL_VALUES.nothing_selected,
          detail: 'nothing has been selected to come back.',
        };
      }

      const noReceipt = request.receiptNumber === undefined;
      let sale: OriginalSale | undefined;
      let returnable: readonly ReturnableLine[] = [];
      let maxRefundMinor = config.noReceiptCapMinor;

      if (!noReceipt) {
        const found = look(request.receiptNumber!);
        if (!found.ok) {
          // The lookup's own refusal, carried through rather than flattened: "no such receipt" and
          // "already all returned" send the person at the desk to two different next actions.
          const refusal = found.refusal === 'no_such_receipt'
            ? REFUND_REFUSAL_VALUES.no_such_receipt
            : found.refusal === 'outside_the_return_window'
              ? REFUND_REFUSAL_VALUES.outside_the_return_window
              : REFUND_REFUSAL_VALUES.more_than_was_sold;
          return { ok: false, refusal, detail: found.detail };
        }
        sale = found.receipt.sale;
        returnable = found.receipt.lines;
        // **What is LEFT of the bill**, not the bill's total. A bill refunded in part yesterday
        // must not be refundable in full today — the line rule stops the same goods coming back
        // twice, and this stops the same money going out twice, which are different breaches.
        maxRefundMinor = found.receipt.refundableMinor;
      } else if (request.refundMinor > config.noReceiptCapMinor) {
        return {
          ok: false,
          refusal: REFUND_REFUSAL_VALUES.no_receipt_over_the_cap,
          detail: `a return with no receipt is capped at ${config.noReceiptCapMinor} in this shop, and this one is ${request.refundMinor}.`,
        };
      }

      if (request.refundMinor > maxRefundMinor) {
        return {
          ok: false,
          refusal: REFUND_REFUSAL_VALUES.more_than_was_paid,
          detail: noReceipt
            ? `a return with no receipt is capped at ${config.noReceiptCapMinor} in this shop.`
            : `this bill has ${maxRefundMinor} left to refund and ${request.refundMinor} was asked for. A refund can never exceed what was paid.`,
        };
      }

      // The at-most-once guard, fed at last. Each selected line carries what was sold on the bill
      // and what has ALREADY come back against it, so `commitReturn` can do the job it was written
      // to do rather than compare against a zero nobody produced.
      const lines = request.lines.map((line) => {
        const known = returnable.find((r) => r.productId === line.productId);
        return {
          productId: line.productId,
          uom: known?.uom ?? 'ea',
          quantityMinor: line.quantityMinor,
          // A no-receipt return has no original line, so nothing constrains the quantity except
          // the value cap above. Stating the quantity as its own original is the honest encoding
          // of "there is no bill to check this against".
          originalQtyMinor: known?.soldMinor ?? line.quantityMinor,
          alreadyReturnedMinor: known?.alreadyReturnedMinor ?? 0,
          disposition: line.disposition,
        };
      });

      try {
        const committed = commitReturn(
          {
            id: request.returnId,
            number: request.number,
            originalSaleId: sale?.saleId ?? null,
            noReceipt,
            laneId: config.laneId,
            processedBy: config.userId,
            processedAt: config.now,
            reasonCode: request.reasonCode,
            lines,
            refund: inr(request.refundMinor),
            refundTender: request.refundTender,
            maxRefund: inr(maxRefundMinor),
            approvalThresholdMinor: config.approvalThresholdMinor,
            ...(noReceipt ? { noReceiptCapMinor: config.noReceiptCapMinor } : {}),
            ...(request.approval === undefined ? {} : { approval: request.approval }),
          },
          ports.stockLedger(),
          ports.outbox(),
        );

        return { ok: true, committed, tellTheCustomer: tellTheCustomer(committed) };
      } catch (e) {
        // The domain's own refusals, named for the desk rather than shown as a stack trace. Each
        // one maps to a different thing the person in front of the customer can do next.
        const name = e instanceof Error ? e.name : '';
        if (name === 'OverReturnError') {
          return {
            ok: false,
            refusal: REFUND_REFUSAL_VALUES.more_than_was_sold,
            detail: 'more of this item is being returned than was bought on this bill. Some of it has already come back.',
          };
        }
        if (name === 'ExcessRefundError') {
          return {
            ok: false,
            refusal: REFUND_REFUSAL_VALUES.more_than_was_paid,
            detail: 'the refund is more than is left of what was paid on this bill.',
          };
        }
        if (name === 'ApprovalRequiredError') {
          return {
            ok: false,
            refusal: REFUND_REFUSAL_VALUES.needs_a_second_person,
            detail: `this refund is ${request.refundMinor}, at or above this shop's limit of ${config.approvalThresholdMinor}${noReceipt ? ', and a return with no receipt always needs one' : ''}. It needs a different person to approve it — the one giving the refund cannot be the one approving it.`,
          };
        }
        if (name === 'MissingReasonError') {
          return { ok: false, refusal: REFUND_REFUSAL_VALUES.needs_a_reason, detail: 'a return needs a reason.' };
        }
        throw e;
      }
    },

    caseList: () => {
      const policy = ports.slaPolicy();
      const views = ports.cases().map((serviceCase) => ({
        serviceCase,
        resolution: assessSla({ serviceCase, now: config.now, ...(policy === undefined ? {} : { policy }) }),
        firstResponse: assessFirstResponse({ serviceCase, now: config.now, ...(policy === undefined ? {} : { policy }) }),
        // Said out loud rather than assumed. A desk running on the product's defaults believes it
        // has agreed targets it has never agreed, and finds out when one is quoted back at it.
        targetsAreDefaults: policy === undefined,
      }));
      // Worst first — this is a work queue, not a list. Breached, then at risk, then the rest,
      // and inside each the one with least time left.
      const rank = (v: CaseView): number =>
        v.resolution.status === 'breached' || v.firstResponse.status === 'breached' ? 0
          : v.resolution.status === 'at_risk' || v.firstResponse.status === 'at_risk' ? 1
            : v.resolution.status === 'within' ? 2 : 3;
      return [...views].sort((a, b) =>
        rank(a) - rank(b) || a.resolution.remainingMinutes - b.resolution.remainingMinutes);
    },

    compensate: (input) => {
      if (config.userId === null) {
        return {
          granted: false,
          outcome: 'nobody_is_named_at_this_desk',
          detail: 'this store box has not been told who is on the desk, so no compensation can be given. Money leaving the business carries a name.',
        };
      }
      const serviceCase = ports.cases().find((c) => c.caseId === input.caseId);
      if (serviceCase === undefined) {
        return { granted: false, outcome: 'no_such_case', detail: `there is no case "${input.caseId}".` };
      }
      return grantCompensation({
        serviceCase,
        kind: input.kind,
        amountMinor: input.amountMinor,
        grantedBy: config.userId,
        reason: input.reason,
        agentAuthorityMinor: config.agentAuthorityMinor,
        policyCapMinor: config.compensationCapMinor,
        ...(input.approval === undefined ? {} : { approval: input.approval }),
        at: config.now,
      });
    },

    useDraft: (input) => approveDraft({
      draft: input.draft,
      decision: input.decision,
      // The desk's own name goes on it, because the person who pressed send owns the reply.
      approvedBy: config.userId ?? '',
      ...(input.editedBody === undefined ? {} : { editedBody: input.editedBody }),
      at: config.now,
    }),

    report: () => {
      // Built from the SAME views the desk's own queue is sorted by, rather than assessed a second
      // time here. Two assessments of one case is how a manager's report and the screen in front of
      // the agent come to disagree about whether a case was late.
      const views = session.caseList();
      return serviceReport({
        cases: ports.cases(),
        slaViews: views.map((v) => v.resolution),
        firstResponseViews: views.map((v) => v.firstResponse),
        scores: ports.satisfaction(),
      });
    },
  };

  return session;
}

/**
 * The true state of the money, in a sentence.
 *
 * A card refund has **not happened** when the desk hands the receipt over — the provider has to
 * move it, and offline nobody has even asked yet. Telling the customer "refunded" makes the shop
 * responsible for a promise it has not kept, and they come back angry in three days.
 */
export function tellTheCustomer(committed: CommittedReturn): string {
  if (committed.refundStatus === 'settled') {
    return committed.refundTender === 'cash'
      ? 'Refunded in cash, from the drawer, now.'
      : 'Refunded as store credit, usable now.';
  }
  return 'The refund has been sent to the bank. It is NOT back on the card yet — it usually takes a few working days, and the shop cannot make it faster. Keep this receipt.';
}
