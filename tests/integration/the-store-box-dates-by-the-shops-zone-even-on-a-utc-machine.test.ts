// The machine's zone is UTC for this whole file — what a container on node:22-alpine keeps, and what CI keeps. Set before
// any date is read, so the box's own process (started in this test) runs exactly as on a UTC container.
process.env['TZ'] = 'UTC';

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';
import type { PaymentProviderPort } from '../../edge/store-edge/src/payment-attempts';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { machineTimeZone } from '../../packages/calendar/src/index';
import { prepareTillBox, signInTill, pinOf } from '../support/till-operator';
import { TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { ownerApprovedSetting } from '../support/owner-approved-setting';

/**
 * **Re-audit lane 1 R1a (M01-FR-02 · P-01 · P-08): the store computer dates by the SHOP's time zone, carried in its signed
 * store pack — even on a machine that keeps UTC.**
 *
 * Before: the box called `wallClockIn(x)` with no zone, so it read the machine's — UTC in its container. At 00:40 IST on
 * 26 Oct (19:10 UTC on the 25th) it believed it was still the 25th: the day close closed the 24th, and a shift, a cash
 * movement and a card payment with no answer were dated the 25th, while the till's receipt said the 26th.
 * Now: the pack carries `policies.timeZone` (head office's `locale.time_zone`), and every date on the box is read in it.
 * A machine whose zone is not the shop's is said on the manager's screen and in the box's log; the dates are right anyway.
 */

const AT_0040_IST_26_OCT = new Date('2026-10-25T19:10:00.000Z');
const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }];
const policies = (timeZone?: string) => ({
  storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000,
  handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1', ...(timeZone === undefined ? {} : { timeZone }),
});
const provider: PaymentProviderPort = { lookup: async () => ({ authorisations: [], statementComplete: false }) };

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function boxWith(timeZone: string | undefined): Promise<{ dir: string; start: () => Promise<EdgeProcess>; said: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-shop-zone-'));
  dirs.push(dir);
  const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: PEOPLE, pack: { policies: policies(timeZone), lossPreventionRules: [], managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 } } });
  const said: string[] = [];
  const start = async (): Promise<EdgeProcess> => {
    // No cloud: the box trades and closes on its own (P-01).
    const edge = (await startEdge({ EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', ...ready }, (m) => { said.push(m); }, { paymentProvider: provider }))!;
    stops.push(() => edge.stop());
    return edge;
  };
  return { dir, start, said };
}

interface Dated { closeDay: string; shiftClose: string; float: string; noAnswer: string }

/** At 00:40 IST on 26 Oct: close the day, then a float, a shift close and a card payment with no answer. Then a cold restart. */
async function tradeAtTwentyToOne(timeZone: string | undefined): Promise<{ dated: Dated; edge: EdgeProcess; said: string[] }> {
  const box = await boxWith(timeZone);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(AT_0040_IST_26_OCT);
  let edge = await box.start();
  const now = new Date().toISOString();

  // The day close first, while nothing is queued (a day never locks with anything unsent).
  const closed = await edge.closeDay({ dayCloseId: `dc-${randomUUID()}`, closedBy: 'u-mgr', closerPin: pinOf('u-mgr') });
  expect(closed.closed, JSON.stringify(closed)).toBe(true);

  // A shift: the float, then the blind count.
  const float = await edge.recordCashMovement({ movementId: 'cm-float', movementKind: 'float_issue', amountMinor: 100_000, at: now, custodianId: 'u-lanecash', performedBy: 'u-mgr' });
  expect(float.committed, JSON.stringify(float)).toBe(true);
  const shift = await edge.closeShift({ shiftId: 'sh-1', closedAt: now, cashierId: 'u-lanecash', countedMinor: 100_000 });
  expect(shift.closed, JSON.stringify(shift)).toBe(true);

  // A card payment the machine never answered — the box relays it as a dated no-answer.
  const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
  await signInTill(till, 'u-lanecash');
  till.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
  const card = await till.startCardPayment('card');
  expect(await till.answerCardPayment(card.attemptId!, 'no_answer')).toMatchObject({ ok: true, state: 'no_answer' });

  // A cold restart: what the box wrote is read back from its disk.
  await edge.stop();
  stops.splice(0);
  edge = await box.start();
  const cash = (await readLog(edge.tillCashLog.path)).flatMap((r) => (r.ok ? [readTillCashRecord(JSON.parse(r.record))!] : []));
  const dayLog = (await readLog(join(box.dir, 'day-close.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
  const close = dayLog.find((r) => typeof r['closedBy'] === 'string')!;
  const noAnswer = dayLog.find((r) => r['noAnswerAttemptId'] === card.attemptId)!;
  return {
    edge, said: box.said,
    dated: {
      closeDay: String(close['tradingDay']),
      float: String(cash.find((r) => r.kind === 'movement')!.tradingDay),
      shiftClose: String(cash.find((r) => r.kind === 'close')!.tradingDay),
      noAnswer: String(noAnswer['tradingDay']),
    },
  };
}

describe('the store box dates by the shop zone on a UTC machine (R1a)', () => {
  it('this machine really is on UTC for the test', () => {
    expect(machineTimeZone()).toBe('UTC');
    expect(AT_0040_IST_26_OCT.toISOString().slice(0, 10)).toBe('2026-10-25');
  });

  it('at 00:40 IST the day close closes the 25th and the shift, the float and the no-answer payment are the 26th — and the box says its zone is not the shop\'s', async () => {
    const { dated, edge, said } = await tradeAtTwentyToOne('Asia/Kolkata');
    expect(dated).toEqual({ closeDay: '2026-10-25', float: '2026-10-26', shiftClose: '2026-10-26', noAnswer: '2026-10-26' });
    expect(edge.zoneCheck()).toMatchObject({ verdict: 'differs', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'store_pack', machineTimeZone: 'UTC', needsAttention: true });
    expect(edge.zoneCheck().staffMessage).toContain('UTC');
    expect(edge.zoneCheck().staffMessageTa).toMatch(/[஀-௿]/);
    expect(said.some((m) => m.startsWith('TIME ZONE:') && m.includes('Asia/Kolkata'))).toBe(true);
  }, 60_000);

  it('follows the zone the pack names, not a fixed India time: a Dubai shop at the same instant is still on the 25th', async () => {
    const { dated } = await tradeAtTwentyToOne('Asia/Dubai');
    expect(dated).toEqual({ closeDay: '2026-10-24', float: '2026-10-25', shiftClose: '2026-10-25', noAnswer: '2026-10-25' });
  }, 60_000);

  it('a pack that names no zone dates by the shop default (Asia/Kolkata), never the machine, and says where the zone came from', async () => {
    const { dated, edge } = await tradeAtTwentyToOne(undefined);
    expect(dated).toEqual({ closeDay: '2026-10-25', float: '2026-10-26', shiftClose: '2026-10-26', noAnswer: '2026-10-26' });
    expect(edge.zoneCheck()).toMatchObject({ verdict: 'differs', shopTimeZone: 'Asia/Kolkata', shopTimeZoneFrom: 'shop_default' });
  }, 60_000);
});

describe.each(r3OpsBackings())('head office carries the shop zone in the signed store pack — on $name (R1a)', ({ harness }) => {
  it('the pack names the tenant\'s locale.time_zone (the default, then the one the owner set)', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    const { req, ok } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'Synthetic Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(req('POST', '/v1/stores/S1/settings', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, warehouseId: null, privacySlaDays: 15 }), 'settings');
    const pack = async () => (await ok(h.request({ method: 'GET', path: '/v1/store-packs/S1', userId: 'u-box', tenantId: T, branchId: 'S1' }), 'pack')).body as { sections: { policies: { timeZone?: string } } };
    expect((await pack()).sections.policies.timeZone).toBe('Asia/Kolkata');
    expect((await ownerApprovedSetting(h, T, 'locale.time_zone', { value: 'Asia/Dubai' })).status).toBe(200);
    expect((await pack()).sections.policies.timeZone).toBe('Asia/Dubai');
    // Someone with no role in the shop reads no pack.
    expect((await h.request({ method: 'GET', path: '/v1/store-packs/S1', userId: 'u-nobody', tenantId: T, branchId: 'S1' })).status).toBe(403);
  });
});
