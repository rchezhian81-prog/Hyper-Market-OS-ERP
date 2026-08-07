// API-09 B2B credit control (M22-FR-01) — sell to businesses on terms, safely. A business customer
// has a CREDIT LIMIT and a running AR balance (invoices raised, payments received). An order that
// would push the balance past the limit is BLOCKED pending a separate approver (§28) — never a silent
// override — and an expired contract blocks per policy. The rule is the pure `checkCredit` in
// `packages/b2b` (another complete engine nothing fed); the outstanding balance is projected from
// append-only receivable movements, never stored. B2B credit is evaluated online on fresh data (§31).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { checkCredit, type CreditVerdict } from '../../../packages/b2b/src/credit';
import type { CurrencyCode } from '../../../packages/contracts/src/money';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';

export type ReceivableKind = 'invoice' | 'payment' | 'credit_note';

const CURRENCIES: readonly CurrencyCode[] = ['INR', 'USD', 'EUR', 'GBP'];
const asCurrency = (v: unknown): CurrencyCode => (typeof v === 'string' && (CURRENCIES as readonly string[]).includes(v)) ? v as CurrencyCode : 'INR';

/** A B2B account's credit terms, as last set. */
export interface B2BAccount {
  readonly creditLimitMinor: number;
  readonly currency: CurrencyCode;
}

/** An AR movement — an invoice adds to what is owed, a payment or credit note reduces it. */
export interface RecordedReceivable {
  readonly movementId: string;
  readonly customerId: string;
  readonly kind: ReceivableKind;
  readonly deltaMinor: number;
  readonly at: string;
  readonly ref: string | null;
}

export interface B2BCreditDeps {
  readonly account: (tenantId: string, customerId: string) => Promise<B2BAccount | undefined> | B2BAccount | undefined;
  readonly outstandingMinor: (tenantId: string, customerId: string) => Promise<number> | number;
  readonly recordAccount: (tenantId: string, customerId: string, creditLimitMinor: number, currency: CurrencyCode, at: string) => Promise<void> | void;
  readonly recordReceivable: (tenantId: string, customerId: string, m: RecordedReceivable) => Promise<void> | void;
  readonly now: () => string;
}

const money = (minor: number, currency: CurrencyCode) => ({ minor, currency });

export function b2bCreditRoutes(deps: B2BCreditDeps): readonly Route[] {
  return [
    {
      // Set (or change) a customer's credit limit. Append-only: a new limit is a new fact, the latest
      // one applies; re-setting the same limit collapses.
      api: 'API-09', method: 'POST', path: '/v1/b2b/accounts/:customerId',
      permission: 'b2b.account.manage', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const b = (ctx.body ?? {}) as { creditLimitMinor?: unknown; currency?: unknown };
        if (!Number.isInteger(b.creditLimitMinor) || (b.creditLimitMinor as number) < 0) {
          throw apiError(400, {
            code: 'not_readable_as_an_account',
            whatHappened: 'A B2B account needs a whole, non-negative credit limit in minor units.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "creditLimitMinor": … }. Nothing was set.',
          });
        }
        const currency = asCurrency(b.currency);
        await deps.recordAccount(ctx.tenantId, customerId, b.creditLimitMinor as number, currency, deps.now());
        return { status: 201, body: { customerId, creditLimitMinor: b.creditLimitMinor, currency } };
      },
    },
    {
      // Record an AR movement: an invoice raised (owed goes up) or a payment/credit note (goes down).
      api: 'API-09', method: 'POST', path: '/v1/b2b/accounts/:customerId/receivables',
      permission: 'b2b.receivable.record', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const b = (ctx.body ?? {}) as { movementId?: unknown; kind?: unknown; amountMinor?: unknown; ref?: unknown };
        const kinds: readonly ReceivableKind[] = ['invoice', 'payment', 'credit_note'];
        if (typeof b.movementId !== 'string' || b.movementId.trim() === ''
          || typeof b.kind !== 'string' || !kinds.includes(b.kind as ReceivableKind)
          || !Number.isInteger(b.amountMinor) || (b.amountMinor as number) <= 0) {
          throw apiError(400, {
            code: 'not_readable_as_a_receivable',
            whatHappened: 'A receivable needs a movement id, a kind (invoice, payment or credit_note) and a positive amount.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the movement id, kind and amount. Nothing was recorded.',
          });
        }
        const amount = b.amountMinor as number;
        const deltaMinor = (b.kind as ReceivableKind) === 'invoice' ? amount : -amount;
        await deps.recordReceivable(ctx.tenantId, customerId, {
          movementId: b.movementId, customerId, kind: b.kind as ReceivableKind, deltaMinor,
          at: deps.now(), ref: typeof b.ref === 'string' ? b.ref : null,
        });
        return { status: 201, body: { customerId, movementId: b.movementId, kind: b.kind, deltaMinor } };
      },
    },
    {
      // Check a proposed order against the customer's limit and contract. An over-limit order (or a
      // blocked expired contract) may proceed only with a separate approver (§28) — the decision says
      // so; it does not silently override.
      api: 'API-09', method: 'POST', path: '/v1/b2b/accounts/:customerId/credit-check',
      permission: 'b2b.credit.check', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const b = (ctx.body ?? {}) as { orderId?: unknown; orderValueMinor?: unknown; contractExpired?: unknown; contractPolicy?: unknown; approvedBy?: unknown; reason?: unknown };
        if (typeof b.orderId !== 'string' || b.orderId.trim() === '' || !Number.isInteger(b.orderValueMinor) || (b.orderValueMinor as number) < 0) {
          throw apiError(400, {
            code: 'not_readable_as_a_credit_check',
            whatHappened: 'A credit check needs an order id and a whole, non-negative order value in minor units.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the order id and value. Nothing was changed; a credit check reads, it never writes.',
          });
        }

        const account = await deps.account(ctx.tenantId, customerId);
        if (account === undefined) throw notFound(`B2B account for ${customerId}`);
        const outstanding = await deps.outstandingMinor(ctx.tenantId, customerId);

        const approval: DecidedRequest | undefined = typeof b.approvedBy === 'string' && b.approvedBy.trim() !== ''
          ? {
            id: `credit-approval-${b.orderId}`, subjectType: 'b2b_credit', subjectRef: b.orderId,
            requestedBy: ctx.userId, branchId: null, value: money(b.orderValueMinor as number, account.currency),
            status: 'approved', decidedBy: b.approvedBy, reason: typeof b.reason === 'string' ? b.reason : 'credit override',
            decidedAt: deps.now(),
          }
          : undefined;

        const decision = checkCredit({
          id: b.orderId, customerId, takenBy: ctx.userId,
          creditLimit: money(account.creditLimitMinor, account.currency),
          outstanding: money(outstanding, account.currency),
          orderValue: money(b.orderValueMinor as number, account.currency),
          ...(b.contractExpired === true ? { contractExpired: true } : {}),
          ...(b.contractPolicy === 'fallback' ? { contractPolicy: 'fallback' as const } : {}),
          ...(approval === undefined ? {} : { approval }),
        });

        return {
          status: 200,
          body: {
            orderId: b.orderId, customerId, verdict: decision.verdict satisfies CreditVerdict,
            allowed: decision.allowed, requiresApproval: decision.requiresApproval,
            availableCreditMinor: decision.availableCredit.minor, outstandingMinor: outstanding,
          },
        };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/b2b/accounts/:customerId',
      permission: 'b2b.account.read',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const account = await deps.account(ctx.tenantId, customerId);
        if (account === undefined) throw notFound(`B2B account for ${customerId}`);
        const outstanding = await deps.outstandingMinor(ctx.tenantId, customerId);
        return {
          status: 200,
          body: { customerId, creditLimitMinor: account.creditLimitMinor, currency: account.currency, outstandingMinor: outstanding, availableCreditMinor: account.creditLimitMinor - outstanding, asAt: deps.now() },
        };
      },
    },
  ];
}
