import { describe, it, expect } from 'vitest';
import {
  buildDataQualityWorklist,
  type DataQualityFinding,
  type SuggestionDisposition,
} from '../../packages/product/src/index';

// A08 "suggestions inbox" (§7.1 / P-05) — the steward's worklist folds the live, re-derived findings
// together with the stewards' persisted DISMISSALS. Fixing a gap makes its finding vanish on its own
// (self-healing, tested in the detector suite); dismissing is the one explicit, recorded human
// judgement that a finding is not a problem. Nothing here is an AI write.

const finding = (findingId: string, headline = 'x'): DataQualityFinding => ({
  findingId,
  kind: 'missing_barcode',
  productIds: [findingId],
  confidence: 'certain',
  headline,
  detail: 'd',
  evidence: [{ productId: findingId, sku: 'SKU', name: 'n', note: 'note' }],
});

const dismissal = (findingId: string, reason = 'not a problem'): SuggestionDisposition =>
  ({ findingId, dismissed: true, by: 'u-steward', at: '2026-09-13T00:00:00Z', reason });

describe('buildDataQualityWorklist — a steward inbox that never drifts from the live master', () => {
  it('lists every finding as open when there are no dispositions', () => {
    const wl = buildDataQualityWorklist({ findings: [finding('a'), finding('b')], dispositions: [] });
    expect(wl.openCount).toBe(2);
    expect(wl.dismissedCount).toBe(0);
    expect(wl.open.map((i) => i.finding.findingId)).toEqual(['a', 'b']);
    expect(wl.open.every((i) => i.status === 'open' && i.dismissal === undefined)).toBe(true);
  });

  it('moves a dismissed finding out of open and into dismissed, carrying who/when/why', () => {
    const wl = buildDataQualityWorklist({
      findings: [finding('a'), finding('b')],
      dispositions: [dismissal('a', 'these two are genuinely different products')],
    });
    expect(wl.open.map((i) => i.finding.findingId)).toEqual(['b']);
    expect(wl.dismissed.map((i) => i.finding.findingId)).toEqual(['a']);
    expect(wl.dismissed[0]!.dismissal).toMatchObject({ by: 'u-steward', reason: 'these two are genuinely different products' });
  });

  it('a reopen (dismissed:false) returns a finding to the open list', () => {
    const reopened: SuggestionDisposition = { ...dismissal('a'), dismissed: false, reason: '' };
    const wl = buildDataQualityWorklist({ findings: [finding('a')], dispositions: [reopened] });
    expect(wl.open.map((i) => i.finding.findingId)).toEqual(['a']);
    expect(wl.dismissedCount).toBe(0);
  });

  it('a dismissal of a finding that is no longer present is moot — it does not appear at all', () => {
    // The gap was fixed, so the detector no longer produces finding "a"; the old dismissal is inert.
    const wl = buildDataQualityWorklist({ findings: [finding('b')], dispositions: [dismissal('a')] });
    expect(wl.open.map((i) => i.finding.findingId)).toEqual(['b']);
    expect(wl.dismissed).toEqual([]);
  });

  it('applies the latest disposition per finding id when several are supplied in order', () => {
    // Defensive: even if the caller passes a history rather than latest-per-id, last wins.
    const wl = buildDataQualityWorklist({
      findings: [finding('a')],
      dispositions: [dismissal('a'), { ...dismissal('a'), dismissed: false, reason: '' }],
    });
    expect(wl.openCount).toBe(1);
    expect(wl.dismissedCount).toBe(0);
  });

  it('preserves the detector order in the open list (stable, deterministic)', () => {
    const wl = buildDataQualityWorklist({
      findings: [finding('z'), finding('a'), finding('m')],
      dispositions: [],
    });
    expect(wl.open.map((i) => i.finding.findingId)).toEqual(['z', 'a', 'm']);
  });
});
