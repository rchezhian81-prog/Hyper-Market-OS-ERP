// API-09 Reverse charge (R3 · A14 · OB-143 "A" — built SWITCHED OFF) — inward supplies recorded for reverse charge, the
// self-invoice the shop issues to itself from its OWN gap-free series (the A2 allocator, RCM/<FY>/<seq>), and the cash
// payment that alone makes the matching input credit available. On the tested `packages/finance` RCM engine.
//
//   POST /v1/finance/rcm/purchases/:purchaseId        — record an inward supply { supplierId, headCode?, supplyDate,
//                                                       taxableMinor, placeOfSupply, description }. The supplier's GSTIN
//                                                       comes from the supplier master (null = unregistered), never the
//                                                       request. Under a configured head (and only while switched on) a
//                                                       self-invoice is issued in the same atomic write.
//   POST /v1/finance/rcm/purchases/:purchaseId/paid   — the liability paid in CASH { challanRef, paidOn }: the ITC exists
//                                                       from that month. There is no set-off against ITC.
//   GET  /v1/finance/rcm/register?period=MMYYYY       — purchases, self-invoices, payments, the exceptions, and the month's
//                                                       3.1(d) / 4(A)(3) figures.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import {
  decideRcm, reverseChargeForPeriod, parseMonthlyPeriod, InvalidGstPeriod, InvalidRcmInput,
  type RcmControl, type RcmDecision, type RcmPurchase, type RcmSelfInvoice, type RcmPayment, type PlaceOfSupply,
} from '../../../packages/finance/src/index';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const POS: readonly PlaceOfSupply[] = ['intra_state', 'inter_state'];

/** A recorded reverse-charge purchase and what was decided for it, at the time it was recorded. */
export interface RecordedRcmPurchase extends RcmPurchase {
  readonly decision: RcmDecision['kind'];
  readonly decisionDetail: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** The self-invoice number, when one was issued. */
  readonly selfInvoiceNumber?: string;
}

export interface RcmStoreDeps {
  readonly control: (tenantId: string) => Promise<RcmControl>;
  /** The supplier's GSTIN from the supplier master; `undefined` when the supplier is not in the master. */
  readonly supplierGstin: (tenantId: string, supplierId: string) => Promise<{ readonly gstin: string | null } | undefined>;
  readonly purchases: (tenantId: string) => Promise<readonly RecordedRcmPurchase[]>;
  readonly selfInvoices: (tenantId: string) => Promise<readonly RcmSelfInvoice[]>;
  readonly payments: (tenantId: string) => Promise<readonly RcmPayment[]>;
  /**
   * Record the purchase; when `issue` is set, allocate the next self-invoice number from the gap-free series and record
   * the self-invoice IN THE SAME ATOMIC WRITE (guarded, so two at once can never take one number). Answers the number.
   */
  readonly recordPurchase: (tenantId: string, purchase: RecordedRcmPurchase, issue?: { readonly headCode: string; readonly tax: RcmSelfInvoice['tax'] }) => Promise<string | undefined>;
  readonly recordPayment: (tenantId: string, payment: RcmPayment) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const exceptionsOf = (purchases: readonly RecordedRcmPurchase[]) =>
  purchases.filter((p) => p.decision === 'exception').map((p) => ({ purchaseId: p.purchaseId, supplierId: p.supplierId, supplyDate: p.supplyDate, taxableMinor: p.taxableMinor, ...(p.headCode !== undefined ? { headCode: p.headCode } : {}), reason: 'unregistered_supplier_no_head', detail: p.decisionDetail }));

export function rcmRoutes(deps: RcmStoreDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/rcm/purchases/:purchaseId',
      permission: 'finance.rcm.record', idempotent: true,
      handler: async (ctx) => {
        const purchaseId = ctx.params['purchaseId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!ID.test(purchaseId) || typeof b['supplierId'] !== 'string' || b['supplierId'] === '' || typeof b['supplyDate'] !== 'string' || !DATE.test(b['supplyDate'])
          || !Number.isInteger(b['taxableMinor']) || (b['taxableMinor'] as number) <= 0 || !POS.includes(b['placeOfSupply'] as PlaceOfSupply)
          || typeof b['description'] !== 'string' || b['description'].trim() === '' || (b['headCode'] !== undefined && typeof b['headCode'] !== 'string')) {
          throw apiError(400, { code: 'rcm_purchase_needs_fields', whatHappened: 'A reverse-charge purchase needs supplierId, supplyDate (YYYY-MM-DD), taxableMinor (whole paise above 0), placeOfSupply (intra_state / inter_state) and a description; headCode is optional.', wasItSaved: 'not_saved', nextSafeAction: 'Send the named fields.' });
        }
        const existing = (await deps.purchases(ctx.tenantId)).find((p) => p.purchaseId === purchaseId);
        if (existing !== undefined) return { status: 200, body: { purchase: existing, alreadyRecorded: true } };
        const supplier = await deps.supplierGstin(ctx.tenantId, b['supplierId']);
        if (supplier === undefined) {
          throw apiError(422, { code: 'rcm_supplier_unknown', whatHappened: `supplier ${b['supplierId']} is not in the supplier master — whether it is registered (its GSTIN) is read from there, never typed here`, wasItSaved: 'not_saved', nextSafeAction: 'Add the supplier to the supplier master first.' });
        }
        const purchase: RcmPurchase = {
          purchaseId, supplierId: b['supplierId'], supplierGstin: supplier.gstin,
          ...(typeof b['headCode'] === 'string' && b['headCode'] !== '' ? { headCode: b['headCode'] } : {}),
          supplyDate: b['supplyDate'], taxableMinor: b['taxableMinor'] as number, placeOfSupply: b['placeOfSupply'] as PlaceOfSupply, description: b['description'].trim(),
        };
        let decision: RcmDecision;
        try { decision = decideRcm(purchase, await deps.control(ctx.tenantId)); } catch (e) {
          if (e instanceof InvalidRcmInput) throw apiError(422, { code: 'invalid_rcm_purchase', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the purchase and send it again.' });
          throw e;
        }
        const recorded: RecordedRcmPurchase = { ...purchase, decision: decision.kind, decisionDetail: decision.detail, recordedBy: ctx.userId, recordedAt: deps.now() };
        const number = await deps.recordPurchase(ctx.tenantId, recorded, decision.kind === 'self_invoice' ? { headCode: decision.head.headCode, tax: decision.tax } : undefined);
        if (number !== undefined) {
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'gst.rcm.self_invoice.issue', objectType: 'rcm_self_invoice', objectId: number, at: recorded.recordedAt,
            origin: { tenantId: ctx.tenantId, branchId: null }, before: null, after: { purchaseId, headCode: purchase.headCode ?? '', taxableMinor: String(purchase.taxableMinor) }, correlationId: ctx.traceId,
          });
        }
        return { status: 201, body: { purchase: { ...recorded, ...(number !== undefined ? { selfInvoiceNumber: number } : {}) }, decision } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/rcm/purchases/:purchaseId/paid',
      permission: 'finance.rcm.pay', idempotent: true,
      handler: async (ctx) => {
        const purchaseId = ctx.params['purchaseId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['challanRef'] !== 'string' || b['challanRef'].trim() === '' || typeof b['paidOn'] !== 'string' || !DATE.test(b['paidOn'])) {
          throw apiError(400, { code: 'rcm_payment_needs_challan_and_date', whatHappened: 'Marking reverse-charge tax paid needs the cash challan reference (challanRef — CPIN / CIN) and paidOn (YYYY-MM-DD).', wasItSaved: 'not_saved', nextSafeAction: 'Send { challanRef, paidOn }. Reverse-charge tax is paid in cash only.' });
        }
        const purchase = (await deps.purchases(ctx.tenantId)).find((p) => p.purchaseId === purchaseId);
        if (purchase === undefined) throw notFound(`a reverse-charge purchase ${purchaseId}`);
        const invoice = (await deps.selfInvoices(ctx.tenantId)).find((s) => s.purchaseId === purchaseId);
        if (invoice === undefined) {
          throw apiError(409, { code: 'rcm_no_liability', whatHappened: `purchase ${purchaseId} raised no reverse-charge liability (${purchase.decisionDetail}) — there is nothing to pay`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to do for this purchase.' });
        }
        if (b['paidOn'] < invoice.supplyDate) throw apiError(422, { code: 'rcm_paid_before_supply', whatHappened: `paidOn ${b['paidOn']} is before the supply date ${invoice.supplyDate}`, wasItSaved: 'not_saved', nextSafeAction: 'Send the date the challan was paid.' });
        const already = (await deps.payments(ctx.tenantId)).find((p) => p.number === invoice.number);
        if (already !== undefined) return { status: 200, body: { payment: already, alreadyPaid: true } };
        const payment: RcmPayment = { number: invoice.number, challanRef: b['challanRef'].trim(), paidOn: b['paidOn'], paidBy: ctx.userId };
        await deps.recordPayment(ctx.tenantId, payment);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'gst.rcm.liability.paid', objectType: 'rcm_self_invoice', objectId: invoice.number, at: deps.now(),
          origin: { tenantId: ctx.tenantId, branchId: null }, before: null, after: { challanRef: payment.challanRef, paidOn: payment.paidOn }, correlationId: ctx.traceId,
        });
        return { status: 201, body: { payment, itcAvailableFrom: payment.paidOn.slice(0, 7) } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/rcm/register',
      permission: 'finance.rcm.read',
      handler: async (ctx) => {
        const raw = ctx.query['period'];
        let month: { from: string; to: string; fp: string } | undefined;
        if (raw !== undefined) {
          try { month = parseMonthlyPeriod(raw); } catch (e) {
            if (e instanceof InvalidGstPeriod) throw apiError(400, { code: 'gst_period_must_be_a_month', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Send ?period=MMYYYY or omit it.' });
            throw e;
          }
        }
        const control = await deps.control(ctx.tenantId);
        const purchases = await deps.purchases(ctx.tenantId);
        const selfInvoices = await deps.selfInvoices(ctx.tenantId);
        const payments = await deps.payments(ctx.tenantId);
        const inMonth = <T extends { supplyDate: string }>(xs: readonly T[]): readonly T[] => (month === undefined ? xs : xs.filter((x) => x.supplyDate >= month!.from && x.supplyDate <= month!.to));
        return {
          status: 200,
          body: {
            switchedOn: control.switchedOn, headCount: control.heads.length,
            purchases: inMonth(purchases), selfInvoices: inMonth(selfInvoices), payments,
            exceptions: exceptionsOf(inMonth(purchases)),
            ...(month !== undefined ? { period: month.fp, ...reverseChargeForPeriod({ from: month.from, to: month.to, selfInvoices, payments }) } : {}),
          },
        };
      },
    },
  ];
}
