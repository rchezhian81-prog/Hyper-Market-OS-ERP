import { describe, it, expect } from 'vitest';
import { FINDING_KINDS, kindWords, groupFindings, FINDINGS_COPY, type BillFinding } from '../../apps/web-erp/src/findings-session';

/**
 * **U5 (UI/UX gap audit, lane 3 HARD): the Bill findings page groups and counts what head office found.**
 *
 * The audit: 48 identical cards in one 9,000-pixel column — a manager could not see what KIND of finding there was, nor
 * how many of each. The page now groups the findings by kind, each group a register with paging, with a count per kind
 * at the top. This proves the session's side: every kind head office raises has its words in both languages (a kind the
 * page does not know is shown as head office named it, never hidden), and the grouping puts the kind with the most
 * critical findings first, then the largest, each group critical first.
 */
const f = (kind: string, severity: 'critical' | 'material', saleId: string): BillFinding => ({ kind, severity, saleId, detail: `d ${saleId}`, ownerAction: '' });

describe('U5: the Bill findings page groups and counts', () => {
  it('every kind head office raises has English and Tamil words; an unknown kind keeps head office\'s name', () => {
    expect(FINDING_KINDS.length).toBeGreaterThanOrEqual(12);
    for (const kind of FINDING_KINDS) {
      expect(kindWords('en', kind), kind).not.toBe(kind);
      expect(kindWords('ta', kind), kind).not.toBe(kind);
      expect(kindWords('ta', kind), kind).not.toBe(kindWords('en', kind));
    }
    expect(kindWords('en', 'some_new_rule_head_office_added')).toBe('some_new_rule_head_office_added');
    expect(Object.keys(FINDINGS_COPY.ta).sort()).toEqual(Object.keys(FINDINGS_COPY.en).sort());
  });

  it('groups by kind: the most critical findings first, then by count, each group critical first; counts per group', () => {
    const groups = groupFindings([
      f('price_cut_below_floor', 'material', 'S-1'), f('price_cut_below_floor', 'material', 'S-2'), f('price_cut_below_floor', 'material', 'S-3'),
      f('sold_above_mrp', 'material', 'S-4'), f('sold_above_mrp', 'critical', 'S-5'),
      f('receipt_number_reused', 'material', 'S-6'),
    ]);
    expect(groups.map((g) => [g.kind, g.count, g.critical, g.material])).toEqual([
      ['sold_above_mrp', 2, 1, 1], ['price_cut_below_floor', 3, 0, 3], ['receipt_number_reused', 1, 0, 1],
    ]);
    expect(groups[0]!.findings.map((x) => x.saleId)).toEqual(['S-5', 'S-4']);
    expect(groups[0]!.worst).toBe('critical');
    expect(groups[1]!.worst).toBe('material');
  });
});
