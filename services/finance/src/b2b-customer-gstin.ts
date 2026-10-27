// OB-416 (owner, option A, 27 Oct 2026, in writing · roadmap v2.1 A5 · M22): the customer's GSTIN on a credit (B2B) account.
// A registered business that buys on credit claims input credit only on an invoice the shop files invoice-by-invoice in
// GSTR-1's B2B section under the buyer's GSTIN. Until now no GSTIN was recorded for a credit customer, so every B2B tax
// invoice filed in the B2C section, rate-wise, and the buyer could claim nothing.
//
//   • `POST /v1/b2b/accounts/:customerId/gstin` — record (or change) the customer's GSTIN and the legal name registered
//     under it, with a reason. Checked for the GSTIN's length, shape and check character (the same validator the store's own
//     GST registration uses) and for its State code. A change is a NEW append-only fact naming who, when, why and the
//     GSTIN it supersedes, written in ONE batch with its audit record. Who may set it: whoever manages B2B accounts
//     (`b2b.account.manage`) — the authority already on the account, no new one.
//   • `GET /v1/b2b/accounts/:customerId/gstin` — the GSTIN in force and every change, oldest first.
//
// A tax invoice takes the GSTIN in force AT THE MOMENT IT IS ISSUED onto the document (`buyer`), and files B2B under it;
// with none, it files B2C as before. An invoice already issued is never changed (OB-415): a later GSTIN applies to later
// invoices only.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { validateGstin, InvalidGstinError } from '../../../packages/org/src/hierarchy';
import { gstStateOf } from '../../../packages/finance/src/gst-states';
import type { B2BAccount } from './b2b-credit';

/** The buyer a B2B tax invoice names — the customer's GSTIN, its registered legal name and its State, as on the day issued. */
export interface B2BInvoiceBuyer {
  readonly gstin: string;
  readonly legalName: string;
  readonly stateCode: string;
  readonly stateName: string;
}

/** One recorded GSTIN fact for a credit customer (append-only; the latest is in force). */
export interface CustomerGstinRecord extends B2BInvoiceBuyer {
  readonly customerId: string;
  readonly reason: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** The GSTIN this one superseded; null for the first. */
  readonly previousGstin: string | null;
}

export type CustomerGstinReading =
  | { readonly ok: true; readonly gstin: string; readonly stateCode: string; readonly stateName: string }
  | { readonly ok: false; readonly code: 'customer_gstin_not_valid' | 'customer_gstin_state_unknown'; readonly why: string };

/**
 * Read a typed GSTIN: trimmed and upper-cased, then 15 characters, the GSTIN pattern and its check character (the store
 * setup's own validator, `validateGstin`), and a first two digits that are a GST State code. Pure.
 */
export function readCustomerGstin(raw: string): CustomerGstinReading {
  let gstin: string;
  try {
    gstin = validateGstin(raw);
  } catch (e) {
    if (e instanceof InvalidGstinError) return { ok: false, code: 'customer_gstin_not_valid', why: e.why };
    throw e;
  }
  const state = gstStateOf(gstin);
  if (state === undefined) {
    return { ok: false, code: 'customer_gstin_state_unknown', why: `its first two digits (${gstin.slice(0, 2)}) are not a GST State code` };
  }
  return { ok: true, gstin, stateCode: state.code, stateName: state.name };
}

export interface B2BCustomerGstinDeps {
  /** The customer's credit account — a GSTIN is recorded on an account that exists. */
  readonly account: (tenantId: string, customerId: string) => Promise<B2BAccount | undefined> | B2BAccount | undefined;
  /** Every GSTIN fact for the customer, oldest first. */
  readonly gstins: (tenantId: string, customerId: string) => Promise<readonly CustomerGstinRecord[]>;
  /**
   * Append the fact and its audit record in ONE batch (both or neither). Resolves the record that stands — `superseded` is
   * the GSTIN fact this one replaced as read inside the write (another person's change in between is named, never lost).
   */
  readonly recordGstin: (tenantId: string, input: { readonly customerId: string; readonly gstin: string; readonly legalName: string; readonly stateCode: string; readonly stateName: string; readonly reason: string; readonly by: string; readonly branchId: string | null }) => Promise<CustomerGstinRecord>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** The buyer a tax invoice issued now names, or undefined when no GSTIN is on record. */
export const buyerOf = (record: CustomerGstinRecord | undefined): B2BInvoiceBuyer | undefined =>
  record === undefined ? undefined : { gstin: record.gstin, legalName: record.legalName, stateCode: record.stateCode, stateName: record.stateName };

export function b2bCustomerGstinRoutes(deps: B2BCustomerGstinDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/b2b/accounts/:customerId/gstin',
      permission: 'b2b.account.manage', idempotent: true,
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = (ctx.params['customerId'] ?? '').trim();
        const b = (ctx.body ?? {}) as { gstin?: unknown; legalName?: unknown; reason?: unknown };
        if (!isStr(b.gstin) || !isStr(b.legalName) || !isStr(b.reason) || b.legalName.trim().length > 200 || b.reason.trim().length > 500) {
          throw apiError(400, {
            code: 'not_readable_as_a_customer_gstin',
            whatHappened: 'Recording a customer\'s GSTIN needs the 15-character GSTIN, the legal name registered under it (up to 200 characters) and the reason (up to 500 characters).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "gstin": …, "legalName": …, "reason": … }. Nothing was recorded.',
          });
        }
        const read = readCustomerGstin(b.gstin);
        if (!read.ok) {
          throw apiError(422, {
            code: read.code,
            whatHappened: `"${b.gstin.trim()}" is not a GSTIN this shop can file under: ${read.why}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Copy the GSTIN exactly from the customer\'s GST registration certificate and send it again. Nothing was recorded; the customer\'s invoices still file as B2C.',
          });
        }
        if (await deps.account(ctx.tenantId, customerId) === undefined) {
          throw notFound(`B2B credit account for ${customerId} (open the credit account first; a GSTIN is recorded on it)`);
        }
        const legalName = b.legalName.trim();
        const history = await deps.gstins(ctx.tenantId, customerId);
        const current = history.at(-1);
        if (current !== undefined && current.gstin === read.gstin && current.legalName === legalName) {
          return { status: 200, body: { ...current, alreadySet: true } };
        }
        const stands = await deps.recordGstin(ctx.tenantId, {
          customerId, gstin: read.gstin, legalName, stateCode: read.stateCode, stateName: read.stateName,
          reason: b.reason.trim(), by: ctx.userId, branchId: ctx.branchId ?? null,
        });
        return { status: 201, body: stands };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/b2b/accounts/:customerId/gstin',
      permission: 'b2b.account.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = (ctx.params['customerId'] ?? '').trim();
        const history = await deps.gstins(ctx.tenantId, customerId);
        const current = history.at(-1);
        return {
          status: 200,
          body: {
            customerId,
            current: current ?? null,
            // P-08: with none on record it is said, with what it means for the return.
            ...(current === undefined ? { files: 'b2c', detail: `No GSTIN is on record for ${customerId}: its tax invoices file in GSTR-1's B2C section, rate-wise.` } : { files: 'b2b', detail: `${customerId}'s tax invoices file invoice-by-invoice in GSTR-1's B2B section under ${current.gstin}.` }),
            history,
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
