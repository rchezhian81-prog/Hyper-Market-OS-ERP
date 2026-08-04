// Display-space contracts and space productivity (M04-FR-04 / D02-FR-06 / M23).
//
// Two questions this answers, both of which shops usually get wrong by feel:
//
//   1. IS THIS SPACE EARNING ITS KEEP? A 14,000 sq ft shop has a fixed amount of
//      floor. Every square foot given to one category is taken from another, and the
//      only honest comparison is sales — or better, MARGIN — per square foot. A
//      category with big turnover and thin margin can be the worst use of space in
//      the building while looking like the best.
//
//   2. IS THE SUPPLIER ACTUALLY PAYING FOR THE END-CAP THEY ARE STANDING ON? Display
//      funding is agreed in a conversation and forgotten by finance. So a contract
//      here names the space, the money and the dates, and reconciles against what was
//      actually received (M23) — an unreconciled display contract is free space the
//      shop gave away.
//
// Money is exact minor units throughout, and a ratio that cannot be computed says so
// rather than returning zero, because "0 sales per sq ft" and "we never measured this
// area" lead to opposite decisions (P-08).

import type { Money } from '../../contracts/src/money';

export interface SpaceArea {
  readonly areaId: string;
  readonly storeId: string;
  readonly name: string;
  /** Selling area in square feet — the denominator. */
  readonly squareFeet: number;
  /** Aisles or locations that make up this area. */
  readonly locationIds?: readonly string[];
}

export type SpaceRatio =
  | { readonly kind: 'per_sq_ft'; readonly minorPerSqFt: number }
  | { readonly kind: 'not_meaningful'; readonly because: string };

export interface SpacePerformanceRow {
  readonly areaId: string;
  readonly name: string;
  readonly squareFeet: number;
  readonly sales: Money;
  readonly grossMargin: Money;
  /** Sales per square foot — the number everyone quotes. */
  readonly salesPerSqFt: SpaceRatio;
  /** Margin per square foot — the number that should decide the layout. */
  readonly marginPerSqFt: SpaceRatio;
  /** Share of the store's total selling area, in basis points. */
  readonly shareOfSpaceBp: number;
  /** Share of the store's total margin, in basis points. */
  readonly shareOfMarginBp: number;
  /** Set when an area takes more space than it earns — the actionable finding. */
  readonly underperforming: boolean;
}

function ratio(minor: number, squareFeet: number, because: string): SpaceRatio {
  if (squareFeet <= 0) return { kind: 'not_meaningful', because };
  return { kind: 'per_sq_ft', minorPerSqFt: Math.round(minor / squareFeet) };
}

/**
 * Rank areas by what they actually earn per square foot. An area is flagged
 * underperforming when its share of margin is materially below its share of space —
 * the comparison that says "this aisle is too big", which raw sales never does.
 */
export function spacePerformance(input: {
  readonly areas: readonly SpaceArea[];
  readonly sales: Readonly<Record<string, Money>>;
  readonly grossMargin: Readonly<Record<string, Money>>;
  readonly currency: Money['currency'];
  /** How far below its space share an area's margin share may sit, in bp. */
  readonly toleranceBp?: number;
}): readonly SpacePerformanceRow[] {
  const tolerance = input.toleranceBp ?? 2_000; // 20% relative, by default
  const totalSqFt = input.areas.reduce((sum, a) => sum + a.squareFeet, 0);
  const totalMarginMinor = input.areas.reduce(
    (sum, a) => sum + (input.grossMargin[a.areaId]?.minor ?? 0),
    0,
  );

  return input.areas
    .map((area): SpacePerformanceRow => {
      const sales = input.sales[area.areaId] ?? { minor: 0, currency: input.currency };
      const margin = input.grossMargin[area.areaId] ?? { minor: 0, currency: input.currency };
      const shareOfSpaceBp =
        totalSqFt === 0 ? 0 : Math.round((area.squareFeet * 10_000) / totalSqFt);
      const shareOfMarginBp =
        totalMarginMinor === 0 ? 0 : Math.round((margin.minor * 10_000) / totalMarginMinor);

      return {
        areaId: area.areaId,
        name: area.name,
        squareFeet: area.squareFeet,
        sales,
        grossMargin: margin,
        salesPerSqFt: ratio(sales.minor, area.squareFeet, 'this area has no recorded floor space'),
        marginPerSqFt: ratio(margin.minor, area.squareFeet, 'this area has no recorded floor space'),
        shareOfSpaceBp,
        shareOfMarginBp,
        underperforming:
          totalMarginMinor > 0 && shareOfMarginBp + tolerance < shareOfSpaceBp,
      };
    })
    .sort((a, b) => {
      const left = a.marginPerSqFt.kind === 'per_sq_ft' ? a.marginPerSqFt.minorPerSqFt : -1;
      const right = b.marginPerSqFt.kind === 'per_sq_ft' ? b.marginPerSqFt.minorPerSqFt : -1;
      return right - left;
    });
}

// --- supplier display-space contracts -----------------------------------------

export interface DisplayContract {
  readonly contractId: string;
  readonly storeId: string;
  readonly supplierId: string;
  readonly description: string;
  /** The space it buys — named, so it can be checked on the floor. */
  readonly areaId?: string;
  readonly locationIds: readonly string[];
  readonly fundingAmount: Money;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly approvedBy?: string;
}

export type ContractFinding =
  | 'active'
  | 'expiring_soon'
  | 'expired_still_occupying'
  | 'unapproved'
  | 'no_space_named'
  | 'funding_not_received';

export interface ContractStatus {
  readonly contractId: string;
  readonly supplierId: string;
  readonly finding: ContractFinding;
  readonly daysRemaining: number;
  /** Funding agreed minus funding actually received (M23 reconciliation). */
  readonly outstanding: Money;
  readonly detail: string;
}

/**
 * Review display contracts. The finding that matters commercially is an EXPIRED
 * contract whose display is still on the floor: the supplier stopped paying and
 * nobody took the stand away, so the shop is giving away its best space.
 */
export function reviewDisplayContracts(input: {
  readonly contracts: readonly DisplayContract[];
  readonly onDate: string;
  /** Funding actually received per contract, from finance (M23). */
  readonly received?: Readonly<Record<string, Money>>;
  /** Contracts whose display is still physically on the floor. */
  readonly stillOccupying?: readonly string[];
  readonly warnDays?: number;
  readonly currency: Money['currency'];
}): readonly ContractStatus[] {
  const warnDays = input.warnDays ?? 30;
  const occupying = new Set(input.stillOccupying ?? []);

  return input.contracts
    .map((contract): ContractStatus => {
      const daysRemaining = Math.floor(
        (Date.parse(`${contract.endsOn}T00:00:00Z`) - Date.parse(`${input.onDate}T00:00:00Z`)) /
          86_400_000,
      );
      const receivedMinor = input.received?.[contract.contractId]?.minor ?? 0;
      const outstanding: Money = {
        minor: contract.fundingAmount.minor - receivedMinor,
        currency: input.currency,
      };

      const base = { contractId: contract.contractId, supplierId: contract.supplierId, daysRemaining, outstanding };

      if (contract.approvedBy === undefined || contract.approvedBy.trim() === '') {
        return {
          ...base,
          finding: 'unapproved',
          detail: 'no approver recorded — display funding is a commercial term and needs Finance (§28)',
        };
      }
      if (contract.locationIds.length === 0 && contract.areaId === undefined) {
        return {
          ...base,
          finding: 'no_space_named',
          detail: 'the contract does not say which space it buys, so nobody can check it on the floor',
        };
      }
      if (daysRemaining < 0) {
        return {
          ...base,
          finding: occupying.has(contract.contractId) ? 'expired_still_occupying' : 'expired_still_occupying',
          detail: occupying.has(contract.contractId)
            ? `expired ${-daysRemaining} days ago and the display is STILL on the floor — the shop is giving away its best space`
            : `expired ${-daysRemaining} days ago; confirm the display has been removed`,
        };
      }
      if (outstanding.minor > 0) {
        return {
          ...base,
          finding: 'funding_not_received',
          detail: `${outstanding.minor} minor units of agreed funding not yet received — the space is being used, the money is not in`,
        };
      }
      if (daysRemaining <= warnDays) {
        return {
          ...base,
          finding: 'expiring_soon',
          detail: `ends in ${daysRemaining} days — renew it or plan the space`,
        };
      }
      return { ...base, finding: 'active', detail: `runs for another ${daysRemaining} days` };
    })
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}
