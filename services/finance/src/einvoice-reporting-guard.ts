// API-09 The 30-day e-invoice reporting guard (R3 · A21 · OB-149 "A" — SWITCHED OFF). On the tested `packages/finance`
// guard engine.
//
//   • At the e-invoice submit boundary (`services/finance/src/e-invoice-register.ts`, through its optional
//     `reportingGuard` dependency): while the guard is ON, a B2B invoice or credit/debit note dated more than 30 days
//     before it is reported is REFUSED and recorded as an exception. While it is OFF, nothing is blocked.
//   • GET /v1/finance/e-invoice/reporting-guard — the guard's state (shown on the GST page) and, while on, every
//     exception: documents refused at submit, and documents submitted but not registered at the portal within 30 days.

import type { Route } from '../../kernel/src/index';
import { judgeEInvoiceReporting, EINVOICE_REPORTING_WINDOW_DAYS, type EInvoiceReportingDocType } from '../../../packages/finance/src/index';

/** A document the guard refused, recorded so it stays on the exception list (hard rule #6). */
export interface EInvoiceReportingBlock {
  readonly invoiceId: string;
  readonly documentType: EInvoiceReportingDocType;
  readonly documentNumber: string;
  readonly documentDate: string;
  readonly blockedOn: string;
  readonly detail: string;
}

/** A document in the e-invoice lifecycle, as the guard reads it. */
export interface EInvoiceLifecycleRow {
  readonly invoiceId: string;
  readonly state: string;
  readonly documentType: EInvoiceReportingDocType;
  readonly documentNumber: string;
  readonly documentDate: string;
}

export interface EInvoiceGuardDeps {
  readonly switchedOn: (tenantId: string) => Promise<boolean>;
  readonly today: (tenantId: string) => Promise<string>;
  readonly blocks: (tenantId: string) => Promise<readonly EInvoiceReportingBlock[]>;
  readonly recordBlock: (tenantId: string, block: EInvoiceReportingBlock) => Promise<void>;
  /** Every document in the e-invoice lifecycle. */
  readonly lifecycle: (tenantId: string) => Promise<readonly EInvoiceLifecycleRow[]>;
  readonly now: () => string;
}

/** The guard the e-invoice submit route consults. Records a refusal before answering it. */
export function eInvoiceReportingGuard(deps: EInvoiceGuardDeps) {
  return async (tenantId: string, doc: { readonly invoiceId: string; readonly documentType: EInvoiceReportingDocType; readonly documentNumber: string; readonly documentDate: string }): Promise<{ readonly blocked: boolean; readonly detail: string }> => {
    const today = await deps.today(tenantId);
    const decision = judgeEInvoiceReporting({ switchedOn: await deps.switchedOn(tenantId), documentDate: doc.documentDate, today, documentType: doc.documentType });
    if (decision.blocked) {
      await deps.recordBlock(tenantId, { ...doc, blockedOn: today, detail: decision.detail });
    }
    return { blocked: decision.blocked, detail: decision.detail };
  };
}

export function eInvoiceGuardRoutes(deps: EInvoiceGuardDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/e-invoice/reporting-guard',
      permission: 'finance.gstr.read',
      handler: async (ctx) => {
        const switchedOn = await deps.switchedOn(ctx.tenantId);
        const today = await deps.today(ctx.tenantId);
        const blocks = await deps.blocks(ctx.tenantId);
        const late = switchedOn
          ? (await deps.lifecycle(ctx.tenantId))
            .filter((r) => r.state !== 'registered' && r.state !== 'cancelled' && judgeEInvoiceReporting({ switchedOn: true, documentDate: r.documentDate, today, documentType: r.documentType }).blocked)
            .map((r) => ({ ...r, detail: `submitted but not registered at the portal, and now past the ${EINVOICE_REPORTING_WINDOW_DAYS}-day window` }))
          : [];
        return {
          status: 200,
          body: {
            switchedOn, windowDays: EINVOICE_REPORTING_WINDOW_DAYS, today,
            said: switchedOn
              ? `ON — a B2B invoice or credit/debit note not reported within ${EINVOICE_REPORTING_WINDOW_DAYS} days is blocked`
              : `SWITCHED OFF (OB-149) — it applies at ₹10 crore turnover; nothing is blocked`,
            exceptions: { blockedAtSubmit: blocks, notRegisteredInWindow: late },
          },
        };
      },
    },
  ];
}
