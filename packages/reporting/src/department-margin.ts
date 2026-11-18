// D-057 (owner, 18 Nov 2026, under OB-801): the margin per department on the department sales report — on head office's
// report and on the store computer's alike, worked out the same way, from the costs the system already holds.
//
// A line's margin is what it took before GST (its inclusive line money, split at its GST rate, as the day book splits it)
// less what its goods cost at head office's AVERAGE BUYING COST (OB-39 "B" — the same cost the Today margin and the
// profitability report use). A department's margin is known only when EVERY one of its lines has a cost, a rate and its
// line money; otherwise it is "Not known — N lines had no cost", with the count. Never a guessed cost, never a zero cost
// (a zero cost is a 100% margin) — P-08. Pure.

import { splitInclusive } from '../../finance/src/day-book';

export interface MarginLine {
  /** What the till charged on the line, GST included (after the line's own discount); undefined when the till did not say. */
  readonly grossMinor: number | undefined;
  /** The line's GST rate in basis points; undefined when not known. */
  readonly taxBps: number | undefined;
  /** The line's goods at the average buying cost; undefined when the product has no cost. */
  readonly costMinor: number | undefined;
}

export interface DepartmentMargin {
  readonly lines: number;
  /** Known only when every line has a cost, a rate and its line money; else null (and the counts say why). */
  readonly netMinor: number | null;
  readonly costMinor: number | null;
  readonly marginMinor: number | null;
  /** Margin as basis points of the net; null when not known or the net is zero. */
  readonly marginBps: number | null;
  readonly linesWithNoCost: number;
  readonly linesWithNoRate: number;
  readonly linesWithNoMoney: number;
}

export function departmentMargin(lines: readonly MarginLine[]): DepartmentMargin {
  let net = 0; let cost = 0; let noCost = 0; let noRate = 0; let noMoney = 0;
  for (const l of lines) {
    if (l.costMinor === undefined) noCost += 1; else cost += l.costMinor;
    if (l.grossMinor === undefined) { noMoney += 1; continue; }
    if (l.taxBps === undefined) { noRate += 1; continue; }
    net += splitInclusive(l.grossMinor, l.taxBps).net;
  }
  const known = noCost === 0 && noRate === 0 && noMoney === 0;
  const marginMinor = known ? net - cost : null;
  return {
    lines: lines.length,
    netMinor: known ? net : null, costMinor: known ? cost : null, marginMinor,
    marginBps: marginMinor === null || net === 0 ? null : Math.round((marginMinor * 10_000) / net),
    linesWithNoCost: noCost, linesWithNoRate: noRate, linesWithNoMoney: noMoney,
  };
}

/** Why a department's margin is not known, in words — or undefined when it is known. */
export function marginNotKnownWhy(m: DepartmentMargin): string | undefined {
  if (m.marginMinor !== null) return undefined;
  const parts: string[] = [];
  if (m.linesWithNoCost > 0) parts.push(`${m.linesWithNoCost} line${m.linesWithNoCost === 1 ? '' : 's'} had no cost`);
  if (m.linesWithNoRate > 0) parts.push(`${m.linesWithNoRate} line${m.linesWithNoRate === 1 ? '' : 's'} had no GST rate`);
  if (m.linesWithNoMoney > 0) parts.push(`${m.linesWithNoMoney} line${m.linesWithNoMoney === 1 ? '' : 's'} came from a till that did not write what it charged`);
  return `Not known — ${parts.join(', ')}`;
}
