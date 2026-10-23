// API-03 Supplier rebates & schemes (M06-FR-03 · D03-FR-03 · M23) — the money the shop has already
// EARNED and not yet collected. A rebate is agreed in a meeting, accrued nowhere, and claimed late or
// never; the gap between what has accrued and what finance has actually received is the number nobody
// tracks. This is the cloud surface that makes it visible:
//
//   • a rebate SCHEME is recorded (basis, rate, threshold, term, approver);
//   • an ACCRUAL is posted for a measured period — the tested `accrueRebate` computes it: nothing
//     accrues below the threshold (and it says how far short); a growth scheme measures against its
//     baseline, never the raw total; and the OUTSTANDING (accrued − received) is the earned-not-claimed
//     figure. Accrual is deliberately separate from receipt (M23) — an accrued rebate is money already
//     made, and reconciling it to what finance received is the whole point.
//
// The rule is the tested `accrueRebate` in `@sre/purchasing` (the `services-run-on-their-tested-engine`
// guardrail); this file is the persistence + HTTP skin. Recording is gated `purchase.contract.manage`;
// reads are `purchase.commitment.read`.
//
// OB-288 P3 (M06-FR-03 acceptance "a rebate accrues and reconciles to finance"): nothing about the money is typed any more.
//   • The BASIS of an accrual is FOLDED from head office's registers for the period the accrual names — a purchase-value
//     (or growth) scheme from the supplier's MATCHED invoices (the taxable value the match let be paid), never a figure in
//     the body. A body that carries a basis, a baseline or a "received" is refused by name.
//   • What has been RECEIVED is finance's: each rebate receipt is a journal (services/finance/src/rebate-receipts.ts), and
//     the outstanding figure here is accrued − what the LEDGER holds.
//   • A VOLUME scheme (OB-334, owner, 23 Oct 2026): its rate is a PERCENTAGE of the value RECEIVED at ORDER cost, from the
//     supplier's matched bills in the period — the received quantity each matched bill accounts for, valued at the order's
//     own unit price (before GST and landed charges). Folded by `volumeBasisFor`; a matched bill whose order cannot be
//     read is named on the accrual as not valued, never counted as nought.

import type { Route } from '../../kernel/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import { apiError, notFound } from '../../kernel/src/index';
import {
  accrueRebate,
  type RebateScheme, type RebateBasis, type RebateAccrual,
} from '../../../packages/purchasing/src/index';
import type { Money } from '../../../packages/contracts/src/money';

export interface RebateDeps {
  /** Head office's maker-checker engine (ADR-0024): a scheme's approver gave it in their own session. Optional on a
   *  bare stub (then a scheme records unapproved); the running system provides it. */
  readonly approvals?: ApprovalPort;
  /** One scheme by id (latest version), or undefined. */
  readonly scheme: (tenantId: string, schemeId: string) => Promise<RebateScheme | undefined> | RebateScheme | undefined;
  /** Every scheme. */
  readonly schemes: (tenantId: string) => Promise<readonly RebateScheme[]> | readonly RebateScheme[];
  /** Every posted accrual for a scheme (latest per accrual id). */
  readonly accruals: (tenantId: string, schemeId: string) => Promise<readonly RebateAccrual[]> | readonly RebateAccrual[];
  /** Record a scheme. Latest per scheme id. */
  readonly recordScheme: (tenantId: string, scheme: RebateScheme) => Promise<void> | void;
  /** Record a posted accrual. Latest per accrual id (a re-measure supersedes). */
  readonly recordAccrual: (tenantId: string, schemeId: string, accrualId: string, accrual: RebateAccrual) => Promise<void> | void;
  /**
   * OB-288 P3: the basis FOLDED from the registers for a period (YYYY-MM-DD, inclusive): the taxable value of the supplier's
   * matched, payable invoices dated in it, and how many bills that is. Absent on a bare stub (then nothing can accrue).
   */
  readonly basisFor?: (tenantId: string, supplierId: string, from: string, to: string) => Promise<{ readonly amountMinor: number; readonly invoices: readonly string[] }>;
  /**
   * OB-334: a VOLUME scheme's basis FOLDED from the registers for a period — the value received at order cost on the
   * supplier's matched, payable bills dated in it, the bills it came from, and any matched bill that could not be valued.
   */
  readonly volumeBasisFor?: (tenantId: string, supplierId: string, from: string, to: string) => Promise<{ readonly amountMinor: number; readonly invoices: readonly string[]; readonly notValued: readonly { readonly invoiceId: string; readonly why: string }[] }>;
  /** OB-288 P3: what finance has RECEIVED for the scheme — from the rebate-receipt journals on the ledger. */
  readonly receivedFor?: (tenantId: string, schemeId: string) => Promise<number>;
  readonly now: () => string;
}

/** A posted accrual as kept: the engine's verdict plus the period it measures and the bills the basis came from. */
export interface StoredRebateAccrual extends RebateAccrual {
  readonly accrualId?: string;
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly basisSources?: { readonly invoices: readonly string[]; readonly baselineInvoices?: readonly string[]; readonly notValued?: readonly { readonly invoiceId: string; readonly why: string }[] };
  /** OB-334: what the basis measures — purchase value paid (taxable), or a volume scheme's value received at order cost. */
  readonly basisMeasure?: 'taxable_value_of_matched_bills' | 'value_received_at_order_cost';
  readonly postedBy?: string;
}

const BASES: readonly RebateBasis[] = ['volume_units', 'purchase_value', 'growth_over_baseline'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Sum a money field across accruals in the scheme's currency (defaulting to INR when empty). */
const sumMinor = (accruals: readonly RebateAccrual[], pick: (a: RebateAccrual) => Money): number =>
  accruals.reduce((s, a) => s + pick(a).minor, 0);

export function rebateRoutes(deps: RebateDeps): readonly Route[] {
  return [
    {
      // Record a rebate scheme. Body: { supplierId, basis, rateBp, thresholdMinor?, startsOn, endsOn,
      // approvalId? }. Latest per scheme id (a renegotiated scheme is a new version, never an overwrite).
      api: 'API-03', method: 'POST', path: '/v1/purchase/rebate-schemes/:schemeId',
      permission: 'purchase.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const schemeId = (ctx.params['schemeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const basis = b['basis'];
        const threshold = b['thresholdMinor'];
        const approvedBy = b['approvedBy'];
        if (schemeId === '' || !isStr(b['supplierId']) || typeof basis !== 'string' || !BASES.includes(basis as RebateBasis)
          || !isNonNegInt(b['rateBp']) || (threshold !== undefined && !isNonNegInt(threshold))
          || !isDate(b['startsOn']) || !isDate(b['endsOn']) || (approvedBy !== undefined && typeof approvedBy !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_rebate_scheme',
            whatHappened: `A rebate scheme needs a schemeId in the path and { supplierId, basis (${BASES.join(' | ')}), rateBp (whole, ≥0), thresholdMinor?, startsOn, endsOn (YYYY-MM-DD), approvalId? } in the body.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the supplier, the basis and rate, and the term.',
          });
        }
        if ((b['endsOn'] as string) < (b['startsOn'] as string)) {
          throw apiError(422, {
            code: 'scheme_ends_before_it_starts',
            whatHappened: `The scheme's end date (${b['endsOn']}) is before its start date (${b['startsOn']}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the term and record again. Nothing was saved.',
          });
        }
        // The scheme's approver (ADR-0024 · 2b-vi-c-1 · audit PA-03): an approval someone who may approve suppliers GAVE in
        // their own session for exactly this scheme (kind `rebate_scheme`). A typed "approved by" is refused by name.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: approvedBy,
          kind: 'rebate_scheme', subjectRef: schemeId, details: actionDetails(ctx.body, { schemeId }), valueMinor: null,
          maker: ctx.userId, usedBy: `rebate-scheme:${schemeId}`, now: deps.now(),
        });
        const scheme: RebateScheme = {
          schemeId,
          supplierId: b['supplierId'] as string,
          basis: basis as RebateBasis,
          rateBp: b['rateBp'] as number,
          ...(isNonNegInt(threshold) ? { thresholdMinor: threshold } : {}),
          startsOn: b['startsOn'] as string,
          endsOn: b['endsOn'] as string,
          ...(opened === undefined ? {} : { approvedBy: opened.decision.decidedBy }),
        };
        await opened?.spend();
        await deps.recordScheme(ctx.tenantId, scheme);
        return { status: 201, body: { scheme } };
      },
    },
    {
      // Post an accrual for a measured period. Body: { periodFrom, periodTo (YYYY-MM-DD, inside the scheme's term),
      // baselineFrom?, baselineTo? (a growth scheme's comparison period) }. The basis is FOLDED from the supplier's matched
      // invoices (OB-288 P3); a typed basis, baseline or "received" is refused. Idempotent on the accrual id — a re-measure supersedes.
      api: 'API-03', method: 'POST', path: '/v1/purchase/rebate-schemes/:schemeId/accruals/:accrualId',
      permission: 'purchase.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const schemeId = (ctx.params['schemeId'] ?? '').trim();
        const accrualId = (ctx.params['accrualId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const typed = ['basisAmount', 'baselineAmount', 'received'].filter((k) => b[k] !== undefined);
        if (typed.length > 0) {
          throw apiError(400, {
            code: 'accrual_carries_caller_claims',
            whatHappened: `This accrual says its own ${typed.join(', ')}. What the supplier was paid for is head office's matched invoices, and what finance received is finance's ledger — never a figure in the request.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send only the period to measure: { periodFrom, periodTo } (and, for a growth scheme, { baselineFrom, baselineTo }). Nothing was saved.',
          });
        }
        if (accrualId === '' || !isDate(b['periodFrom']) || !isDate(b['periodTo'])
          || (b['baselineFrom'] !== undefined && !isDate(b['baselineFrom'])) || (b['baselineTo'] !== undefined && !isDate(b['baselineTo']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_accrual',
            whatHappened: 'An accrual needs an accrualId in the path and { periodFrom, periodTo } (YYYY-MM-DD) in the body; a growth scheme also { baselineFrom, baselineTo }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the period the accrual measures. Nothing was saved.',
          });
        }
        const scheme = await deps.scheme(ctx.tenantId, schemeId);
        if (scheme === undefined) throw notFound(`rebate scheme ${schemeId}`);
        const from = b['periodFrom'] as string;
        const to = b['periodTo'] as string;
        if (to < from || from < scheme.startsOn || to > scheme.endsOn) {
          throw apiError(422, {
            code: 'period_outside_the_scheme',
            whatHappened: `Scheme ${schemeId} runs ${scheme.startsOn} to ${scheme.endsOn}; the period ${from} to ${to} is not inside it (or ends before it starts).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Measure a period inside the scheme\'s term. Nothing was saved.',
          });
        }
        if (scheme.basis === 'growth_over_baseline' && (!isDate(b['baselineFrom']) || !isDate(b['baselineTo']))) {
          throw apiError(422, { code: 'baseline_period_required', whatHappened: 'A growth scheme is measured against a baseline period — send { baselineFrom, baselineTo }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the comparison period. Nothing was saved.' });
        }
        const volume = scheme.basis === 'volume_units';
        if ((volume ? deps.volumeBasisFor : deps.basisFor) === undefined) {
          throw apiError(503, { code: 'rebate_basis_unavailable', whatHappened: 'The matched-invoice register is not wired here, so the basis cannot be folded.', wasItSaved: 'not_saved', nextSafeAction: 'Try again later. Nothing was saved.' });
        }
        // OB-334: a volume scheme earns its percentage on the value RECEIVED at ORDER cost from the matched bills.
        const basis: { amountMinor: number; invoices: readonly string[]; notValued?: readonly { invoiceId: string; why: string }[] } = volume
          ? await deps.volumeBasisFor!(ctx.tenantId, scheme.supplierId, from, to)
          : await deps.basisFor!(ctx.tenantId, scheme.supplierId, from, to);
        const baseline = scheme.basis === 'growth_over_baseline' ? await deps.basisFor!(ctx.tenantId, scheme.supplierId, b['baselineFrom'] as string, b['baselineTo'] as string) : undefined;
        const accrual = accrueRebate({
          scheme,
          basisAmount: { minor: basis.amountMinor, currency: 'INR' },
          ...(baseline === undefined ? {} : { baselineAmount: { minor: baseline.amountMinor, currency: 'INR' } }),
        });
        const stored: StoredRebateAccrual = {
          ...accrual, accrualId, periodFrom: from, periodTo: to, postedBy: ctx.userId,
          basisMeasure: volume ? 'value_received_at_order_cost' : 'taxable_value_of_matched_bills',
          basisSources: {
            invoices: basis.invoices, ...(baseline === undefined ? {} : { baselineInvoices: baseline.invoices }),
            ...(basis.notValued === undefined || basis.notValued.length === 0 ? {} : { notValued: basis.notValued }),
          },
        };
        await deps.recordAccrual(ctx.tenantId, schemeId, accrualId, stored);
        return { status: 201, body: { accrual: stored } };
      },
    },
    {
      // Every scheme (the rebate register).
      api: 'API-03', method: 'GET', path: '/v1/purchase/rebate-schemes',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const schemes = await deps.schemes(ctx.tenantId);
        return { status: 200, body: { schemes, count: schemes.length } };
      },
    },
    {
      // A scheme's accruals and the money EARNED and not yet claimed (total outstanding). 404 if unknown.
      api: 'API-03', method: 'GET', path: '/v1/purchase/rebate-schemes/:schemeId/accruals',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const schemeId = (ctx.params['schemeId'] ?? '').trim();
        const scheme = await deps.scheme(ctx.tenantId, schemeId);
        if (scheme === undefined) throw notFound(`rebate scheme ${schemeId}`);
        const accruals = await deps.accruals(ctx.tenantId, schemeId);
        const accrued = sumMinor(accruals, (a) => a.accrued);
        // OB-288 P3: what finance RECEIVED is the ledger's (rebate-receipt journals), never a figure typed on an accrual.
        const received = deps.receivedFor === undefined ? undefined : await deps.receivedFor(ctx.tenantId, schemeId);
        return {
          status: 200,
          body: {
            accruals,
            count: accruals.length,
            totalAccruedMinor: accrued,
            totalReceivedMinor: received ?? null,
            receivedFrom: received === undefined ? 'not_known' : 'finance_ledger',
            // The headline: earned and not yet collected (M06-FR-03 / M23) — not known when the ledger cannot be read.
            outstandingMinor: received === undefined ? null : accrued - received,
          },
        };
      },
    },
  ];
}
