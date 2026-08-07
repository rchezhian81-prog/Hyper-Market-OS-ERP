// Expiry and recall (M10-FR-01…04 · D05 · §9.3 FSSAI · API-04/API-06 · P-01 · P-08).
//
// Two jobs that share one fact — which batch, with which expiry date, is where — and that are
// otherwise nothing alike. One saves money quietly every week. The other is the only screen in this
// product where being late is a safety matter rather than a commercial one.
//
// ── What was already written, and connected to nothing ──────────────────────
//
// `allocateFefo`, `expiryActions`, `assessColdChain`, `releaseFromQualityHold` and `traceBatch` were
// all written, all tested, and **not one of them was called from anywhere outside its own unit
// test.** The eighth instance of this codebase's recurring shape.
//
// ── And the one that was worse than unwired ─────────────────────────────────
//
// `CatalogueCache.assertSellable` refuses a recall-blocked scan **before** it checks anything else,
// and its message says *"even offline"* — the loudest safety claim in this system. The flag it reads
// had **no field in the store pack to arrive in**, so it was never set on a real lane and the
// refusal was unreachable. A recalled tin scanned and sold like any other.
//
// That is fixed on the box (`posPayload` now serves a real `CatalogueSnapshot` carrying the block,
// and either the master or the lane summary saying blocked means blocked). This surface is the
// other half: the place a person actually starts a recall.
//
// ── The rule that shapes the whole screen ───────────────────────────────────
//
// **A recall is not finished when it is started.** Blocking the till is the easy half. The hard half
// is knowing how much is still out there — on shelves, in the stockroom, and in customers' homes —
// and this screen refuses to report a recall as closed until the stock is accounted for and the
// evidence is recorded (M10-FR-04, hard rule #6: recall evidence is never deleted).
//
// Everything here is computed from the box's own cached ledger, so the expiry list and the trace
// work with the network cable out (M10-FR-01 offline rule).

import {
  expiryActions, allocateFefo,
  type Batch, type ExpiryActionItem, type FefoResult,
} from '../../../packages/fefo/src/index';
import { traceBatch, type BatchTrace } from '../../../packages/traceability/src/index';
import type { Ledger } from '../../../packages/ledger/src/ledger';

/** What the desk can see, and what it honestly cannot. */
export interface ExpiryPorts {
  /** Every batch this box knows of, with its expiry and state. */
  batches(): readonly Batch[];
  /** The ledger the trace is projected over — inbound receipts and outbound sales. */
  ledger(): Ledger;
  /** Recalls already started, so one is never started twice and closure is auditable. */
  recalls(): readonly RecallRecord[];
  /** Product names, so a screen about food safety does not show product codes to a person. */
  productNames(): Readonly<Record<string, string>> | undefined;
}

export interface ExpiryConfig {
  readonly tenantId: string;
  readonly storeId: string;
  /** Who is looking. `null` means the box was not told — a recall carries the name that started it. */
  readonly userId: string | null;
  readonly now: string;
  /**
   * How many days ahead counts as *near expiry*, per-tenant.
   *
   * Never a constant. Bread and tinned goods are not the same question, and a shop that takes a
   * delivery twice a week needs a different number from one that takes it daily.
   */
  readonly nearExpiryDays: number;
}

/** A recall, as this shop recorded it. Append-only: a correction is a new record (hard rule #2). */
export interface RecallRecord {
  readonly recallId: string;
  readonly batchId: string;
  readonly productId: string;
  readonly reason: string;
  readonly startedBy: string;
  readonly startedAt: string;
  /** Closure evidence. Absent means the recall is still open — and it may not be closed without it. */
  readonly closure?: {
    readonly closedBy: string;
    readonly closedAt: string;
    /** What was actually done with the stock. A recall closed with no evidence is a recall nobody did. */
    readonly evidence: string;
    readonly recoveredQty: number;
    readonly disposedQty: number;
  };
}

export type StartRefusal =
  | 'nobody_is_named_at_this_desk'
  | 'no_such_batch'
  | 'already_recalled'
  | 'needs_a_reason';

export type CloseRefusal =
  | 'nobody_is_named_at_this_desk'
  | 'no_such_recall'
  | 'already_closed'
  | 'needs_evidence'
  | 'stock_not_accounted_for';

const START_REFUSAL_VALUES: Readonly<Record<StartRefusal, StartRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  no_such_batch: 'no_such_batch',
  already_recalled: 'already_recalled',
  needs_a_reason: 'needs_a_reason',
});
export const START_REFUSAL_KINDS: readonly StartRefusal[] = Object.freeze(Object.values(START_REFUSAL_VALUES));

const CLOSE_REFUSAL_VALUES: Readonly<Record<CloseRefusal, CloseRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  no_such_recall: 'no_such_recall',
  already_closed: 'already_closed',
  needs_evidence: 'needs_evidence',
  stock_not_accounted_for: 'stock_not_accounted_for',
});
export const CLOSE_REFUSAL_KINDS: readonly CloseRefusal[] = Object.freeze(Object.values(CLOSE_REFUSAL_VALUES));

/** One line of the expiry action list, with the words a person needs rather than a product code. */
export interface ExpiryLine extends ExpiryActionItem {
  readonly name: string;
}

/** What a recall has found, and what is still unaccounted for. */
export interface RecallView {
  readonly recall: RecallRecord;
  readonly name: string;
  readonly trace: BatchTrace;
  /**
   * How much of this batch went out and has not come back.
   *
   * **The number the whole screen exists for.** It is what is still in customers' homes, and a
   * recall is not finished while it is above nought — or, at least, not finished without somebody
   * writing down why it is being closed anyway.
   */
  readonly stillOutThere: number;
  /** Sales this batch went out on, so the shop can contact the people who bought it. */
  readonly soldOn: readonly { readonly ref: string | null; readonly at: string; readonly customerRef: string | null; readonly qty: number }[];
  /** Customers who can be contacted. A sale with no identified customer is counted, not hidden. */
  readonly identifiedCustomers: number;
  readonly anonymousSales: number;
  readonly open: boolean;
}

export type StartOutcome =
  | { readonly ok: true; readonly recall: RecallRecord; readonly view: RecallView }
  | { readonly ok: false; readonly refusal: StartRefusal; readonly detail: string };

export type CloseOutcome =
  | { readonly ok: true; readonly recall: RecallRecord }
  | { readonly ok: false; readonly refusal: CloseRefusal; readonly detail: string };

export interface ExpirySession {
  /** What is expired or close to it, earliest first — the list M10-FR-01 asks for first. */
  actionList(): readonly ExpiryLine[];
  /** What a sale of this product would draw, oldest expiry first (M10-FR-01). */
  wouldAllocate(productId: string, qty: number): FefoResult;
  /** Every recall this shop has run, open ones first. */
  recalls(): readonly RecallView[];
  /** Start a recall on a batch, or refuse and say why. */
  start(input: { readonly recallId: string; readonly batchId: string; readonly reason: string }): StartOutcome;
  /** Close one, which requires evidence and the stock accounted for. */
  close(input: {
    readonly recallId: string;
    readonly evidence: string;
    readonly recoveredQty: number;
    readonly disposedQty: number;
    /** Set only when closing with stock still out there, which needs a reason of its own. */
    readonly acceptUnrecovered?: string;
  }): CloseOutcome;
}

export function createExpirySession(config: ExpiryConfig, ports: ExpiryPorts): ExpirySession {
  const nameOf = (productId: string): string =>
    ports.productNames()?.[productId] ?? productId;

  const viewOf = (recall: RecallRecord): RecallView => {
    const trace = traceBatch(ports.ledger(), recall.batchId);
    const soldOn = trace.outbound.map((r) => ({
      ref: r.ref, at: r.at, customerRef: r.customerRef, qty: r.qty,
    }));
    return {
      recall,
      name: nameOf(recall.productId),
      trace,
      // Out minus back. Clamped at nought: a negative would mean more came back than went out,
      // which is a different problem and not a reason to report a recall as over-complete.
      stillOutThere: Math.max(0, trace.issuedQty - (recall.closure?.recoveredQty ?? 0)),
      soldOn,
      identifiedCustomers: new Set(soldOn.filter((s) => s.customerRef !== null).map((s) => s.customerRef)).size,
      // Counted, never hidden. A shop that can contact four of nineteen buyers needs to know it is
      // four of nineteen, because the other fifteen are the reason for a public notice.
      anonymousSales: soldOn.filter((s) => s.customerRef === null).length,
      open: recall.closure === undefined,
    };
  };

  return {
    actionList: () => expiryActions(ports.batches(), config.now, config.nearExpiryDays)
      .map((item) => ({ ...item, name: nameOf(item.productId) })),

    wouldAllocate: (productId, qty) => allocateFefo(ports.batches(), productId, qty, config.now),

    recalls: () => {
      const views = ports.recalls().map(viewOf);
      // Open first, then most recently started. This is a work list, and an open recall is the
      // most urgent thing on any screen in this product.
      return [...views].sort((a, b) =>
        (a.open === b.open ? 0 : a.open ? -1 : 1)
        || b.recall.startedAt.localeCompare(a.recall.startedAt));
    },

    start: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: START_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen. A recall carries the name of whoever started it.',
        };
      }
      if (input.reason.trim() === '') {
        return {
          ok: false,
          refusal: START_REFUSAL_VALUES.needs_a_reason,
          detail: 'a recall needs a reason. It is the first thing anybody asks afterwards, including an inspector.',
        };
      }
      const batch = ports.batches().find((b) => b.batchId === input.batchId);
      if (batch === undefined) {
        return {
          ok: false,
          refusal: START_REFUSAL_VALUES.no_such_batch,
          detail: `this store box has no batch "${input.batchId}". Check the code on the packaging.`,
        };
      }
      const existing = ports.recalls().find((r) => r.batchId === input.batchId && r.closure === undefined);
      if (existing !== undefined) {
        return {
          ok: false,
          refusal: START_REFUSAL_VALUES.already_recalled,
          detail: `batch "${input.batchId}" is already recalled, started by ${existing.startedBy}. Starting it twice would split the evidence across two records.`,
        };
      }

      const recall: RecallRecord = {
        recallId: input.recallId,
        batchId: input.batchId,
        productId: batch.productId,
        reason: input.reason,
        startedBy: config.userId,
        startedAt: config.now,
      };
      return { ok: true, recall, view: viewOf(recall) };
    },

    close: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: CLOSE_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen. Closing a recall carries a name.',
        };
      }
      const recall = ports.recalls().find((r) => r.recallId === input.recallId);
      if (recall === undefined) {
        return { ok: false, refusal: CLOSE_REFUSAL_VALUES.no_such_recall, detail: `there is no recall "${input.recallId}".` };
      }
      if (recall.closure !== undefined) {
        return {
          ok: false,
          refusal: CLOSE_REFUSAL_VALUES.already_closed,
          detail: `this recall was closed by ${recall.closure.closedBy} on ${recall.closure.closedAt}. Reopening it would be a new record, never an edit of this one.`,
        };
      }
      // **A recall closed with no evidence is a recall nobody did.** The record is the only thing
      // that exists afterwards, and it is the thing an inspector reads (hard rule #6).
      if (input.evidence.trim() === '') {
        return {
          ok: false,
          refusal: CLOSE_REFUSAL_VALUES.needs_evidence,
          detail: 'closing a recall needs evidence of what was actually done with the stock — where it went, who took it away, what was destroyed.',
        };
      }

      const trace = traceBatch(ports.ledger(), recall.batchId);
      const accountedFor = input.recoveredQty + input.disposedQty;
      const stillOut = trace.issuedQty - accountedFor;
      // Blocking the till was the easy half. This is the hard half, and it is the one that gets
      // skipped: closing with stock unaccounted for is allowed ONLY with a reason of its own,
      // because in a real recall some of it is genuinely eaten and never coming back — but that is
      // a decision somebody makes and signs, not a default.
      if (stillOut > 0 && (input.acceptUnrecovered ?? '').trim() === '') {
        return {
          ok: false,
          refusal: CLOSE_REFUSAL_VALUES.stock_not_accounted_for,
          detail: `${stillOut} of this batch went out and has not been accounted for. Closing now needs a note saying why — most of it is probably in customers' homes, and that is the fact the closure record has to state.`,
        };
      }

      return {
        ok: true,
        recall: {
          ...recall,
          closure: {
            closedBy: config.userId,
            closedAt: config.now,
            evidence: stillOut > 0
              ? `${input.evidence} — closed with ${stillOut} unaccounted for: ${input.acceptUnrecovered!.trim()}`
              : input.evidence,
            recoveredQty: input.recoveredQty,
            disposedQty: input.disposedQty,
          },
        },
      };
    },
  };
}
