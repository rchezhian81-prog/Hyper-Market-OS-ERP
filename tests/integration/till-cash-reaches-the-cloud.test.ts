import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { sealedCashMovement, sealedShiftClose } from '../support/store-seal';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge } from '../../edge/store-edge/src/main';
import { bootPos, laneDurable, laneCashMovement, laneShiftClose, laneTillCash } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, holdSignedInAt } from '../support/till-operator';

/**
 * **The till's cash reaches head office and is RE-VERIFIED there — never refused, always said (SP-4c · F10 · M14-FR-01 ·
 * M14-FR-02 · §28 · §31 · hard rules #4 #10).**
 *
 * The store box records a float, a pickup and a close on its own log and relays them under the store's sync identity to
 * two SYNCED routes. Each re-verifies the person the record names from THEIR grants (never the relay's), re-runs the same
 * guard head office runs on its own chain, and records the movement or close WITH any finding as a visible flag: a name
 * head office does not know, a person with no till authority, a chain that disagrees, figures that do not follow, a
 * default tolerance — record-and-flag, never silently applied, never dropped. A material short opens a loss-prevention
 * investigation exactly as a direct close does. Idempotent on the till's own ids. Then the whole seam through the real
 * edge: float and close on the box's disk, drained through the real transport to these routes, not re-sent on restart.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa4c';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb4c';
const DAY = '2026-09-30';
const AT = '2026-09-30T09:00:00.000Z';

const movement = (over: Record<string, unknown> = {}) => ({
  movementId: 'cm-1', tillId: 'lane-1', laneId: 'lane-1', kind: 'float_issue', amountMinor: 200_000, deltaMinor: 200_000, currency: 'INR',
  custodianId: 'u-meena', performedBy: 'u-meena', tradingDay: DAY, at: AT, ...over,
});
const close = (over: Record<string, unknown> = {}) => ({
  shiftId: 'sh-1', tillId: 'lane-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: DAY, openedAt: AT, closedAt: '2026-09-30T20:00:00.000Z',
  openingFloatMinor: 200_000, cashSalesMinor: 96_000, pickupsMinor: 250_000, cashRefundsMinor: 0, countedMinor: 46_000, expectedMinor: 46_000, varianceMinor: 0,
  exceptionRaised: false, reasonCode: null, toleranceMinor: 10_000, toleranceKnown: true, currency: 'INR', ...over,
});

// Relayed as a current store computer sends them — who did it, sealed by the box (ADR-0023).
const relayMovement = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>, key = `k-${String(body['movementId'])}`) =>
  h.request({ method: 'POST', path: `/v1/tills/${String(body['tillId'])}/cash-movements/synced`, userId, tenantId, idempotencyKey: key, body: sealedCashMovement(tenantId, body) });
const relayClose = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>, key = `k-${String(body['shiftId'])}`) =>
  h.request({ method: 'POST', path: `/v1/shifts/${String(body['shiftId'])}/close/synced`, userId, tenantId, idempotencyKey: key, body: sealedShiftClose(tenantId, body) });
const tillCash = (h: ApiHarness, tenantId: string, tillId = 'lane-1', userId = 'u-owner') =>
  h.request({ method: 'GET', path: `/v1/tills/${tillId}/cash`, userId, tenantId });
const overShort = (h: ApiHarness, tenantId: string) => h.request({ method: 'GET', path: '/v1/shifts/over-short', userId: 'u-owner', tenantId });

interface Cash { custodian: string | null; balanceMinor: number; flagged: { movementId: string; flags: string[] }[] }
interface OverShort { overShort: { shiftId: string; relayed: boolean; flags: string[]; laneId: string | null; varianceMinor: number }[] }

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-meena', 'cashier');   // holds the till: pos.sale.sync
  await h.provisionRole(A, 'u-box', 'cashier');     // the store box's sync identity: cash.movement.sync, till.shift.sync
  await h.provisionRole(A, 'u-visitor', 'customer'); // a known person with NO till authority
  await h.provisionRole(A, 'u-manager', 'store_manager'); // who a material short is investigated by
  await h.seedOwner(B, 'u-owner-b');
  return h;
}

describe('the cloud records a relayed cash movement and re-verifies it (SP-4c · F10 · M14-FR-01)', () => {
  it('records a float and a pickup the box relayed, idempotently, and the cash office reads the chain the same as a direct one', async () => {
    const h = await seeded();
    const float = await relayMovement(h, A, 'u-box', movement());
    expect(float.status).toBe(202);
    expect(float.body).toEqual({ movementId: 'cm-1', tillId: 'lane-1', recorded: true, flags: [] });
    expect((await relayMovement(h, A, 'u-box', movement({ movementId: 'cm-2', kind: 'pickup', amountMinor: 50_000, deltaMinor: -50_000, at: '2026-09-30T12:00:00.000Z' }))).status).toBe(202);
    // The same movement again, under the same key and under a fresh one: recorded once.
    expect((await relayMovement(h, A, 'u-box', movement())).status).toBe(202);
    const again = await relayMovement(h, A, 'u-box', movement(), 'k-fresh');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ movementId: 'cm-1', recorded: true, alreadyRecorded: true });
    expect((await tillCash(h, A)).body as Cash).toMatchObject({ custodian: 'u-meena', balanceMinor: 150_000, flagged: [] });
    // Another tenant sees none of it.
    expect((await tillCash(h, B, 'lane-1', 'u-owner-b')).body as Cash).toMatchObject({ custodian: null, balanceMinor: 0 });
  });

  it('flags — never refuses — a custodian head office does not know, a recorder with no till authority, and a chain that disagrees', async () => {
    const h = await seeded();
    const stranger = await relayMovement(h, A, 'u-box', movement({ custodianId: 'u-nobody', performedBy: 'u-nobody' }));
    expect(stranger.status).toBe(202);
    expect((stranger.body as { flags: string[] }).flags).toEqual(['custodian_unknown']);
    // The float is now held by u-nobody on the cloud's chain: a pickup relayed for u-meena is a chain disagreement, and
    // its recorder (a known customer) holds no till authority. Recorded as it happened, both flags on it.
    const pick = await relayMovement(h, A, 'u-box', movement({ movementId: 'cm-2', kind: 'pickup', amountMinor: 50_000, deltaMinor: -50_000, custodianId: 'u-meena', performedBy: 'u-visitor' }));
    expect(pick.status).toBe(202);
    expect((pick.body as { flags: string[] }).flags).toEqual(['recorder_lacks_authority', 'chain_till_not_held_by_this_custodian']);
    const cash = (await tillCash(h, A)).body as Cash;
    expect(cash.balanceMinor).toBe(150_000); // the money moved at the lane whatever the chain says
    expect(cash.flagged.map((f) => [f.movementId, f.flags])).toEqual([['cm-1', ['custodian_unknown']], ['cm-2', ['recorder_lacks_authority', 'chain_till_not_held_by_this_custodian']]]);
  });

  it('refuses a body that is not a relayed movement (400, nothing saved) and a caller without the sync permission (403)', async () => {
    const h = await seeded();
    const bad = await relayMovement(h, A, 'u-box', movement({ amountMinor: -5 }));
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_synced_cash_movement');
    expect((await relayMovement(h, A, 'u-visitor', movement())).status).toBe(403);
    expect((await tillCash(h, A)).body as Cash).toMatchObject({ custodian: null, balanceMinor: 0 });
  });
});

describe('the cloud records a relayed shift close, re-runs the rule and re-verifies the cashier (SP-4c · F10 · M14-FR-02)', () => {
  it('records a balanced close the box decided, idempotently; the over/short list shows nothing', async () => {
    const h = await seeded();
    const res = await relayClose(h, A, 'u-box', close());
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ shiftId: 'sh-1', tillId: 'lane-1', recorded: true, expectedMinor: 46_000, varianceMinor: 0, exceptionRaised: false, flags: [] });
    const again = await relayClose(h, A, 'u-box', close(), 'k-fresh');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ shiftId: 'sh-1', alreadyClosed: true });
    expect(((await overShort(h, A)).body as OverShort).overShort).toEqual([]);
  });

  it('a material SHORT with its reason is recorded, flagged for what the cloud found, and opens a loss-prevention investigation', async () => {
    const h = await seeded();
    const res = await relayClose(h, A, 'u-box', close({
      shiftId: 'sh-2', cashierId: 'u-nobody', countedMinor: 18_000, varianceMinor: -28_000, exceptionRaised: true, reasonCode: 'wrong_change', toleranceKnown: false,
    }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ recorded: true, varianceMinor: -28_000, exceptionRaised: true, flags: ['cashier_unknown', 'default_tolerance'], investigation: { opened: true, assignedTo: 'u-manager' } });
    const list = ((await overShort(h, A)).body as OverShort).overShort;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ shiftId: 'sh-2', relayed: true, laneId: 'lane-1', varianceMinor: -28_000, flags: ['cashier_unknown', 'default_tolerance'] });
  });

  it('figures that do not follow from the relayed inputs, and a material variance with no reason, are flags — the cloud\'s own arithmetic stands on the record', async () => {
    const h = await seeded();
    // The box says variance 0 but the figures say ₹280 short with no reason: recorded on the CLOUD's arithmetic, both flags.
    const res = await relayClose(h, A, 'u-box', close({ shiftId: 'sh-3', countedMinor: 18_000, varianceMinor: 0, exceptionRaised: false }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ varianceMinor: -28_000, exceptionRaised: true, flags: ['figures_inconsistent', 'material_variance_without_reason'] });
    expect(((await overShort(h, A)).body as OverShort).overShort[0]).toMatchObject({ shiftId: 'sh-3', varianceMinor: -28_000 });
  });

  it('refuses a body that is not a relayed close (400) and a caller without the sync permission (403)', async () => {
    const h = await seeded();
    const bad = await relayClose(h, A, 'u-box', close({ countedMinor: 'a lot' }));
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { code: string } }).error.code).toBe('not_readable_as_a_synced_shift_close');
    expect((await relayClose(h, A, 'u-visitor', close())).status).toBe(403);
    expect((await relayClose(h, A, 'u-meena', close())).status).toBe(202); // a cashier's own grant holds the sync permission (the box IS a cashier identity)
  });
});

describe('the till\'s cash reaches the cloud through the REAL edge, and is not re-sent on restart (§31 · hard rule #6)', () => {
  // The box and head office share the pack signing key, as a real store and its head office do — so the box's seal on who
  // it verified checks out at head office (ADR-0023).
  const KEY = TEST_PACK_KEY;
  let h: ApiHarness;
  let dir: string;
  let online = true;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = await seeded();
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      // The till's own loopback calls go to the real socket; only the cloud is answered by the harness.
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'],
        path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''),
        idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-till-cash-cloud-'));
    // The pack names Meena with till authority and her till PIN is issued on this box (ADR-0020).
    await prepareTillBox({
      dir, key: KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }],
      pack: {
        policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
        lossPreventionRules: [],
      },
    });
  });
  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
    EDGE_PACK_FILE: join(dir, 'store-pack.json'),
    CLOUD_API_URL: 'https://cloud.example.test',
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
  });

  it('with the cable out, the float, the sale, the pickup and the close are on the box only; when the line returns they reach the cloud once', async () => {
    online = false;
    const edge = (await startEdge(env(), () => {}))!;
    const port = edge.lane!.port;
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: port, durable: laneDurable(port), cashMovement: laneCashMovement(port), shiftClose: laneShiftClose(port), tillCash: laneTillCash(port) });
    await holdSignedInAt(port, 'u-meena');
    till.signIn('u-meena');
    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT, movementId: 'cm-edge-float' })).toMatchObject({ committed: true });
    till.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 48_000, qty: 1 });
    await till.tenderCash('S-edge-1', await till.nextReceipt(), '2026-09-30T10:00:00.000Z');
    expect(await till.till.moveCash({ kind: 'pickup', amountMinor: 200_000, at: '2026-09-30T12:00:00.000Z', movementId: 'cm-edge-pick' })).toMatchObject({ committed: true });
    // Expected 2,000 + 480 − 2,000 = ₹480.
    expect(await till.till.close({ shiftId: 'sh-edge-1', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 48_000 })).toMatchObject({ closed: true, varianceMinor: 0 });
    expect(edge.tillCashAgent?.health().unsentCount).toBe(3);
    expect((await tillCash(h, A)).body as Cash).toMatchObject({ custodian: null, balanceMinor: 0 }); // nothing at the cloud yet

    online = true;
    const pass = await edge.syncOnce!();
    expect(pass.dead).toBe(0);
    expect(edge.tillCashAgent?.health().unsentCount).toBe(0);
    // The float and the pickup are on the till's chain at head office; the close is on the shifts register, clean.
    expect((await tillCash(h, A)).body as Cash).toMatchObject({ custodian: 'u-meena', balanceMinor: 0, flagged: [] });
    const closed = await relayClose(h, A, 'u-box', close({ shiftId: 'sh-edge-1' }), 'k-probe');
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ alreadyClosed: true, varianceMinor: 0, exceptionRaised: false });
    await edge.stop();
  }, 30_000);

  it('does not re-send any of it on the next start — the till-cash cursor remembers', async () => {
    const said: string[] = [];
    const edge = (await startEdge(env(), (l) => said.push(l)))!;
    expect(edge.tillCashAgent?.health().unsentCount).toBe(0);
    expect(said.join('\n')).not.toContain('till cash record(s) from before are still to send');
    await edge.stop();
    // Still exactly one float and one pickup on the chain.
    expect((await tillCash(h, A)).body as Cash).toMatchObject({ custodian: 'u-meena', balanceMinor: 0 });
  });

  it('PF-08: the day cannot close while a till shift of that day is still open — the box reads its own cash log', async () => {
    online = true;
    const edge = (await startEdge(env(), () => {}))!;
    const port = edge.lane!.port;
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: port, durable: laneDurable(port), cashMovement: laneCashMovement(port), shiftClose: laneShiftClose(port), tillCash: laneTillCash(port) });
    await holdSignedInAt(port, 'u-meena');
    till.signIn('u-meena');
    // A new float on lane-1 — the drawer is open again and nobody has counted it.
    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-10-01T09:00:00.000Z', movementId: 'cm-pf08-float' })).toMatchObject({ committed: true });
    expect((await edge.syncOnce!()).dead).toBe(0);

    const refused = await edge.closeDay({ dayCloseId: 'dc-pf08', closedBy: 'u-mgr' });
    expect(refused.closed).toBe(false);
    expect((refused as { reason: string }).reason).toMatch(/1 till shift\(s\) still open — till lane-1 \(held by u-meena/);

    // The cashier counts and closes the drawer; with nothing unsent, the day closes.
    expect(await till.till.close({ shiftId: 'sh-pf08', closedAt: '2026-10-01T20:00:00.000Z', countedMinor: 200_000 })).toMatchObject({ closed: true, varianceMinor: 0 });
    expect((await edge.syncOnce!()).dead).toBe(0);
    expect(await edge.closeDay({ dayCloseId: 'dc-pf08', closedBy: 'u-mgr' })).toMatchObject({ closed: true, locked: true });
    await edge.stop();
  }, 30_000);
});
