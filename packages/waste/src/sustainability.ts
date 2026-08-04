// Waste, energy and sustainability reporting (M28-FR-04 / M26-FR-04 / P-08 / P-03).
//
// Sustainability reporting has a specific failure mode that is worth naming, because it is
// not incompetence — it is the natural drift of any number nobody can check.
//
// A store reports "waste down 18%". Waste is not down; **recording** is down. The one manager
// who logged every damaged crate went on leave, and the figure improved. Six months later the
// shop believes it has a waste problem under control that it has simply stopped measuring.
//
// So this report is built on one rule: **a fall in recorded waste is not a fall in waste, and
// this module will say so.** Coverage — how much of the estate was actually reporting — is on
// the face of the report, next to the number, not in a footnote.
//
//   • **THE NUMBER CARRIES ITS COVERAGE.** A 20% improvement on 60% coverage is not an
//     improvement, it is an unknown, and it is labelled as one.
//   • **WASTE IS VALUED AND CATEGORISED BY WHERE IT CAME FROM.** "₹2,40,000 of waste" is a
//     number nobody can act on. *"₹1,80,000 of it is fresh vegetables expiring on the shelf,
//     and 70% of that is one department"* is an ordering decision.
//   • **NOTHING HERE IS AN AI CLAIM.** Every figure is derived arithmetic over recorded
//     events, with its inputs named, so it can be drilled into (M29). Sustainability numbers
//     get quoted publicly, and a number that cannot be traced should never be published.
//
// Pure and deterministic: no I/O, the window is injected.

export type WasteSource = 'expiry' | 'damage' | 'shrinkage' | 'preparation' | 'customer_return' | 'recall';

export interface WasteRecord {
  readonly wasteId: string;
  readonly branchId: string;
  readonly departmentId: string;
  readonly productId: string;
  readonly source: WasteSource;
  readonly at: string;
  readonly grams?: number;
  readonly valueMinor: number;
  /** Where it went. Donation and recycling are diverted from landfill. */
  readonly disposal: 'landfill' | 'recycled' | 'donated' | 'composted' | 'destroyed';
}

export interface CoverageInput {
  /** Branches and departments expected to report in this window. */
  readonly expected: readonly { readonly branchId: string; readonly departmentId: string }[];
}

export interface WasteBreakdown {
  readonly key: string;
  readonly label: string;
  readonly valueMinor: number;
  readonly records: number;
  readonly shareBps: number;
  readonly detail: string;
}

export type Confidence = 'reliable' | 'partial' | 'not_comparable';

export interface SustainabilityReport {
  readonly branchId: string;
  readonly from: string;
  readonly to: string;
  readonly totalWasteValueMinor: number;
  readonly totalWasteGrams: number;
  readonly records: number;
  /** Basis points of expected reporting units that actually reported. */
  readonly coverageBps: number;
  readonly notReporting: readonly string[];
  readonly confidence: Confidence;
  readonly bySource: readonly WasteBreakdown[];
  readonly byDepartment: readonly WasteBreakdown[];
  /** Basis points of waste weight kept out of landfill. */
  readonly diversionBps: number | 'not_meaningful';
  readonly energyKilowattHours?: number;
  readonly energyCostMinor?: number;
  readonly scrapProceedsMinor?: number;
  readonly detail: string;
  /** Stated plainly so a headline figure is never quoted without it. */
  readonly caveat?: string;
}

function breakdown(
  records: readonly WasteRecord[],
  keyOf: (r: WasteRecord) => string,
  labelOf: (key: string) => string,
  total: number,
): readonly WasteBreakdown[] {
  const groups = new Map<string, WasteRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  return [...groups]
    .map(([key, rows]): WasteBreakdown => {
      const valueMinor = rows.reduce((s, r) => s + r.valueMinor, 0);
      const shareBps = total === 0 ? 0 : Number((BigInt(valueMinor) * 10_000n) / BigInt(total));
      return {
        key,
        label: labelOf(key),
        valueMinor,
        records: rows.length,
        shareBps,
        detail: `${valueMinor} across ${rows.length} record(s), ${(shareBps / 100).toFixed(1)}% of the total`,
      };
    })
    .sort((a, b) => b.valueMinor - a.valueMinor || a.key.localeCompare(b.key));
}

/**
 * Build the waste and sustainability report for a window.
 *
 * **Coverage sits next to the number, not under it.** A store reporting less waste because
 * one careful manager went on leave is the failure this exists to prevent, and it is invisible
 * to any report that shows the total alone. Below 80% coverage the report says the figure is
 * `not_comparable` in those words, because "waste down 18%" gets quoted and the footnote does
 * not.
 */
export function buildSustainabilityReport(input: {
  readonly branchId: string;
  readonly waste: readonly WasteRecord[];
  readonly coverage: CoverageInput;
  readonly from: string;
  readonly to: string;
  readonly departmentNames?: Readonly<Record<string, string>>;
  readonly energyKilowattHours?: number;
  readonly energyCostMinor?: number;
  readonly scrapProceedsMinor?: number;
  /** Coverage below which a comparison is meaningless. Default 8,000bps (80%). */
  readonly comparableAboveBps?: number;
}): SustainabilityReport {
  const window = input.waste.filter(
    (w) => w.branchId === input.branchId && w.at >= input.from && w.at <= `${input.to}T23:59:59Z`,
  );

  const expected = input.coverage.expected.filter((e) => e.branchId === input.branchId);
  const reported = new Set(window.map((w) => w.departmentId));
  const notReporting = expected
    .filter((e) => !reported.has(e.departmentId))
    .map((e) => input.departmentNames?.[e.departmentId] ?? e.departmentId)
    .sort();

  const coverageBps =
    expected.length === 0
      ? 10_000
      : Number((BigInt(expected.length - notReporting.length) * 10_000n) / BigInt(expected.length));

  const comparableAbove = input.comparableAboveBps ?? 8_000;
  const confidence: Confidence =
    coverageBps >= 10_000 ? 'reliable' : coverageBps >= comparableAbove ? 'partial' : 'not_comparable';

  const totalWasteValueMinor = window.reduce((s, w) => s + w.valueMinor, 0);
  const totalWasteGrams = window.reduce((s, w) => s + (w.grams ?? 0), 0);

  const weighed = window.filter((w) => w.grams !== undefined && w.grams > 0);
  const weighedGrams = weighed.reduce((s, w) => s + (w.grams ?? 0), 0);
  const divertedGrams = weighed
    .filter((w) => w.disposal === 'recycled' || w.disposal === 'donated' || w.disposal === 'composted')
    .reduce((s, w) => s + (w.grams ?? 0), 0);

  const diversionBps =
    weighedGrams === 0
      ? ('not_meaningful' as const)
      : Number((BigInt(divertedGrams) * 10_000n) / BigInt(weighedGrams));

  const bySource = breakdown(
    window,
    (r) => r.source,
    (key) => key.replace(/_/g, ' '),
    totalWasteValueMinor,
  );
  const byDepartment = breakdown(
    window,
    (r) => r.departmentId,
    (key) => input.departmentNames?.[key] ?? key,
    totalWasteValueMinor,
  );

  const worst = byDepartment[0];
  const worstSource = bySource[0];

  const caveat =
    confidence === 'not_comparable'
      ? `only ${(coverageBps / 100).toFixed(0)}% of departments reported — this total is NOT comparable with any other period, and a fall in it would mean less RECORDING, not less waste. Not reporting: ${notReporting.join(', ')}`
      : confidence === 'partial'
        ? `${notReporting.length} department(s) did not report (${notReporting.join(', ')}) — the real figure is higher than this one`
        : undefined;

  return {
    branchId: input.branchId,
    from: input.from,
    to: input.to,
    totalWasteValueMinor,
    totalWasteGrams,
    records: window.length,
    coverageBps,
    notReporting,
    confidence,
    bySource,
    byDepartment,
    diversionBps,
    energyKilowattHours: input.energyKilowattHours,
    energyCostMinor: input.energyCostMinor,
    scrapProceedsMinor: input.scrapProceedsMinor,
    caveat,
    detail:
      window.length === 0
        ? `nothing recorded as waste in this window — in a hypermarket that means nobody logged it, not that nothing was thrown away`
        : worst === undefined || worstSource === undefined
          ? `${totalWasteValueMinor} of recorded waste`
          : `${totalWasteValueMinor} of waste: the biggest cause is ${worstSource.label} at ${(worstSource.shareBps / 100).toFixed(0)}%, and ${worst.label} accounts for ${(worst.shareBps / 100).toFixed(0)}% of the money`,
  };
}

export interface WasteTrendPoint {
  readonly label: string;
  readonly valueMinor: number;
  readonly coverageBps: number;
}

export interface WasteTrend {
  readonly from: WasteTrendPoint;
  readonly to: WasteTrendPoint;
  readonly changeBps: number | 'not_meaningful';
  readonly direction: 'improved' | 'worsened' | 'flat' | 'unknown';
  readonly detail: string;
}

/**
 * Compare two periods — and **refuse to call it an improvement when coverage moved**.
 *
 * This is the whole point of the module. If waste fell 18% and coverage fell from 100% to
 * 62%, the honest answer is *"we cannot tell"*, and saying so is more use to the owner than
 * a number he will repeat to somebody.
 */
export function compareWaste(input: {
  readonly from: WasteTrendPoint;
  readonly to: WasteTrendPoint;
  /** Coverage movement, in bps, beyond which the comparison is void. Default 500 (5pp). */
  readonly coverageToleranceBps?: number;
}): WasteTrend {
  const tolerance = input.coverageToleranceBps ?? 500;
  const coverageMoved = Math.abs(input.to.coverageBps - input.from.coverageBps) > tolerance;

  if (coverageMoved) {
    return {
      from: input.from,
      to: input.to,
      changeBps: 'not_meaningful',
      direction: 'unknown',
      detail: `waste went from ${input.from.valueMinor} to ${input.to.valueMinor}, but reporting coverage moved from ${(input.from.coverageBps / 100).toFixed(0)}% to ${(input.to.coverageBps / 100).toFixed(0)}% — we CANNOT say whether waste changed. A fall here would be less recording, not less waste`,
    };
  }
  if (input.from.valueMinor === 0) {
    return {
      from: input.from,
      to: input.to,
      changeBps: 'not_meaningful',
      direction: 'unknown',
      detail: 'nothing was recorded in the earlier period, so there is nothing to compare against',
    };
  }

  const changeBps = Number(
    ((BigInt(input.to.valueMinor) - BigInt(input.from.valueMinor)) * 10_000n) / BigInt(input.from.valueMinor),
  );
  const direction: WasteTrend['direction'] =
    changeBps < -100 ? 'improved' : changeBps > 100 ? 'worsened' : 'flat';

  return {
    from: input.from,
    to: input.to,
    changeBps,
    direction,
    detail:
      direction === 'flat'
        ? `waste is broadly unchanged at ${input.to.valueMinor}`
        : `waste ${direction === 'improved' ? 'fell' : 'rose'} ${Math.abs(changeBps / 100).toFixed(1)}% to ${input.to.valueMinor}, on comparable reporting coverage`,
  };
}
