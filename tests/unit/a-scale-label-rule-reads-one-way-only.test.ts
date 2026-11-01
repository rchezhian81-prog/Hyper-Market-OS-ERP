import { describe, it, expect } from 'vitest';
import {
  scaleRuleProblems, activeScaleRules, activeScaleRuleEvents, lastScaleRuleVersion, type ScaleLabelRuleEvent,
} from '../../packages/catalogue/src/scale-label-rules';
import type { EmbeddedBarcodeRule } from '../../packages/catalogue/src/catalogue';

// OB-570 "A" · M03-FR-02: the tested rule for a scale-label (variable-weight barcode) rule head office may send to the tills.
// "Weight barcodes parse to item + weight/price deterministically"; "ambiguous weight-barcode pattern rejected". Pure.

const RULE: EmbeddedBarcodeRule = { prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' };
const refusals = (r: EmbeddedBarcodeRule, active: readonly EmbeddedBarcodeRule[] = []): readonly string[] => scaleRuleProblems(r, active).map((p) => p.refusal);

describe('a scale-label rule is read one way only (M03-FR-02)', () => {
  it('the demo rule — prefix 2, item code digits 2–7, weight in grams 8–12, check digit 13 — is sound', () => {
    expect(refusals(RULE)).toEqual([]);
    expect(refusals({ ...RULE, prefix: '29', itemStart: 2, itemLength: 5, valueKind: 'price' })).toEqual([]);
    expect(refusals({ prefix: '27', itemStart: 2, itemLength: 4, valueStart: 6, valueLength: 6, valueKind: 'expiry' })).toEqual([]);
  });

  it('an ambiguous pattern is refused: a prefix equal to another, starting it, or started by it', () => {
    const other = { ...RULE, prefix: '29', itemStart: 2, itemLength: 5 };
    expect(refusals({ ...RULE, prefix: '2' }, [other])).toEqual(['prefix_overlaps_another_rule']); // "2" starts "29"
    expect(refusals(other, [RULE])).toEqual(['prefix_overlaps_another_rule']); // "29" starts with "2"
    expect(refusals({ ...other, prefix: '28' }, [other])).toEqual([]); // siblings do not overlap
    // The rule for the SAME prefix is the one being replaced, not a rival.
    expect(refusals({ ...RULE, valueKind: 'price' }, [RULE])).toEqual([]);
  });

  it('each malformed part is refused by name', () => {
    expect(refusals({ ...RULE, prefix: '2a' })).toContain('prefix_not_digits');
    expect(refusals({ ...RULE, prefix: '' })).toContain('prefix_not_digits');
    expect(refusals({ ...RULE, valueLength: 6 })).toEqual(['field_overruns_the_check_digit']);
    expect(refusals({ ...RULE, itemStart: 0 })).toEqual(['field_inside_the_prefix']);
    expect(refusals({ ...RULE, valueStart: 6 })).toContain('fields_overlap');
    expect(refusals({ ...RULE, itemLength: 0 })).toEqual(['position_not_whole']);
    expect(refusals({ ...RULE, itemStart: 1.5 })).toEqual(['position_not_whole']);
    expect(refusals({ ...RULE, valueKind: 'volume' as never })).toEqual(['value_kind_unknown']);
    expect(refusals({ ...RULE, valueKind: 'expiry' })).toEqual(['expiry_needs_six_digits']);
  });

  it('the register folds append-only: the latest event per prefix, a withdrawal takes it out, in prefix order', () => {
    const e = (prefix: string, version: number, state: 'active' | 'withdrawn', rule: EmbeddedBarcodeRule = { ...RULE, prefix }): ScaleLabelRuleEvent =>
      ({ prefix, version, state, rule, by: 'u-owner', at: `2026-11-01T0${version}:00:00Z` });
    const history = [e('29', 1, 'active', { ...RULE, prefix: '29', itemStart: 2, itemLength: 5 }), e('2', 1, 'active'), e('2', 2, 'withdrawn'), e('27', 1, 'active', { ...RULE, prefix: '27', itemStart: 2, itemLength: 5 })];
    expect(activeScaleRules(history).map((r) => r.prefix)).toEqual(['27', '29']);
    expect(activeScaleRuleEvents(history).every((x) => x.state === 'active')).toBe(true);
    expect(lastScaleRuleVersion(history, '2')).toBe(2);
    expect(lastScaleRuleVersion(history, '5')).toBe(0);
    expect(activeScaleRules([...history, e('2', 3, 'active')]).map((r) => r.prefix)).toEqual(['2', '27', '29']);
  });
});
