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
//     a supplier return PENDING until the goods have physically gone back (`…/excess/returned`), then as returned.
//
// Nothing here is stored a second time. The account is READ from the registers, so it can never disagree with them, a
// retry can never double it, and a correction anywhere upstream shows the next time it is read (P-02, hard rule #2).
// Finance posts this account to the ledger through the accountant's mapping (services/finance/src/payables.ts) and
// reconciles the two — the register and the ledger — as two figures reached two different ways (QG-07).

import type { Route } from '../../kernel/src/index';
import { notFound } from '../../kernel/src/index';
import type { PayablesAccount } from '../../../packages/finance/src/payables';
import type { SupplierInvoiceRecord, StoredMatch } from './index';

/** One line of a goods receipt as the account reads it — a structural subset of the inventory service's `CheckedLine`. */
export interface ReceiptLineForAccount {
  readonly lineId: string;
  readonly productId: string;
  readonly quarantinedMinor: number;
  readonly rejectedMinor: number;
  readonly heldMinor: number;
  readonly unitCost: { readonly minor: number; readonly currency: string };
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

export interface SupplierAccountTotals {
  readonly invoicedMinor: number;
  /** Σ matched payable — what the shop has agreed it owes. */
  readonly accruedMinor: number;
  /** Σ withheld — in dispute, not owed until settled. */
  readonly withheldMinor: number;
  readonly debitNotesMinor: number;
  /** accrued − debit notes: the balance the supplier's statement should show. */
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
  readonly asAt: string;
}

const heldValue = (r: ReceiptForAccount): number => r.captured.lines.reduce((s, l) => s + l.heldMinor * l.unitCost.minor, 0);

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
  for (const r of input.receipts) {
    if (r.poId === null || !orderIds.has(r.poId)) continue;
    const poId = r.poId;
    for (const d of r.dispositions ?? []) {
      if (d.disposition === 'accept') continue;
      const line = r.captured.lines.find((l) => l.lineId === d.lineId);
      if (line === undefined) continue;
      if (line.quarantinedMinor > 0) {
        debitNotes.push({
          debitNoteRef: `DN-${r.grnId}-${d.lineId}`, grnId: r.grnId, lineId: d.lineId, productId: d.productId, poId, disposition: d.disposition,
          quantityMinor: line.quarantinedMinor, valueMinor: line.quarantinedMinor * line.unitCost.minor, currency: d.currency,
          decidedBy: d.decidedBy, decidedAt: d.decidedAt, reason: d.reason,
        });
      }
      if (line.rejectedMinor > 0) {
        refusedNotOwed.push({
          grnId: r.grnId, lineId: d.lineId, productId: d.productId, poId, disposition: d.disposition,
          quantityMinor: line.rejectedMinor, valueMinor: line.rejectedMinor * line.unitCost.minor, currency: d.currency,
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
  return {
    supplierId: input.supplierId, currency: 'INR',
    invoices, debitNotes, refusedNotOwed, pendingSupplierReturns,
    totals: {
      invoicedMinor: invoices.reduce((s, i) => s + i.invoicedMinor, 0),
      accruedMinor, withheldMinor: invoices.reduce((s, i) => s + i.withheldMinor, 0),
      debitNotesMinor, owedMinor: accruedMinor - debitNotesMinor,
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
  const supplierIds = [...new Set([...input.invoices.map((i) => i.supplierId), ...input.orders.map((o) => o.supplierId)])].sort();
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
  a.totals.unmatchedInvoices > 0 || a.totals.blockedInvoices > 0 || a.totals.withheldMinor > 0 || a.totals.pendingReturns > 0;

export interface SupplierAccountDeps {
  readonly invoices: (tenantId: string) => Promise<readonly SupplierInvoiceRecord[]> | readonly SupplierInvoiceRecord[];
  /** The LATEST recorded match per invoice id. */
  readonly latestMatches: (tenantId: string) => Promise<ReadonlyMap<string, StoredMatch>> | ReadonlyMap<string, StoredMatch>;
  readonly purchaseOrders: (tenantId: string) => Promise<readonly OrderForAccount[]> | readonly OrderForAccount[];
  readonly receipts: (tenantId: string) => Promise<readonly ReceiptForAccount[]> | readonly ReceiptForAccount[];
  readonly now: () => string;
}

async function registers(deps: SupplierAccountDeps, tenantId: string): Promise<Omit<SupplierAccountInput, 'supplierId'>> {
  const [invoices, matches, orders, receipts] = await Promise.all([
    deps.invoices(tenantId), deps.latestMatches(tenantId), deps.purchaseOrders(tenantId), deps.receipts(tenantId),
  ]);
  return { invoices, matchOf: (id) => matches.get(id), orders, receipts, asAt: deps.now() };
}

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
        const known = regs.invoices.some((i) => i.supplierId === supplierId) || regs.orders.some((o) => o.supplierId === supplierId);
        if (!known) throw notFound(`supplier ${supplierId}`);
        return { status: 200, body: foldSupplierAccount({ ...regs, supplierId }) };
      },
    },
  ];
}
