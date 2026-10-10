// API-03 Supplier account (SP-7b · audit finding F04's payable half · M23-FR-01 · M07-FR-03 · M07-FR-04 · §28 · P-02).
//
// What a supplier is OWED is not a figure anybody types. It is a PROJECTION over four records head office already holds:
//
//   • the invoice as the paper said it (SP-7a) and the LATEST three-way match of that invoice against the stored order and
//     the receipts folded into it — the lowest of three is the payable (accrued), the rest is WITHHELD (in dispute, not
//     owed); an invoice nobody has matched yet is owed nothing until it has been compared;
//   • the goods receipts' dispositions (SP-6): a RETURN or a CLAIM by a second person raises a DEBIT NOTE for the quantity
//     that was received against the order and therefore paid for — the QUARANTINED quantity, valued at the delivered cost.
//     Refused stock (expired at the dock) was never received against the order, so the match already withheld it and NO
//     debit note is raised — raising one would count the same shortfall twice; it is listed as "refused, never owed";
//   • the rejected over-delivery (SP-6b): held out of the received figure, so the match withholds it if invoiced; listed as
//     a supplier return PENDING until the goods have physically gone back (`…/excess/returned`), then as returned;
//   • SP-7c: the PAYMENTS recorded against the supplier (a second person approving each) net the balance, and a debit note
//     carries the statutory number it was issued under once a person issued it (supplier-master.ts).
//
// Nothing here is stored a second time. The account is READ from the registers, so it can never disagree with them, a
// retry can never double it, and a correction anywhere upstream shows the next time it is read (P-02, hard rule #2).
// Finance posts this account to the ledger through the accountant's mapping (services/finance/src/payables.ts) and
// reconciles the two — the register and the ledger — as two figures reached two different ways (QG-07).

import type { Route } from '../../kernel/src/index';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';
import { notFound } from '../../kernel/src/index';
import type { PayablesAccount } from '../../../packages/finance/src/payables';
import type { SupplierInvoiceRecord, StoredMatch } from './index';
import type { AccountOpening } from './supplier-openings';

/** One line of a goods receipt as the account reads it — a structural subset of the inventory service's `CheckedLine`. */
export interface ReceiptLineForAccount {
  readonly lineId: string;
  readonly productId: string;
  readonly quarantinedMinor: number;
  readonly rejectedMinor: number;
  readonly heldMinor: number;
  readonly unitCost: { readonly minor: number; readonly currency: string };
  /** OB-31: the line's unit — quantities are smallest steps (grams for kg), the cost is per whole unit. */
  readonly uom?: string;
}

/** A second person's disposition of a line (SP-6) — a structural subset of `LineDisposition`. */
export interface ReceiptDispositionForAccount {
  readonly lineId: string;
  readonly productId: string;
  readonly disposition: 'accept' | 'return' | 'claim';
  readonly quantityMinor: number;
  readonly valueMinor: number;
  readonly currency: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
}

/** A goods receipt as the account reads it — a structural subset of the inventory service's `GrnRecord`. */
export interface ReceiptForAccount {
  readonly grnId: string;
  readonly poId: string | null;
  readonly receivedBy: string;
  readonly receivedAt: string;
  readonly heldMinor: number;
  readonly captured: { readonly lines: readonly ReceiptLineForAccount[] };
  readonly dispositions?: readonly ReceiptDispositionForAccount[];
  readonly excessDecision?: { readonly decision: 'approved' | 'rejected'; readonly decidedBy: string; readonly decidedAt: string; readonly reason: string };
  readonly excessReturn?: { readonly returnedBy: string; readonly returnedAt: string; readonly quantityMinor: number; readonly valueMinor: number };
  /** Batch 2 — quarantined lines disposed of as a return that have physically gone back (goods-receipt `lineReturns`). */
  readonly lineReturns?: readonly { readonly lineId: string; readonly returnedBy: string; readonly returnedAt: string }[];
}

/** SP-7c — a payment recorded against the supplier (supplier-master.ts): a fact a second person approved, netting the balance. */
export interface SupplierPayment {
  readonly paymentId: string;
  readonly supplierId: string;
  readonly amountMinor: number;
  readonly currency: 'INR';
  /** The day the money went, YYYY-MM-DD. */
  readonly paidOn: string;
  readonly method: 'bank_transfer' | 'cheque' | 'upi' | 'cash';
  readonly reference: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

/** SP-7c — a debit note ISSUED to the supplier under a number from the tenant's series (M23-FR-02). */
export interface DebitNoteIssue {
  readonly debitNoteRef: string;
  readonly supplierId: string;
  readonly number: string;
  readonly seq: number;
  readonly valueMinor: number;
  readonly issuedBy: string;
  readonly issuedAt: string;
}

/** A purchase order as the account needs it — which supplier a receipt against it belongs to. */
export interface OrderForAccount {
  readonly poId: string;
  readonly supplierId: string;
  readonly status: string;
}

export interface AccountInvoice {
  readonly invoiceId: string;
  readonly poId: string | null;
  readonly capturedBy: string;
  readonly capturedAt: string;
  readonly approvedBy: string | null;
  readonly invoicedMinor: number;
  /** What the latest match says may be paid — 0 until matched. */
  readonly payableMinor: number;
  /** What the latest match holds back — the whole invoice until matched. */
  readonly withheldMinor: number;
  readonly matched: boolean;
  readonly blocked: boolean;
  readonly matchedAt: string | null;
  readonly flags: readonly string[];
}

/** A debit note raised by a second person's return / claim of stock the shop had received and was going to pay for. */
export interface DebitNote {
  readonly debitNoteRef: string;
  readonly grnId: string;
  readonly lineId: string;
  readonly productId: string;
  readonly poId: string;
  readonly disposition: 'return' | 'claim';
  /** The QUARANTINED quantity — received against the order, so accrued; the refused part is never owed and never noted. */
  readonly quantityMinor: number;
  readonly valueMinor: number;
  readonly currency: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason: string;
  /** The statutory number it was issued under, once a person issued it (SP-7c); null while it is only a figure on the account. */
  readonly number: string | null;
  readonly issuedBy: string | null;
  readonly issuedAt: string | null;
}

/** Refused (expired) stock a second person returned or claimed — said, and never owed, because the match withheld it. */
export interface RefusedNotOwed {
  readonly grnId: string;
  readonly lineId: string;
  readonly productId: string;
  readonly poId: string;
  readonly disposition: 'return' | 'claim';
  readonly quantityMinor: number;
  readonly valueMinor: number;
  readonly currency: string;
}

/** A rejected over-delivery (SP-6b): counted, in the building, going back to the supplier — pending until it has. */
export interface PendingSupplierReturn {
  readonly grnId: string;
  readonly poId: string;
  readonly heldMinor: number;
  readonly valueMinor: number;
  readonly currency: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly returned: boolean;
  readonly returnedAt: string | null;
}

/**
 * Batch 2 — a quarantined line a second person disposed of as a RETURN: the goods are the supplier's to collect, beside the
 * debit note the disposition raised. `returned` once someone records the hand-over; until then it waits, visibly.
 */
export interface PendingLineReturn {
  readonly grnId: string;
  readonly lineId: string;
  readonly productId: string;
  readonly poId: string;
  readonly quantityMinor: number;
  readonly valueMinor: number;
  readonly currency: string;
  readonly debitNoteRef: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly returned: boolean;
  readonly returnedBy: string | null;
  readonly returnedAt: string | null;
}

export interface SupplierAccountTotals {
  readonly invoicedMinor: number;
  /** Σ matched payable — what the shop has agreed it owes. */
  readonly accruedMinor: number;
  /** Σ withheld — in dispute, not owed until settled. */
  readonly withheldMinor: number;
  readonly debitNotesMinor: number;
  /** Σ payments recorded against the supplier (SP-7c). */
  readonly paidMinor: number;
  /** GT-05 — Σ SIGNED opening balances carried from the old system (supplier-openings.ts). */
  readonly openingMinor: number;
  /** GT-05 — Σ opening balances recorded but not yet signed off by a second person: shown, NOT owed. */
  readonly openingPendingSignOffMinor: number;
  /** accrued + signed openings − debit notes − paid: the balance the supplier's statement should show. */
  readonly owedMinor: number;
  readonly unmatchedInvoices: number;
  readonly blockedInvoices: number;
  readonly pendingReturns: number;
}

export interface SupplierAccountStatement extends PayablesAccount {
  readonly supplierId: string;
  readonly currency: 'INR';
  readonly invoices: readonly AccountInvoice[];
  readonly debitNotes: readonly DebitNote[];
  readonly refusedNotOwed: readonly RefusedNotOwed[];
  readonly pendingSupplierReturns: readonly PendingSupplierReturn[];
  /** Batch 2 — quarantined lines disposed of as returns, and whether they have physically gone back. */
  readonly pendingLineReturns: readonly PendingLineReturn[];
  readonly payments: readonly SupplierPayment[];
  /** GT-05 — the legacy bills still outstanding at cutover, each with its sign-off state. */
  readonly openings: readonly AccountOpening[];
  readonly totals: SupplierAccountTotals;
  readonly asAt: string;
}

/** A receipt whose dispositions or rejected excess reach NO supplier — a visible exception, never a silent loss (P-08). */
export interface UnattributedReceipt {
  readonly grnId: string;
  readonly reason: 'no_purchase_order' | 'order_unknown';
  readonly dispositions: number;
  readonly rejectedExcess: boolean;
}

export interface SupplierAccountInput {
  readonly supplierId: string;
  readonly invoices: readonly SupplierInvoiceRecord[];
  readonly matchOf: (invoiceId: string) => StoredMatch | undefined;
  readonly orders: readonly OrderForAccount[];
  readonly receipts: readonly ReceiptForAccount[];
  /** SP-7c — every payment recorded (all suppliers); the fold keeps this supplier's. Optional for callers that have none. */
  readonly payments?: readonly SupplierPayment[];
  /** SP-7c — every debit note issued under a number (all suppliers). */
  readonly debitNoteIssues?: readonly DebitNoteIssue[];
  /** GT-05 — every opening balance (all suppliers), with its sign-off state. Optional for callers that have none. */
  readonly openings?: readonly AccountOpening[];
  readonly asAt: string;
}

const heldValue = (r: ReceiptForAccount): number => r.captured.lines.reduce((s, l) => s + valueAtUnitCost(l.heldMinor, l.uom ?? 'ea', l.unitCost.minor), 0); // OB-31

/** ONE supplier's account, folded from the registers. Pure. */
export function foldSupplierAccount(input: SupplierAccountInput): SupplierAccountStatement {
  const invoices: AccountInvoice[] = input.invoices
    .filter((i) => i.supplierId === input.supplierId)
    .map((i) => {
      const m = input.matchOf(i.invoiceId);
      return {
        invoiceId: i.invoiceId, poId: i.poId, capturedBy: i.capturedBy, capturedAt: i.capturedAt, approvedBy: i.approvedBy,
        invoicedMinor: i.totalMinor,
        payableMinor: m?.payableMinor ?? 0,
        withheldMinor: m === undefined ? i.totalMinor : m.withheldMinor,
        matched: m !== undefined, blocked: m?.blocked ?? false, matchedAt: m?.matchedAt ?? null,
        flags: [...i.governanceFlags, ...(m?.flags ?? [])],
      };
    });

  const orderIds = new Set(input.orders.filter((o) => o.supplierId === input.supplierId).map((o) => o.poId));
  const debitNotes: DebitNote[] = [];
  const refusedNotOwed: RefusedNotOwed[] = [];
  const pendingSupplierReturns: PendingSupplierReturn[] = [];
  const pendingLineReturns: PendingLineReturn[] = [];
  for (const r of input.receipts) {
    if (r.poId === null || !orderIds.has(r.poId)) continue;
    const poId = r.poId;
    for (const d of r.dispositions ?? []) {
      if (d.disposition === 'accept') continue;
      const line = r.captured.lines.find((l) => l.lineId === d.lineId);
      if (line === undefined) continue;
      if (line.quarantinedMinor > 0) {
        const debitNoteRef = `DN-${r.grnId}-${d.lineId}`;
        const issued = (input.debitNoteIssues ?? []).find((i) => i.debitNoteRef === debitNoteRef && i.supplierId === input.supplierId);
        debitNotes.push({
          debitNoteRef, grnId: r.grnId, lineId: d.lineId, productId: d.productId, poId, disposition: d.disposition,
          quantityMinor: line.quarantinedMinor, valueMinor: valueAtUnitCost(line.quarantinedMinor, line.uom ?? 'ea', line.unitCost.minor), currency: d.currency,
          decidedBy: d.decidedBy, decidedAt: d.decidedAt, reason: d.reason,
          number: issued?.number ?? null, issuedBy: issued?.issuedBy ?? null, issuedAt: issued?.issuedAt ?? null,
        });
        if (d.disposition === 'return') {
          const back = (r.lineReturns ?? []).find((x) => x.lineId === d.lineId);
          pendingLineReturns.push({
            grnId: r.grnId, lineId: d.lineId, productId: d.productId, poId, quantityMinor: line.quarantinedMinor,
            valueMinor: valueAtUnitCost(line.quarantinedMinor, line.uom ?? 'ea', line.unitCost.minor), currency: d.currency, debitNoteRef,
            decidedBy: d.decidedBy, decidedAt: d.decidedAt, returned: back !== undefined, returnedBy: back?.returnedBy ?? null, returnedAt: back?.returnedAt ?? null,
          });
        }
      }
      if (line.rejectedMinor > 0) {
        refusedNotOwed.push({
          grnId: r.grnId, lineId: d.lineId, productId: d.productId, poId, disposition: d.disposition,
          quantityMinor: line.rejectedMinor, valueMinor: valueAtUnitCost(line.rejectedMinor, line.uom ?? 'ea', line.unitCost.minor), currency: d.currency,
        });
      }
    }
    if (r.excessDecision?.decision === 'rejected' && r.heldMinor > 0) {
      pendingSupplierReturns.push({
        grnId: r.grnId, poId, heldMinor: r.heldMinor, valueMinor: heldValue(r), currency: r.captured.lines[0]?.unitCost.currency ?? 'INR',
        decidedBy: r.excessDecision.decidedBy, decidedAt: r.excessDecision.decidedAt,
        returned: r.excessReturn !== undefined, returnedAt: r.excessReturn?.returnedAt ?? null,
      });
    }
  }

  const accruedMinor = invoices.reduce((s, i) => s + i.payableMinor, 0);
  const debitNotesMinor = debitNotes.reduce((s, d) => s + d.valueMinor, 0);
  const payments = (input.payments ?? []).filter((p) => p.supplierId === input.supplierId);
  const paidMinor = payments.reduce((s, p) => s + p.amountMinor, 0);
  const openings = (input.openings ?? []).filter((o) => o.supplierId === input.supplierId);
  const openingMinor = openings.filter((o) => o.signed).reduce((s, o) => s + o.amountMinor, 0);
  return {
    supplierId: input.supplierId, currency: 'INR',
    invoices, debitNotes, refusedNotOwed, pendingSupplierReturns, pendingLineReturns, payments, openings,
    totals: {
      invoicedMinor: invoices.reduce((s, i) => s + i.invoicedMinor, 0),
      accruedMinor, withheldMinor: invoices.reduce((s, i) => s + i.withheldMinor, 0),
      openingMinor, openingPendingSignOffMinor: openings.filter((o) => !o.signed).reduce((s, o) => s + o.amountMinor, 0),
      debitNotesMinor, paidMinor, owedMinor: accruedMinor + openingMinor - debitNotesMinor - paidMinor,
      unmatchedInvoices: invoices.filter((i) => !i.matched).length,
      blockedInvoices: invoices.filter((i) => i.blocked).length,
      pendingReturns: pendingSupplierReturns.filter((p) => !p.returned).length,
    },
    asAt: input.asAt,
  };
}

/** Every supplier the registers name — with an invoice or an order — and the receipts that reach no supplier at all. */
export function foldAllSupplierAccounts(input: Omit<SupplierAccountInput, 'supplierId'>): {
  readonly accounts: readonly SupplierAccountStatement[];
  readonly unattributed: readonly UnattributedReceipt[];
} {
  const supplierIds = [...new Set([
    ...input.invoices.map((i) => i.supplierId), ...input.orders.map((o) => o.supplierId), ...(input.payments ?? []).map((p) => p.supplierId),
    ...(input.openings ?? []).map((o) => o.supplierId),
  ])].sort();
  const accounts = supplierIds.map((supplierId) => foldSupplierAccount({ ...input, supplierId }));
  const known = new Set(input.orders.map((o) => o.poId));
  const unattributed: UnattributedReceipt[] = [];
  for (const r of input.receipts) {
    const dispositions = (r.dispositions ?? []).filter((d) => d.disposition !== 'accept').length;
    const rejectedExcess = r.excessDecision?.decision === 'rejected' && r.heldMinor > 0;
    if (dispositions === 0 && !rejectedExcess) continue;
    if (r.poId === null) unattributed.push({ grnId: r.grnId, reason: 'no_purchase_order', dispositions, rejectedExcess });
    else if (!known.has(r.poId)) unattributed.push({ grnId: r.grnId, reason: 'order_unknown', dispositions, rejectedExcess });
  }
  return { accounts, unattributed };
}

/** Whether an account needs a person: something unmatched, blocked, withheld, or a return not yet made (P-03). */
export const needsAttention = (a: SupplierAccountStatement): boolean =>
  a.totals.unmatchedInvoices > 0 || a.totals.blockedInvoices > 0 || a.totals.withheldMinor > 0 || a.totals.pendingReturns > 0
  || a.totals.openingPendingSignOffMinor > 0;

export interface SupplierAccountDeps {
  readonly invoices: (tenantId: string) => Promise<readonly SupplierInvoiceRecord[]> | readonly SupplierInvoiceRecord[];
  /** The LATEST recorded match per invoice id. */
  readonly latestMatches: (tenantId: string) => Promise<ReadonlyMap<string, StoredMatch>> | ReadonlyMap<string, StoredMatch>;
  readonly purchaseOrders: (tenantId: string) => Promise<readonly OrderForAccount[]> | readonly OrderForAccount[];
  readonly receipts: (tenantId: string) => Promise<readonly ReceiptForAccount[]> | readonly ReceiptForAccount[];
  /** SP-7c — every payment recorded against any supplier, and every debit note issued under a number. */
  readonly payments: (tenantId: string) => Promise<readonly SupplierPayment[]> | readonly SupplierPayment[];
  readonly debitNoteIssues: (tenantId: string) => Promise<readonly DebitNoteIssue[]> | readonly DebitNoteIssue[];
  /** GT-05 — every opening balance with its sign-off state (supplier-openings.ts). Optional: a stub has none. */
  readonly openingBalances?: (tenantId: string) => Promise<readonly AccountOpening[]> | readonly AccountOpening[];
  readonly now: () => string;
}

/** The registers the account folds from, read once — shared by the account routes, the master (SP-7c) and finance. */
export async function accountRegisters(deps: SupplierAccountDeps, tenantId: string): Promise<Omit<SupplierAccountInput, 'supplierId'>> {
  const [invoices, matches, orders, receipts, payments, debitNoteIssues, openings] = await Promise.all([
    deps.invoices(tenantId), deps.latestMatches(tenantId), deps.purchaseOrders(tenantId), deps.receipts(tenantId),
    deps.payments(tenantId), deps.debitNoteIssues(tenantId), deps.openingBalances?.(tenantId) ?? [],
  ]);
  return { invoices, matchOf: (id) => matches.get(id), orders, receipts, payments, debitNoteIssues, openings, asAt: deps.now() };
}
const registers = accountRegisters;

export function supplierAccountRoutes(deps: SupplierAccountDeps): readonly Route[] {
  return [
    {
      // Every supplier's account — the ones needing a person first (control by exception, P-03), and the receipts whose
      // dispositions or rejected excess reach no supplier because they named no order head office knows.
      api: 'API-03', method: 'GET', path: '/v1/purchase/suppliers/accounts',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const folded = foldAllSupplierAccounts(await registers(deps, ctx.tenantId));
        const attention = folded.accounts.filter(needsAttention);
        const rows = [...attention, ...folded.accounts.filter((a) => !attention.includes(a))]
          .map((a) => ({ supplierId: a.supplierId, totals: a.totals, needsAttention: needsAttention(a) }));
        return {
          status: 200,
          body: {
            accounts: rows, count: rows.length, needingAttentionCount: attention.length,
            owedMinor: folded.accounts.reduce((s, a) => s + a.totals.owedMinor, 0),
            unattributed: folded.unattributed, asAt: deps.now(),
          },
        };
      },
    },
    {
      // ONE supplier's statement — the invoices with their matched payable and withheld figures, the debit notes, what was
      // refused and never owed, the returns pending — and the balance. 404 for a supplier no register names: not known is
      // not the same answer as nothing owed.
      api: 'API-03', method: 'GET', path: '/v1/purchase/suppliers/:supplierId/account',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const regs = await registers(deps, ctx.tenantId);
        const known = regs.invoices.some((i) => i.supplierId === supplierId) || regs.orders.some((o) => o.supplierId === supplierId)
          || (regs.payments ?? []).some((p) => p.supplierId === supplierId) || (regs.openings ?? []).some((o) => o.supplierId === supplierId);
        if (!known) throw notFound(`supplier ${supplierId}`);
        return { status: 200, body: foldSupplierAccount({ ...regs, supplierId }) };
      },
    },
  ];
}
