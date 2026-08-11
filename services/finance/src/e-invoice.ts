// API-09 GST e-invoicing (A20) — the deterministic core on the live API, run on the tested
// `packages/e-invoice` engine. Three steps a caller takes before (and around) a real IRP submission:
//
//   • `POST /v1/finance/e-invoice/eligibility` — is an IRN mandatory for this document? (₹5-crore-gated,
//     B2C-excluded), so a B2C till receipt is never needlessly sent to the portal.
//   • `POST /v1/finance/e-invoice/build` — assemble the canonical IRP request from an assembled tax
//     invoice, refusing to send a Rule-46-invalid invoice (it would be rejected at the IRP anyway), and
//     returning the IRP's own idempotency key (supplier GSTIN + doc type + number + FY).
//   • `POST /v1/finance/e-invoice/apply-irp-result` — turn whatever the IRP actually answered into the
//     record to store, NEVER fabricating an IRN or QR it did not return, and keeping an `unknown` answer
//     as its own state rather than a silent success.
//
// The live submission to a certified GSP/IRP (the network call, its credentials from a vault, and the
// event-sourced IRN store) is the next increment plus a deployment adapter — the same shape as the
// payment-reversal provider. This increment lands everything deterministic and testable.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  assessEInvoiceEligibility, buildIrnRequest, applyIrpResult,
  type SupplyType, type EInvoiceDocType, type IrpResult,
} from '../../../packages/e-invoice/src/index';
import type { TaxInvoiceFields } from '../../../packages/finance/src/index';

const SUPPLY: readonly SupplyType[] = ['b2b', 'b2c', 'export', 'sez', 'deemed_export'];
const DOCTYPES: readonly EInvoiceDocType[] = ['INV', 'CRN', 'DBN'];
const STATUSES = ['registered', 'duplicate', 'rejected', 'unknown'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function eInvoiceRoutes(): readonly Route[] {
  return [
    {
      // Is an IRN mandatory here? A read/decision modelled as POST — idempotent, writes nothing.
      api: 'API-09', method: 'POST', path: '/v1/finance/e-invoice/eligibility',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!Number.isInteger(b['annualTurnoverMinor']) || !SUPPLY.includes(b['supplyType'] as SupplyType) || !DOCTYPES.includes(b['documentType'] as EInvoiceDocType)) {
          throw apiError(400, { code: 'eligibility_needs_turnover_supply_doctype', whatHappened: 'E-invoice eligibility needs annualTurnoverMinor (integer), supplyType (b2b/b2c/export/sez/deemed_export) and documentType (INV/CRN/DBN).', wasItSaved: 'not_saved', nextSafeAction: 'Send the shop’s turnover, the supply type and the document type.' });
        }
        return { status: 200, body: assessEInvoiceEligibility({
          annualTurnoverMinor: b['annualTurnoverMinor'] as number,
          supplyType: b['supplyType'] as SupplyType,
          ...(typeof b['recipientGstin'] === 'string' ? { recipientGstin: b['recipientGstin'] } : {}),
          documentType: b['documentType'] as EInvoiceDocType,
        }) };
      },
    },
    {
      // Build the IRP request from an assembled invoice — refuses a Rule-46-invalid one.
      api: 'API-09', method: 'POST', path: '/v1/finance/e-invoice/build',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isObj(b['invoice']) || !Number.isInteger(b['annualTurnoverMinor']) || !SUPPLY.includes(b['supplyType'] as SupplyType) || !DOCTYPES.includes(b['documentType'] as EInvoiceDocType)) {
          throw apiError(400, { code: 'build_needs_invoice_turnover_supply_doctype', whatHappened: 'Building an IRP request needs the assembled invoice, annualTurnoverMinor, supplyType and documentType.', wasItSaved: 'not_saved', nextSafeAction: 'Send the invoice fields plus turnover, supply type and document type.' });
        }
        const recipientGstin = typeof b['recipientGstin'] === 'string' ? (b['recipientGstin'] as string) : undefined;
        const eligibility = assessEInvoiceEligibility({
          annualTurnoverMinor: b['annualTurnoverMinor'] as number,
          supplyType: b['supplyType'] as SupplyType,
          ...(recipientGstin !== undefined ? { recipientGstin } : {}),
          documentType: b['documentType'] as EInvoiceDocType,
        });
        const result = buildIrnRequest({
          invoice: b['invoice'] as TaxInvoiceFields,
          eligibility,
          documentType: b['documentType'] as EInvoiceDocType,
          ...(recipientGstin !== undefined ? { recipientGstin } : {}),
        });
        if (result.outcome === 'invalid_invoice') {
          throw apiError(422, { code: 'invalid_invoice', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Fix the named Rule 46 fields and rebuild — a malformed invoice must not be sent to the IRP.' });
        }
        return { status: 200, body: result };
      },
    },
    {
      // Turn the IRP's answer into the record to store — never fabricating a signature we did not receive.
      api: 'API-09', method: 'POST', path: '/v1/finance/e-invoice/apply-irp-result',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const result = b['result'];
        if (typeof b['invoiceId'] !== 'string' || !isObj(result) || !STATUSES.includes(result['status'] as typeof STATUSES[number]) || (result['status'] === 'rejected' && !Array.isArray(result['errors']))) {
          throw apiError(400, { code: 'apply_needs_invoiceid_and_irp_result', whatHappened: 'Applying an IRP answer needs invoiceId and a result with a status (registered/duplicate/rejected/unknown; a rejected result needs errors[]).', wasItSaved: 'not_saved', nextSafeAction: 'Send the invoice id and the IRP’s raw response.' });
        }
        return { status: 200, body: applyIrpResult({ invoiceId: b['invoiceId'], result: result as unknown as IrpResult }) };
      },
    },
  ];
}
