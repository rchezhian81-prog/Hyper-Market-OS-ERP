import { describe, it, expect } from 'vitest';
import {
  createScaleRulesSession, describeScaleRule, setByWords, ruleFromInput, scaleRuleOutcomeWords, SCALE_RULE_COPY, SCALE_RULE_COPY_KEYS,
  type ScaleRuleHttp,
} from '../../apps/web-erp/src/scale-label-rules-session';
import type { HttpAnswer } from '../../apps/web-erp/src/finance-close-session';

// OB-570 "A" · M03-FR-02: the Scale label rules panel on Products and prices — a thin client over head office's routes. It
// counts digits from 1 as printed (head office counts from 0), speaks English and Tamil, and never reports a success it did
// not get (P-08). Synthetic data only.

const RULE = { prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' as const };
const PRODUCT_USER = ['catalogue.pack.read', 'catalogue.pack.publish'];

function fakeHttp(answer: HttpAnswer): ScaleRuleHttp & { calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    get: async (path) => { calls.push({ method: 'GET', path }); return answer; },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return answer; },
  };
}

describe('the Scale label rules panel (OB-570 "A")', () => {
  it('every word has a Tamil twin, and none is left in English', () => {
    for (const k of SCALE_RULE_COPY_KEYS) {
      expect(SCALE_RULE_COPY.ta[k].trim(), k).not.toBe('');
      expect(SCALE_RULE_COPY.ta[k], k).not.toBe(SCALE_RULE_COPY.en[k]);
    }
    expect(Object.keys(SCALE_RULE_COPY.ta).sort()).toEqual([...SCALE_RULE_COPY_KEYS].sort());
  });

  it('says a rule in plain words, digits counted from 1', () => {
    expect(describeScaleRule('en', RULE)).toBe('Labels starting with 2: item code in digits 2–7, weight in grams in digits 8–12');
    expect(describeScaleRule('en', { ...RULE, prefix: '29', itemStart: 2, itemLength: 5, valueKind: 'price' })).toBe('Labels starting with 29: item code in digits 3–7, price in paise in digits 8–12');
    expect(describeScaleRule('ta', RULE)).toBe('2 இல் தொடங்கும் லேபிள்கள்: பொருள் குறியீடு இலக்கங்கள் 2–7 இல், கிராமில் எடை இலக்கங்கள் 8–12 இல்');
  });

  it('says who set it on the SHOP\'s day — 20:00 UTC on 31 Oct is already 1 Nov in the shop', () => {
    expect(setByWords('en', { by: 'u-owner', at: '2026-10-31T20:00:00Z', reason: 'deli scale' }, 'Asia/Kolkata')).toBe('set by u-owner on 2026-11-01 · deli scale');
    expect(setByWords('ta', { by: 'u-owner', at: '2026-10-31T20:00:00Z' }, 'Asia/Kolkata')).toBe('u-owner அவர்களால் 2026-11-01 அன்று அமைக்கப்பட்டது');
  });

  it('turns the typed digits (from 1) into head office\'s positions (from 0); a non-number is not sent', () => {
    expect(ruleFromInput({ prefix: ' 2 ', itemFrom: '2', itemTo: '7', valueFrom: '8', valueTo: '12', valueKind: 'weight' })).toEqual(RULE);
    expect(ruleFromInput({ prefix: '2', itemFrom: 'two', itemTo: '7', valueFrom: '8', valueTo: '12', valueKind: 'weight' })).toBeUndefined();
    expect(ruleFromInput({ prefix: '2', itemFrom: '7', itemTo: '2', valueFrom: '8', valueTo: '12', valueKind: 'weight' })).toBeUndefined();
    expect(ruleFromInput({ prefix: '', itemFrom: '2', itemTo: '7', valueFrom: '8', valueTo: '12', valueKind: 'weight' })).toBeUndefined();
  });

  it('the Product user sets a rule through head office\'s route, with the positions from 0 and the reason', async () => {
    const http = fakeHttp({ status: 201, body: { rule: { prefix: '2', version: 1, state: 'active', rule: RULE, by: 'u-owner', at: '2026-11-01T06:00:00Z' } } });
    const s = createScaleRulesSession({ permissions: PRODUCT_USER }, http);
    const out = await s.set({ prefix: '2', itemFrom: '2', itemTo: '7', valueFrom: '8', valueTo: '12', valueKind: 'weight', reason: ' deli scale ' });
    expect(http.calls).toEqual([{ method: 'POST', path: '/v1/catalogue/scale-label-rules/2', body: { itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight', reason: 'deli scale' } }]);
    expect(scaleRuleOutcomeWords('en', out)).toEqual({ ok: true, text: 'Saved at head office. The tills read labels this way after the next price update.' });
    // Stopping one is its own route — a new event, never a delete.
    await s.withdraw('2', '');
    expect(http.calls[1]).toEqual({ method: 'POST', path: '/v1/catalogue/scale-label-rules/2/withdrawal', body: {} });
  });

  it('head office\'s refusal is shown in its own words; an unreachable head office is said, never a success', async () => {
    const refused = createScaleRulesSession({ permissions: PRODUCT_USER }, fakeHttp({ status: 422, body: { error: { code: 'prefix_overlaps_another_rule', whatHappened: 'The scale-label rule for prefix "21" cannot be set: a label starting "21" would match both.', nextSafeAction: 'Nothing was saved.' } } }));
    const r = await refused.set({ prefix: '21', itemFrom: '3', itemTo: '7', valueFrom: '8', valueTo: '12', valueKind: 'weight' });
    expect(scaleRuleOutcomeWords('en', r)).toEqual({ ok: false, text: 'Head office refused: The scale-label rule for prefix "21" cannot be set: a label starting "21" would match both. Nothing was saved.' });
    const offline = createScaleRulesSession({ permissions: PRODUCT_USER }, fakeHttp({ status: 0, body: null }));
    const o = await offline.set({ prefix: '2', itemFrom: '2', itemTo: '7', valueFrom: '8', valueTo: '12', valueKind: 'weight' });
    expect(scaleRuleOutcomeWords('en', o)).toEqual({ ok: false, text: 'Head office cannot be reached — nothing was saved. Try again when the connection is back.' });
    expect(scaleRuleOutcomeWords('ta', o).text).toContain('எதுவும் சேமிக்கப்படவில்லை');
    expect((await offline.list()).kind).toBe('unreachable');
  });

  it('a person without the product role reads but cannot change; nothing is sent for them', async () => {
    const http = fakeHttp({ status: 201, body: {} });
    const s = createScaleRulesSession({ permissions: ['catalogue.pack.read'] }, http);
    expect(s.may).toEqual({ read: true, set: false });
    expect((await s.set({ prefix: '2', itemFrom: '2', itemTo: '7', valueFrom: '8', valueTo: '12', valueKind: 'weight' })).kind).toBe('not_allowed');
    expect((await s.withdraw('2')).kind).toBe('not_allowed');
    expect(http.calls).toEqual([]);
  });
});
