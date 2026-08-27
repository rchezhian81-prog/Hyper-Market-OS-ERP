// API-06 Customer duplicate detection (M16-FR-01 · P-02 · P-08 · §28) — one customer truth. Tested since
// the module was written, on NO cloud route. A hypermarket accumulates the same person twice: they enrolled
// at the till on Tuesday and again on the app on Friday, and now their spend, their loyalty and their consent
// are split across two records that each look complete. The cost is quiet — a marketing message sent twice,
// a lifetime-value figure that is half the truth, a "we don't have your history" at the counter.
//
// So duplicates are FOUND, but the rule that matters is what is NOT done: **nothing is ever auto-merged.** A
// shared VERIFIED phone or email is a high-confidence merge CANDIDATE; a shared unverified contact or just a
// matching name is low-confidence and goes to REVIEW. A merge itself is a governed, reversible, audited act
// by a person (§28) — this engine only proposes, because a wrong auto-merge fuses two real people's records
// and is far harder to undo than a duplicate is to live with (P-08).
//
// The rule is the tested `detectDuplicateCustomers` in `@sre/customer` (the services-run-on-their-tested-
// engine guardrail). A pure compute over the candidate set the caller supplies (like the segments routes) —
// PII is compared on normalised values only, nothing is written. Gated `customer.segment.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { detectDuplicateCustomers, type CustomerRecord } from '../../../packages/customer/src/index';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Validate one caller-supplied customer record, or return undefined. */
function readCustomer(v: unknown): CustomerRecord | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const c = v as Record<string, unknown>;
  if (!isStr(c['customerId'])
    || (c['phone'] !== undefined && typeof c['phone'] !== 'string')
    || (c['email'] !== undefined && typeof c['email'] !== 'string')
    || (c['name'] !== undefined && typeof c['name'] !== 'string')
    || (c['phoneVerified'] !== undefined && typeof c['phoneVerified'] !== 'boolean')
    || (c['emailVerified'] !== undefined && typeof c['emailVerified'] !== 'boolean')) {
    return undefined;
  }
  return {
    customerId: c['customerId'],
    ...(typeof c['phone'] === 'string' ? { phone: c['phone'] } : {}),
    ...(typeof c['email'] === 'string' ? { email: c['email'] } : {}),
    ...(typeof c['name'] === 'string' ? { name: c['name'] } : {}),
    ...(typeof c['phoneVerified'] === 'boolean' ? { phoneVerified: c['phoneVerified'] } : {}),
    ...(typeof c['emailVerified'] === 'boolean' ? { emailVerified: c['emailVerified'] } : {}),
  };
}

export interface CustomerDuplicatesDeps {
  readonly now: () => string;
}

export function customerDuplicatesRoutes(deps: CustomerDuplicatesDeps): readonly Route[] {
  return [
    {
      // Find duplicate customer pairs among a candidate set. Body: { customers: [{ customerId, phone?,
      // phoneVerified?, email?, emailVerified?, name? }] }. Returns the matches, high-confidence first —
      // merge_candidate (still governed, never auto-merged) vs review. A pure compute; nothing is written.
      api: 'API-06', method: 'POST', path: '/v1/customer/duplicates',
      permission: 'customer.segment.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const raw = b['customers'];
        const customers = Array.isArray(raw) ? raw.map(readCustomer) : undefined;
        if (customers === undefined || customers.some((c) => c === undefined)) {
          throw apiError(400, {
            code: 'not_readable_as_a_customer_set',
            whatHappened: 'Duplicate detection needs { customers: [{ customerId, phone?, phoneVerified?, email?, emailVerified?, name? }] }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the candidate customers to check — the check only proposes, it never merges anyone.',
          });
        }
        const matches = detectDuplicateCustomers(customers as CustomerRecord[]);
        return {
          status: 200,
          body: {
            matches,
            count: matches.length,
            // The split the reviewer acts on: high-confidence candidates a person can confirm and merge,
            // versus low-confidence pairs that only warrant a look. Neither is ever merged automatically.
            mergeCandidates: matches.filter((m) => m.disposition === 'merge_candidate').length,
            forReview: matches.filter((m) => m.disposition === 'review').length,
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
