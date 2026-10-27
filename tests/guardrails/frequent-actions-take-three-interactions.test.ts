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
 * Re-audit T2 (27 Oct 2026): the list is empty — the whole-line refund is counted at 7 as the written exception OB-394.
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
// QG-02 lane 1 R4: the browser tests that now count the actions that were "not yet counted".
const WEIGHED = `${E2E}/f7-the-served-till-spreads-an-offer-by-what-each-line-charges.e2e.ts`;
const REFUND = `${E2E}/the-served-till-takes-a-refund.e2e.ts`;
const OWNER = `${E2E}/the-owner-app-meets-its-interaction-budget.e2e.ts`;
const AI = `${E2E}/the-ai-control-screen-reaches-head-office.e2e.ts`;
const CATALOGUE = `${E2E}/catalogue-price-change-delivery.e2e.ts`;
const LANE_HEALTH = `${E2E}/the-manager-opens-a-lanes-health-from-today.e2e.ts`; // OB-392
// OB-390 (owner, 26 Oct 2026: actions above the budget are shortened with defaults; the required checks stay).
const SERVICE_DESK = `${E2E}/service-desk-and-assistant-drafts.e2e.ts`;
const TASKS = `${E2E}/store-tasks-meet-the-interaction-budget.e2e.ts`;
/** OB-394 (owner, 26 Oct 2026, in writing): the whole-line refund's 7, accepted as a written QG-02 exception — measured
 *  in the browser at 7, and every act after the line is a required check (OB-390 shortened the rest with defaults). */
const OB394 = 'OB-394 (owner, 26 Oct 2026, in writing): accepted at 7, measured in a real browser — after the line the till must still take the reason (M15), the condition of the goods (M13-FR-02), how the refund is given (never defaulted, OB-390), and a manager\'s badge, PIN and reason (§28 · ADR-0021), one act each; the spec itself lists the manager as "+1 step by design"';

const REGISTER: readonly Budgeted[] = [
  // ── The till (pos-cashier.md) ──
  { action: 'scan an item', spec: 'pos-cashier.md', specWords: 'Scan an item', budget: 1, counted: { file: TILL, label: 'scan an item' } },
  { action: 'change quantity', spec: 'pos-cashier.md', specWords: 'Change quantity', budget: 3, counted: { file: TILL, label: 'change quantity' } },
  { action: 'take cash payment', spec: 'pos-cashier.md', specWords: 'Take cash payment', budget: 3, counted: { file: TILL, label: 'take cash payment' } },
  { action: 'suspend', spec: 'pos-cashier.md', specWords: 'Suspend / recall', budget: 3, counted: { file: TILL, label: 'suspend' } },
  { action: 'recall', spec: 'pos-cashier.md', specWords: 'Suspend / recall', budget: 3, counted: { file: TILL, label: 'recall' } },
  { action: 'sign in for the shift', spec: 'pos-cashier.md', specWords: 'Sign in for the shift', budget: 3, counted: { file: TILL, label: 'sign in for the shift' } },
  { action: 'sell a weighed item', spec: 'pos-cashier.md', specWords: 'Sell a weighed item', budget: 3, counted: { file: WEIGHED, label: 'sell a weighed item' } },
  { action: 'go to tender', spec: 'pos-cashier.md', specWords: 'Go to tender', budget: 1, counted: { file: TILL, label: 'go to tender' } },
  // ── The refund screen (pos-refund.md) ──
  { action: 'look up a receipt', spec: 'pos-refund.md', specWords: 'Look up a receipt', budget: 3, counted: { file: REFUND, label: 'look up a receipt' } },
  // OB-390: 14 → 7. The amount now starts at the line's value (shown, changeable — the METHOD is never defaulted), a reason
  // is one tap on a chip, and a line with one unit left does not ask how many. What is left is the line plus six checks.
  { action: 'return one whole line', spec: 'pos-refund.md', specWords: 'Return one whole line', budget: 7, counted: { file: REFUND, label: 'return one whole line' }, exception: OB394 },
  // ── The store manager (store-manager.md) ──
  { action: 'approve with a reason', spec: 'store-manager.md', specWords: 'approve/reject a request', budget: 3, counted: { file: TILL, label: 'approve with a reason' } },
  { action: 'start the day close', spec: 'store-manager.md', specWords: 'start day close', budget: 2, counted: { file: TILL, label: 'start the day close' } },
  // OB-392 (owner, 26 Oct 2026): lane health on the manager's Today screen, one tap per lane.
  { action: 'open a lane\'s health', spec: 'store-manager.md', specWords: 'open a lane\'s health', budget: 2, counted: { file: LANE_HEALTH, label: 'open a lane’s health' } },
  // OB-390: assigning defaults the store to the manager's own (from the sign-in) and the deadline to the end of today.
  { action: 'assign a task', spec: 'store-manager.md', specWords: 'assign/complete a task', budget: 3, counted: { file: TASKS, label: 'assign a task' } },
  { action: 'complete a task', spec: 'store-manager.md', specWords: 'assign/complete a task', budget: 3, counted: { file: TASKS, label: 'complete a task' } },
  // ── The warehouse handheld (inventory-warehouse.md) ──
  { action: 'put away a line', spec: 'inventory-warehouse.md', specWords: 'put away a line', budget: 3, counted: { file: HANDHELDS, label: 'put away a line' } },
  { action: 'warehouse: pick a line', spec: 'inventory-warehouse.md', specWords: 'pick a line', budget: 3, counted: { file: HANDHELDS, label: 'pick a line' } },
  { action: 'count a bin (start a count)', spec: 'inventory-warehouse.md', specWords: 'start a count', budget: 2, counted: { file: HANDHELDS, label: 'start a count' } },
  { action: 'raise an adjustment (with reason)', spec: 'inventory-warehouse.md', specWords: 'record an adjustment with reason', budget: 3, counted: { file: HANDHELDS, label: 'record an adjustment with reason' } },
  { action: 'delivery complete', spec: 'inventory-warehouse.md', specWords: 'delivery complete', budget: 1, counted: { file: HANDHELDS, label: 'delivery complete' } },
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
  { action: 'drill a KPI to its detail', spec: 'owner-command-centre.md', specWords: 'drill a KPI to its detail', budget: 3, counted: { file: OWNER, label: 'drill a KPI to its detail' } },
  { action: 'approve a pending item (owner)', spec: 'owner-command-centre.md', specWords: 'approve a pending item', budget: 3, counted: { file: OWNER, label: 'approve a pending item (owner)' } },
  { action: 'approve/reject an AI suggestion with reason', spec: 'ai-control.md', specWords: 'approve/reject an AI suggestion with reason', budget: 3, counted: { file: AI, label: 'approve/reject an AI suggestion with reason' } },
  // OB-390: a Stop button per running assistant beside the written reason (still required) — reason, Stop.
  { action: 'pull an agent\'s kill switch', spec: 'ai-control.md', specWords: 'pull an agent\'s kill switch', budget: 2, counted: { file: AI, label: 'stop one assistant with its kill switch' } },
  // OB-390: the case carries how the customer came; one press approves the shown words and sends them that way.
  { action: 'open and reply to a case', spec: 'crm-service.md', specWords: 'open and reply to a case', budget: 3, counted: { file: SERVICE_DESK, label: 'open and reply to a case' } },
  // OB-390: the price form opens holding the item; the MRP / margin-floor check runs as the price is typed, before Save.
  { action: 'edit a price', spec: 'product-merchandising.md', specWords: 'edit a price', budget: 3, counted: { file: CATALOGUE, label: 'edit a price' } },
  { action: 'set a recall block on an item', spec: 'product-merchandising.md', specWords: 'set a recall block on an item', budget: 2, counted: { file: CATALOGUE, label: 'set a recall block on an item' } },
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

  it('an action left above its spec is never parked as "not yet counted" — it is counted, at the figure the owner accepted', () => {
    // OB-390 brought three of the four within budget; OB-394 accepted the fourth, the whole-line refund, at 7 in writing.
    expect(REGISTER.filter((b) => /^measured AS BUILT/.test(b.notYetCounted ?? '')).map((b) => b.action)).toEqual([]);
    const refund = REGISTER.find((b) => b.action === 'return one whole line')!;
    expect(refund).toMatchObject({ budget: 7, counted: { file: REFUND, label: 'return one whole line' } });
    expect(refund.exception).toMatch(/^OB-394 \(owner, 26 Oct 2026, in writing\)/);
    // The browser test bars it at exactly the accepted figure, not a looser one.
    expect(readFileSync(REFUND, 'utf8')).toMatch(/taps\.reset\(\), 'return one whole line'\)\.toBeLessThanOrEqual\(7\)/);
  });

  it('every exception above 3 is justified in words, and one above the spec\'s own figure cites the owner\'s written decision', () => {
    for (const b of REGISTER.filter((x) => x.budget > 4)) expect(b.exception, `${b.action} (≤${b.budget})`).toMatch(/^OB-\d+ \(owner, [^)]*in writing\)/);
  });

  it('says out loud how many frequent actions are still not counted — none: QG-02 is done in software', () => {
    const open = REGISTER.filter((b) => b.notYetCounted !== undefined).map((b) => b.action);
    // The number is pinned so it can only change on purpose: add an action not yet counted and say so here.
    // QG-02 lane 1 R4 (26 Oct 2026): 8 of the 14 counted. OB-390 (26 Oct 2026): price, case reply, kill switch and
    // assign/complete a task counted within budget; OB-392: a lane's health on the manager's Today screen (one tap).
    // Re-audit T2 (27 Oct 2026): the whole-line refund is counted at 7, the owner's written exception (OB-394). None left.
    expect(open).toEqual([]);
    expect(REGISTER.every((b) => b.counted !== undefined)).toBe(true);
  });
});
