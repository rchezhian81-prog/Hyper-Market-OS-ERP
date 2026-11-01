// API-09 Concession INVOICES and the settlement in the books (Round 4d · M27-FR-03 "settle concession counter sales, issue
// invoices and reconcile" · M23-FR-01 · §28 maker-checker · P-08 · hard rules #2, #10).
//
// Settlement was computed on read and nothing invoiced the concessionaire or posted it. Here:
//   • GST TREATMENT (`PUT /v1/concession/gst-treatment`, `finance.posting.configure` — the accountant / CA) — the GST rate
//     on rent, on revenue share and on utilities recovery, and whether the supply is within the state or across it. No rate
//     is assumed: until the CA sets it, no invoice can be issued (said by name). Versioned and append-only.
//   • ISSUE (`POST /v1/concession/contracts/:contractId/invoices/:invoiceId`) — { from, to, bankedForThemMinor,
//     meteredUtilitiesMinor?, approvalId }. One person makes it, ANOTHER approves it in their own session (kind
//     `concession_invoice`, spent once). The period's charge is the contract's (packages/concession computePeriodCharge);
//     the lines carry the CA's GST; the invoice NETS the counter's sales the tills collected for them and STATES the deposit
//     (never netted). Refused, nothing written: a period whose tills and counter disagree (settle the difference first), an
//     invoice already issued for an overlapping period, no GST treatment, a posting map without `concession_settlement`.
//     The number comes from a GAP-FREE series per financial year (CI/2026-27/0001), taken under a guard so two issues at
//     once cannot share or skip a number; the settlement journal posts in the same act (liability off, income, output GST,
//     payable to them or receivable from them). A closed month's journal goes to the next open one, carrying its date.
//   • READ (`GET /v1/concession/contracts/:contractId/invoices`) — every invoice issued, and the RECONCILE check: the
//     settlement journals on the ledger against the invoices, figure for figure (WF-18 "settlement reconciles to M23").
// An issued invoice is never edited or deleted; a wrong one is put right by a credit note (a compensating document), the
// accountant's own act on the finance notes surface.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, assertBranchInScope } from '../../kernel/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import {
  computePeriodCharge, settleConcession, concessionInvoiceFigures, concessionSettlementComponents, financialYearOf, nextConcessionInvoiceNumber,
  type ConcessionContract, type ConcessionSale, type ConcessionGstTreatment, type ConcessionInvoiceFigures,
} from '../../../packages/concession/src/index';
import { postJournal as mapToJournal, type PostingMap } from '../../../packages/finance/src/index';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';

export const CONCESSION_SETTLEMENT_KIND = 'concession_settlement';

export interface ConcessionInvoice extends ConcessionInvoiceFigures {
  readonly invoiceId: string;
  readonly number: string;
  readonly financialYear: string;
  readonly contractId: string;
  readonly concessionaireId: string;
  readonly branchId: string;
  readonly from: string;
  readonly to: string;
  readonly issuedOn: string;
  readonly madeBy: string;
  readonly approvedBy: string;
  readonly gstTreatmentVersion: number;
  readonly supply: ConcessionGstTreatment['supply'];
  readonly entryId: string;
  readonly issuedAt: string;
}

export interface ConcessionSettlementJournal extends JournalEntry {
  readonly concessionSettlement: { readonly invoiceId: string; readonly contractId: string; readonly components: Readonly<Record<string, number>> };
}

export interface ConcessionInvoiceDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly contract: (tenantId: string, contractId: string) => Promise<ConcessionContract | undefined> | ConcessionContract | undefined;
  readonly sales: (tenantId: string, contractId: string) => Promise<readonly ConcessionSale[]> | readonly ConcessionSale[];
  readonly postingMap: (tenantId: string) => Promise<PostingMap | undefined> | PostingMap | undefined;
  readonly gstTreatment: (tenantId: string) => Promise<ConcessionGstTreatment | undefined>;
  readonly recordGstTreatment: (tenantId: string, t: ConcessionGstTreatment) => Promise<void>;
  readonly invoices: (tenantId: string) => Promise<readonly ConcessionInvoice[]>;
  /**
   * Take the next number of the series and record the invoice — under the series' guard: `build` is handed the numbers
   * issued so far and returns the invoice; the append lands only while no other issue landed meanwhile (else it is tried
   * again on the newer series). Gap-free and never shared.
   */
  readonly issueInvoice: (tenantId: string, build: (issued: readonly ConcessionInvoice[]) => ConcessionInvoice) => Promise<ConcessionInvoice>;
  readonly settlementJournals: (tenantId: string) => Promise<readonly ConcessionSettlementJournal[]>;
  readonly approvals?: ApprovalPort;
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isBps = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000;
const asLines = (posted: ReturnType<typeof mapToJournal>) =>
  posted.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 }));

export function concessionInvoiceRoutes(deps: ConcessionInvoiceDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'PUT', path: '/v1/concession/gst-treatment',
      permission: 'finance.posting.configure', idempotent: true, entitlement: 'dept.concession',
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isBps(b['rentBps']) || !isBps(b['revenueShareBps']) || !isBps(b['utilitiesBps']) || (b['supply'] !== 'intra_state' && b['supply'] !== 'inter_state')
          || (b['note'] !== undefined && (typeof b['note'] !== 'string' || b['note'].length > 500))) {
          throw apiError(400, { code: 'not_readable_as_a_gst_treatment', whatHappened: 'The GST treatment needs { rentBps, revenueShareBps, utilitiesBps (each 0 to 10000 basis points: 1800 is 18%), supply: "intra_state" | "inter_state", note? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the rates the CA confirmed. Nothing was changed.' });
        }
        const prior = await deps.gstTreatment(ctx.tenantId);
        const t: ConcessionGstTreatment = {
          rentBps: b['rentBps'] as number, revenueShareBps: b['revenueShareBps'] as number, utilitiesBps: b['utilitiesBps'] as number, supply: b['supply'] as ConcessionGstTreatment['supply'],
          version: (prior?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now(), ...(isStr(b['note']) ? { note: (b['note'] as string).trim() } : {}),
        };
        await deps.recordGstTreatment(ctx.tenantId, t);
        return { status: 200, body: { gstTreatment: t } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/concession/gst-treatment',
      permission: 'concession.charge.read', entitlement: 'dept.concession',
      handler: async (ctx) => ({ status: 200, body: { gstTreatment: (await deps.gstTreatment(ctx.tenantId)) ?? null, decidedBy: 'the CA (M27-FR-03: the GST on a concession invoice is the CA\'s to confirm)' } }),
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/concession/contracts/:contractId/invoices/:invoiceId',
      permission: 'concession.contract.manage', idempotent: true, entitlement: 'dept.concession',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const contractId = (ctx.params['contractId'] ?? '').trim();
        const invoiceId = (ctx.params['invoiceId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const metered = b['meteredUtilitiesMinor'];
        if (!/^[A-Za-z0-9._-]{1,60}$/.test(invoiceId) || !isDate(b['from']) || !isDate(b['to']) || (b['to'] as string) < (b['from'] as string)
          || !Number.isInteger(b['bankedForThemMinor']) || (metered !== undefined && (!Number.isInteger(metered) || (metered as number) < 0))) {
          throw apiError(400, { code: 'not_readable_as_a_concession_invoice', whatHappened: 'A concession invoice needs { from, to (YYYY-MM-DD, to not before from), bankedForThemMinor (what the tills banked for this counter, from the day-close), meteredUtilitiesMinor?, approvalId }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the period and the banked figure, with the approval a second person gave. Nothing was issued.' });
        }
        const from = b['from'] as string; const to = b['to'] as string;
        const already = (await deps.invoices(t)).find((i) => i.invoiceId === invoiceId);
        if (already !== undefined) return { status: 200, body: { invoice: already, alreadyIssued: true } };
        const contract = await deps.contract(t, contractId);
        if (contract === undefined) throw notFound(`concession contract ${contractId}`);
        assertBranchInScope(ctx, contract.branchId);
        const overlapping = (await deps.invoices(t)).find((i) => i.contractId === contractId && i.from <= to && from <= i.to);
        if (overlapping !== undefined) {
          throw apiError(409, { code: 'period_already_invoiced', whatHappened: `${overlapping.number} already invoices ${contract.name} for ${overlapping.from} to ${overlapping.to}, which overlaps ${from} to ${to}.`, wasItSaved: 'not_saved', nextSafeAction: 'Invoice the days not yet invoiced; a wrong invoice is put right by a credit note, never by a second invoice. Nothing was issued.' });
        }
        const gst = await deps.gstTreatment(t);
        if (gst === undefined) {
          throw apiError(409, { code: 'concession_gst_not_set', whatHappened: 'The CA has not yet said which GST applies to concession rent, revenue share and utilities, so no invoice can be written — the rate is the CA\'s decision, not the system\'s.', wasItSaved: 'not_saved', nextSafeAction: 'The accountant or CA sets the GST treatment (PUT /v1/concession/gst-treatment), then issue again. Nothing was issued.' });
        }
        const sales = await deps.sales(t, contractId);
        const charge = computePeriodCharge({ contract, sales, from, to, ...(metered === undefined ? {} : { meteredUtilitiesMinor: metered as number }) });
        const settlement = settleConcession({ contract, charge, sales, bankedForThemMinor: b['bankedForThemMinor'] as number });
        if (!settlement.reconciles) {
          throw apiError(409, { code: 'settlement_does_not_reconcile', whatHappened: `The counter rang ${settlement.collectedForThemMinor} and the tills banked ${String(b['bankedForThemMinor'])} for it — a ${Math.abs(settlement.differenceMinor)} difference. An invoice is not written over a difference.`, wasItSaved: 'not_saved', nextSafeAction: 'Find and settle the difference between the tills and the counter, then issue. Nothing was issued.' });
        }
        const figures = concessionInvoiceFigures({ charge, collectedForThemMinor: settlement.collectedForThemMinor, depositHeldMinor: contract.depositMinor, gst });
        // Check the mapping before the approval is spent: a refused posting must not use the approval up.
        const map = await deps.postingMap(t);
        if (map === undefined || map.rules.find((r) => r.kind === CONCESSION_SETTLEMENT_KIND) === undefined) {
          throw apiError(409, { code: `${CONCESSION_SETTLEMENT_KIND}_not_mapped`, whatHappened: 'The ledger mapping has no "concession_settlement" rule, so the settlement cannot be put in the books — which accounts it uses is the accountant\'s decision.', wasItSaved: 'not_saved', nextSafeAction: 'The accountant adds the rule on the Accounts and Tally names page, then issue again. The approval is unused. Nothing was issued.' });
        }
        // §28: one person makes the invoice, ANOTHER approves exactly it (its contract, period and total), in their own session.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: t, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'concession_invoice', subjectRef: `concession-invoice:${invoiceId}`,
          details: actionDetails(ctx.body, { contractId, invoiceId }), valueMinor: figures.invoiceTotalMinor,
          maker: ctx.userId, usedBy: `concession-invoice:${invoiceId}`, now: deps.now(),
        });
        if (opened === undefined) {
          throw apiError(422, { code: 'concession_invoice_needs_approval', whatHappened: 'A concession invoice needs a second person\'s approval (§28), never the maker\'s own.', wasItSaved: 'not_saved', nextSafeAction: `Ask for approval (kind concession_invoice, subject concession-invoice:${invoiceId}, with these details); once approved, send this again with the approvalId. Nothing was issued.` });
        }
        const components = concessionSettlementComponents(figures);
        const entryId = `concession-settlement:${invoiceId}`;
        const mapped = mapToJournal({ id: entryId, kind: CONCESSION_SETTLEMENT_KIND, at: `${to}T00:00:00.000Z`, currency: 'INR', components }, map);
        const states = await deps.periodStates(t);
        const belongsTo = to.slice(0, 7);
        const closed = states.get(belongsTo) === 'closed';
        const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
        await opened.spend();
        const at = deps.now();
        const invoice = await deps.issueInvoice(t, (issued) => {
          const financialYear = financialYearOf(to);
          return {
            ...figures, invoiceId, number: nextConcessionInvoiceNumber(issued.map((i) => i.number), financialYear), financialYear,
            contractId, concessionaireId: contract.concessionaireId, branchId: contract.branchId, from, to, issuedOn: to,
            madeBy: ctx.userId, approvedBy: opened.decision.decidedBy, gstTreatmentVersion: gst.version, supply: gst.supply, entryId, issuedAt: at,
          };
        });
        const journal: ConcessionSettlementJournal = {
          entryId, period, documentDate: to,
          narrative: `Concession settlement ${invoice.number} — ${contract.name} (${contract.concessionaireId}), ${from} to ${to}: held ${figures.collectedForThemMinor}, invoiced ${figures.invoiceTotalMinor}${closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''}`,
          lines: asLines(mapped), postedBy: ctx.userId, concessionSettlement: { invoiceId, contractId, components },
        };
        const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
        if (!gate.ok) throw apiError(422, { code: gate.refusedBecause ?? 'journal_refused', whatHappened: gate.detail, wasItSaved: 'not_saved', nextSafeAction: 'Correct it and send again.' });
        await deps.appendJournal(t, journal);
        return { status: 201, body: { invoice, entryId, period, alreadyIssued: false } };
      },
    },
    {
      // What the period's invoice would say — read only, nothing written, no number taken — so the maker can ask a second
      // person to approve exactly this total. Refuses what the issue would refuse (no GST, tills and counter apart).
      api: 'API-09', method: 'GET', path: '/v1/concession/contracts/:contractId/invoice-preview',
      permission: 'concession.charge.read', entitlement: 'dept.concession',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const contractId = (ctx.params['contractId'] ?? '').trim();
        const from = ctx.query['from']; const to = ctx.query['to']; const banked = ctx.query['bankedForThemMinor']; const metered = ctx.query['meteredUtilitiesMinor'];
        if (!isDate(from) || !isDate(to) || to < from || banked === undefined || !Number.isInteger(Number(banked)) || (metered !== undefined && !(Number.isInteger(Number(metered)) && Number(metered) >= 0))) {
          throw apiError(400, { code: 'invoice_preview_needs_a_period', whatHappened: 'A preview needs ?from=&to=YYYY-MM-DD&bankedForThemMinor= (and optionally meteredUtilitiesMinor).', wasItSaved: 'not_saved', nextSafeAction: 'Send the period and the banked figure. A preview writes nothing.' });
        }
        const contract = await deps.contract(t, contractId);
        if (contract === undefined) throw notFound(`concession contract ${contractId}`);
        assertBranchInScope(ctx, contract.branchId);
        const gst = await deps.gstTreatment(t);
        if (gst === undefined) throw apiError(409, { code: 'concession_gst_not_set', whatHappened: 'The CA has not yet said which GST applies to concession rent, revenue share and utilities.', wasItSaved: 'not_saved', nextSafeAction: 'The accountant or CA sets the GST treatment first.' });
        const sales = await deps.sales(t, contractId);
        const charge = computePeriodCharge({ contract, sales, from, to, ...(metered === undefined ? {} : { meteredUtilitiesMinor: Number(metered) }) });
        const settlement = settleConcession({ contract, charge, sales, bankedForThemMinor: Number(banked) });
        const figures = concessionInvoiceFigures({ charge, collectedForThemMinor: settlement.collectedForThemMinor, depositHeldMinor: contract.depositMinor, gst });
        return { status: 200, body: { contractId, from, to, ...figures, reconciles: settlement.reconciles, differenceMinor: settlement.differenceMinor, gstTreatmentVersion: gst.version, supply: gst.supply, asAt: deps.now() } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/concession/contracts/:contractId/invoices',
      permission: 'concession.charge.read', entitlement: 'dept.concession',
      handler: async (ctx) => {
        const contractId = (ctx.params['contractId'] ?? '').trim();
        const contract = await deps.contract(ctx.tenantId, contractId);
        if (contract === undefined) throw notFound(`concession contract ${contractId}`);
        assertBranchInScope(ctx, contract.branchId);
        const [all, journals, gst] = await Promise.all([deps.invoices(ctx.tenantId), deps.settlementJournals(ctx.tenantId), deps.gstTreatment(ctx.tenantId)]);
        const invoices = all.filter((i) => i.contractId === contractId).sort((a, b) => a.number.localeCompare(b.number));
        // WF-18: each invoice against its settlement journal on the ledger, figure for figure — a missing or differing
        // journal is named, never assumed.
        const reconcile = invoices.map((i) => {
          const j = journals.find((x) => x.concessionSettlement.invoiceId === i.invoiceId);
          const expected = concessionSettlementComponents(i);
          const agrees = j !== undefined && Object.entries(expected).every(([k, v]) => (j.concessionSettlement.components[k] ?? 0) === v);
          return { invoiceId: i.invoiceId, number: i.number, journal: j?.entryId ?? null, period: j?.period ?? null, agrees, detail: j === undefined ? 'no settlement journal on the ledger for this invoice' : agrees ? 'the ledger holds this invoice\'s settlement, figure for figure' : 'the ledger\'s settlement differs from the invoice' };
        });
        return { status: 200, body: { contractId, invoices, reconcile, allAgree: reconcile.every((r) => r.agrees), gstTreatment: gst ?? null, asAt: deps.now() } };
      },
    },
  ];
}
