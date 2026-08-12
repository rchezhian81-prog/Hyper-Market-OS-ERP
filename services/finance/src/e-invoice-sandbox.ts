// API-09 GST e-invoicing — the SANDBOX GSP register route (A20, owner directive §2), on the tested
// `packages/e-invoice` sandbox provider. It runs a canonical IRP request through the deterministic sandbox
// and returns both the simulated IRP answer and the record `applyIrpResult` would store — so the whole
// submit → register → apply loop can be driven and demonstrated WITHOUT a live, credentialed GSP.
//
//   • `POST /v1/finance/e-invoice/sandbox/register` — body { invoiceId, request: IrnRequest, force? }.
//
// This is a bring-up / testing tool: the IRN it returns is a hash of the invoice's identity and the signed
// QR is `SANDBOX.`-prefixed — never a value any government portal issued, and never valid for a real
// filing. Production points the same `EInvoiceProvider` port at a certified GSP (credentials from a vault),
// behind the e-invoicing feature flag. Gated `finance.einvoice.generate`, the same permission as the real
// e-invoice routes; writes nothing (idempotent).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  sandboxGspProvider, registerViaProvider,
  type IrnRequest, type SandboxGspOptions, type EInvoiceDocType,
} from '../../../packages/e-invoice/src/index';

const DOCTYPES: readonly EInvoiceDocType[] = ['INV', 'CRN', 'DBN'];
const FORCE: readonly NonNullable<SandboxGspOptions['forceOutcome']>[] = ['registered', 'unknown', 'rejected'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Is `r` a well-formed canonical IRP request? (The build step produces these; the sandbox re-checks.) */
function readRequest(r: Record<string, unknown>): IrnRequest | undefined {
  if (
    typeof r['supplierGstin'] !== 'string' || !DOCTYPES.includes(r['documentType'] as EInvoiceDocType) ||
    typeof r['documentNumber'] !== 'string' || typeof r['documentDate'] !== 'string' ||
    typeof r['financialYear'] !== 'string' || typeof r['taxableMinor'] !== 'number'
  ) return undefined;
  return {
    supplierGstin: r['supplierGstin'],
    documentType: r['documentType'] as EInvoiceDocType,
    documentNumber: r['documentNumber'],
    documentDate: r['documentDate'],
    financialYear: r['financialYear'],
    ...(typeof r['recipientGstin'] === 'string' ? { recipientGstin: r['recipientGstin'] } : {}),
    taxableMinor: r['taxableMinor'],
  };
}

export function eInvoiceSandboxRoutes(): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/e-invoice/sandbox/register',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const request = isObj(b['request']) ? readRequest(b['request']) : undefined;
        if (typeof b['invoiceId'] !== 'string' || request === undefined) {
          throw apiError(400, { code: 'sandbox_needs_invoiceid_and_request', whatHappened: 'The sandbox register needs invoiceId and a canonical request (supplierGstin, documentType INV/CRN/DBN, documentNumber, documentDate, financialYear, taxableMinor).', wasItSaved: 'not_saved', nextSafeAction: 'Send the invoice id and the request the build step produced.' });
        }
        const force = b['force'];
        if (force !== undefined && !FORCE.includes(force as NonNullable<SandboxGspOptions['forceOutcome']>)) {
          throw apiError(400, { code: 'sandbox_bad_force', whatHappened: `force must be one of: ${FORCE.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Omit force for the natural outcome, or send a valid value to simulate a timeout/rejection.' });
        }
        const provider = sandboxGspProvider(force !== undefined ? { forceOutcome: force as NonNullable<SandboxGspOptions['forceOutcome']> } : {});
        const outcome = await registerViaProvider({ invoiceId: b['invoiceId'], request, provider });
        return { status: 200, body: { sandbox: true, ...outcome } };
      },
    },
  ];
}
