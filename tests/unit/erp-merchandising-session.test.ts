import { describe, it, expect } from 'vitest';
import {
  createMerchandisingSession, refillDraft, refillIndentId, SHELF_COUNTED, REFILL_INDENT_PREFIX, shelfCountKeyFor,
  type MerchandisingConfig, type MerchandisingPorts, type MerchandisingDevice, type RefillIndentPort, type RefillDraft,
} from '../../apps/web-erp/src/merchandising-session';
import { createIndentsSession, FLOOR_INDENT_REQUESTED } from '../../apps/web-erp/src/indents-session';
import { refillIndentPortOf } from '../../apps/web-erp/src/browser-entry';
import { openDeviceOutbox, guardedStore } from '../../packages/sync/src/device-outbox';
import {
  Assortment, ShelfMap,
  type DisplayContract, type Planogram, type ShelfAssignment, type ShelfCount,
  type ShelfLocation, type SpaceArea,
} from '../../packages/merchandising/src/index';
import { money } from '../../packages/contracts/src/money';

/**
 * **The merchandising and space surface (M04 · D02 · §28).**
 *
 * Every rule here was built and tested the day the module was written, and **not one was called by
 * anything outside its own unit test** — the range decision, the assortment integrity check, the
 * planogram comparison, the refill tasks, the space ranking, the display contracts.
 *
 * The prerequisite had to be built first: `planogramCompliance` needs how many of an item are on
 * the shelf right now, and nothing produced it. So this surface's headline control is that it never
 * reports compliance without saying how much of the plan anybody actually looked at.
 */

const NOW = '2026-08-06T10:00:00.000Z';
const JUST_NOW = '2026-08-06T09:55:00.000Z';
const TODAY = '2026-08-06';

const LOCATIONS: ShelfLocation[] = [
  { storeId: 'store-1', locationId: 'L-A1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, label: 'A1' },
  { storeId: 'store-1', locationId: 'L-B3', aisle: 2, rack: 3, bay: 1, shelf: 1, position: 1, label: 'B3' },
];

const ASSIGNMENTS: ShelfAssignment[] = [
  { storeId: 'store-1', productId: 'rice', locationId: 'L-A1', capacityMinor: 24, primary: true },
  { storeId: 'store-1', productId: 'oil', locationId: 'L-B3', capacityMinor: 18, primary: true },
];

const PLANOGRAM: Planogram = {
  planogramId: 'pg-1', storeId: 'store-1', version: 1,
  effectiveFrom: '2026-08-01', assignments: ASSIGNMENTS, createdBy: 'u-merch',
};

const CONTRACTS: DisplayContract[] = [
  {
    contractId: 'dc-1', storeId: 'store-1', supplierId: 'sup-1', description: 'End cap, front aisle',
    locationIds: ['L-A1'], fundingAmount: money(50_000, 'INR'),
    startsOn: '2026-06-01', endsOn: '2026-07-31', approvedBy: 'u-finance',
  },
];

const AREAS: SpaceArea[] = [
  { areaId: 'grocery', storeId: 'store-1', name: 'Grocery', squareFeet: 2_000 },
  { areaId: 'chilled', storeId: 'store-1', name: 'Chilled', squareFeet: 500 },
];

const counted = (productId: string, locationId: string, countedMinor: number, at = JUST_NOW): ShelfCount =>
  ({ storeId: 'store-1', locationId, productId, countedMinor, countedBy: 'u-merch', at });

const CONFIG: MerchandisingConfig = {
  tenantId: 't1', storeId: 'store-1', userId: 'u-merch', currency: 'INR',
  today: TODAY, now: NOW, refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'shelf-filler',
};

function ports(over: Partial<MerchandisingPorts> = {}): MerchandisingPorts {
  const map = new ShelfMap('store-1', LOCATIONS, ASSIGNMENTS);
  const assortment = new Assortment('store-1', [
    { storeId: 'store-1', productId: 'rice', status: 'listed', effectiveFrom: '2026-01-01' },
    { storeId: 'store-1', productId: 'oil', status: 'listed', effectiveFrom: '2026-01-01' },
  ]);
  return {
    shelfMap: () => map,
    planogram: () => PLANOGRAM,
    shelfCounts: () => [],
    backstock: () => ({ rice: 100, oil: 100 }),
    assortment: () => assortment,
    soldProductIds: () => ['rice'],
    onHand: () => ({ rice: 40, oil: 0 }),
    spaceAreas: () => AREAS,
    salesByArea: () => ({ grocery: money(900_000, 'INR'), chilled: money(400_000, 'INR') }),
    marginByArea: () => ({ grocery: money(90_000, 'INR'), chilled: money(120_000, 'INR') }),
    displayContracts: () => CONTRACTS,
    fundingReceived: () => ({}),
    stillOccupying: () => ['dc-1'],
    ...over,
  };
}

const session = (over: Partial<MerchandisingPorts> = {}, config: Partial<MerchandisingConfig> = {}) =>
  createMerchandisingSession({ ...CONFIG, ...config }, ports(over));

// ── The control this whole build exists for ─────────────────────────────────

describe('an uncounted shelf never becomes a refill task', () => {
  it('sends nobody anywhere when nothing has been counted', () => {
    // `state?.onShelfMinor ?? 0` made every uncounted facing read as EMPTY — the loudest finding
    // there is — so on day one the whole shop was an urgent task list and staff were sent to full
    // shelves. An alarm that fires on everything is worse than no alarm.
    const check = session().check();
    expect('why' in check).toBe(false);
    if ('why' in check) return;
    expect(check.tasks).toEqual([]);
    expect(check.issues.map((i) => i.finding)).toEqual(['never_counted', 'never_counted']);
    expect(check.notObserved).toBe(2);
    expect(check.wholePlanObserved).toBe(false);
  });

  it('never reports compliance without saying how much of the plan was looked at', () => {
    const check = session({ shelfCounts: () => [counted('rice', 'L-A1', 24)] }).check();
    if ('why' in check) return;
    // One of one observed facing is compliant — 100% — but two facings are on the plan.
    expect(check.complianceBp).toBe(10_000);
    expect(check.plannedFacings).toBe(2);
    expect(check.notObserved).toBe(1);
    expect(check.wholePlanObserved, 'a partial check must never read as a whole one').toBe(false);
  });

  it('raises the urgent task once somebody has actually looked', () => {
    const check = session({ shelfCounts: () => [counted('rice', 'L-A1', 0)] }).check();
    if ('why' in check) return;
    const task = check.tasks.find((t) => t.productId === 'rice');
    expect(task?.priority).toBe('urgent');
    expect(task?.quantityMinor).toBe(24);
    expect(task?.assignedRole).toBe('shelf-filler');
  });

  it('drops back to silence when the count goes stale', () => {
    const stale = session({
      shelfCounts: () => [counted('rice', 'L-A1', 0, '2026-08-01T09:00:00.000Z')],
    }).check();
    if ('why' in stale) return;
    expect(stale.tasks).toEqual([]);
    expect(stale.issues.find((i) => i.productId === 'rice')?.finding).toBe('last_counted_too_long_ago');
  });

  it('says WHY it cannot check at all, rather than reporting a clean shop', () => {
    // Two different nothings, and they lead to different actions: address the shelves, or publish
    // a plan. "0 issues" would read as neither.
    expect(session({ shelfMap: () => null }).check()).toEqual({ why: 'this_store_has_no_shelf_map' });
    expect(session({ planogram: () => null }).check())
      .toEqual({ why: 'this_store_has_never_published_a_planogram' });
  });
});

// ── Counting ────────────────────────────────────────────────────────────────

describe('counting a facing', () => {
  it('takes the count blind — the session has no way to ask what it should be', () => {
    // Absence as a control: nothing on this surface returns an expected quantity, so a view cannot
    // put one on the screen next to the counting field even by accident.
    const s = session();
    expect(Object.keys(s).filter((k) => /expected|capacityFor|shouldHold/i.test(k))).toEqual([]);
  });

  it('records the count with the counter’s name and the shop’s clock', () => {
    const outcome = session().count({ locationId: 'L-A1', productId: 'rice', countedMinor: 7 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.count).toMatchObject({ countedBy: 'u-merch', at: NOW, countedMinor: 7 });
  });

  it('refuses a count against a shelf this shop does not have', () => {
    const outcome = session().count({ locationId: 'L-NOWHERE', productId: 'rice', countedMinor: 7 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('this_shop_has_no_such_shelf');
  });

  it('refuses every count when there is no shelf map, rather than counting into nowhere', () => {
    const outcome = session({ shelfMap: () => null })
      .count({ locationId: 'L-A1', productId: 'rice', countedMinor: 7 });
    expect(outcome.ok).toBe(false);
  });

  it('puts never-counted facings at the top of the counting list', () => {
    const list = session({ shelfCounts: () => [counted('oil', 'L-B3', 5, '2026-08-01T09:00:00.000Z')] })
      .countingList();
    expect(list.map((r) => r.productId)).toEqual(['rice', 'oil']);
    expect(list[0]?.lastCountedAt).toBeNull();
  });

  it('leaves a freshly counted facing off the counting list', () => {
    const list = session({
      shelfCounts: () => [counted('rice', 'L-A1', 5), counted('oil', 'L-B3', 5)],
    }).countingList();
    expect(list).toEqual([]);
  });
});

// ── The range ───────────────────────────────────────────────────────────────

describe('a range drop never makes stock invisible', () => {
  it('routes an item with stock to clearance rather than deleting it', () => {
    // Removing a stocked item from the range means it is not counted, not replenished, not sold,
    // and eventually written off.
    const outcome = session().drop({ productId: 'rice', reason: 'poor_sales' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.outcome).toBe('routed_to_clearance');
    expect(outcome.decision.detail).toContain('40 still on hand');
  });

  it('delists cleanly when there is genuinely none left', () => {
    const outcome = session().drop({ productId: 'oil', reason: 'supplier_discontinued' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.outcome).toBe('delisted');
  });

  it('reads the REAL on-hand, so a screen cannot delist a stocked item by guessing zero', () => {
    // Zero is the dangerous default here: it turns "route to clearance" into "delete".
    const outcome = session({ onHand: () => ({}) }).drop({ productId: 'rice', reason: 'poor_sales' });
    if (!outcome.ok) return;
    // With the port genuinely empty the item really has none — the point is that the session asks
    // the port rather than assuming, which the first case above proves.
    expect(outcome.decision.outcome).toBe('delisted');
    const stocked = session().drop({ productId: 'rice', reason: 'poor_sales' });
    if (!stocked.ok) return;
    expect(stocked.decision.outcome).toBe('routed_to_clearance');
  });

  it('refuses to drop something as "replaced" without saying what replaced it', () => {
    // Otherwise the customer is simply told no.
    const outcome = session().drop({ productId: 'oil', reason: 'replaced_by_alternative' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail).toContain('what replaced it');
  });

  it('records who decided, from the session rather than from the form', () => {
    const outcome = session().drop({ productId: 'oil', reason: 'poor_margin' });
    if (!outcome.ok) return;
    expect(outcome.decision.entry.decidedBy).toBe('u-merch');
    expect(outcome.decision.entry.effectiveFrom).toBe(TODAY);
  });

  it('has no function on this surface that deletes a range entry', () => {
    expect(Object.keys(session()).filter((k) => /delete|remove|purge/i.test(k))).toEqual([]);
  });

  it('flags an item sold at a store that does not range it', () => {
    const issues = session({ soldProductIds: () => ['ghee'] }).rangeIssues();
    expect(issues.find((i) => i.productId === 'ghee')?.finding).toBe('sold_not_in_assortment');
  });
});

// ── Space ───────────────────────────────────────────────────────────────────

describe('what the floor earns', () => {
  it('ranks areas by margin per square foot, not by turnover', () => {
    // Grocery turns over more than twice as much and earns less. A category with big turnover and
    // thin margin can be the worst use of space in the building while looking like the best.
    const rows = session().space();
    expect(rows[0]?.areaId).toBe('chilled');
    expect(rows.find((r) => r.areaId === 'grocery')?.underperforming).toBe(true);
  });

  it('says a ratio is not meaningful rather than returning zero', () => {
    // "0 sales per sq ft" and "we never measured this area" lead to opposite decisions.
    const rows = session({
      spaceAreas: () => [{ areaId: 'unmeasured', storeId: 'store-1', name: 'Back wall', squareFeet: 0 }],
      salesByArea: () => ({ unmeasured: money(100_000, 'INR') }),
      marginByArea: () => ({ unmeasured: money(20_000, 'INR') }),
    }).space();
    expect(rows[0]?.salesPerSqFt.kind).toBe('not_meaningful');
  });

  it('finds the expired display contract whose stand is still on the floor', () => {
    // The supplier stopped paying and nobody took the stand away, so the shop is giving away its
    // best space — and the money was never received either.
    const found = session().contracts();
    expect(found[0]?.finding).toBe('expired_still_occupying');
    expect(found[0]?.outstanding.minor).toBe(50_000);
  });

  it('flags a contract nobody in finance approved (§28)', () => {
    const found = session({
      displayContracts: () => [{ ...CONTRACTS[0]!, approvedBy: undefined, endsOn: '2027-01-01' }],
    }).contracts();
    expect(found[0]?.finding).toBe('unapproved');
  });
});

// ── SP-8c-ii (F08): the two saves leave the page ─────────────────────────────────────────────────────────────

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
/** The SAME queue key the Floor indents screen opens for this store — one queue, one relay, one set of state words. */
const queueOn = (storage = memory()) => openDeviceOutbox(guardedStore('sre.indents.outbox.store-1', storage, () => {}), () => {});

/** A stand-in for the Indents session: records what was asked, answers like the real one, and reads back what it holds. */
function fakeIndents(over: { canRequest?: boolean; refuse?: string } = {}): RefillIndentPort & { raised: RefillDraft[] } {
  const raised: RefillDraft[] = [];
  return {
    raised,
    raise: (draft) => { if (over.refuse !== undefined) return { ok: false, refusal: over.refuse }; raised.push(draft); return { ok: true, indentId: draft.indentId }; },
    savedWork: () => raised.map((d) => ({ kind: 'request', id: d.indentId, detail: d.lines.map((l) => `${l.productId} × ${l.quantityMinor}`).join(' · '), at: NOW, state: 'saved_here' as const, attempts: 0 })),
    canRequest: () => over.canRequest ?? true,
  };
}
const withDevice = (device: MerchandisingDevice, over: Partial<MerchandisingPorts> = {}, config: Partial<MerchandisingConfig> = {}) =>
  createMerchandisingSession({ ...CONFIG, ...config }, ports(over), device);

describe('a count is on the DURABLE device queue before the screen is told saved (SP-8c-ii · P-01 · §31)', () => {
  it('a good count is queued as ONE ShelfCounted in the counter\'s name, with the shop\'s shelves for head office to judge against, and listed as saved here', () => {
    const outbox = queueOn();
    const s = withDevice({ outbox, freshCountId: () => 'sc-1' });
    const outcome = s.count({ locationId: 'L-A1', productId: 'rice', countedMinor: 12 });
    expect(outcome).toMatchObject({ ok: true, countId: 'sc-1', queued: true });
    const items = outbox.all();
    expect(items).toHaveLength(1);
    expect(items[0]!.key).toBe(shelfCountKeyFor('sc-1'));
    expect(items[0]!.event).toMatchObject({
      type: SHELF_COUNTED, idempotencyKey: 'shelf-count:sc-1', occurredAt: NOW, source: 'web-erp/merchandising',
      payload: { countId: 'sc-1', storeId: 'store-1', locationId: 'L-A1', productId: 'rice', countedMinor: 12, countedBy: 'u-merch', at: NOW, knownLocationIds: ['L-A1', 'L-B3'], source: 'merchandising-screen' },
    });
    // No expected quantity rides along — counted blind stays blind on the wire too.
    expect(Object.keys(items[0]!.event.payload as object)).not.toContain('expectedMinor');
    expect(s.savedCounts()).toEqual([{ countId: 'sc-1', productId: 'rice', locationId: 'L-A1', countedMinor: 12, at: NOW, state: 'saved_here', attempts: 0 }]);
    expect(s.handedKeys()).toEqual([]);
  });

  it('once the store computer has taken it the key is handed, and "posted" / "refused" are only ever the box\'s word (P-08)', () => {
    const outbox = queueOn();
    const s = withDevice({ outbox, freshCountId: () => 'sc-2' });
    s.count({ locationId: 'L-A1', productId: 'rice', countedMinor: 3 });
    outbox.recordFailure('shelf-count:sc-2');
    expect(s.savedCounts()[0]?.state).toBe('retrying');
    outbox.acknowledge('shelf-count:sc-2');
    expect(s.savedCounts()[0]?.state).toBe('handed_to_box');
    expect(s.handedKeys()).toEqual(['shelf-count:sc-2']);
    s.noteBoxStatus([{ key: 'shelf-count:sc-2', state: 'posted', attempts: 1 }]);
    expect(s.savedCounts()[0]?.state).toBe('posted');
    s.noteBoxStatus([{ key: 'shelf-count:sc-2', state: 'refused', attempts: 1, reason: 'this_shop_has_no_such_shelf' }]);
    expect(s.savedCounts()[0]).toMatchObject({ state: 'refused', reason: 'this_shop_has_no_such_shelf' });
  });

  it('the work is still there when the screen is reopened over the same storage; with no queue wired a count changes only the page and says so', () => {
    const storage = memory();
    withDevice({ outbox: queueOn(storage), freshCountId: () => 'sc-3' }).count({ locationId: 'L-B3', productId: 'oil', countedMinor: 4 });
    const reopened = withDevice({ outbox: queueOn(storage) });
    expect(reopened.savedCounts().map((c) => c.countId)).toEqual(['sc-3']);
    expect(session().count({ locationId: 'L-A1', productId: 'rice', countedMinor: 1 })).toMatchObject({ ok: true, queued: false });
  });

  it('refuses — with NOTHING queued — a count nobody signed (no person named at the screen) and a count against a shelf the shop does not have', () => {
    const outbox = queueOn();
    const nobody = withDevice({ outbox }, {}, { userId: '' });
    expect(nobody.count({ locationId: 'L-A1', productId: 'rice', countedMinor: 1 })).toMatchObject({ ok: false, refusal: 'nobody_signed_this_count' });
    const named = withDevice({ outbox });
    expect(named.count({ locationId: 'L-TYPO', productId: 'rice', countedMinor: 1 })).toMatchObject({ ok: false, refusal: 'this_shop_has_no_such_shelf' });
    expect(outbox.all()).toEqual([]);
  });
});

describe('the refill tasks become ONE indent on the shared queue, asked once a day (SP-8c-ii · F08 · M04-FR-03 · WF-06)', () => {
  /** Both planned facings looked at and found empty: two tasks, two products. */
  const emptyShelves = { shelfCounts: () => [counted('rice', 'L-A1', 0), counted('oil', 'L-B3', 0)] };

  it('the draft is one line per product with the tasks\' quantities, named for the shelves, under an id that is the same for the same shelves today', () => {
    const s = withDevice({ indents: fakeIndents() }, emptyShelves);
    const view = s.refills();
    expect(view.tasks.map((t) => [t.productId, t.quantityMinor])).toEqual([['rice', 24], ['oil', 18]]);
    expect(view.draft).toEqual({
      indentId: refillIndentId(TODAY, view.tasks),
      lines: [{ productId: 'rice', quantityMinor: '24', uom: '' }, { productId: 'oil', quantityMinor: '18', uom: '' }],
      reason: 'shelf refill · A1, B3',
    });
    expect(view.draft!.indentId.startsWith(`${REFILL_INDENT_PREFIX}${TODAY}-`)).toBe(true);
    expect(view).toMatchObject({ canRaise: true, alreadySaved: false, saved: [] });
    // The id is a function of the DAY and the SHELVES, not of the quantities or the order — a recount does not ask again.
    expect(refillIndentId(TODAY, [...view.tasks].reverse())).toBe(view.draft!.indentId);
    expect(refillIndentId(TODAY, view.tasks.map((t) => ({ ...t, quantityMinor: 1 })))).toBe(view.draft!.indentId);
    expect(refillIndentId('2026-08-07', view.tasks)).not.toBe(view.draft!.indentId);
    expect(refillIndentId(TODAY, view.tasks.slice(0, 1))).not.toBe(view.draft!.indentId);
    // The same product on two shelves asks once, for both.
    const twice = refillDraft(TODAY, [view.tasks[0]!, { ...view.tasks[0]!, taskId: 't2', locationId: 'L-B3', location: { ...view.tasks[0]!.location, label: 'B3' }, quantityMinor: 6 }]);
    expect(twice?.lines).toEqual([{ productId: 'rice', quantityMinor: '30', uom: '' }]);
    expect(twice?.reason).toBe('shelf refill · A1, B3');
  });

  it('raising it hands the draft to the Indents session ONCE; a second tap says already asked and raises nothing new; the ask is listed with its state', () => {
    const indents = fakeIndents();
    const s = withDevice({ indents }, emptyShelves);
    const first = s.raiseRefill();
    expect(first).toMatchObject({ ok: true, alreadySaved: false });
    expect(indents.raised).toHaveLength(1);
    expect(indents.raised[0]!.lines.map((l) => l.productId)).toEqual(['rice', 'oil']);
    const again = s.raiseRefill();
    expect(again).toMatchObject({ ok: true, alreadySaved: true, indentId: (first as { indentId: string }).indentId });
    expect(indents.raised).toHaveLength(1);
    const view = s.refills();
    expect(view.alreadySaved).toBe(true);
    expect(view.saved).toEqual([{ indentId: (first as { indentId: string }).indentId, detail: 'rice × 24 · oil × 18', at: NOW, state: 'saved_here', attempts: 0 }]);
  });

  it('refuses — with nothing asked — when there is no link to the indents, nobody is named, the reader lacks the right, or nothing needs filling; the Indents session\'s own refusal is passed on', () => {
    expect(withDevice({}, emptyShelves).raiseRefill()).toEqual({ ok: false, refusal: 'no_indent_link' });
    expect(withDevice({ indents: fakeIndents() }, emptyShelves, { userId: '' }).raiseRefill()).toEqual({ ok: false, refusal: 'nobody_named' });
    const noRight = fakeIndents({ canRequest: false });
    expect(withDevice({ indents: noRight }, emptyShelves).raiseRefill()).toEqual({ ok: false, refusal: 'not_permitted' });
    expect(withDevice({ indents: noRight }, emptyShelves).refills().canRaise).toBe(false);
    expect(withDevice({ indents: fakeIndents() }).raiseRefill()).toEqual({ ok: false, refusal: 'nothing_to_fill' }); // nothing counted → no task
    expect(withDevice({ indents: fakeIndents({ refuse: 'bad_line' }) }, emptyShelves).raiseRefill()).toEqual({ ok: false, refusal: 'bad_line' });
    expect(noRight.raised).toEqual([]);
  });

  it('through the REAL Indents session it is the same record the floor raises by hand: a FloorIndentRequested from the back store to the floor, in the reader\'s name, with the catalogue\'s unit, on the SAME queue as the counts', () => {
    const outbox = queueOn();
    const indents = createIndentsSession(
      { userId: 'u-merch', storeId: 'store-1', backStoreId: 'store-1-back', products: [{ productId: 'rice', name: 'Rice', uom: 'KG' }, { productId: 'oil', name: 'Oil', uom: 'LTR' }], now: () => NOW },
      { snapshot: () => ({}), mayRead: () => true, mayRequest: () => true, mayApprove: () => false, mayReceive: () => false, approvePort: () => null },
      outbox,
    );
    const s = withDevice({ outbox, indents: refillIndentPortOf(indents), freshCountId: () => 'sc-9' }, emptyShelves);
    s.count({ locationId: 'L-A1', productId: 'rice', countedMinor: 0 });
    const raised = s.raiseRefill();
    expect(raised.ok).toBe(true);
    const asks = outbox.all().filter((i) => i.event.type === FLOOR_INDENT_REQUESTED);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.event.payload).toMatchObject({
      indentId: (raised as { indentId: string }).indentId, fromLocationId: 'store-1-back', toLocationId: 'store-1', requestedBy: 'u-merch', at: NOW, storeId: 'store-1',
      lines: [{ productId: 'rice', quantityMinor: 24, uom: 'KG' }, { productId: 'oil', quantityMinor: 18, uom: 'LTR' }], reason: 'shelf refill · A1, B3',
    });
    // One queue carries both: the count and the ask sit side by side, and the refill view reads its ask back from it.
    expect(outbox.all().map((i) => i.event.type)).toEqual([SHELF_COUNTED, FLOOR_INDENT_REQUESTED]);
    expect(s.refills().saved.map((r) => r.indentId)).toEqual([(raised as { indentId: string }).indentId]);
    expect(s.raiseRefill()).toMatchObject({ ok: true, alreadySaved: true });
    expect(outbox.all()).toHaveLength(2);
  });
});
