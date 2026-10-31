import { describe, it, expect } from 'vitest';
import { createWasteReviewSession, WASTE_REVIEW_COPY, type WriteOffRow } from '../../apps/web-erp/src/waste-review-session';
import { createCategoryPolicySession, CATEGORY_POLICY_COPY } from '../../apps/web-erp/src/category-policy-session';
import { createChecklistSession, CHECKLIST_COPY, type StoredChecklist } from '../../apps/web-erp/src/checklist-session';
import { wastePortsFromData, categoryPolicyPortsFromData } from '../../apps/web-erp/src/browser-entry';
import { presetPolicy } from '../../packages/product/src/index';

/**
 * **Screen gap audit (31 Oct 2026) Round A · P-08 — an empty page never says "all clear".**
 *
 * The audit found three pages that read an empty register as good news: the Waste page said "No material losses — nothing
 * needed a second approval" with no write-off recorded at all; the Category rules page said "Every category's rules are in
 * force and clear" with no category; and the Checklists page said "Every checklist is signed" on a day with NO checklists.
 * Each session now words the one line above its list itself:
 *   • a register the store computer was never given says so ("has not been given … This is not …");
 *   • an empty register says "nothing recorded / set up yet" — or, for checklists, "there are no checklists for today";
 *   • "all clear" is said ONLY when there are rows and none needs attention.
 * Every line has its Tamil twin.
 */

const ROW: WriteOffRow = { id: 'wo-1', productId: 'MILK', lossType: 'expiry', qtyRemoved: 6, uom: 'ea', valueMinor: 30_000, requiredApproval: false };
const BIG: WriteOffRow = { ...ROW, id: 'wo-2', lossType: 'damage', valueMinor: 240_000, requiredApproval: true };
const waste = (rows: readonly WriteOffRow[] | undefined) =>
  createWasteReviewSession({ userId: 'u-mgr' }, wastePortsFromData({ userId: 'u-mgr', permissions: ['waste.view'], ...(rows === undefined ? {} : { rows }) }));

describe('the Waste page (M28-FR-01)', () => {
  it('no write-off recorded: "nothing recorded yet", never "no material losses"', () => {
    for (const lang of ['en', 'ta'] as const) {
      const v = waste([]).view(lang);
      expect(v.summaryLine).toBe(WASTE_REVIEW_COPY[lang].stateEmpty);
      expect(v.summaryLine).not.toBe(WASTE_REVIEW_COPY[lang].allClear);
      expect(v.screenState.label).toBe(WASTE_REVIEW_COPY[lang].stateEmpty);
    }
    expect(waste([]).view('en').summaryLine).toMatch(/^Nothing recorded yet/);
  });

  it('never given the write-offs: says the store computer was not told, not "nothing recorded"', () => {
    const v = waste(undefined).view('en');
    expect(v.summaryLine).toBe(WASTE_REVIEW_COPY.en.stateNotTold);
    expect(v.summaryLine).toMatch(/has not been given the write-offs/);
    expect(waste(undefined).view('ta').summaryLine).toBe(WASTE_REVIEW_COPY.ta.stateNotTold);
  });

  it('losses recorded, none material: "no material losses" — and one material: "1 needed approval"', () => {
    expect(waste([ROW]).view('en').summaryLine).toBe(WASTE_REVIEW_COPY.en.allClear);
    expect(waste([ROW, BIG]).view('en').summaryLine).toBe(`1 ${WASTE_REVIEW_COPY.en.attentionCount}`);
  });

  it('the total is "recorded", not "today" — the list is every loss recorded at the store', () => {
    expect(WASTE_REVIEW_COPY.en.totalLoss).toBe('Total loss recorded');
    expect(WASTE_REVIEW_COPY.ta.totalLoss).not.toMatch(/இன்றைய/);
  });
});

describe('the Category rules page (M03-FR-01)', () => {
  const cats = (categories: unknown) => createCategoryPolicySession({ userId: 'u-cat' }, categoryPolicyPortsFromData({
    userId: 'u-cat', permissions: ['catalogue.pack.read'], onDate: '2026-10-31', ...(categories === undefined ? {} : { categories: categories as never }),
  }));

  it('no category: "nothing set up yet", never "every category clear"', () => {
    for (const lang of ['en', 'ta'] as const) {
      const v = cats([]).view(lang);
      expect(v.summaryLine).toBe(CATEGORY_POLICY_COPY[lang].stateEmpty);
      expect(v.summaryLine).not.toBe(CATEGORY_POLICY_COPY[lang].allClear);
    }
  });

  it('never given the categories: says so', () => {
    expect(cats(undefined).view('en').summaryLine).toBe(CATEGORY_POLICY_COPY.en.stateNotTold);
  });

  it('a category head office holds with no rules is flagged "no rules in force" (what the pack now sends)', () => {
    const v = cats([{ categoryId: 'grocery', name: 'Grocery', history: [] }]).view('en');
    expect(v.summaryLine).toBe(`1 ${CATEGORY_POLICY_COPY.en.attentionCount}`);
    expect(v.categories[0]).toMatchObject({ categoryId: 'grocery', inForce: false, needsAttention: true, detail: CATEGORY_POLICY_COPY.en.noPolicyDetail });
  });

  it('every category with rules in force and nothing to look at: then, and only then, "clear"', () => {
    expect(cats([presetPolicy('grocery', 'grocery_fmcg', '2026-01-01')]).view('en').summaryLine).toBe(CATEGORY_POLICY_COPY.en.allClear);
  });
});

describe('the Checklists page (M25-FR-02)', () => {
  const day = (checklists: readonly StoredChecklist[]) => createChecklistSession({ userId: 'u-mgr' }, {
    worklist: () => ({ checklists }), mayRead: () => true, mayManage: () => true, submitPort: () => ({ post: async () => 'recorded' as const }),
  });
  const signed: StoredChecklist = { checklistId: 'c1', kind: 'opening', items: [{ itemId: 'i1', description: 'lights', done: true, blocking: false }], signedBy: 'u-mgr' };
  const unsigned: StoredChecklist = { checklistId: 'c2', kind: 'closing', items: [{ itemId: 'i2', description: 'cash', done: false, blocking: true }] };

  it('no checklists at all: "there are no checklists for today", never "every checklist is signed"', () => {
    for (const lang of ['en', 'ta'] as const) {
      const v = day([]).view(lang);
      expect(v.workLine).toBe(CHECKLIST_COPY[lang].noneSetUp);
      expect(v.screenState.label).toBe(CHECKLIST_COPY[lang].noneSetUp);
      expect(v.workLine).not.toBe(CHECKLIST_COPY[lang].allDone);
      expect(v.screenState.label).not.toBe(CHECKLIST_COPY[lang].scrEmpty);
    }
    expect(day([]).view('en').workLine).toMatch(/no checklists for today/);
  });

  it('every checklist signed: "every checklist is signed"; one still to sign: "1 to sign off"', () => {
    expect(day([signed]).view('en').workLine).toBe(CHECKLIST_COPY.en.allDone);
    expect(day([signed, unsigned]).view('en').workLine).toBe(`1 ${CHECKLIST_COPY.en.toWorkCount}`);
  });
});
