// The partner counters' trading decisions, as the store computer holds them (Wave 5 · PF-13 · M27-FR-01, M27-FR-04,
// §31, P-01, P-08). Pure — no clock, no store.
//
// A concession counter may trade only on an approved, active agreement that has started and not ended, with insurance
// (and, where it needs one, a licence) in date (`mayConcessionTrade`). Head office knows the agreements; the store
// computer must know them too, so a counter whose agreement lapsed is stopped at the counter BEFORE money changes hands —
// with the cable out as well. Head office publishes each agreement's TERMS (dates and approval), not a yes/no for today:
// the box decides by its own calendar, so an agreement that ends tonight stops the counter tomorrow without a pull.

import { mayConcessionTrade, type ConcessionBlockReason, type ConcessionContract } from './concession';

/** What the box needs of one agreement — never the commercial terms (rent, share, deposit). */
export interface CounterTerms {
  readonly contractId: string;
  readonly concessionaireId: string;
  readonly branchId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly insuranceUntil?: string;
  readonly licenceUntil?: string;
  /** A second person approved the agreement (ADR-0024). */
  readonly approved: boolean;
  readonly active: boolean;
}

export interface ConcessionTradingFeed {
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly contracts: readonly CounterTerms[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const optDate = (v: unknown): boolean => v === undefined || (typeof v === 'string' && DATE.test(v));

export function termsOf(c: ConcessionContract): CounterTerms {
  return {
    contractId: c.contractId, concessionaireId: c.concessionaireId, branchId: c.branchId, startsOn: c.startsOn, endsOn: c.endsOn,
    ...(c.insuranceUntil === undefined ? {} : { insuranceUntil: c.insuranceUntil }),
    ...(c.licenceUntil === undefined ? {} : { licenceUntil: c.licenceUntil }),
    approved: c.approvedBy !== undefined, active: c.active,
  };
}

/** Read an untrusted feed (off the wire or the disk); anything malformed is refused whole. */
export function readConcessionTradingFeed(raw: unknown): ConcessionTradingFeed | undefined {
  if (!isObj(raw) || !isStr(raw['tenantId']) || !isStr(raw['generatedAt']) || Number.isNaN(Date.parse(raw['generatedAt'])) || !Array.isArray(raw['contracts'])) return undefined;
  const contracts: CounterTerms[] = [];
  for (const c of raw['contracts'] as unknown[]) {
    if (!isObj(c) || !isStr(c['contractId']) || !isStr(c['concessionaireId']) || !isStr(c['branchId'])
      || typeof c['startsOn'] !== 'string' || !DATE.test(c['startsOn']) || typeof c['endsOn'] !== 'string' || !DATE.test(c['endsOn'])
      || !optDate(c['insuranceUntil']) || !optDate(c['licenceUntil']) || typeof c['approved'] !== 'boolean' || typeof c['active'] !== 'boolean') return undefined;
    contracts.push({
      contractId: c['contractId'], concessionaireId: c['concessionaireId'], branchId: c['branchId'], startsOn: c['startsOn'], endsOn: c['endsOn'],
      ...(c['insuranceUntil'] === undefined ? {} : { insuranceUntil: c['insuranceUntil'] as string }),
      ...(c['licenceUntil'] === undefined ? {} : { licenceUntil: c['licenceUntil'] as string }),
      approved: c['approved'], active: c['active'],
    });
  }
  return { tenantId: raw['tenantId'], generatedAt: raw['generatedAt'], contracts };
}

const WORDS: Readonly<Record<ConcessionBlockReason, string>> = {
  inactive: 'the agreement is not active',
  not_approved: 'the agreement has not been approved',
  contract_not_started: 'the agreement has not started',
  contract_expired: 'the agreement has ended',
  insurance_lapsed: 'the partner\'s insurance is not in date',
  licence_lapsed: 'the partner\'s licence is not in date',
};

export type CounterDecision =
  | { readonly mayTrade: true; readonly contractId: string; readonly warnings: readonly string[] }
  | { readonly mayTrade: false; readonly contractId?: string; readonly blockedBy: readonly (ConcessionBlockReason | 'no_agreement' | 'agreement_ambiguous')[]; readonly laneMessage: string };

/**
 * May this partner's counter take a new sale today, by the box's copy? The agreement the line names, or the partner's
 * one agreement covering today at this store. A counter with no agreement, or more than one, does not trade here.
 */
export function counterDecision(input: {
  readonly feed: ConcessionTradingFeed;
  readonly concessionaireId: string;
  readonly contractId?: string;
  /** The store this box is; agreements for other stores are not this counter's. Absent → any store. */
  readonly branchId?: string;
  readonly today: string;
}): CounterDecision {
  const mine = input.feed.contracts.filter((c) => c.concessionaireId === input.concessionaireId
    && (input.branchId === undefined || c.branchId === input.branchId));
  let terms: CounterTerms | undefined;
  if (input.contractId !== undefined) {
    terms = mine.find((c) => c.contractId === input.contractId);
  } else {
    const covering = mine.filter((c) => c.active && c.startsOn <= input.today && input.today <= c.endsOn);
    if (covering.length > 1) {
      return { mayTrade: false, blockedBy: ['agreement_ambiguous'], laneMessage: `Partner ${input.concessionaireId} has ${covering.length} agreements covering today. Do not take money at this counter — the manager must say which agreement applies.` };
    }
    terms = covering[0] ?? mine.sort((a, b) => b.endsOn.localeCompare(a.endsOn))[0];
  }
  if (terms === undefined) {
    return { mayTrade: false, blockedBy: ['no_agreement'], laneMessage: `This store computer holds no agreement for partner ${input.concessionaireId}. Do not take money at this counter — tell the manager.` };
  }
  const decision = mayConcessionTrade({
    contract: {
      contractId: terms.contractId, tenantId: input.feed.tenantId, branchId: terms.branchId, concessionaireId: terms.concessionaireId, name: terms.contractId,
      startsOn: terms.startsOn, endsOn: terms.endsOn, basis: 'fixed_rent', depositMinor: 0, active: terms.active,
      ...(terms.insuranceUntil === undefined ? {} : { insuranceUntil: terms.insuranceUntil }),
      ...(terms.licenceUntil === undefined ? {} : { licenceUntil: terms.licenceUntil }),
      ...(terms.approved ? { approvedBy: 'approved' } : {}),
    },
    today: input.today,
  });
  if (decision.mayTrade) return { mayTrade: true, contractId: terms.contractId, warnings: decision.warnings };
  return {
    mayTrade: false, contractId: terms.contractId, blockedBy: decision.blockedBy,
    laneMessage: `This counter may not trade today: ${decision.blockedBy.map((b) => WORDS[b]).join('; ')}. Do not take money at this counter — tell the manager.`,
  };
}
