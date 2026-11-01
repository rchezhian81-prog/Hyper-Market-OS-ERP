// Scale-label rules (M03-FR-02 "configure variable-weight barcode parsing" · OB-570 "A") — the tested rule for what head
// office may put in the signed pack as an `EmbeddedBarcodeRule`, and how the register of them folds.
//
// A scale prints a 13-digit EAN label: a prefix, the item code, the weight (or price, or use-by date) and a check digit
// last. The till reads it with `Catalogue.scan` → `decodeEmbedded`, offline, trying the pack's rules in order. That is
// only deterministic when no two rules could both read the same label — so a rule whose prefix is equal to, or starts, or
// is started by, another ACTIVE rule's prefix is refused as ambiguous ("ambiguous weight-barcode pattern rejected").
// Positions are 0-based (the shape the till reads); the office screen shows them 1-based.
//
// Append-only (hard rule #2): the register is a list of events — a rule set (a new version for its prefix) or withdrawn —
// and what is in force is the latest event per prefix. Nothing here has a clock or a store; the route supplies both.

import type { EmbeddedBarcodeRule } from './catalogue';

/** An EAN-13 label: digits 0..11 carry the data, digit 12 is the GS1 check digit. */
export const SCALE_LABEL_LENGTH = 13;
const CHECK_DIGIT_AT = SCALE_LABEL_LENGTH - 1;

export const SCALE_VALUE_KINDS: readonly EmbeddedBarcodeRule['valueKind'][] = Object.freeze(['weight', 'price', 'expiry']);

/** Why a rule cannot be used — each named, so the person fixing it reads which part is wrong. */
export type ScaleRuleRefusal =
  | 'prefix_not_digits'
  | 'position_not_whole'
  | 'field_overruns_the_check_digit'
  | 'field_inside_the_prefix'
  | 'fields_overlap'
  | 'value_kind_unknown'
  | 'expiry_needs_six_digits'
  | 'prefix_overlaps_another_rule';

export interface ScaleRuleProblem {
  readonly refusal: ScaleRuleRefusal;
  readonly detail: string;
}

/** One event on the register: a rule set for its prefix (a new version), or the prefix's rule withdrawn. */
export interface ScaleLabelRuleEvent {
  readonly prefix: string;
  /** Per prefix, 1, 2, 3 … — a change or a withdrawal is the next version, never an overwrite. */
  readonly version: number;
  readonly state: 'active' | 'withdrawn';
  /** The rule as set; on a withdrawal, the rule that stopped (so the record reads on its own). */
  readonly rule: EmbeddedBarcodeRule;
  readonly reason?: string;
  readonly by: string;
  readonly at: string;
}

const isWhole = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;

/**
 * Everything wrong with a rule, judged against the rules in force (`others` — the one being replaced, same prefix, is
 * left out by the caller or ignored here). Empty = it may be set. Pure.
 */
export function scaleRuleProblems(rule: EmbeddedBarcodeRule, active: readonly EmbeddedBarcodeRule[]): readonly ScaleRuleProblem[] {
  const problems: ScaleRuleProblem[] = [];
  const { prefix } = rule;
  if (typeof prefix !== 'string' || !/^\d+$/.test(prefix) || prefix.length >= CHECK_DIGIT_AT) {
    problems.push({ refusal: 'prefix_not_digits', detail: `the prefix must be 1 to ${CHECK_DIGIT_AT - 1} digits and nothing else (got "${String(prefix)}")` });
  }
  if (!(SCALE_VALUE_KINDS as readonly string[]).includes(rule.valueKind)) {
    problems.push({ refusal: 'value_kind_unknown', detail: `what the label carries must be weight, price or expiry (got "${String(rule.valueKind)}")` });
  }
  const positions = [rule.itemStart, rule.valueStart].every((v) => isWhole(v, 0)) && [rule.itemLength, rule.valueLength].every((v) => isWhole(v, 1));
  if (!positions) {
    problems.push({ refusal: 'position_not_whole', detail: 'each start must be a whole number from 0 and each length a whole number from 1' });
    return problems;
  }
  const fields = [['item code', rule.itemStart, rule.itemLength], [rule.valueKind ?? 'value', rule.valueStart, rule.valueLength]] as const;
  for (const [name, start, length] of fields) {
    if (start + length > CHECK_DIGIT_AT) {
      problems.push({ refusal: 'field_overruns_the_check_digit', detail: `the ${name} runs to digit ${start + length} of ${SCALE_LABEL_LENGTH}; digit ${SCALE_LABEL_LENGTH} is the check digit and nothing else may sit there` });
    }
    if (typeof prefix === 'string' && start < prefix.length) {
      problems.push({ refusal: 'field_inside_the_prefix', detail: `the ${name} starts at digit ${start + 1}, inside the ${prefix.length}-digit prefix "${prefix}"` });
    }
  }
  if (rule.itemStart < rule.valueStart + rule.valueLength && rule.valueStart < rule.itemStart + rule.itemLength) {
    problems.push({ refusal: 'fields_overlap', detail: 'the item code and the value share digits, so neither could be read with certainty' });
  }
  if (rule.valueKind === 'expiry' && rule.valueLength !== 6) {
    problems.push({ refusal: 'expiry_needs_six_digits', detail: `a use-by date is printed as 6 digits YYMMDD (got ${rule.valueLength})` });
  }
  if (typeof prefix === 'string') {
    for (const other of active) {
      if (other.prefix === prefix) continue; // the rule this one replaces
      if (other.prefix.startsWith(prefix) || prefix.startsWith(other.prefix)) {
        problems.push({ refusal: 'prefix_overlaps_another_rule', detail: `a label starting "${prefix.length >= other.prefix.length ? prefix : other.prefix}" would match both this rule and the rule for prefix "${other.prefix}", so the till could read it two ways` });
      }
    }
  }
  return problems;
}

/** The latest event per prefix, in prefix order. */
function latestPerPrefix(history: readonly ScaleLabelRuleEvent[]): readonly ScaleLabelRuleEvent[] {
  const latest = new Map<string, ScaleLabelRuleEvent>();
  for (const e of history) {
    const cur = latest.get(e.prefix);
    if (cur === undefined || e.version > cur.version) latest.set(e.prefix, e);
  }
  return [...latest.values()].sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
}

/** The rules in force — each prefix's latest event when it is a set, not a withdrawal — with who set each and when. */
export function activeScaleRuleEvents(history: readonly ScaleLabelRuleEvent[]): readonly ScaleLabelRuleEvent[] {
  return latestPerPrefix(history).filter((e) => e.state === 'active');
}

/** The rules in force as the pack carries them: just the rule, in prefix order (a stable, signed order). */
export function activeScaleRules(history: readonly ScaleLabelRuleEvent[]): readonly EmbeddedBarcodeRule[] {
  return activeScaleRuleEvents(history).map((e) => ({
    prefix: e.rule.prefix, itemStart: e.rule.itemStart, itemLength: e.rule.itemLength,
    valueStart: e.rule.valueStart, valueLength: e.rule.valueLength, valueKind: e.rule.valueKind,
  }));
}

/** The prefix's latest version number, 0 when it was never set. */
export function lastScaleRuleVersion(history: readonly ScaleLabelRuleEvent[], prefix: string): number {
  return history.filter((e) => e.prefix === prefix).reduce((n, e) => Math.max(n, e.version), 0);
}

export const sameScaleRule = (a: EmbeddedBarcodeRule, b: EmbeddedBarcodeRule): boolean =>
  a.prefix === b.prefix && a.itemStart === b.itemStart && a.itemLength === b.itemLength
  && a.valueStart === b.valueStart && a.valueLength === b.valueLength && a.valueKind === b.valueKind;
