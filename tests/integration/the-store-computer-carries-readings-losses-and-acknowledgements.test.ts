import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { aBranch } from '../support/a-branch';
import { storeRules } from '../support/store-rules';

// OB-288 LP/workforce package — the facilities office (M26-FR-01/02/04), the manual readings, the stock losses and the SOP
// acknowledgements the store computer carries with the line down (M26-FR-02 "readings cache/queue offline" · M28-FR-01
// "queued; approval on sync" · M25-FR-04 "help works offline"), and the relabel tasks a price change raises (D11-FR-03).
// Through the real API, in memory and — with DATABASE_URL — on real PostgreSQL, with cold restarts. Synthetic data.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const TODAY = new Date().toISOString().slice(0, 10);

describe.each(backings)('the store computer carries readings, losses and acknowledgements; the office read; relabel tasks — on $name', ({ harness }) => {
  it('the facilities office read; a reading carried by the box recorded as the person, refusals by name', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier', ['br-1']);
    await h.provisionRole(T, 'box-1', 'store_computer', ['br-1']);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>, key?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(['box-1', 'u-cash'].includes(userId) ? { branchId: 'br-1' } : {}), ...(method === 'POST' ? { idempotencyKey: key ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    await ok(call('POST', '/v1/facilities/assets/cold-1', 'u-owner', { branchId: 'br-1', name: 'Cold room 1', kind: 'cold_room', criticality: 'critical', installedOn: '2020-01-01', protectsValueMinor: 800_000 }), 'cold room');
    await ok(call('POST', '/v1/facilities/assets/trolley-1', 'u-owner', { branchId: 'br-1', name: 'Shelf trolley', kind: 'handling', criticality: 'routine', installedOn: '2020-01-01', amcUntil: '2099-01-01' }), 'trolley');
    await ok(call('POST', '/v1/facilities/assets/other-1', 'u-owner', { branchId: 'br-2', name: 'Other store chiller', kind: 'refrigeration', criticality: 'critical', installedOn: '2020-01-01' }), 'other store');
    await ok(call('POST', '/v1/facilities/equipment/cold-1/range', 'u-owner', { branchId: 'br-1', name: 'Cold room 1', minTenthsC: 0, maxTenthsC: 80, graceMinutes: 30, expectEveryMinutes: 120 }), 'range');
    await ok(call('POST', '/v1/facilities/energy/en-1', 'u-owner', { branchId: 'br-1', onDate: TODAY, kilowattHours: 100, costMinor: 100_000, source: 'meter' }), 'energy');
    await ok(call('POST', '/v1/facilities/assets/cold-1/downtime/dt-1', 'u-owner', { failedAt: ago(300), reportedAt: ago(240) }), 'downtime');
    await ok(call('POST', '/v1/facilities/incidents/I1', 'u-mgr', { branchId: 'br-1', kind: 'near_miss', severity: 'minor', occurredAt: ago(60), reportedAt: ago(55), reportedBy: 'u-mgr', description: 'wet floor by the chiller' }), 'incident');

    // ── the office read: one read, each part from the facilities engines ──
    expect(codeOf(await call('GET', '/v1/facilities/office', 'u-mgr'))).toBe('office_needs_a_branch');
    expect((await call('GET', '/v1/facilities/office', 'u-cash', undefined, { branchId: 'br-1' })).status).toBe(403);
    expect((await call('GET', '/v1/facilities/office', 'box-1', undefined, { branchId: 'br-2' })).status).toBe(403); // its own store only
    const office = (await ok(call('GET', '/v1/facilities/office', 'u-mgr', undefined, { branchId: 'br-1' }), 'office')).body as {
      assets: { assetId: string; lastServicedOn: string | null }[]; health: { critical: { assetId: string; kind: string }[] };
      equipment: { assetId: string; lastReading: unknown; assessment: { state: string } }[]; downtime: { assetId: string; stillDown: boolean }[];
      energy: { kilowattHours: number; estimatedShareBps: number | string }; incidents: { incidentId: string; open: boolean }[];
    };
    expect(office.assets.map((a) => [a.assetId, a.lastServicedOn])).toEqual([['cold-1', null], ['trolley-1', null]]); // critical first; the other store's not here
    expect(office.health.critical.some((a) => a.assetId === 'cold-1' && a.kind === 'amc_missing')).toBe(true);
    expect(office.equipment.map((e) => [e.assetId, e.lastReading, e.assessment.state])).toEqual([['cold-1', null, 'no_data']]); // silence is a fault, not a pass
    expect(office.downtime.map((d) => [d.assetId, d.stillDown])).toEqual([['cold-1', true]]);
    expect([office.energy.kilowattHours, office.energy.estimatedShareBps]).toEqual([100, 0]);
    expect(office.incidents.map((i) => [i.incidentId, i.open])).toEqual([['I1', true]]);

    // ── the store computer's feed for its offline facilities page ──
    expect((await call('GET', '/v1/facilities/equipment-feed', 'u-cash', undefined, { branchId: 'br-1' })).status).toBe(403);
    const feed = (await ok(call('GET', '/v1/facilities/equipment-feed', 'box-1', undefined, { branchId: 'br-1' }), 'feed')).body as { equipment: { assetId: string; range: { maxTenthsC: number }; lastReadingAt: string | null }[] };
    expect(feed.equipment.map((e) => [e.assetId, e.range.maxTenthsC, e.lastReadingAt])).toEqual([['cold-1', 80, null]]);

    // ── a manual reading taken on that page with the line down, carried by the box ──
    const at = ago(20);
    const reading = (readingId: string, over: Record<string, unknown> = {}) => ({ assetId: 'cold-1', readingId, tenthsC: 40, at, source: 'manual_probe', recordedBy: 'u-mgr', storeId: 'br-1', ...over });
    expect((await call('POST', '/v1/facilities/equipment/cold-1/readings/rd-1/synced', 'u-mgr', reading('rd-1'))).status).toBe(403); // only a store computer relays
    expect(codeOf(await call('POST', '/v1/facilities/equipment/cold-1/readings/rd-1/synced', 'box-1', reading('rd-2')))).toBe('not_readable_as_a_relayed_reading');
    expect(codeOf(await call('POST', '/v1/facilities/equipment/cold-1/readings/rd-1/synced', 'box-1', reading('rd-1', { tenthsC: 4.5 })))).toBe('not_readable_as_a_relayed_reading');
    expect(codeOf(await call('POST', '/v1/facilities/equipment/cold-1/readings/rd-1/synced', 'box-1', reading('rd-1', { at: new Date(Date.now() + 3_600_000).toISOString() })))).toBe('reading_in_the_future');
    expect(codeOf(await call('POST', '/v1/facilities/equipment/cold-1/readings/rd-1/synced', 'box-1', reading('rd-1', { recordedBy: 'u-cash' })))).toBe('person_may_not_record_readings');
    expect(codeOf(await call('POST', '/v1/facilities/equipment/cold-9/readings/rd-9/synced', 'box-1', reading('rd-9', { assetId: 'cold-9' })))).toBe('equipment_not_known');
    await ok(call('POST', '/v1/facilities/equipment/cold-1/readings/rd-1/synced', 'box-1', reading('rd-1'), undefined, 'relay-rd-1'), 'relayed reading');
    await ok(call('POST', '/v1/facilities/equipment/cold-1/readings/rd-1/synced', 'box-1', reading('rd-1'), undefined, 'relay-rd-1'), 'replayed');

    h = harness(h); // ── COLD RESTART ──
    const after = (await ok(call('GET', '/v1/facilities/office', 'u-mgr', undefined, { branchId: 'br-1' }), 'office')).body as { equipment: { lastReading: { tenthsC: number; at: string; recordedBy: string; source: string } | null; assessment: { state: string } }[] };
    expect(after.equipment[0]!.lastReading).toMatchObject({ tenthsC: 40, at, recordedBy: 'u-mgr', source: 'manual_probe' }); // timed by when it was taken
    expect(after.equipment[0]!.assessment.state).toBe('within_range');
    const feed2 = (await ok(call('GET', '/v1/facilities/equipment-feed', 'box-1', undefined, { branchId: 'br-1' }), 'feed')).body as { equipment: { lastReadingAt: string | null }[] };
    expect(feed2.equipment[0]!.lastReadingAt).toBe(at);
  });

  it('a loss captured at the store: a small one recorded, a big one waits for a second person (never the raiser), rejected keeps nothing', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await aBranch(h, T, 'u-owner', 'br-1');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier', ['br-1']);
    await h.provisionRole(T, 'box-1', 'store_computer', ['br-1']);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>, key?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(['box-1', 'u-cash'].includes(userId) ? { branchId: 'br-1' } : {}), ...(method === 'POST' ? { idempotencyKey: key ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    expect((await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rcv-MILK', productId: 'MILK', locationId: 'br-1', kind: 'received', quantityMinor: 100, uom: 'ea', occurredAt: ago(600), enteredBy: 'u-owner', unitCostMinor: 5_000 })).status).toBe(202);

    const capturedAt = ago(30);
    const loss = (writeOffId: string, over: Record<string, unknown> = {}) => ({ writeOffId, productId: 'MILK', locationId: 'br-1', qty: 2, uom: 'ea', lossType: 'damage', reasonCode: 'damage', raisedBy: 'u-mgr', capturedAt, storeId: 'br-1', ...over });
    const relay = (id: string, body: Record<string, unknown>) => call('POST', `/v1/inventory/write-off/${id}/synced`, 'box-1', body, undefined, `relay-${id}`);
    expect((await call('POST', '/v1/inventory/write-off/WO-1/synced', 'u-mgr', loss('WO-1'))).status).toBe(403); // only a store computer relays
    expect(codeOf(await relay('WO-X', loss('WO-Y')))).toBe('not_readable_as_a_captured_write_off');
    expect(codeOf(await relay('WO-X', loss('WO-X', { reasonCode: 'leaking' })))).toBe('not_readable_as_a_captured_write_off');
    expect(codeOf(await relay('WO-C', loss('WO-C', { raisedBy: 'u-cash' })))).toBe('raiser_may_not_write_off');
    expect((await relay('WO-B', loss('WO-B', { locationId: 'br-2' }))).status).toBe(403); // the box speaks for its own store only
    // A small loss (₹100, below the ₹500 line): recorded there and then, valued at head office's own cost.
    const small = await relay('WO-1', loss('WO-1'));
    expect([small.status, small.body]).toEqual([201, { writeOffId: 'WO-1', state: 'posted', valueMinor: 10_000 }]);
    expect((await relay('WO-1', loss('WO-1'))).status).toBe(201); // the same relay replays its answer
    // A big loss (₹1,000) with no photo is refused by name and stays at the store.
    expect(codeOf(await relay('WO-2', loss('WO-2', { qty: 20 })))).toBe('write_off_needs_evidence');
    // With its photo it waits at head office for a second person: approval on sync.
    const big = await relay('WO-3', loss('WO-3', { qty: 20, evidenceRef: 'photo-wo-3' }));
    expect([big.status, big.body]).toEqual([202, { writeOffId: 'WO-3', state: 'awaiting_approval', valueMinor: 100_000 }]);
    expect(((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { count: number }).count).toBe(1); // nothing written off yet

    h = harness(h); // ── COLD RESTART ──
    expect((await call('POST', '/v1/inventory/write-off/WO-3/synced', 'box-1', loss('WO-3', { qty: 20, evidenceRef: 'photo-wo-3' }), undefined, 'relay-again-WO-3')).status).toBe(202); // a second carry is the same capture
    const pending = (await ok(call('GET', '/v1/inventory/write-off-captures', 'u-mgr2'), 'captures')).body as { captures: { loss: { writeOffId: string }; state: string }[]; awaitingApproval: number };
    expect([pending.awaitingApproval, pending.captures.map((c) => [c.loss.writeOffId, c.state])]).toEqual([1, [['WO-3', 'awaiting_approval'], ['WO-1', 'posted']]]);
    expect(codeOf(await call('POST', '/v1/inventory/write-off-captures/WO-3/decide', 'u-mgr2', { decision: 'maybe', reason: 'x' }))).toBe('not_readable_as_a_decision');
    expect((await call('POST', '/v1/inventory/write-off-captures/WO-9/decide', 'u-mgr2', { decision: 'approved', reason: 'seen it' })).status).toBe(404);
    expect((await call('POST', '/v1/inventory/write-off-captures/WO-3/decide', 'u-cash', { decision: 'approved', reason: 'seen it' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/inventory/write-off-captures/WO-3/decide', 'u-mgr', { decision: 'approved', reason: 'mine' }))).toBe('self_approval');
    const approved = await ok(call('POST', '/v1/inventory/write-off-captures/WO-3/decide', 'u-mgr2', { decision: 'approved', reason: 'saw the split crate' }), 'approve');
    expect((approved.body as { state: string; approvalId: string }).state).toBe('posted');
    expect(((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { count: number }).count).toBe(2);
    // The approval is the approvals engine's: asked by the raiser, decided by the second person.
    const approvalId = (approved.body as { approvalId: string }).approvalId;
    const mine = ((await ok(call('GET', '/v1/approvals/requests', 'u-mgr'), 'approvals')).body as { mine: { requestId: string; kind: string; requestedBy: string; decidedBy?: string; usedBy?: string }[] }).mine;
    expect(mine.find((r) => r.requestId === approvalId)).toMatchObject({ kind: 'stock_write_off', requestedBy: 'u-mgr', decidedBy: 'u-mgr2' });

    // Rejected: nothing is written off; the capture is kept with the reason.
    expect((await relay('WO-4', loss('WO-4', { qty: 30, evidenceRef: 'photo-wo-4' }))).status).toBe(202);
    await ok(call('POST', '/v1/inventory/write-off-captures/WO-4/decide', 'u-mgr2', { decision: 'rejected', reason: 'the crate was resold' }), 'reject');
    h = harness(h); // ── COLD RESTART ──
    expect(((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { count: number }).count).toBe(2);
    const all = (await ok(call('GET', '/v1/inventory/write-off-captures', 'u-owner'), 'captures')).body as { captures: { loss: { writeOffId: string }; state: string; decidedBy?: string; decisionReason?: string }[] };
    expect(all.captures.find((c) => c.loss.writeOffId === 'WO-4')).toMatchObject({ state: 'rejected', decidedBy: 'u-mgr2', decisionReason: 'the crate was resold' });
    expect((await call('POST', '/v1/inventory/write-off-captures/WO-4/decide', 'u-owner', { decision: 'approved', reason: 'again' })).body).toMatchObject({ state: 'rejected', alreadyDecided: true });
  });

  it('a new price raises one relabel task per shelf place; closed with the photo and the price the label shows; an SOP acknowledged at the store', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await aBranch(h, T, 'u-owner', 'br-1');
    await storeRules(h, T, 'u-owner', 'br-1', 0);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier', ['br-1']);
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'box-1', 'store_computer', ['br-1']);
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>, key?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(['box-1', 'u-cash'].includes(userId) ? { branchId: 'br-1' } : {}), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('PUT', '/v1/merchandising/stores/br-1/shelf-map', 'u-mgr', { locations: [{ locationId: 'L1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1 }, { locationId: 'L2', aisle: 4, rack: 1, bay: 1, shelf: 2, position: 1 }] }), 'map');
    await ok(call('PUT', '/v1/merchandising/stores/br-1/planograms/PG-1', 'u-mgr', { effectiveFrom: '2026-01-01', assignments: [{ productId: 'p-salt', locationId: 'L1', capacityMinor: 10, primary: true }, { productId: 'p-salt', locationId: 'L2', capacityMinor: 10, primary: false }] }), 'plan');
    await ok(call('POST', '/v1/catalogue/products/p-salt/publish', 'u-owner', { product: { sku: 'SKU-SALT', name: 'Salt 1kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 'product');

    const change = await ok(call('POST', '/v1/prices/changes', 'u-owner', { productId: 'p-salt', priceMinor: 1_800, mrpMinor: 2_500, costMinor: 1_000, currency: 'INR', marginFloorBps: 0 }), 'price change');
    expect(change.body).toMatchObject({ operativeAt: ['br-1'], relabelTasks: 2 });
    expect((await call('GET', '/v1/pricing/relabel-tasks', 'u-cash')).status).toBe(403);

    h = harness(h); // ── COLD RESTART ──
    const tasks = (await ok(call('GET', '/v1/pricing/relabel-tasks', 'u-mgr', undefined, { branchId: 'br-1' }), 'tasks')).body as { tasks: { taskId: string; locationId: string | null; priceMinor: number; because: string; done: unknown; dueNow: boolean }[]; open: number };
    expect([tasks.open, tasks.tasks.map((t) => [t.locationId, t.priceMinor, t.because, t.done, t.dueNow])]).toEqual([2, [['L1', 1_800, 'price_change', null, true], ['L2', 1_800, 'price_change', null, true]]]);
    const first = tasks.tasks[0]!.taskId;
    expect(codeOf(await call('POST', `/v1/pricing/relabel-tasks/${first}/done`, 'u-mgr', { shelfPriceMinor: 1_800 }))).toBe('not_readable_as_relabel_done');
    expect(codeOf(await call('POST', `/v1/pricing/relabel-tasks/${first}/done`, 'u-mgr', { shelfPriceMinor: 2_000, evidenceRef: 'photo-l1' }))).toBe('label_shows_another_price');
    expect((await call('POST', '/v1/pricing/relabel-tasks/RL-nope/done', 'u-mgr', { shelfPriceMinor: 1_800, evidenceRef: 'photo-l1' })).status).toBe(404);
    await ok(call('POST', `/v1/pricing/relabel-tasks/${first}/done`, 'u-mgr', { shelfPriceMinor: 1_800, evidenceRef: 'photo-l1' }), 'done');
    expect(((await call('POST', `/v1/pricing/relabel-tasks/${first}/done`, 'u-mgr', { shelfPriceMinor: 1_800, evidenceRef: 'photo-l1' })).body as { alreadyDone: boolean }).alreadyDone).toBe(true);
    // A store price-list entry raises its own, due from its day.
    expect((await ok(call('POST', '/v1/prices/list/p-salt/entries/e2', 'u-owner', { scope: 'store', scopeRef: 'br-1', priceMinor: 1_700, mrpMinor: 2_500, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }), 'entry')).body).toMatchObject({ relabelTasks: 2 });

    h = harness(h); // ── COLD RESTART ──
    const later = (await ok(call('GET', '/v1/pricing/relabel-tasks', 'u-mgr'), 'tasks')).body as { tasks: { taskId: string; done: { doneBy: string; shelfPriceMinor: number } | null; because: string }[]; open: number };
    expect(later.open).toBe(3);
    expect(later.tasks.find((t) => t.taskId === first)!.done).toMatchObject({ doneBy: 'u-mgr', shelfPriceMinor: 1_800 });
    // The shelf label is now a price-integrity observation (D-7), in the person's name.
    const obs = (await ok(call('GET', '/v1/pricing/integrity/ageing', 'u-owner', undefined, { branchId: 'br-1', productId: 'p-salt' }), 'price integrity')).body;
    expect(JSON.stringify(obs)).toMatch(/shelf_label/);

    // ── an SOP acknowledgement given on the help page the box serves, carried to head office ──
    await ok(call('POST', '/v1/hr/workforce/help/built-in/SOP-01/publish', 'u-mgr', {}), 'publish');
    const acknowledgedAt = ago(15);
    const ack = (over: Record<string, unknown> = {}) => ({ sopId: 'SOP-01', employeeId: 'u-cash', version: 1, acknowledgedAt, ...over });
    expect((await call('POST', '/v1/hr/workforce/sops/SOP-01/acknowledgements/u-cash/synced', 'u-mgr', ack())).status).toBe(403); // only a store computer relays
    expect(codeOf(await call('POST', '/v1/hr/workforce/sops/SOP-01/acknowledgements/u-cash/synced', 'box-1', ack({ employeeId: 'u-mgr' })))).toBe('not_readable_as_a_relayed_acknowledgement');
    expect(codeOf(await call('POST', '/v1/hr/workforce/sops/SOP-01/acknowledgements/u-it/synced', 'box-1', ack({ employeeId: 'u-it' })))).toBe('person_may_not_acknowledge');
    expect((await ok(call('POST', '/v1/hr/workforce/sops/SOP-01/acknowledgements/u-cash/synced', 'box-1', ack()), 'relayed ack')).status).toBe(202);
    h = harness(h); // ── COLD RESTART ──
    const help = (await ok(call('GET', '/v1/hr/workforce/help', 'u-cash'), 'help')).body as { sops: { sopId: string; upToDate: boolean; acknowledgedVersion: number | null }[] };
    expect(help.sops.find((s) => s.sopId === 'SOP-01')).toMatchObject({ upToDate: true, acknowledgedVersion: 1 });
  });
});
