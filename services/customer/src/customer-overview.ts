// M16 (R4, signed OB-227 · OB-74) — the Customers page's one read: every customer head office knows of, each with its
// segment, and the merges waiting for a second person.
//
//   GET /v1/customer/overview
//
// "A customer without profiling consent shows as 'not profiled', never silently left out." Every customer named in the
// stored order facts (derived from the banked sales, FUL-10) or on the consent ledger is listed. The segment is the
// tested `assembleProfiles` for the PROFILING purpose, so a customer who has not agreed to be analysed is listed as
// `not_profiled` with the reason — present, counted, never dropped. Merges are read from the governed merge record
// (services/customer/src/customer-360.ts): one person proposes, ANOTHER approves, and either can be reversed. This read
// writes nothing and merges nothing.

import type { Route } from '../../kernel/src/index';
import {
  assembleProfiles, type OrderFact, type ComplaintFact, type SegmentPolicy, type SegmentName,
} from '../../../packages/customer/src/index';
import { collapseConsent } from './segments';
import { mergeState, type CustomerMerge } from './customer-360';
import type { ConsentRecord } from './index';

export interface CustomerOverviewDeps {
  readonly now: () => string;
  readonly orderFacts: (tenantId: string) => Promise<readonly OrderFact[]>;
  readonly complaintFacts: (tenantId: string) => Promise<readonly ComplaintFact[]>;
  readonly policy: (tenantId: string) => Promise<SegmentPolicy | undefined>;
  /** Every customer with a consent record on file (so a customer who never bought but gave or refused consent is listed). */
  readonly consentSubjects?: (tenantId: string) => Promise<readonly string[]>;
  readonly consentFor: (tenantId: string, customerRef: string) => Promise<readonly ConsentRecord[]>;
  readonly merges: (tenantId: string) => Promise<readonly CustomerMerge[]>;
}

const SEGMENT_ORDER: readonly SegmentName[] = ['loyal', 'regular', 'new', 'lapsing', 'lapsed', 'insufficient_history', 'not_profiled'];

export function customerOverviewRoutes(deps: CustomerOverviewDeps): readonly Route[] {
  return [
    {
      api: 'API-06', method: 'GET', path: '/v1/customer/overview',
      permission: 'customer.segment.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const asOf = deps.now();
        const [orders, complaints, policy, merges] = await Promise.all([deps.orderFacts(t), deps.complaintFacts(t), deps.policy(t), deps.merges(t)]);
        const refs = [...new Set([...orders.map((o) => o.customerRef), ...((await deps.consentSubjects?.(t)) ?? [])])].sort();
        const consents = await Promise.all(refs.map(async (ref) => collapseConsent(ref, await deps.consentFor(t, ref))));
        const profiles = assembleProfiles({ orders, complaints, consents, purpose: 'profiling', asOf, policy: policy ?? {} });
        const byRef = new Map(profiles.map((p) => [p.customerRef, p]));
        const customers = refs.map((ref) => {
          const p = byRef.get(ref);
          const segment: SegmentName = p?.segment ?? 'not_profiled';
          return {
            customerRef: ref, segment, profiled: segment !== 'not_profiled',
            orders: p?.orderCount ?? 0, lastOrderAt: p?.lastOrderAt ?? null,
            detail: p?.detail ?? 'this customer has not consented to profiling, so they are not segmented',
          };
        });
        const counts = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, customers.filter((c) => c.segment === s).length]));
        const state = mergeState(merges);
        const pending = state.filter((m) => m.approvedBy === undefined && m.reversedBy === undefined);
        const inForce = state.filter((m) => m.approvedBy !== undefined && m.reversedBy === undefined);
        return {
          status: 200,
          body: {
            customers, counts, notProfiled: counts['not_profiled'] ?? 0,
            merges: { waitingForSecondPerson: pending, inForce, reversed: state.filter((m) => m.reversedBy !== undefined) },
            mergesAnything: false,
            asAt: asOf,
          },
        };
      },
    },
  ];
}
