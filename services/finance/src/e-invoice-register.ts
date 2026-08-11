// API-09 GST e-invoicing — the durable lifecycle store (A20 inc2), on the tested `packages/e-invoice`
// engine. The API is the store of record for each invoice's e-invoice state; a credentialed GSP connector
// (the deployment step) reads submitted invoices, calls the IRP, and posts the answer back here.
//
//   • `POST …/invoices/:id/submit`          — record the intent + the canonical IRP request (idempotent
//                                              per invoice; refuses B2C/not-required and a Rule-46-invalid
//                                              invoice before anything is stored).
//   • `POST …/invoices/:id/record-response`  — apply the IRP's answer and store it; a `registered` invoice
//                                              is FINAL (a later response cannot change its IRN), an
//                                              `unknown` answer stays retryable, a re-posted answer collapses.
//   • `POST …/invoices/:id/cancel`           — cancel a registered IRN within 24 hours (a credit note after).
//   • `GET  …/invoices/:id`                  — the current folded state.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  assessEInvoiceEligibility, buildIrnRequest, applyIrpResult, assessCancellation,
  type SupplyType, type EInvoiceDocType, type IrpResult, type IrnRequest, type EInvoiceRecord, type EInvoiceAggregate,
} from '../../../packages/e-invoice/src/index';
import type { TaxInvoiceFields } from '../../../packages/finance/src/index';

const SUPPLY: readonly SupplyType[] = ['b2b', 'b2c', 'export', 'sez', 'deemed_export'];
const DOCTYPES: readonly EInvoiceDocType[] = ['INV', 'CRN', 'DBN'];
const STATUSES = ['registered', 'duplicate', 'rejected', 'unknown'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export interface EInvoiceRegisterDeps {
  readonly load: (tenantId: string, invoiceId: string) => Promise<EInvoiceAggregate | undefined> | EInvoiceAggregate | undefined;
  readonly recordSubmit: (tenantId: string, invoiceId: string, request: IrnRequest, at: string) => Promise<void> | void;
  readonly recordResponse: (tenantId: string, invoiceId: string, record: EInvoiceRecord, at: string) => Promise<void> | void;
  readonly recordCancel: (tenantId: string, invoiceId: string, reason: string, at: string) => Promise<void> | void;
  readonly now: () => string;
}

export function eInvoiceRegisterRoutes(deps: EInvoiceRegisterDeps): readonly Route[] {
  return [
    {
      // Record the intent to e-invoice this document, with the canonical IRP request. Idempotent per invoice.
      api: 'API-09', method: 'POST', path: '/v1/finance/e-invoice/invoices/:invoiceId/submit',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const invoiceId = ctx.params['invoiceId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isObj(b['invoice']) || !Number.isInteger(b['annualTurnoverMinor']) || !SUPPLY.includes(b['supplyType'] as SupplyType) || !DOCTYPES.includes(b['documentType'] as EInvoiceDocType)) {
          throw apiError(400, { code: 'submit_needs_invoice_turnover_supply_doctype', whatHappened: 'Submitting for e-invoicing needs the assembled invoice, annualTurnoverMinor, supplyType and documentType.', wasItSaved: 'not_saved', nextSafeAction: 'Send the invoice fields plus turnover, supply type and document type.' });
        }
        const recipientGstin = typeof b['recipientGstin'] === 'string' ? (b['recipientGstin'] as string) : undefined;
        const eligibility = assessEInvoiceEligibility({
          annualTurnoverMinor: b['annualTurnoverMinor'] as number,
          supplyType: b['supplyType'] as SupplyType,
          ...(recipientGstin !== undefined ? { recipientGstin } : {}),
          documentType: b['documentType'] as EInvoiceDocType,
        });
        if (!eligibility.required) {
          return { status: 200, body: { invoiceId, required: false, reason: eligibility.reason, detail: eligibility.detail } };
        }
        const existing = await deps.load(ctx.tenantId, invoiceId);
        if (existing !== undefined) {
          // Already in the lifecycle — a re-submit does not start a second registration.
          return { status: 200, body: { invoiceId, alreadyInLifecycle: true, state: existing.state, detail: existing.detail } };
        }
        const built = buildIrnRequest({
          invoice: b['invoice'] as TaxInvoiceFields,
          eligibility,
          documentType: b['documentType'] as EInvoiceDocType,
          ...(recipientGstin !== undefined ? { recipientGstin } : {}),
        });
        if (!built.built || built.request === undefined) {
          throw apiError(422, { code: 'invalid_invoice', whatHappened: built.detail, wasItSaved: 'not_saved', nextSafeAction: 'Fix the named Rule 46 fields and submit again — a malformed invoice must not be sent to the IRP.' });
        }
        await deps.recordSubmit(ctx.tenantId, invoiceId, built.request, deps.now());
        return { status: 201, body: { invoiceId, state: 'submitted', idempotencyKey: built.idempotencyKey } };
      },
    },
    {
      // The GSP connector posts the IRP's answer back here. Registered is final; unknown stays retryable.
      api: 'API-09', method: 'POST', path: '/v1/finance/e-invoice/invoices/:invoiceId/record-response',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const invoiceId = ctx.params['invoiceId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const result = b['result'];
        if (!isObj(result) || !STATUSES.includes(result['status'] as typeof STATUSES[number]) || (result['status'] === 'rejected' && !Array.isArray(result['errors']))) {
          throw apiError(400, { code: 'record_needs_irp_result', whatHappened: 'Recording a response needs result.status (registered/duplicate/rejected/unknown; a rejected result needs errors[]).', wasItSaved: 'not_saved', nextSafeAction: 'Send the IRP’s raw response under "result".' });
        }
        const existing = await deps.load(ctx.tenantId, invoiceId);
        if (existing === undefined) throw notFound(`a submitted e-invoice for ${invoiceId}`);
        if (existing.state === 'registered' || existing.state === 'cancelled') {
          // Final — a re-posted answer does not change or un-set a registered IRN.
          return { status: 200, body: existing };
        }
        const record = applyIrpResult({ invoiceId, result: result as unknown as IrpResult });
        const at = typeof b['at'] === 'string' ? (b['at'] as string) : deps.now();
        await deps.recordResponse(ctx.tenantId, invoiceId, record, at);
        const updated = await deps.load(ctx.tenantId, invoiceId);
        return { status: 200, body: updated ?? record };
      },
    },
    {
      // Cancel a registered IRN — only within the 24-hour window, else a credit note is the route.
      api: 'API-09', method: 'POST', path: '/v1/finance/e-invoice/invoices/:invoiceId/cancel',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const invoiceId = ctx.params['invoiceId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['reason'] !== 'string' || b['reason'].trim() === '') {
          throw apiError(400, { code: 'cancel_needs_reason', whatHappened: 'Cancelling an IRN needs a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Send a reason for the cancellation.' });
        }
        const existing = await deps.load(ctx.tenantId, invoiceId);
        if (existing === undefined) throw notFound(`an e-invoice for ${invoiceId}`);
        if (existing.state === 'cancelled') return { status: 200, body: existing }; // idempotent
        if (existing.state !== 'registered' || existing.registeredAt === undefined) {
          throw apiError(422, { code: 'not_registered', whatHappened: `only a registered IRN can be cancelled — this invoice is ${existing.state}`, wasItSaved: 'not_saved', nextSafeAction: 'There is no IRN to cancel.' });
        }
        const at = deps.now();
        const check = assessCancellation({ registeredAt: existing.registeredAt, at });
        if (!check.cancellable) {
          throw apiError(422, { code: 'cancel_window_closed', whatHappened: check.reason, wasItSaved: 'not_saved', nextSafeAction: 'Issue a credit note (CRN) against this invoice instead of cancelling the IRN.' });
        }
        await deps.recordCancel(ctx.tenantId, invoiceId, b['reason'], at);
        return { status: 200, body: { invoiceId, state: 'cancelled', detail: `cancelled: ${b['reason']}` } };
      },
    },
    {
      // The current folded e-invoice state for a document.
      api: 'API-09', method: 'GET', path: '/v1/finance/e-invoice/invoices/:invoiceId',
      permission: 'finance.einvoice.read',
      handler: async (ctx) => {
        const invoiceId = ctx.params['invoiceId'] ?? '';
        const agg = await deps.load(ctx.tenantId, invoiceId);
        if (agg === undefined) throw notFound(`an e-invoice for ${invoiceId}`);
        return { status: 200, body: agg };
      },
    },
  ];
}
