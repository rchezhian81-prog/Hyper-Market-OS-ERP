import { describe, it, expect } from 'vitest';
import {
  createMerchSetupSession, contractBody, shelfMapFromRows, planogramFromRows, floorAreasFromRows, shelfRowsOf, areaRowsOf, listOf,
  merchSetupOutcomeWords, merchSetupWords, askWords, MERCH_SETUP_COPY, MERCH_SETUP_COPY_KEYS, MERCH_SETUP_PERMISSIONS, CLUSTER_DROP_REASONS,
  type MerchSetupHttp, type ContractForm, type ContractAsk,
} from '../../apps/web-erp/src/merchandising-setup-session';
import type { HttpAnswer } from '../../apps/web-erp/src/finance-close-session';

// Round 4a — the Shelves and space page's head-office setup tabs (re-audit M04-FR-04 · R8-8 / OB-318 · screen gap audit Round
// D). A thin client over head office's own routes: each action offered only to a person who holds the route's permission, the
// display contract's Finance approval asked for and then USED (never typed), a cluster drop that carries no stock figure, and
// each layout published whole as a new version. Never a success it did not get (P-08). Synthetic data only.

const ALL = Object.values(MERCH_SETUP_PERMISSIONS);
const ME = { userId: 'u-merch', permissions: ALL };

function fakeHttp(...answers: HttpAnswer[]): MerchSetupHttp & { calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const next = (): HttpAnswer => answers.shift() ?? { status: 200, body: {} };
  return {
    calls,
    get: async (path) => { calls.push({ method: 'GET', path }); return next(); },
    send: async (method, path, body) => { calls.push({ method, path, body }); return next(); },
  };
}

const FORM: ContractForm = {
  contractId: ' DC-1 ', storeId: 'S1', supplierId: 'sup-ak', description: 'End-cap aisle 3', fundingRupees: '5,000.50',
  startsOn: '2026-11-01', endsOn: '2026-12-31', places: 'A1, A2 A2', areaId: '',
};
const BODY = {
  storeId: 'S1', supplierId: 'sup-ak', description: 'End-cap aisle 3', fundingAmount: { minor: 500_050, currency: 'INR' },
  startsOn: '2026-11-01', endsOn: '2026-12-31', locationIds: ['A1', 'A2'],
};

describe('the merchandising setup tabs speak both languages', () => {
  it('every word has a Tamil twin, none left in English', () => {
    expect(Object.keys(MERCH_SETUP_COPY.ta).sort()).toEqual([...MERCH_SETUP_COPY_KEYS].sort());
    for (const k of MERCH_SETUP_COPY_KEYS) {
      expect(MERCH_SETUP_COPY.ta[k].trim(), k).not.toBe('');
      expect(MERCH_SETUP_COPY.ta[k], k).not.toBe(MERCH_SETUP_COPY.en[k]);
    }
    // Every drop reason and every season standing the routes give has words.
    for (const k of [...CLUSTER_DROP_REASONS, 'upcoming', 'in_season', 'due_to_end', 'ended', 'routed_to_clearance', 'delisted']) expect(MERCH_SETUP_COPY_KEYS).toContain(k);
  });
});

describe('the pure readings', () => {
  it('a contract body is exactly what the route reads: rupees to paise, places split and de-duplicated, no approval field', () => {
    expect(contractBody(FORM)).toEqual({ contractId: 'DC-1', body: BODY });
    expect(contractBody({ ...FORM, areaId: ' end-caps ' })?.body).toMatchObject({ areaId: 'end-caps' });
    expect(contractBody({ ...FORM, fundingRupees: 'five' })).toBeUndefined();
    expect(contractBody({ ...FORM, endsOn: '31/12/2026' })).toBeUndefined();
    expect(contractBody({ ...FORM, supplierId: ' ' })).toBeUndefined();
    expect(listOf(' a,b  c,,a ')).toEqual(['a', 'b', 'c']);
  });

  it('shelf-map lines: blank lines are skipped, a missing place code or a non-number names its line and box, an unknown zone is refused', () => {
    const line = { locationId: 'A1', aisle: '1', rack: '1', bay: '2', shelf: '3', position: '1', zone: 'chilled', label: 'Milk' };
    const empty = { locationId: '', aisle: '', rack: '', bay: '', shelf: '', position: '', zone: '', label: '' };
    expect(shelfMapFromRows([line, empty])).toEqual({ ok: true, value: [{ locationId: 'A1', aisle: 1, rack: 1, bay: 2, shelf: 3, position: 1, zone: 'chilled', label: 'Milk' }] });
    expect(shelfMapFromRows([empty])).toEqual({ ok: false, line: 0, field: 'none' });
    expect(shelfMapFromRows([line, { ...line, locationId: 'A2', bay: 'two' }])).toEqual({ ok: false, line: 2, field: 'bay' });
    expect(shelfMapFromRows([{ ...line, zone: 'hot' }])).toEqual({ ok: false, line: 1, field: 'zone' });
    // What head office holds reads back into the same lines.
    expect(shelfRowsOf({ storeId: 'S1', version: 2, publishedBy: 'u', publishedAt: 't', locations: [{ locationId: 'A1', aisle: 1, rack: 1, bay: 2, shelf: 3, position: 1 }] }))
      .toEqual([{ locationId: 'A1', aisle: '1', rack: '1', bay: '2', shelf: '3', position: '1', zone: '', label: '' }]);
    expect(shelfRowsOf(null)).toEqual([]);
  });

  it('planogram and floor-plan lines become the route\'s assignments and areas', () => {
    expect(planogramFromRows([{ productId: 'rice', locationId: 'A1', capacity: '40', primary: true }, { productId: '', locationId: '', capacity: '', primary: false }]))
      .toEqual({ ok: true, value: [{ productId: 'rice', locationId: 'A1', capacityMinor: 40, primary: true }] });
    expect(planogramFromRows([{ productId: 'rice', locationId: '', capacity: '40', primary: true }])).toEqual({ ok: false, line: 1, field: 'locationId' });
    const area = { areaId: 'staples', name: 'Staples', nameTa: 'மளிகை', x: '0', y: '0', width: '10', depth: '10', squareFeet: '', places: 'A1, A2' };
    expect(floorAreasFromRows([area])).toEqual({ ok: true, value: [{ areaId: 'staples', name: 'Staples', nameTa: 'மளிகை', x: 0, y: 0, width: 10, depth: 10, locationIds: ['A1', 'A2'] }] });
    expect(floorAreasFromRows([{ ...area, depth: '' }])).toEqual({ ok: false, line: 1, field: 'depth' });
    expect(areaRowsOf({ storeId: 'S1', version: 1, widthFt: 40, depthFt: 30, publishedBy: 'u', publishedAt: 't', areas: [{ areaId: 'staples', name: 'Staples', x: 0, y: 0, width: 10, depth: 10, squareFeet: 100, locationIds: ['A1'] }] }))
      .toEqual([{ areaId: 'staples', name: 'Staples', nameTa: '', x: '0', y: '0', width: '10', depth: '10', squareFeet: '100', places: 'A1' }]);
  });
});

describe('the display contract (M04-FR-04 · D02-FR-06 · ADR-0024)', () => {
  it('records through head office\'s route with exactly the body — and says "not approved" when head office says so', async () => {
    const http = fakeHttp({ status: 201, body: { contractId: 'DC-1', approved: false } });
    const out = await createMerchSetupSession(ME, http).recordContract(FORM);
    expect(http.calls).toEqual([{ method: 'POST', path: '/v1/merchandising/display-contracts/DC-1', body: BODY }]);
    expect(out).toMatchObject({ kind: 'done', body: { approved: false } });
  });

  it('asks Finance with the same body as the details, the amount in paise, and a reason — then records naming THAT approval with the ask\'s own details', async () => {
    const http = fakeHttp({ status: 201, body: { requestId: 'areq-1', status: 'waiting' } });
    const s = createMerchSetupSession(ME, http);
    expect(await s.askContractApproval(FORM, '  ')).toEqual({ kind: 'invalid', detail: 'needAskReason' });
    expect(http.calls).toEqual([]);
    await s.askContractApproval(FORM, ' Diwali end-cap ');
    expect(http.calls[0]).toMatchObject({
      method: 'POST', path: '/v1/approvals/requests',
      body: { kind: 'display_contract', subjectRef: 'DC-1', valueMinor: 500_050, details: { ...BODY, contractId: 'DC-1' }, reason: 'Diwali end-cap' },
    });

    const approved: ContractAsk = { requestId: 'areq-1', kind: 'display_contract', subjectRef: 'DC-1', status: 'approved', details: { ...BODY, contractId: 'DC-1' }, valueMinor: 500_050, summary: 's', decidedBy: 'u-acct' };
    const rec = fakeHttp({ status: 201, body: { contractId: 'DC-1', approved: true } });
    const out = await createMerchSetupSession(ME, rec).recordApprovedContract(approved);
    expect(rec.calls).toEqual([{ method: 'POST', path: '/v1/merchandising/display-contracts/DC-1', body: { ...BODY, approvalId: 'areq-1' } }]);
    expect(out).toMatchObject({ kind: 'done', body: { approved: true } });
    // An ask still waiting (or refused) is never used to record.
    expect(await createMerchSetupSession(ME, rec).recordApprovedContract({ ...approved, status: 'waiting' })).toEqual({ kind: 'invalid', detail: 'needContract' });
    expect(askWords('en', approved)).toBe('approved by u-acct');
    expect(askWords('ta', { status: 'waiting' })).toBe('நிதித் துறைக்காகக் காத்திருக்கிறது');
  });

  it('lists only the person\'s own display-contract asks, newest first', async () => {
    const http = fakeHttp({ status: 200, body: { mine: [
      { requestId: 'a1', kind: 'display_contract', subjectRef: 'DC-1', status: 'used' }, { requestId: 'b', kind: 'rebate_claim', subjectRef: 'x', status: 'waiting' },
      { requestId: 'a2', kind: 'display_contract', subjectRef: 'DC-2', status: 'waiting' },
    ] } });
    const out = await createMerchSetupSession(ME, http).contractAsks();
    expect(out.kind === 'done' ? out.body.map((a) => a.requestId) : out).toEqual(['a2', 'a1']);
  });

  it('a person without the right is told so and nothing is sent; nobody named is nobody', async () => {
    const http = fakeHttp();
    const s = createMerchSetupSession({ userId: 'u-floor', permissions: ['merchandising.range.read'] }, http);
    expect(s.may).toMatchObject({ named: true, contract: false, rangeRead: true, rangeManage: false, publish: false });
    const out = await s.recordContract(FORM);
    expect(merchSetupOutcomeWords('en', out)).toBe('Your role cannot record display contracts.');
    const nobody = createMerchSetupSession({ permissions: ALL }, http);
    expect(nobody.may.contract).toBe(false);
    expect(merchSetupOutcomeWords('en', await nobody.publishShelfMap('S1', []))).toBe('Nobody is signed in on this screen — nothing can be read or changed here.');
    expect(createMerchSetupSession(undefined, http).may.named).toBe(false);
    expect(http.calls).toEqual([]);
  });
});

describe('clusters and seasons (R8-8 · OB-318: the cluster is the price-zone register)', () => {
  it('reads the clusters and a store\'s range, lists and drops for a cluster — a drop carries no stock figure', async () => {
    const http = fakeHttp(
      { status: 200, body: { clusters: [{ zoneId: 'north', stores: ['S1', 'S2'] }] } },
      { status: 201, body: { stores: ['S1', 'S2'] } },
      { status: 201, body: { decisions: [{ storeId: 'S1', outcome: 'routed_to_clearance', onHandMinor: 7 }] } },
      { status: 200, body: { storeId: 'S1', onDate: '2026-11-01', listed: ['diya'] } },
    );
    const s = createMerchSetupSession(ME, http);
    await s.clusters();
    await s.listForCluster('north', 'diya', '2026-11-01');
    await s.dropForCluster('north', 'diya', { reason: 'poor_sales', effectiveFrom: '2026-11-01', reasonNote: ' ', replacedByProductId: '' });
    await s.storeRange('S1', '2026-11-01');
    expect(http.calls).toEqual([
      { method: 'GET', path: '/v1/merchandising/clusters' },
      { method: 'POST', path: '/v1/merchandising/clusters/north/diya/list', body: { effectiveFrom: '2026-11-01' } },
      { method: 'POST', path: '/v1/merchandising/clusters/north/diya/drop', body: { reason: 'poor_sales', effectiveFrom: '2026-11-01' } },
      { method: 'GET', path: '/v1/merchandising/assortment/S1?onDate=2026-11-01' },
    ]);
    expect(await s.dropForCluster('north', 'diya', { reason: 'because', effectiveFrom: '2026-11-01' })).toEqual({ kind: 'invalid', detail: 'needDropFields' });
  });

  it('makes a season plan for a cluster or one store, and ends the seasons that are over', async () => {
    const http = fakeHttp({ status: 201, body: { plan: { storeIds: ['S1'] } } }, { status: 201, body: { plan: { storeIds: ['S1'] } } }, { status: 200, body: { count: 1 } });
    const s = createMerchSetupSession(ME, http);
    await s.makeSeasonPlan({ planId: 'diwali', scope: 'zone', scopeId: 'north', products: 'crackers, sweets', listFrom: '2026-10-20', listTo: '2026-11-05', reason: 'Diwali' });
    await s.makeSeasonPlan({ planId: 'pongal', scope: 'store', scopeId: 'S1', products: 'cane', listFrom: '2027-01-10', listTo: '2027-01-17', reason: 'Pongal' });
    await s.sweepSeasons();
    expect(http.calls).toEqual([
      { method: 'POST', path: '/v1/merchandising/season-plans/diwali', body: { zoneId: 'north', productIds: ['crackers', 'sweets'], listFrom: '2026-10-20', listTo: '2026-11-05', reason: 'Diwali' } },
      { method: 'POST', path: '/v1/merchandising/season-plans/pongal', body: { storeId: 'S1', productIds: ['cane'], listFrom: '2027-01-10', listTo: '2027-01-17', reason: 'Pongal' } },
      { method: 'POST', path: '/v1/merchandising/season-plans/sweep', body: {} },
    ]);
    expect(await s.makeSeasonPlan({ planId: 'x', scope: 'zone', scopeId: 'north', products: '', listFrom: '2026-10-20', listTo: '2026-11-05', reason: 'r' })).toEqual({ kind: 'invalid', detail: 'needSeason' });
  });
});

describe('the shelf layout (Round D: shelf map, planogram, floor plan)', () => {
  it('publishes each whole, as head office\'s routes take it (PUT the map and the plan, POST the floor plan)', async () => {
    const http = fakeHttp({ status: 201, body: {} }, { status: 201, body: {} }, { status: 201, body: {} });
    const s = createMerchSetupSession(ME, http);
    await s.publishShelfMap('S1', [{ locationId: 'A1', aisle: '1', rack: '1', bay: '1', shelf: '1', position: '1' }]);
    await s.publishPlanogram('S1', 'main', '2026-11-01', [{ productId: 'rice', locationId: 'A1', capacity: '40', primary: true }]);
    await s.publishFloorPlan('S1', '40', '30', [{ areaId: 'staples', name: 'Staples', x: '0', y: '0', width: '10', depth: '10', places: 'A1' }]);
    expect(http.calls).toEqual([
      { method: 'PUT', path: '/v1/merchandising/stores/S1/shelf-map', body: { locations: [{ locationId: 'A1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1 }] } },
      { method: 'PUT', path: '/v1/merchandising/stores/S1/planograms/main', body: { effectiveFrom: '2026-11-01', assignments: [{ productId: 'rice', locationId: 'A1', capacityMinor: 40, primary: true }] } },
      { method: 'POST', path: '/v1/merchandising/stores/S1/floor-plan', body: { widthFt: 40, depthFt: 30, areas: [{ areaId: 'staples', name: 'Staples', x: 0, y: 0, width: 10, depth: 10, locationIds: ['A1'] }] } },
    ]);
  });

  it('a register never published reads as "none yet" (head office\'s 404), not as a failure; no answer is said as nothing read', async () => {
    const http = fakeHttp({ status: 404, body: { error: { code: 'not_found', whatHappened: 'Not found: shelf map for store S1' } } }, { status: 0, body: null });
    const s = createMerchSetupSession(ME, http);
    expect(await s.shelfMap('S1')).toEqual({ kind: 'done', status: 404, body: null });
    const lost = await s.floorPlan('S1');
    expect(merchSetupOutcomeWords('en', lost, 'read')).toBe('Head office cannot be reached — nothing was read, so nothing is shown.');
  });

  it('a line that cannot be sent names its line and box, in both languages; a refusal is head office\'s own words; no answer saves nothing', async () => {
    const http = fakeHttp(
      { status: 422, body: { error: { code: 'the_plan_is_inconsistent', whatHappened: 'Product rice is assigned to location Z9, which is not on the shelf map.', nextSafeAction: 'Fix the shelf map.' } } },
      { status: 0, body: null },
    );
    const s = createMerchSetupSession(ME, http);
    const bad = await s.publishShelfMap('S1', [{ locationId: 'A1', aisle: '1', rack: 'x', bay: '1', shelf: '1', position: '1' }]);
    expect(merchSetupOutcomeWords('en', bad)).toBe('Line 1: “Rack” is missing or not a number. Nothing was sent.');
    expect(merchSetupOutcomeWords('ta', bad)).toBe('வரி 1: “ரேக்” இல்லை அல்லது எண் அல்ல. எதுவும் அனுப்பப்படவில்லை.');
    expect(merchSetupOutcomeWords('en', await s.publishShelfMap('S1', []))).toBe('Add at least one line. Nothing was sent.');
    expect(merchSetupOutcomeWords('en', await s.publishPlanogram('S1', '', '2026-11-01', []))).toBe('Give the plan a name and the date it starts. Nothing was sent.');
    expect(http.calls).toEqual([]);
    const refused = await s.publishPlanogram('S1', 'main', '2026-11-01', [{ productId: 'rice', locationId: 'Z9', capacity: '4', primary: true }]);
    expect(merchSetupOutcomeWords('en', refused)).toBe('Head office refused: Product rice is assigned to location Z9, which is not on the shelf map. Fix the shelf map.');
    const lost = await s.publishFloorPlan('S1', '40', '30', [{ areaId: 'a', name: 'A', x: '0', y: '0', width: '1', depth: '1', places: '' }]);
    expect(merchSetupOutcomeWords('en', lost)).toBe(merchSetupWords('en')('unreachable'));
  });
});
