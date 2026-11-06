// API-09 salesperson commission (M22-FR-03) — what a salesperson has EARNED, recorded exactly and
// read as a running total, never a stored balance. A commission is a basis-points rate applied to a
// commissionable base with an optional cap; the sum owed to a person is PROJECTED from the accruals,
// never overwritten (hard rule #2). The rate is the pure `computeCommission` engine in `packages/b2b`
// (exact money, no float) — this surface gives it persistence, an authorization split and a read.
//
// W4 (M22-FR-03): commission is only ever DERIVED. The rate is a rule one person proposed and a different person approved;
// the base is the taxable value of the tax invoice head office issued for an order attributed to the salesperson, once per
// invoice (`accrueFromInvoice` below). The old manual accrual — a typed base and rate from whoever called — is RETIRED: its
// route only refuses, by name, naming the invoice-derived path, and records nothing. Accruals recorded before that stay on
// the salesperson's stream and are read exactly as before (append-only). A manager may read what the floor has earned; a
// cashier may do neither.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { computeCommission } from '../../../packages/b2b/src/commission';
import type { CurrencyCode } from '../../../packages/contracts/src/money';

/** One recorded commission — the base it was earned on, the rate, and the exact amount. */
export interface CommissionAccrual {
  readonly accrualId: string;
  readonly salespersonId: string;
  /** The commissionable base the rate was applied to, minor units (the invoice's taxable value). */
  readonly baseMinor: number;
  /** Basis points, 0–10000 (1000 = 10%). */
  readonly rateBps: number;
  /** An optional payout cap, minor units. Null means uncapped. */
  readonly capMinor: number | null;
  /** The exact commission, computed by the engine and rounded half-up. */
  readonly commissionMinor: number;
  readonly currency: CurrencyCode;
  /** What it was earned against — the invoice and the rule (older, retired manual accruals: free text). */
  readonly ref: string | null;
  readonly at: string;
}

export interface B2BCommissionDeps {
  readonly accruals: (tenantId: string, salespersonId: string) => Promise<readonly CommissionAccrual[]> | readonly CommissionAccrual[];
  /** Used only by the invoice-derived path (`accrueFromInvoice`); the retired manual route never records. */
  readonly recordAccrual: (tenantId: string, salespersonId: string, accrual: CommissionAccrual) => Promise<void> | void;
  readonly now: () => string;
}

/** The refusal the retired manual accrual route gives (W4 · M22-FR-03). */
export const MANUAL_ACCRUAL_RETIRED = 'manual_commission_accrual_retired';

export function b2bCommissionRoutes(deps: B2BCommissionDeps): readonly Route[] {
  return [
    {
      // RETIRED (W4 · M22-FR-03). It took a typed `baseMinor` and `rateBps`, so a fitted base could be recorded beside the
      // invoice-derived path. It stays on the surface only to refuse — by name, naming that path — so an old caller is told,
      // never silently ignored. Nothing it is sent is ever recorded; earlier accruals are untouched.
      api: 'API-09', method: 'POST', path: '/v1/b2b/commissions/:salespersonId/accruals/:accrualId',
      permission: 'b2b.commission.record', idempotent: true,
      entitlement: 'b2b',
      handler: async (ctx) => {
        const salespersonId = (ctx.params['salespersonId'] ?? '').trim();
        throw apiError(410, {
          code: MANUAL_ACCRUAL_RETIRED,
          whatHappened: `Commission is no longer recorded from a typed amount. ${salespersonId === '' ? 'A salesperson' : `Salesperson ${salespersonId}`} earns commission only from a tax invoice head office issues for an order attributed to them, at the commission rate a second person approved (M22-FR-03).`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Propose the rate on the Sales commission page (POST /v1/b2b/commissions/:salespersonId/rules/:ruleId) and have a different person approve it (POST /v1/b2b/commissions/:salespersonId/rules/:ruleId/approve); then issue the tax invoice for the attributed order (POST /v1/b2b/documents/:customerId/invoices/:documentId) — head office works the commission out from it. Nothing was recorded; earlier accruals are unchanged.',
        });
      },
    },
    {
      // What a salesperson has earned so far — the sum of the accruals, projected, never a stored total.
      api: 'API-09', method: 'GET', path: '/v1/b2b/commissions/:salespersonId',
      permission: 'b2b.commission.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const salespersonId = ctx.params['salespersonId'] ?? '';
        const accruals = await deps.accruals(ctx.tenantId, salespersonId);
        if (accruals.length === 0) throw notFound(`commission for ${salespersonId}`);
        const totalCommissionMinor = accruals.reduce((s, a) => s + a.commissionMinor, 0);
        const totalBaseMinor = accruals.reduce((s, a) => s + a.baseMinor, 0);
        return {
          status: 200,
          body: {
            salespersonId,
            // The store trades in one currency; the accruals' currency is reported for the reader.
            currency: accruals[accruals.length - 1]?.currency ?? 'INR',
            totalCommissionMinor, totalBaseMinor, count: accruals.length,
            accruals, asAt: deps.now(),
          },
        };
      },
    },
  ];
}

// ── Commission RULES, governed, and commission DERIVED from invoices (FUL-09 · M22-FR-03 "commission rules approved;
// commission computed with exact money") ──────────────────────────────────────────────────────────────────────────────
// The retired accrual route above took the base and the rate from whoever called it. The FR wants the rate to be an APPROVED
// rule and the base to be what was actually invoiced: so a salesperson's rate is proposed by one person and approved by
// another (§28 — never the same person), and when a tax invoice is issued for an order attributed to them, the accrual
// is derived from the invoice's taxable value at the rule in force, once per invoice.

/** A salesperson's commission rule — proposed, then approved by someone else. Latest approved is in force. */
export interface CommissionRule {
  readonly ruleId: string;
  readonly salespersonId: string;
  readonly rateBps: number;
  readonly capMinor: number | null;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

export interface CommissionRuleDeps {
  readonly rules: (tenantId: string, salespersonId: string) => Promise<readonly CommissionRule[]> | readonly CommissionRule[];
  readonly recordRule: (tenantId: string, rule: CommissionRule) => Promise<void> | void;
  readonly accruals: B2BCommissionDeps['accruals'];
  readonly recordAccrual: B2BCommissionDeps['recordAccrual'];
  readonly now: () => string;
}

/** The rule in force: the latest APPROVED one. */
export const ruleInForce = (rules: readonly CommissionRule[]): CommissionRule | undefined =>
  [...rules].filter((r) => r.approvedBy !== undefined).sort((a, b) => (a.approvedAt ?? '').localeCompare(b.approvedAt ?? '')).at(-1);

/** Derive a salesperson's commission from an invoice by the approved rule — once per invoice (the accrual id is the invoice). */
export async function accrueFromInvoice(deps: CommissionRuleDeps, tenantId: string, input: {
  readonly salespersonId: string; readonly invoiceId: string; readonly invoiceNumber: string; readonly netMinor: number; readonly currency?: CurrencyCode;
}): Promise<{ readonly accrued: true; readonly commissionMinor: number; readonly rateBps: number } | { readonly accrued: false; readonly why: string }> {
  const accrualId = `inv-${input.invoiceId}`;
  const prior = (await deps.accruals(tenantId, input.salespersonId)).find((a) => a.accrualId === accrualId);
  if (prior !== undefined) return { accrued: true, commissionMinor: prior.commissionMinor, rateBps: prior.rateBps };
  const rule = ruleInForce(await deps.rules(tenantId, input.salespersonId));
  if (rule === undefined) return { accrued: false, why: `no approved commission rule for ${input.salespersonId} — nothing accrued` };
  const currency = input.currency ?? 'INR';
  const commission = computeCommission({ minor: input.netMinor, currency }, rule.rateBps, rule.capMinor ?? undefined);
  await deps.recordAccrual(tenantId, input.salespersonId, {
    accrualId, salespersonId: input.salespersonId, baseMinor: input.netMinor, rateBps: rule.rateBps, capMinor: rule.capMinor,
    commissionMinor: commission.minor, currency, ref: `invoice ${input.invoiceNumber} (rule ${rule.ruleId})`, at: deps.now(),
  });
  return { accrued: true, commissionMinor: commission.minor, rateBps: rule.rateBps };
}

export function commissionRuleRoutes(deps: CommissionRuleDeps): readonly Route[] {
  return [
    {
      // Propose a salesperson's rate. Not in force until someone ELSE approves it. Body: { rateBps, capMinor? }.
      api: 'API-09', method: 'POST', path: '/v1/b2b/commissions/:salespersonId/rules/:ruleId',
      permission: 'b2b.commission.record', idempotent: true,
      entitlement: 'b2b',
      handler: async (ctx) => {
        const salespersonId = ctx.params['salespersonId'] ?? '';
        const ruleId = ctx.params['ruleId'] ?? '';
        const b = (ctx.body ?? {}) as { rateBps?: unknown; capMinor?: unknown };
        if (!Number.isInteger(b.rateBps) || (b.rateBps as number) < 0 || (b.rateBps as number) > 10_000
          || (b.capMinor !== undefined && (!Number.isInteger(b.capMinor) || (b.capMinor as number) < 0))) {
          throw apiError(400, { code: 'not_readable_as_a_commission_rule', whatHappened: 'A commission rule is { rateBps: 0–10000, capMinor?: whole, non-negative }.', wasItSaved: 'not_saved', nextSafeAction: 'Send it again. Nothing was recorded.' });
        }
        if ((await deps.rules(ctx.tenantId, salespersonId)).some((r) => r.ruleId === ruleId)) {
          throw apiError(409, { code: 'commission_rule_exists', whatHappened: `Rule ${ruleId} is already on record; a change is a new rule.`, wasItSaved: 'not_saved', nextSafeAction: 'Propose the change under a new rule id. Nothing was changed.' });
        }
        const rule: CommissionRule = { ruleId, salespersonId, rateBps: b.rateBps as number, capMinor: b.capMinor === undefined ? null : b.capMinor as number, proposedBy: ctx.userId, proposedAt: deps.now() };
        await deps.recordRule(ctx.tenantId, rule);
        return { status: 201, body: { ...rule, inForce: false } };
      },
    },
    {
      // Approve a proposed rule — by someone other than the person who proposed it (§28). It is then in force.
      api: 'API-09', method: 'POST', path: '/v1/b2b/commissions/:salespersonId/rules/:ruleId/approve',
      permission: 'b2b.commission.approve', idempotent: true,
      entitlement: 'b2b',
      handler: async (ctx) => {
        const salespersonId = ctx.params['salespersonId'] ?? '';
        const ruleId = ctx.params['ruleId'] ?? '';
        const rule = [...await deps.rules(ctx.tenantId, salespersonId)].reverse().find((r) => r.ruleId === ruleId);
        if (rule === undefined) throw notFound(`commission rule ${ruleId} for ${salespersonId}`);
        if (rule.approvedBy !== undefined) return { status: 200, body: { ...rule, inForce: ruleInForce(await deps.rules(ctx.tenantId, salespersonId))?.ruleId === ruleId } };
        if (rule.proposedBy === ctx.userId) {
          throw apiError(403, { code: 'self_approval', whatHappened: 'A commission rule must be approved by someone other than the person who proposed it.', wasItSaved: 'not_saved', nextSafeAction: 'Ask another approver. Nothing was changed.' });
        }
        const approved: CommissionRule = { ...rule, approvedBy: ctx.userId, approvedAt: deps.now() };
        await deps.recordRule(ctx.tenantId, approved);
        return { status: 200, body: { ...approved, inForce: true } };
      },
    },
    {
      // A salesperson's rules — proposed and approved — and the one in force.
      api: 'API-09', method: 'GET', path: '/v1/b2b/commissions/:salespersonId/rules',
      permission: 'b2b.commission.read',
      entitlement: 'b2b',
      handler: async (ctx) => {
        const salespersonId = ctx.params['salespersonId'] ?? '';
        const rules = await deps.rules(ctx.tenantId, salespersonId);
        return { status: 200, body: { salespersonId, rules, inForce: ruleInForce(rules) ?? null } };
      },
    },
  ];
}
