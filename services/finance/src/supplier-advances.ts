// API-09 Finance — SUPPLIER ADVANCES (D10-FR-01 "chart/ledger mapping, AP/AR and advances" · §17.1 "suppliers … advances
// and outstanding" · M23-FR-01 · WF-18 "reconcile … AP" · §28 maker-checker · P-08 · hard rules #2, #10).
//
// Money paid to a supplier BEFORE the bill (a prepayment against an order) is the shop's asset until a bill uses it up.
// Without a record of it, the advance either vanishes into the supplier's balance (nobody can say how much is still owed
// back) or is paid twice. So:
//
//   • PAY (`POST /v1/finance/supplier-advances/:advanceId`) — { supplierId, amountMinor, paidOn, method, reference, poId?,
//     approvalId }. Paying a supplier is a payment: it needs a SECOND person's approval in their own session (the engine's
//     `supplier_payment` kind, never the maker's own), spent once. The advance is ONE journal through the accountant's
//     mapping (`supplier_advance`: e.g. Dr supplier advances, Cr bank) — the journal IS the record, so a re-send posts
//     nothing twice. Refused, nothing written: an unknown supplier, a mapping without the rule (the accountant's call).
//   • APPLY (`POST /v1/finance/supplier-advances/:advanceId/applications/:applicationId`) — { amountMinor, invoiceId,
//     appliedOn }. A later bill of the SAME supplier uses some or all of it: one journal (`supplier_advance_applied`: e.g.
//     Dr the supplier's payable, Cr supplier advances). Refused: more than the advance has left; a bill that is not this
//     supplier's matched bill; more than the purchase register says is still owed to that supplier after earlier
//     applications. An application is never edited; a wrong one is undone by a REVERSAL application (a compensating
//     journal, `reverses`), never by deleting it.
//   • READ (`GET /v1/finance/supplier-advances`) — every advance: paid, applied, left; per supplier; and the advances
//     account in the ledger beside the register — two figures reached two ways (WF-18 close check).
//
// Closed months take nothing: a journal belonging to a closed month posts to the next open one, carrying its real date.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { postJournal as mapToJournal, type PostingMap } from '../../../packages/finance/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';

export const SUPPLIER_ADVANCE_KIND = 'supplier_advance';
export const SUPPLIER_ADVANCE_APPLIED_KIND = 'supplier_advance_applied';
const METHODS = ['bank_transfer', 'cheque', 'upi', 'cash'] as const;
type Method = (typeof METHODS)[number];

export interface SupplierAdvanceJournal extends JournalEntry {
  readonly supplierAdvance: {
    readonly change: 'paid' | 'applied';
    readonly advanceId: string;
    readonly supplierId: string;
    readonly amountMinor: number;
    readonly on: string;
    readonly poId?: string;
    readonly method?: Method;
    readonly reference?: string;
    readonly approvedBy?: string;
    readonly applicationId?: string;
    readonly invoiceId?: string;
    /** An application that undoes an earlier one (a compensating journal). Its amount is then taken OFF what was applied. */
    readonly reverses?: string;
  };
}

/** One supplier's matched bill as the purchase register holds it (what an application may be set against). */
export interface BillForAdvance {
  readonly invoiceId: string;
  readonly supplierId: string;
  readonly payableMinor: number;
  readonly matched: boolean;
}

export interface SupplierAdvanceDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<PostingMap | undefined> | PostingMap | undefined;
  readonly advanceJournals: (tenantId: string) => Promise<readonly SupplierAdvanceJournal[]> | readonly SupplierAdvanceJournal[];
  /** Is this a supplier head office knows? */
  readonly supplierExists: (tenantId: string, supplierId: string) => Promise<boolean> | boolean;
  /** The supplier's matched bills and what the purchase register says is owed to them now (before advances). */
  readonly supplierPosition: (tenantId: string, supplierId: string) => Promise<{ readonly bills: readonly BillForAdvance[]; readonly owedMinor: number }>;
  /** The ledger's balance on an account over every journal (debit less credit). */
  readonly ledgerBalance: (tenantId: string, account: string) => Promise<number>;
  readonly approvals?: ApprovalPort;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

/** The account the advance rule DEBITS — where the ledger holds advances; undefined when unmapped. */
export function advancesAccount(map: PostingMap | undefined): string | undefined {
  return map?.rules.find((r) => r.kind === SUPPLIER_ADVANCE_KIND)?.legs.find((l) => l.side === 'debit')?.account;
}

export interface AdvancePosition {
  readonly advanceId: string;
  readonly supplierId: string;
  readonly poId: string | null;
  readonly paidMinor: number;
  readonly appliedMinor: number;
  readonly leftMinor: number;
  readonly paidOn: string;
  readonly approvedBy: string | null;
  readonly applications: readonly { readonly applicationId: string; readonly invoiceId: string | null; readonly amountMinor: number; readonly on: string; readonly reverses: string | null }[];
}

/** Every advance at its position: paid, applied (net of reversals), left. Pure. */
export function advancePositions(journals: readonly SupplierAdvanceJournal[]): readonly AdvancePosition[] {
  const paid = journals.filter((j) => j.supplierAdvance.change === 'paid');
  return paid.map((p) => {
    const apps = journals.filter((j) => j.supplierAdvance.change === 'applied' && j.supplierAdvance.advanceId === p.supplierAdvance.advanceId);
    const appliedMinor = apps.reduce((s, a) => s + (a.supplierAdvance.reverses === undefined ? a.supplierAdvance.amountMinor : -a.supplierAdvance.amountMinor), 0);
    return {
      advanceId: p.supplierAdvance.advanceId, supplierId: p.supplierAdvance.supplierId, poId: p.supplierAdvance.poId ?? null,
      paidMinor: p.supplierAdvance.amountMinor, appliedMinor, leftMinor: p.supplierAdvance.amountMinor - appliedMinor,
      paidOn: p.supplierAdvance.on, approvedBy: p.supplierAdvance.approvedBy ?? null,
      applications: apps.map((a) => ({ applicationId: a.supplierAdvance.applicationId ?? '', invoiceId: a.supplierAdvance.invoiceId ?? null, amountMinor: a.supplierAdvance.amountMinor, on: a.supplierAdvance.on, reverses: a.supplierAdvance.reverses ?? null })),
    };
  });
}

/** What a supplier's applications have taken off the purchase register's owed (net of reversals). Pure. */
export function appliedForSupplier(journals: readonly SupplierAdvanceJournal[], supplierId: string): number {
  return journals.filter((j) => j.supplierAdvance.change === 'applied' && j.supplierAdvance.supplierId === supplierId)
    .reduce((s, a) => s + (a.supplierAdvance.reverses === undefined ? a.supplierAdvance.amountMinor : -a.supplierAdvance.amountMinor), 0);
}

const asLines = (posted: ReturnType<typeof mapToJournal>) =>
  posted.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 }));

export function supplierAdvanceRoutes(deps: SupplierAdvanceDeps): readonly Route[] {
  /** Post one advance journal, the period gate first; a closed month's journal goes to the next open one. */
  const post = async (tenantId: string, kind: string, id: string, on: string, amountMinor: number, narrative: string, tag: SupplierAdvanceJournal['supplierAdvance'], postedBy: string): Promise<SupplierAdvanceJournal> => {
    const map = await deps.postingMap(tenantId);
    if (map === undefined || map.rules.find((r) => r.kind === kind) === undefined) {
      throw apiError(409, {
        code: `${kind}_not_mapped`,
        whatHappened: `The ledger mapping has no "${kind}" rule, so the money cannot be put in the books — which accounts a supplier advance uses is the accountant's decision, not the system's.`,
        wasItSaved: 'not_saved',
        nextSafeAction: `The accountant adds a "${kind}" rule to the mapping (PUT /v1/finance/posting-map), then send this again. Nothing was recorded.`,
      });
    }
    const mapped = mapToJournal({ id, kind, at: `${on}T00:00:00.000Z`, currency: 'INR', components: { amount: amountMinor } }, map);
    const states = await deps.periodStates(tenantId);
    const belongsTo = on.slice(0, 7);
    const closed = states.get(belongsTo) === 'closed';
    const period = closed ? await deps.nextOpenPeriod(tenantId) : belongsTo;
    const lines = asLines(mapped);
    const journal: SupplierAdvanceJournal = {
      entryId: id, period, documentDate: on,
      narrative: narrative + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
      // A reversal is the mirror of the application it undoes — the same accounts, the sides swapped.
      lines: tag.reverses === undefined ? lines : lines.map((l) => ({ accountCode: l.accountCode, debitMinor: l.creditMinor, creditMinor: l.debitMinor })),
      postedBy, supplierAdvance: tag,
    };
    const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
    if (!gate.ok) throw apiError(422, { code: gate.refusedBecause ?? 'journal_refused', whatHappened: gate.detail, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send again. Nothing was recorded.' });
    await deps.appendJournal(tenantId, journal);
    return journal;
  };

  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/supplier-advances/:advanceId',
      permission: 'purchase.supplier.pay', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const advanceId = (ctx.params['advanceId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (advanceId === '' || !isStr(b['supplierId']) || !isPosInt(b['amountMinor']) || !isDate(b['paidOn']) || !METHODS.includes(b['method'] as Method) || !isStr(b['reference'])
          || (b['poId'] !== undefined && !isStr(b['poId']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_supplier_advance',
            whatHappened: `A supplier advance needs { supplierId, amountMinor (whole paise, more than 0), paidOn (YYYY-MM-DD), method (${METHODS.join(' / ')}), reference, poId?, approvalId }.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the payment as it was made, with the approval a second person gave. Nothing was recorded.',
          });
        }
        const journals = await deps.advanceJournals(t);
        const prior = journals.find((j) => j.supplierAdvance.change === 'paid' && j.supplierAdvance.advanceId === advanceId);
        if (prior !== undefined) {
          const same = prior.supplierAdvance.supplierId === b['supplierId'] && prior.supplierAdvance.amountMinor === b['amountMinor'];
          if (!same) throw apiError(409, { code: 'advance_id_used', whatHappened: `Advance ${advanceId} is already recorded for ${prior.supplierAdvance.supplierId}, ${prior.supplierAdvance.amountMinor} paise. A different payment cannot take its id.`, wasItSaved: 'not_saved', nextSafeAction: 'Record the payment under its own advance id. Nothing was changed.' });
          return { status: 200, body: { advance: prior.supplierAdvance, entryId: prior.entryId, alreadyRecorded: true } };
        }
        if (!(await deps.supplierExists(t, b['supplierId'] as string))) throw notFound(`supplier ${String(b['supplierId'])}`);
        // §28: paying a supplier needs a second person's approval, given in their own session, for exactly this payment.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: t, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'supplier_payment', subjectRef: `advance:${advanceId}`,
          details: actionDetails(ctx.body, { advanceId }), valueMinor: b['amountMinor'],
          maker: ctx.userId, usedBy: `supplier-advance:${advanceId}`, now: deps.now(),
        });
        if (opened === undefined) {
          throw apiError(422, {
            code: 'advance_needs_approval',
            whatHappened: 'Paying a supplier in advance is a payment: it needs a second person\'s approval (§28), never the maker\'s own.',
            wasItSaved: 'not_saved',
            nextSafeAction: `Ask for approval (POST /v1/approvals/requests, kind supplier_payment, subject advance:${advanceId}, with these details); once approved, send this again with the approvalId. Nothing was recorded.`,
          });
        }
        const supplierId = (b['supplierId'] as string).trim();
        // Check the mapping before the approval is spent: a refused posting must not use the approval up.
        const map = await deps.postingMap(t);
        if (map === undefined || map.rules.find((r) => r.kind === SUPPLIER_ADVANCE_KIND) === undefined) {
          throw apiError(409, { code: `${SUPPLIER_ADVANCE_KIND}_not_mapped`, whatHappened: 'The ledger mapping has no "supplier_advance" rule, so the advance cannot be put in the books — the accountant decides which accounts it uses.', wasItSaved: 'not_saved', nextSafeAction: 'The accountant adds a "supplier_advance" rule to the mapping, then send this again. The approval is unused. Nothing was recorded.' });
        }
        await opened.spend();
        const journal = await post(t, SUPPLIER_ADVANCE_KIND, `supplier-advance:${advanceId}`, b['paidOn'] as string, b['amountMinor'] as number,
          `Advance paid to supplier ${supplierId}${isStr(b['poId']) ? ` against order ${(b['poId'] as string).trim()}` : ''}, ${b['method'] as string} ref ${(b['reference'] as string).trim()}, approved by ${opened.decision.decidedBy}`,
          {
            change: 'paid', advanceId, supplierId, amountMinor: b['amountMinor'] as number, on: b['paidOn'] as string,
            ...(isStr(b['poId']) ? { poId: (b['poId'] as string).trim() } : {}), method: b['method'] as Method, reference: (b['reference'] as string).trim(),
            approvedBy: opened.decision.decidedBy,
          }, ctx.userId);
        return { status: 201, body: { advance: journal.supplierAdvance, entryId: journal.entryId, period: journal.period, alreadyRecorded: false } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/supplier-advances/:advanceId/applications/:applicationId',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const advanceId = (ctx.params['advanceId'] ?? '').trim();
        const applicationId = (ctx.params['applicationId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reversing = isStr(b['reverses']);
        if (advanceId === '' || applicationId === '' || !isPosInt(b['amountMinor']) || !isDate(b['appliedOn']) || (!reversing && !isStr(b['invoiceId']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_advance_application',
            whatHappened: 'Using an advance against a bill needs { amountMinor (whole paise, more than 0), invoiceId (the supplier\'s matched bill), appliedOn (YYYY-MM-DD) } — or, to undo an earlier one, { reverses: "<applicationId>", amountMinor, appliedOn }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the bill and the amount to set against it. Nothing was recorded.',
          });
        }
        const journals = await deps.advanceJournals(t);
        const done = journals.find((j) => j.supplierAdvance.change === 'applied' && j.supplierAdvance.advanceId === advanceId && j.supplierAdvance.applicationId === applicationId);
        if (done !== undefined) return { status: 200, body: { application: done.supplierAdvance, entryId: done.entryId, alreadyRecorded: true } };
        const position = advancePositions(journals).find((p) => p.advanceId === advanceId);
        if (position === undefined) throw notFound(`supplier advance ${advanceId}`);
        const amount = b['amountMinor'] as number;
        if (reversing) {
          const original = position.applications.find((a) => a.applicationId === b['reverses'] && a.reverses === null);
          const alreadyReversed = position.applications.filter((a) => a.reverses === b['reverses']).reduce((s, a) => s + a.amountMinor, 0);
          if (original === undefined) throw notFound(`application ${String(b['reverses'])} of advance ${advanceId}`);
          if (amount > original.amountMinor - alreadyReversed) {
            throw apiError(422, { code: 'reversal_exceeds_application', whatHappened: `Application ${original.applicationId} set ${original.amountMinor} paise against the bill and ${alreadyReversed} of it is already undone; ${amount} more cannot be undone.`, wasItSaved: 'not_saved', nextSafeAction: 'Undo at most what is left of it. Nothing was recorded.' });
          }
          const journal = await post(t, SUPPLIER_ADVANCE_APPLIED_KIND, `supplier-advance:${advanceId}:applied:${applicationId}`, b['appliedOn'] as string, amount,
            `Undo of advance ${advanceId} application ${original.applicationId} (${amount} paise) for supplier ${position.supplierId}: the bill is owed again and the advance is open again`,
            { change: 'applied', advanceId, supplierId: position.supplierId, amountMinor: amount, on: b['appliedOn'] as string, applicationId, ...(original.invoiceId === null ? {} : { invoiceId: original.invoiceId }), reverses: original.applicationId }, ctx.userId);
          return { status: 201, body: { application: journal.supplierAdvance, entryId: journal.entryId, leftMinor: position.leftMinor + amount, alreadyRecorded: false } };
        }
        if (amount > position.leftMinor) {
          throw apiError(422, { code: 'more_than_the_advance_has_left', whatHappened: `Advance ${advanceId} paid ${position.paidMinor} paise and ${position.appliedMinor} is already used; ${amount} more is ${amount - position.leftMinor} above what is left.`, wasItSaved: 'not_saved', nextSafeAction: 'Set only what is left against the bill. Nothing was recorded.' });
        }
        const sp = await deps.supplierPosition(t, position.supplierId);
        const bill = sp.bills.find((x) => x.invoiceId === b['invoiceId']);
        if (bill === undefined || !bill.matched || bill.supplierId !== position.supplierId) {
          throw apiError(422, { code: 'not_this_suppliers_matched_bill', whatHappened: `${String(b['invoiceId'])} is not a matched bill of ${position.supplierId} on the purchase register — an advance is used only against its own supplier's matched bill.`, wasItSaved: 'not_saved', nextSafeAction: 'Name the supplier\'s matched bill. Nothing was recorded.' });
        }
        const owedAfter = sp.owedMinor - appliedForSupplier(journals, position.supplierId);
        if (amount > owedAfter) {
          throw apiError(422, { code: 'more_than_is_owed', whatHappened: `The purchase register says ${position.supplierId} is owed ${sp.owedMinor} paise, of which ${sp.owedMinor - owedAfter} is already settled from advances; ${amount} would pay more than is owed.`, wasItSaved: 'not_saved', nextSafeAction: 'Set at most what is still owed. Nothing was recorded.' });
        }
        const journal = await post(t, SUPPLIER_ADVANCE_APPLIED_KIND, `supplier-advance:${advanceId}:applied:${applicationId}`, b['appliedOn'] as string, amount,
          `Advance ${advanceId} used against bill ${bill.invoiceId} of supplier ${position.supplierId} (${amount} paise)`,
          { change: 'applied', advanceId, supplierId: position.supplierId, amountMinor: amount, on: b['appliedOn'] as string, applicationId, invoiceId: bill.invoiceId }, ctx.userId);
        return { status: 201, body: { application: journal.supplierAdvance, entryId: journal.entryId, leftMinor: position.leftMinor - amount, alreadyRecorded: false } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/supplier-advances',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const [journals, map] = await Promise.all([deps.advanceJournals(t), deps.postingMap(t)]);
        const positions = advancePositions(journals);
        const account = advancesAccount(map);
        const registerLeftMinor = positions.reduce((s, p) => s + p.leftMinor, 0);
        const ledgerMinor = account === undefined ? null : await deps.ledgerBalance(t, account);
        return {
          status: 200,
          body: {
            advances: positions, registerLeftMinor, advancesAccount: account ?? null, ledgerMinor,
            agrees: ledgerMinor !== null && ledgerMinor === registerLeftMinor,
            detail: account === undefined ? 'The mapping names no "supplier_advance" rule, so the ledger side is not known (not zero).' : ledgerMinor === registerLeftMinor ? 'The advances left on the register equal the advances account in the ledger.' : 'The advances left on the register do NOT equal the advances account in the ledger — a person must look.',
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
