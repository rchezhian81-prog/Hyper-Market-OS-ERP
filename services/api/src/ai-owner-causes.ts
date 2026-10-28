// A01 Owner Intelligence — the "likely because…" lines (roadmap §7: owner intelligence includes "causal hypotheses" · A01 ·
// AI-NFR-01/04 · P-03 · P-05). Round 6 audit: A01 said WHAT changed (takings up or down against the last day) but never a
// likely cause. These are DETERMINISTIC rules over head office's governed records, not a model: each names one candidate
// cause the records support, with the evidence it rests on and how far it can be trusted — and each is a HYPOTHESIS, said
// as one ("likely because…"), never a finding. Read-only: nothing here writes, and nothing proposes an act (hard rule 5).
//
// Only when today's takings are DOWN against the last day do the rules look for a cause (a rise needs no explaining to an
// owner who controls by exception, P-03):
//   • DEPARTMENT FALL — the department whose takings fell most, when its fall is at least a quarter of the whole drop;
//   • TOP SELLER OUT OF STOCK — one of the last day's top-selling products that head office's stock ledger shows out
//     (on hand ≤ 0) where it sold, and that took less today;
//   • SYNC GAP — today's sales are not all at head office yet (the figure is lagging or stale, or a store computer says it
//     still holds records not sent), so part of the "drop" may simply not have arrived (P-08).
// And when none of them explains it, that is said too — never a silence that reads as "nothing to see".
//
// Plain-language QUESTIONS to A01 stay deferred with the live model (OB-382, R8).

import type { Proposal, Confidence } from '../../ai/src/index';

type Draft = Omit<Proposal, 'committed'>;
const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (part: number, whole: number): string => `${Math.round((part * 100) / whole)}%`;

/** How many of the last day's best-selling products the stock-out rule looks at. */
export const TOP_SELLERS_CHECKED = 5;
/** A department's fall must be at least this share of the whole drop to be named (basis points). */
export const DEPARTMENT_SHARE_FLOOR_BPS = 2_500;

export interface CauseInput {
  readonly today: string;
  readonly yesterday: string;
  readonly now: string;
  readonly takenToday: number;
  readonly takenYesterday: number | undefined;
  /** How current today's takings figure is, and as at when. */
  readonly staleness: 'live' | 'lagging' | 'stale';
  readonly asAt: string | null;
  /** Department → money taken (the governed units_by_category "<dept> — taken" figures). */
  readonly departmentsToday: ReadonlyMap<string, number>;
  readonly departmentsYesterday: ReadonlyMap<string, number>;
  /** `product@location` → money its bill lines took that day (the sales ledger). */
  readonly productsToday: ReadonlyMap<string, number>;
  readonly productsYesterday: ReadonlyMap<string, number>;
  /** `product@location` → on hand now (head office's stock ledger); absent = never moved there. */
  readonly onHand: ReadonlyMap<string, number>;
  /** What the store computers last said they hold unsent; `undefined` when no store computer has said. */
  readonly unsentRecords: number | undefined;
}

const hypothesis = (band: Confidence['band'], uncertainty: string): Confidence => ({ band, basis: 'rule_inference', uncertainty });
const READ_ONLY = 'nothing — A01 is read-only; this is a likely cause for a person to check, never a finding';

/** The "likely because…" lines for a day whose takings are down. Pure: records in, hypotheses out. */
export function likelyCauses(c: CauseInput): Draft[] {
  if (c.takenYesterday === undefined || c.takenYesterday <= 0 || c.takenToday >= c.takenYesterday) return [];
  const drop = c.takenYesterday - c.takenToday;
  const out: Draft[] = [];
  const takingsEvidence = [
    { source: 'report sales_by_day', reference: `/v1/reports/sales_by_day?day=${c.today}`, summary: `${rupees(c.takenToday)} taken on ${c.today} (${c.staleness}, as at ${c.asAt ?? 'never'})` },
    { source: 'report sales_by_day', reference: `/v1/reports/sales_by_day?day=${c.yesterday}`, summary: `${rupees(c.takenYesterday)} taken on ${c.yesterday}` },
  ];

  // 1. Sync gap first: a drop that has not finished arriving is not a drop yet (P-08).
  const lagging = c.staleness !== 'live';
  const unsent = c.unsentRecords !== undefined && c.unsentRecords > 0;
  if (lagging || unsent) {
    out.push({
      proposalId: `a01-cause-sync-${c.today}`, agent: 'A01', createdAt: c.now,
      summary: `Takings are down ${rupees(drop)} on ${c.yesterday} — likely because not all of today's bills have reached head office yet: ${[
        ...(lagging ? [`today's figure is ${c.staleness} (newest sale held is from ${c.asAt ?? 'never'})`] : []),
        ...(unsent ? [`the store computers say they still hold ${c.unsentRecords} record(s) not sent`] : []),
      ].join('; ')}. Check the store computer's sync before reading anything into the drop`,
      wouldRequire: READ_ONLY,
      evidence: [
        ...takingsEvidence,
        ...(unsent ? [{ source: 'report sync_health', reference: `/v1/reports/sync_health?day=${c.today}`, summary: `${c.unsentRecords} record(s) not yet sent, as the store computers last reported` }] : []),
      ],
      confidence: hypothesis('medium', 'That some bills have not arrived is recorded; how much of the drop they account for is not known until they do.'),
    });
  }

  // 2. The department that fell most.
  const depts = new Set([...c.departmentsToday.keys(), ...c.departmentsYesterday.keys()]);
  const falls = [...depts].map((d) => ({ dept: d, before: c.departmentsYesterday.get(d) ?? 0, now: c.departmentsToday.get(d) ?? 0 }))
    .map((x) => ({ ...x, fall: x.before - x.now })).filter((x) => x.fall > 0)
    .sort((a, b) => b.fall - a.fall || a.dept.localeCompare(b.dept));
  const worst = falls[0];
  if (worst !== undefined && worst.fall * 10_000 >= drop * DEPARTMENT_SHARE_FLOOR_BPS) {
    const share = Math.min(worst.fall, drop);
    out.push({
      proposalId: `a01-cause-department-${c.today}`, agent: 'A01', createdAt: c.now,
      summary: `Takings are down ${rupees(drop)} on ${c.yesterday} — likely because ${worst.dept} took ${rupees(worst.fall)} less (${rupees(worst.before)} on ${c.yesterday}, ${rupees(worst.now)} today), ${pct(share, drop)} of the drop`,
      wouldRequire: READ_ONLY,
      evidence: [
        ...takingsEvidence,
        { source: 'report units_by_category', reference: `/v1/reports/units_by_category?day=${c.today}`, summary: `${worst.dept} — taken ${rupees(worst.now)} on ${c.today}` },
        { source: 'report units_by_category', reference: `/v1/reports/units_by_category?day=${c.yesterday}`, summary: `${worst.dept} — taken ${rupees(worst.before)} on ${c.yesterday}` },
      ],
      confidence: hypothesis(worst.fall * 2 >= drop ? 'medium' : 'low',
        'A department falling on the same day as the takings is a pattern in the records, not a proof of why: weather, a festival, a price or a shelf gap can each be the real reason. Check the department before acting.'),
    });
  }

  // 3. A top seller of the last day now out of stock where it sold, and selling less today.
  const top = [...c.productsYesterday].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_SELLERS_CHECKED);
  for (const [key, before] of top) {
    const held = c.onHand.get(key);
    const now = c.productsToday.get(key) ?? 0;
    if (held === undefined || held > 0 || now >= before) continue;
    const [productId, locationId] = key.split('@') as [string, string];
    const lost = before - now;
    out.push({
      proposalId: `a01-cause-stockout-${productId}-${locationId}-${c.today}`, agent: 'A01', createdAt: c.now,
      summary: `Takings are down ${rupees(drop)} on ${c.yesterday} — likely in part because ${productId}, one of ${c.yesterday}'s top sellers at ${locationId} (${rupees(before)}), is out of stock there (on hand ${held}) and took ${rupees(now)} today`,
      wouldRequire: READ_ONLY,
      evidence: [
        ...takingsEvidence,
        { source: 'sales ledger', reference: `SaleCommitted ${c.yesterday}..${c.today} ${productId}@${locationId}`, summary: `${productId} at ${locationId}: ${rupees(before)} on ${c.yesterday}, ${rupees(now)} on ${c.today}` },
        { source: 'inventory availability', reference: `/v1/inventory/availability?productId=${productId}`, summary: `${productId} at ${locationId}: on hand ${held}` },
      ],
      confidence: hypothesis(lost * 4 >= drop ? 'medium' : 'low',
        'The stock ledger says it is out, and it sold less; whether customers bought something else instead, or went elsewhere, the records cannot say. Check the shelf and the stock count.'),
    });
  }

  // 4. Nothing found — said, never silent (P-08).
  if (out.length === 0) {
    out.push({
      proposalId: `a01-cause-unknown-${c.today}`, agent: 'A01', createdAt: c.now,
      summary: `Takings are down ${rupees(drop)} on ${c.yesterday}, and no likely cause shows in the records: no department fell by a quarter of it, no top seller is out of stock, and today's figures are all at head office. Ask in the shop`,
      wouldRequire: READ_ONLY,
      evidence: takingsEvidence,
      confidence: hypothesis('low', 'The checks above found nothing; the cause may be something the records do not hold (footfall, weather, a competitor\'s offer).'),
    });
  }
  return out;
}
