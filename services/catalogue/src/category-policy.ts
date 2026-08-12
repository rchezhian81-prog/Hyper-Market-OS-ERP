// API-02 Category-policy preview route (owner continuation directive, 12 Aug 2026 — category rules as
// effective-dated configuration). Given a category's dated policy history and a business date, resolve
// the rules in force and preview the sale/return decisions they produce. It is a READ: it validates and
// computes over the supplied policy and commits nothing — an ERP admin previews what a policy will do
// before saving it, and a lane can validate a category's controls without a round trip to storage.
//
// Stateless over the tested `@sre/product` category-policy engine (the `services-run-on-their-tested-
// engine` guardrail): this route only shapes input and calls `resolvePolicy` / `categorySaleDecision` /
// `categoryReturnDecision` / `describePolicy`. Gated `catalogue.pack.read` — the same permission the
// catalogue is read under.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  resolvePolicy,
  categorySaleDecision,
  categoryReturnDecision,
  describePolicy,
  presetFor,
  CATEGORY_KINDS,
  InvalidCategoryPolicy,
  type CategoryPolicyRules,
  type CategoryKind,
  type SaleContext,
  type EffectiveValue,
} from '../../../packages/product/src/index';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isKind = (v: unknown): v is CategoryKind => typeof v === 'string' && (CATEGORY_KINDS as readonly string[]).includes(v);

export function categoryPolicyRoutes(): readonly Route[] {
  return [
    {
      // Resolve a category's rules in force on a date and preview the sale/return decisions. Either supply
      // the category's own effective-dated `history`, OR a preset `kind` to preview a shipped default.
      // Body: { onDate: "YYYY-MM-DD", history?: EffectiveValue<CategoryPolicyRules>[], kind?: CategoryKind,
      //         sale?: SaleContext, returnAfterDays?: number }
      api: 'API-02', method: 'POST', path: '/v1/catalogue/category-policy/resolve',
      permission: 'catalogue.pack.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const onDate = b['onDate'];
        if (typeof onDate !== 'string' || onDate === '') {
          throw apiError(400, { code: 'category_policy_needs_date', whatHappened: 'The policy preview needs onDate as YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send onDate (the business date) and either the category’s policy history or a preset kind.' });
        }
        // A preset kind seeds a one-entry history effective on the business date; otherwise use the supplied history.
        const history = b['kind'] !== undefined
          ? (isKind(b['kind'])
            ? [{ effectiveFrom: onDate, value: presetFor(b['kind']) }]
            : (() => { throw apiError(400, { code: 'category_policy_unknown_kind', whatHappened: `kind must be one of: ${CATEGORY_KINDS.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send a known preset kind, or send an explicit history instead.' }); })())
          : b['history'];
        if (!Array.isArray(history)) {
          throw apiError(400, { code: 'category_policy_needs_history_or_kind', whatHappened: 'The policy preview needs either history (effective-dated rule entries) or a preset kind.', wasItSaved: 'not_saved', nextSafeAction: 'Send history as [{ effectiveFrom, value: { …rules } }, …], or kind: "grocery_fmcg" (etc.).' });
        }
        try {
          const rules = resolvePolicy(history as readonly EffectiveValue<CategoryPolicyRules>[], onDate);
          if (rules === undefined) {
            return { status: 200, body: { inForce: false, detail: `No policy has taken effect for this category on ${onDate}.` } };
          }
          const sale = isObject(b['sale']) ? categorySaleDecision(rules, b['sale'] as SaleContext) : undefined;
          const returnAfterDays = b['returnAfterDays'];
          const ret = typeof returnAfterDays === 'number' ? categoryReturnDecision(rules, returnAfterDays) : undefined;
          return {
            status: 200,
            body: {
              inForce: true,
              rules,
              summary: describePolicy(rules),
              ...(sale !== undefined ? { sale } : {}),
              ...(ret !== undefined ? { return: ret } : {}),
            },
          };
        } catch (err) {
          if (err instanceof InvalidCategoryPolicy) {
            throw apiError(400, { code: 'category_policy_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the dates (YYYY-MM-DD) in the policy history and try again.' });
          }
          throw err;
        }
      },
    },
  ];
}
