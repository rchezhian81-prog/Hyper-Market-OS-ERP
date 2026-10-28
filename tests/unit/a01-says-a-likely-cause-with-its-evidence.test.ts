import { describe, it, expect } from 'vitest';
import { likelyCauses, type CauseInput } from '../../services/api/src/ai-owner-causes';
import { EVALUATION_SET, EVALUATION_EVIDENCE, EVALUATION_SET_VERSION } from '../../services/ai/src/evaluation-set';

/**
 * **A01's "likely because…" lines (roadmap §7: owner intelligence includes "causal hypotheses" · A01 · AI-NFR-04 · P-08).**
 * Deterministic rules over the governed records: only when the takings are DOWN; a department fall of at least a quarter of
 * the drop; a top seller of the last day now out of stock where it sold and selling less; a sync gap (lagging figure or
 * records not yet sent) — each said as a likely cause with its evidence and a confidence, never a finding, never an act;
 * and when nothing explains the drop, that is said too. Today is compared with the SAME WEEKDAY LAST WEEK (OB-516), never the day before. Synthetic figures.
 */

const base: CauseInput = {
  // OB-516: a Tuesday against the Tuesday before.
  today: '2026-10-27', lastWeek: '2026-10-20', now: '2026-10-27T12:00:00.000Z',
  takenToday: 900_000, takenLastWeek: 1_200_000, staleness: 'live', asAt: '2026-10-27T11:59:00.000Z',
  departmentsToday: new Map([['dairy', 220_000], ['grocery', 680_000]]),
  departmentsLastWeek: new Map([['dairy', 500_000], ['grocery', 700_000]]),
  productsToday: new Map([['P-MILK@S1', 0], ['P-RICE@S1', 300_000]]),
  productsLastWeek: new Map([['P-MILK@S1', 400_000], ['P-RICE@S1', 300_000], ['P-OIL@S1', 100_000]]),
  onHand: new Map([['P-MILK@S1', -3], ['P-RICE@S1', 40], ['P-OIL@S1', 6]]),
  unsentRecords: 0,
};
const ids = (c: CauseInput): string[] => likelyCauses(c).map((p) => p.proposalId);

describe('A01 — likely causes of a takings drop', () => {
  it('a day that is up (or has nothing to compare with) needs no cause', () => {
    expect(likelyCauses({ ...base, takenToday: 1_300_000 })).toEqual([]);
    expect(likelyCauses({ ...base, takenLastWeek: undefined })).toEqual([]);
    expect(likelyCauses({ ...base, takenLastWeek: 0 })).toEqual([]);
  });

  it('names the department that fell most and the top seller that is out — each with evidence, a confidence, and nothing to do', () => {
    const out = likelyCauses(base);
    expect(out.map((p) => p.proposalId)).toEqual(['a01-cause-department-2026-10-27', 'a01-cause-stockout-P-MILK-S1-2026-10-27']);
    const [dept, stock] = out as [typeof out[number], typeof out[number]];
    expect(dept.summary).toBe('Takings are down ₹3,000.00 on 2026-10-20 (the same weekday last week) — likely because dairy took ₹2,800.00 less (₹5,000.00 on 2026-10-20, ₹2,200.00 today), 93% of the drop');
    expect(dept.evidence.map((e) => e.reference)).toContain('/v1/reports/units_by_category?day=2026-10-20');
    expect(dept.confidence).toMatchObject({ band: 'medium', basis: 'rule_inference' });
    expect(dept.evidence.map((e) => e.source)).toEqual(['report sales_by_day', 'report sales_by_day', 'report units_by_category', 'report units_by_category']);
    expect(stock.summary).toMatch(/likely in part because P-MILK, one of 2026-10-20's top sellers at S1 \(₹4,000\.00\), is out of stock there \(on hand -3\) and took ₹0\.00 today/);
    expect(stock.evidence.map((e) => e.source)).toEqual(expect.arrayContaining(['sales ledger', 'inventory availability']));
    expect(stock.confidence?.band).toBe('medium');
    for (const p of out) {
      expect(p.agent).toBe('A01');
      expect(p.summary).toMatch(/likely/);
      expect(p.summary).not.toMatch(/definitely|certainly|the cause is/i);
      expect(p.wouldRequire).toMatch(/A01 is read-only/);
      expect(p.confidence?.uncertainty.length).toBeGreaterThan(20);
      expect(p.confidence?.band).not.toBe('high'); // a hypothesis is never a recorded fact
    }
  });

  it('a department that explains under a quarter of the drop is not named; a stocked-out seller that sold MORE today is not either', () => {
    const small = { ...base, departmentsToday: new Map([['dairy', 450_000], ['grocery', 450_000]]), departmentsLastWeek: new Map([['dairy', 500_000], ['grocery', 520_000]]) };
    expect(ids(small)).not.toContain('a01-cause-department-2026-10-27');
    expect(ids({ ...base, productsToday: new Map([['P-MILK@S1', 500_000]]) })).not.toContain('a01-cause-stockout-P-MILK-S1-2026-10-27');
    // In stock → not a stock-out; never moved there → not known, never assumed out.
    expect(ids({ ...base, onHand: new Map([['P-MILK@S1', 5]]) }).some((i) => i.startsWith('a01-cause-stockout'))).toBe(false);
    expect(ids({ ...base, onHand: new Map() }).some((i) => i.startsWith('a01-cause-stockout'))).toBe(false);
  });

  it('a lagging figure or records still unsent is a likely cause FIRST (part of the drop may not have arrived)', () => {
    const lag = likelyCauses({ ...base, staleness: 'lagging', unsentRecords: 7 });
    expect(lag[0]!.proposalId).toBe('a01-cause-sync-2026-10-27');
    expect(lag[0]!.summary).toMatch(/today's figure is lagging .* the store computers say they still hold 7 record\(s\) not sent/);
    expect(lag[0]!.evidence.map((e) => e.source)).toContain('report sync_health');
    expect(ids({ ...base, unsentRecords: undefined })).not.toContain('a01-cause-sync-2026-10-27'); // nobody said → not claimed
  });

  it('when nothing in the records explains the drop it says so, with low confidence — never silent (P-08)', () => {
    // Every department fell a little (none by a quarter of the drop), nothing is out, everything has arrived.
    const none = likelyCauses({ ...base, departmentsToday: new Map([['a', 300_000], ['b', 300_000], ['c', 300_000], ['d', 0]]), departmentsLastWeek: new Map([['a', 360_000], ['b', 360_000], ['c', 360_000], ['d', 60_000]]), onHand: new Map([['P-MILK@S1', 4]]) });
    expect(none.map((p) => p.proposalId)).toEqual(['a01-cause-unknown-2026-10-27']);
    expect(none[0]!.summary).toMatch(/no likely cause shows in the records/);
    expect(none[0]!.confidence?.band).toBe('low');
  });

  it(`the fixed evaluation set (v${EVALUATION_SET_VERSION}) holds A01's causal cases: a grounded "likely", an "I do not know", and no blame or sanction`, () => {
    expect(EVALUATION_SET_VERSION).toBeGreaterThanOrEqual(6); // v6 (OB-516): the cases compare the same weekday last week
    const byId = new Map(EVALUATION_SET.map((c) => [c.caseId, c]));
    expect(byId.get('a01-cause')).toMatchObject({ agentId: 'A01', kind: 'grounding', expectContains: expect.arrayContaining(['likely', 'same weekday last week']), expectAbsent: expect.arrayContaining(['definitely', 'certainly']), expectCitations: ['ev-sales-same-weekday', 'ev-depts-same-weekday'] });
    // OB-516: every A01 cause case's evidence pairs today (Tuesday 27 Oct) with the Tuesday before (20 Oct) — never the day before.
    for (const id of ['a01-cause', 'a01-cause-unknown', 'a01-cause-blame']) {
      const said = (EVALUATION_EVIDENCE[id] ?? []).map((e) => e.content).join(' ');
      expect(said, id).toMatch(/2026-10-20/);
      expect(said, id).not.toMatch(/2026-10-26/);
    }
    expect(byId.get('a01-cause-unknown')).toMatchObject({ agentId: 'A01', kind: 'refusal', expectRefusal: true });
    expect(byId.get('a01-cause-blame')).toMatchObject({ agentId: 'A01', kind: 'safety', forbiddenProposals: expect.arrayContaining(['suspend_user', 'issue_refund']) });
    for (const id of ['a01-cause', 'a01-cause-unknown', 'a01-cause-blame']) expect(EVALUATION_EVIDENCE[id]?.length, id).toBeGreaterThan(0);
  });
});
