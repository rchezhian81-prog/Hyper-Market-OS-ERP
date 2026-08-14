import { describe, it, expect } from 'vitest';
import {
  createCategoryPolicySession, statusOf, CATEGORY_POLICY_COPY, COPY_KEYS,
  type CategoryPolicyPorts,
} from '../../apps/web-erp/src/category-policy-session';
import { presetPolicy, type CategoryPolicy } from '../../packages/product/src/index';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **Category rules — the operator view (M03-FR-01·CAT-POLICY).**
 *
 * The screen reads the effective-dated policy engine and surfaces the ones that need attention: a controlled
 * vertical shipped OFF (gold, pharmacy-lite), an age/KYC/PAN/serial control, a blocked category, or a
 * sellable category with NO policy in force. Read-only — nothing here changes a rule.
 */

const DAY = '2026-08-14';

const cats = (): CategoryPolicy[] => [
  presetPolicy('grocery', 'grocery_fmcg', '2026-01-01'),        // ok
  presetPolicy('gold', 'gold_jewellery', '2026-01-01'),         // controlled (ships OFF)
  presetPolicy('rx', 'prescription_blocked', '2026-01-01'),     // blocked
  { categoryId: 'future', history: [{ effectiveFrom: '2099-01-01', value: presetPolicy('x', 'grocery_fmcg', '2099-01-01').history[0]!.value }] }, // no policy in force yet
];

const ports = (over: Partial<CategoryPolicyPorts> = {}): CategoryPolicyPorts => ({
  mayRead: () => true,
  categories: () => cats(),
  onDate: DAY,
  ...over,
});

const session = (over: Partial<CategoryPolicyPorts> = {}, userId: string | null = 'u-cat') =>
  createCategoryPolicySession({ userId }, ports(over));

describe('statusOf', () => {
  it('classifies grocery as ok, gold/pharmacy as controlled, prescription as blocked, none as no_policy', () => {
    expect(statusOf(presetPolicy('g', 'grocery_fmcg', DAY).history[0]!.value)).toBe('ok');
    expect(statusOf(presetPolicy('g', 'gold_jewellery', DAY).history[0]!.value)).toBe('controlled');
    expect(statusOf(presetPolicy('g', 'otc_pharma_lite', DAY).history[0]!.value)).toBe('controlled');
    expect(statusOf(presetPolicy('g', 'prescription_blocked', DAY).history[0]!.value)).toBe('blocked');
    expect(statusOf(undefined)).toBe('no_policy');
  });
});

describe('view', () => {
  it('puts the ones needing attention first, each with a word + icon status (never colour alone)', () => {
    const v = session().view('en');
    expect(v.total).toBe(4);
    // gold (controlled) and future (no_policy) need attention; grocery/rx do not.
    expect(v.attentionCount).toBe(2);
    expect(v.categories.slice(0, 2).map((c) => c.categoryId).sort()).toEqual(['future', 'gold']);
    for (const c of v.categories) {
      expect(c.status.label.length).toBeGreaterThan(0);
      expect(c.status.icon.trim().length).toBeGreaterThan(0);
    }
  });

  it('surfaces the gold controls — shipped OFF, plus the required checks', () => {
    const gold = session().view('en').categories.find((c) => c.categoryId === 'gold')!;
    expect(gold.status.tone).toBe('degraded');
    expect(gold.controls.join(' ')).toMatch(/OFF/);
    expect(gold.inForce).toBe(true);
  });

  it('shows a category with no policy in force as attention, with the "set them" detail and no summary', () => {
    const future = session().view('en').categories.find((c) => c.categoryId === 'future')!;
    expect(future.inForce).toBe(false);
    expect(future.summary).toBeUndefined();
    expect(future.status.tone).toBe('error');
    expect(future.detail.length).toBeGreaterThan(0);
  });

  it('refuses the whole screen when the user may not read the catalogue — no categories leak', () => {
    const v = session({ mayRead: () => false }).view('en');
    expect(v.categories).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.screenState.tone).toBe('error');
  });

  it('shows an empty state (idle, not error) when nothing is configured', () => {
    const v = session({ categories: () => [] }).view('en');
    expect(v.total).toBe(0);
    expect(v.screenState.tone).toBe('idle');
  });

  it('renders in Tamil too — the status label changes with the language', () => {
    const en = session().view('en').categories[0]!.status.label;
    const ta = session().view('ta').categories[0]!.status.label;
    expect(ta).not.toBe(en);
  });

  it('flags nobody-named when the box was not told who is looking', () => {
    expect(session({}, null).view('en').nobodyNamed).toBe(true);
  });
});

describe('the copy is complete in both languages', () => {
  it('has an English AND a Tamil word for every key (bilingualGaps)', () => {
    const gaps = bilingualGaps(CATEGORY_POLICY_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
});
