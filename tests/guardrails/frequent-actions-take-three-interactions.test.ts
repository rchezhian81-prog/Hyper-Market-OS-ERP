import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * QG-02 guardrail (roadmap §22 "Frequent action ≤3 interactions where feasible"; design-system.md §1 rule 1 "≤ 3
 * interactions for any action done more than ten times a day. Every exception is listed explicitly and justified" and §9
 * "count interactions for the ten most frequent actions on each surface"; OB-288 gates lane).
 *
 * ONE register of every frequent action the screen specs give a budget, with where it is COUNTED in a real browser (the
 * shared `Tally` in tests/e2e/lib/tally.ts: one tap, one scan, one typed field each cost one). This fails when:
 *   • a counted action's browser test stops asserting its budget, or asserts a looser one than the spec;
 *   • a budget above 3 is not listed as a justified exception;
 *   • a browser test counts an action this register does not know (so it cannot drift off the books);
 *   • an action marked NOT YET COUNTED is in fact counted (the register is stale) — or one is quietly dropped;
 *   • the screen spec no longer names the action (the register and the spec must say the same thing).
 * Actions not yet counted are listed with the reason, never hidden: QG-02 is not "done" while that list is non-empty.
 */

interface Budgeted {
  readonly action: string;
  /** The screen spec that sets the budget (docs/design/screens/…), and the words it uses for the action. */
  readonly spec: string;
  readonly specWords: string;
  readonly budget: number;
  /** Where it is counted: the browser test file and the label its `taps.reset()` assertion carries. */
  readonly counted?: { readonly file: string; readonly label: string };
  /** Not counted yet — why, in plain words. */
  readonly notYetCounted?: string;
  /** A budget above 3, and why (design-system §1 rule 1: listed and justified). */
  readonly exception?: string;
}

const E2E = 'tests/e2e';
const TILL = `${E2E}/the-till-and-manager-meet-the-interaction-budget.e2e.ts`;
const HANDHELDS = `${E2E}/the-handhelds-meet-the-spec.e2e.ts`;
const CUSTOMER = `${E2E}/the-customer-app-meets-wcag-aa.e2e.ts`;
const BUYING = `${E2E}/open-to-buy-on-the-production-api.e2e.ts`;

const REGISTER: readonly Budgeted[] = [
  // ── The till (pos-cashier.md) ──
  { action: 'scan an item', spec: 'pos-cashier.md', specWords: 'Scan an item', budget: 1, counted: { file: TILL, label: 'scan an item' } },
  { action: 'change quantity', spec: 'pos-cashier.md', specWords: 'Change quantity', budget: 3, counted: { file: TILL, label: 'change quantity' } },
  { action: 'take cash payment', spec: 'pos-cashier.md', specWords: 'Take cash payment', budget: 3, counted: { file: TILL, label: 'take cash payment' } },
  { action: 'suspend', spec: 'pos-cashier.md', specWords: 'Suspend / recall', budget: 3, counted: { file: TILL, label: 'suspend' } },
  { action: 'recall', spec: 'pos-cashier.md', specWords: 'Suspend / recall', budget: 3, counted: { file: TILL, label: 'recall' } },
  { action: 'sign in for the shift', spec: 'pos-cashier.md', specWords: 'Sign in for the shift', budget: 3, counted: { file: TILL, label: 'sign in for the shift' } },
  { action: 'sell a weighed item', spec: 'pos-cashier.md', specWords: 'Sell a weighed item', budget: 3, notYetCounted: 'needs a scale reading in the browser test; the till\'s weighed line is proven by tests/e2e/f7-… but its taps are not counted' },
  { action: 'go to tender', spec: 'pos-cashier.md', specWords: 'Go to tender', budget: 1, notYetCounted: 'counted inside "take cash payment" (Tender → Cash → confirm), not on its own' },
  // ── The refund screen (pos-refund.md) ──
  { action: 'look up a receipt', spec: 'pos-refund.md', specWords: 'Look up a receipt', budget: 3, notYetCounted: 'the refund flow is proven in the browser, but its taps are not counted yet' },
  { action: 'return one whole line', spec: 'pos-refund.md', specWords: 'Return one whole line', budget: 3, notYetCounted: 'as above — refund taps are not counted yet' },
  // ── The store manager (store-manager.md) ──
  { action: 'approve with a reason', spec: 'store-manager.md', specWords: 'approve/reject a request', budget: 3, counted: { file: TILL, label: 'approve with a reason' } },
  { action: 'start the day close', spec: 'store-manager.md', specWords: 'start day close', budget: 2, counted: { file: TILL, label: 'start the day close' } },
  { action: 'open a lane\'s health', spec: 'store-manager.md', specWords: 'open a lane\'s health', budget: 2, notYetCounted: 'not counted yet' },
  { action: 'assign/complete a task', spec: 'store-manager.md', specWords: 'assign/complete a task', budget: 3, notYetCounted: 'not counted yet' },
  // ── The warehouse handheld (inventory-warehouse.md) ──
  { action: 'put away a line', spec: 'inventory-warehouse.md', specWords: 'put away a line', budget: 3, counted: { file: HANDHELDS, label: 'put away a line' } },
  { action: 'warehouse: pick a line', spec: 'inventory-warehouse.md', specWords: 'pick a line', budget: 3, counted: { file: HANDHELDS, label: 'pick a line' } },
  { action: 'count a bin (start a count)', spec: 'inventory-warehouse.md', specWords: 'start a count', budget: 2, counted: { file: HANDHELDS, label: 'start a count' } },
  { action: 'raise an adjustment (with reason)', spec: 'inventory-warehouse.md', specWords: 'record an adjustment with reason', budget: 3, counted: { file: HANDHELDS, label: 'record an adjustment with reason' } },
  { action: 'delivery complete', spec: 'inventory-warehouse.md', specWords: 'delivery complete', budget: 1, notYetCounted: 'proven in tests/e2e/goods-receipt-delivery.e2e.ts, taps not counted yet' },
  // ── Receiving and buying (purchase-receiving.md: "Receiving/QC (handheld)", "PO approval") — QG-02's own design bar ──
  { action: 'receive a line', spec: 'purchase-receiving.md', specWords: 'Receiving/QC (handheld)', budget: 3, counted: { file: HANDHELDS, label: 'receive a line' } },
  { action: 'approve a PO', spec: 'purchase-receiving.md', specWords: 'PO approval', budget: 3, counted: { file: BUYING, label: 'approve a PO' } },
  { action: 'issue to the floor', spec: 'inventory-warehouse.md', specWords: 'To issue to the floor', budget: 4, counted: { file: HANDHELDS, label: 'issue to the floor' }, exception: 'the Issue button chooses the floor request first; the three steps after it (scan bin → scan item → confirm) are the pick budget (SP-8c)' },
  // ── The picker (picker-packer.md) and the driver (delivery.md) ──
  { action: 'picker: pick a line', spec: 'picker-packer.md', specWords: 'pick a line', budget: 3, counted: { file: HANDHELDS, label: 'pick a line' } },
  { action: 'record a substitution', spec: 'picker-packer.md', specWords: 'record a substitution', budget: 3, counted: { file: HANDHELDS, label: 'record a substitution' } },
  { action: 'flag a quality fail', spec: 'picker-packer.md', specWords: 'flag a quality fail', budget: 2, counted: { file: HANDHELDS, label: 'flag a quality fail' } },
  { action: 'capture proof', spec: 'delivery.md', specWords: 'capture proof', budget: 3, counted: { file: HANDHELDS, label: 'capture proof' } },
  { action: 'record COD collected', spec: 'delivery.md', specWords: 'record COD collected', budget: 3, counted: { file: HANDHELDS, label: 'record COD collected' } },
  { action: 'mark failed with reason', spec: 'delivery.md', specWords: 'mark failed with reason', budget: 3, counted: { file: HANDHELDS, label: 'mark failed with reason' } },
  // ── The customer app (customer-app.md) ──
  { action: 'reorder a past basket', spec: 'customer-app.md', specWords: 'reorder a past basket', budget: 3, counted: { file: CUSTOMER, label: 'reorder a past basket' } },
  { action: 'add a searched item to the cart', spec: 'customer-app.md', specWords: 'add a searched item to cart', budget: 2, counted: { file: CUSTOMER, label: 'add a searched item to the cart' } },
  { action: 'reach checkout from the cart', spec: 'customer-app.md', specWords: 'reach checkout from cart', budget: 2, counted: { file: CUSTOMER, label: 'reach checkout from the cart' } },
  // ── The owner, AI control, CRM and merchandising screens ──
  { action: 'drill a KPI to its detail', spec: 'owner-command-centre.md', specWords: 'drill a KPI to its detail', budget: 3, notYetCounted: 'not counted yet' },
  { action: 'approve a pending item (owner)', spec: 'owner-command-centre.md', specWords: 'approve a pending item', budget: 3, notYetCounted: 'not counted yet' },
  { action: 'approve/reject an AI suggestion with reason', spec: 'ai-control.md', specWords: 'approve/reject an AI suggestion with reason', budget: 3, notYetCounted: 'not counted yet' },
  { action: 'pull an agent\'s kill switch', spec: 'ai-control.md', specWords: 'pull an agent\'s kill switch', budget: 2, notYetCounted: 'not counted yet' },
  { action: 'open and reply to a case', spec: 'crm-service.md', specWords: 'open and reply to a case', budget: 3, notYetCounted: 'not counted yet' },
  { action: 'edit a price', spec: 'product-merchandising.md', specWords: 'edit a price', budget: 3, notYetCounted: 'not counted yet' },
  { action: 'set a recall block on an item', spec: 'product-merchandising.md', specWords: 'set a recall block on an item', budget: 2, notYetCounted: 'not counted yet' },
];

/** The four frequent actions of the receiving / count / adjustment / buying slice the QG-02 audit names (audit-1 P6). */
const SLICE_ACTIONS = ['receive a line', 'count a bin (start a count)', 'raise an adjustment (with reason)', 'approve a PO'];

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const e2eFiles = readdirSync(E2E).filter((f) => f.endsWith('.e2e.ts')).map((f) => join(E2E, f));

describe('QG-02: every frequent action has a budget, and is counted in a real browser or listed as not yet counted', () => {
  it('each entry is either counted or honestly listed as not yet counted, never both, never neither', () => {
    for (const b of REGISTER) {
      expect(Boolean(b.counted) !== Boolean(b.notYetCounted), `${b.action}: counted XOR notYetCounted`).toBe(true);
    }
  });

  it('every budget is ≤3, unless it is listed as a justified exception (design-system §1 rule 1)', () => {
    for (const b of REGISTER) {
      if (b.budget > 3) expect(b.exception, `${b.action} (≤${b.budget}) needs a written justification`).toBeTruthy();
      else expect(b.exception, `${b.action} is within 3 and needs no exception`).toBeUndefined();
    }
  });

  it('the screen spec still names each action (the register cannot drift from the spec)', () => {
    for (const b of REGISTER) {
      const spec = readFileSync(join('docs/design/screens', b.spec), 'utf8').toLowerCase();
      expect(spec, `${b.spec} names "${b.specWords}"`).toContain(b.specWords.toLowerCase());
    }
  });

  it('each counted action\'s browser test asserts its budget — no looser than the register says', () => {
    for (const b of REGISTER.filter((x) => x.counted !== undefined)) {
      const code = readFileSync(b.counted!.file, 'utf8');
      const m = new RegExp(`taps\\.reset\\(\\), '${escape(b.counted!.label)}'\\)\\.toBeLessThanOrEqual\\((\\d+)\\)`).exec(code);
      expect(m, `${b.counted!.file} counts "${b.counted!.label}"`).not.toBeNull();
      expect(Number(m![1]), `${b.action}: the test's bar`).toBeLessThanOrEqual(b.budget);
    }
  });

  it('every action a browser test counts is on this register (nothing counted off the books)', () => {
    const counted = new Set(REGISTER.filter((b) => b.counted !== undefined).map((b) => `${b.counted!.file}|${b.counted!.label}`));
    const found: string[] = [];
    for (const f of e2eFiles) for (const m of readFileSync(f, 'utf8').matchAll(/taps\.reset\(\), '([^']+)'\)\.toBeLessThanOrEqual/g)) found.push(`${f}|${m[1]}`);
    expect(found.length).toBeGreaterThan(20);
    expect(found.filter((x) => !counted.has(x))).toEqual([]);
  });

  it('an action listed "not yet counted" is genuinely not counted anywhere (the list is not stale)', () => {
    const labels = new Set<string>();
    for (const f of e2eFiles) for (const m of readFileSync(f, 'utf8').matchAll(/taps\.reset\(\), '([^']+)'\)/g)) labels.add(m[1]!.toLowerCase());
    for (const b of REGISTER.filter((x) => x.notYetCounted !== undefined)) expect(labels.has(b.action.toLowerCase()), `${b.action} is counted — move it to "counted"`).toBe(false);
  });

  it('the receiving / count / adjustment / buying slice — receive a line, count a bin, raise an adjustment, approve a PO — is all counted, each ≤3', () => {
    for (const a of SLICE_ACTIONS) {
      const b = REGISTER.find((x) => x.action === a);
      expect(b?.counted, `${a} is counted in a browser`).toBeDefined();
      expect(b!.budget).toBeLessThanOrEqual(3);
    }
  });

  it('says out loud how many frequent actions are still not counted (QG-02 is not done while this is above zero)', () => {
    const open = REGISTER.filter((b) => b.notYetCounted !== undefined).map((b) => b.action);
    // The number is pinned so it can only change on purpose: count one more and move it, or add one and say so.
    expect(open).toHaveLength(14);
  });
});
