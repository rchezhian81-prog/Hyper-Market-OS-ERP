import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos, laneDurable, laneDurableReturn, laneLookup, laneCashMovement, laneShiftClose, laneTillCash, LANE_NO_ANSWER } from '../../apps/pos/src/browser-entry';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';
import { prepareTillBox, holdSignedInAt } from '../support/till-operator';

/**
 * **D-129 · OB-911 · hard rules #2 and #10: a cash movement or a close whose answer was lost is recorded ONCE.**
 *
 * A real store computer (its lane socket, its cash log on a real disk) with the real till in front of it, and between them a
 * wire that carries the till's call to the store computer and then LOSES the answer — the store computer writes the float
 * (or the close) and the till hears nothing. The till waits its bounded time and says it does not know. Pressed again, the
 * till sends the SAME movement id (the SAME shift id): the store computer answers "already recorded", its cash log holds one
 * movement, and the drawer's expected cash counts it once — a blind count of exactly the float balances to the paisa.
 */

const KEY = ['d129', 'cash', 'answer', 'lost', 'signing', 'key'].join('-').padEnd(48, '0');
const PACK = ({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
});
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const startBox = async (): Promise<EdgeProcess> => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-d129-'));
  dirs.push(dir);
  const tillReady = await prepareTillBox({ dir, key: KEY, pack: PACK, laneId: 'lane-1', people: [{ userId: 'u-meena', displayName: 'Meena' }] });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', ...tillReady,
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};

/**
 * The wire between the till and its store computer. Every call is carried to the store computer in full; the answer to the
 * next `lose[path]` calls on a path is LOST (the store computer has done the work; the till never hears); on the next
 * `cut[path]` calls the line is CUT right after the store computer answered (the till's call fails as if it never connected).
 */
const lossyWire = async (boxPort: number): Promise<{ port: number; lose: Record<string, number>; cut: Record<string, number>; carried: string[] }> => {
  const lose: Record<string, number> = {};
  const cut: Record<string, number> = {};
  const carried: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';
      carried.push(`${req.method} ${path}`);
      const out = request({ host: '127.0.0.1', port: boxPort, method: req.method, path, headers: req.headers }, (answer) => {
        const back: Buffer[] = [];
        answer.on('data', (c: Buffer) => back.push(c));
        answer.on('end', () => {
          if ((lose[path] ?? 0) > 0) { lose[path] = lose[path]! - 1; return; } // the store computer answered; the wire lost it
          if ((cut[path] ?? 0) > 0) { cut[path] = cut[path]! - 1; req.socket.destroy(); return; } // …or the line was cut
          res.writeHead(answer.statusCode ?? 500, answer.headers);
          res.end(Buffer.concat(back));
        });
      });
      out.end(Buffer.concat(chunks));
    });
  });
  stops.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, lose, cut, carried };
};

const tillThrough = async (edge: EdgeProcess, wirePort: number) => {
  const view = bootPos({
    laneId: 'lane-1', taxPercent: 0, lanePort: wirePort, durable: laneDurable(edge.lane!.port), durableReturn: laneDurableReturn(edge.lane!.port), laneLookup: laneLookup(edge.lane!.port),
    cashMovement: laneCashMovement(wirePort, { waitMs: 400 }), shiftClose: laneShiftClose(wirePort, { waitMs: 400 }), tillCash: laneTillCash(wirePort, { waitMs: 400 }),
  });
  await holdSignedInAt(edge.lane!.port, 'u-meena');
  view.signIn('u-meena');
  return view;
};
const cashLog = async (edge: EdgeProcess) => (await readLog(edge.tillCashLog.path)).flatMap((r) => (r.ok ? [readTillCashRecord(JSON.parse(r.record))!] : []));

describe('a cash movement or close whose answer was lost is recorded once when pressed again (D-129 · OB-911)', () => {
  it('float, cash loan, pickup and safe drop: answer lost → "not known"; pressed again under the SAME id → "already recorded"; ONE movement each; the blind count balances on them once', async () => {
    const edge = await startBox();
    const wire = await lossyWire(edge.lane!.port);
    const till = await tillThrough(edge, wire.port);
    const moves = [
      { kind: 'float_issue' as const, amountMinor: 200_000, at: '2026-11-22T03:30:00.000Z', movementId: 'cm-float_issue-a' },
      { kind: 'loan' as const, amountMinor: 50_000, at: '2026-11-22T05:00:00.000Z', movementId: 'cm-loan-b' },
      { kind: 'pickup' as const, amountMinor: 30_000, at: '2026-11-22T08:00:00.000Z', movementId: 'cm-pickup-c' },
      { kind: 'safe_drop' as const, amountMinor: 20_000, at: '2026-11-22T10:00:00.000Z', movementId: 'cm-safe_drop-d' },
    ];
    for (const move of moves) {
      wire.lose['/lane/cash-movements'] = 1;
      const first = await till.till.moveCash(move);
      expect(first).toMatchObject({ committed: false, refusedBecause: LANE_NO_ANSWER });
      expect((first as { laneMessage: string }).laneMessage).toContain('does not know if this cash was recorded');
      // The store computer DID record it — that is why the till must not say "NOT recorded".
      expect((await cashLog(edge)).filter((r) => r.kind === 'movement' && r.movementId === move.movementId)).toHaveLength(1);
      const again = await till.till.moveCash(move);
      expect(again).toMatchObject({ committed: true, alreadyRecorded: true, movementId: move.movementId });
    }
    const log = await cashLog(edge);
    expect(log.map((r) => (r.kind === 'movement' ? r.movementId : r.kind))).toEqual(moves.map((m) => m.movementId));
    // 2,000 + 500 − 300 − 200 = ₹2,000 in the drawer (no sales): a blind count of ₹2,000 balances — each counted once.
    const close = await till.till.close({ shiftId: 'sh-d129', closedAt: '2026-11-22T15:30:00.000Z', countedMinor: 200_000 });
    expect(close).toMatchObject({ closed: true, varianceMinor: 0, drawer: { floatMinor: 200_000, loansMinor: 50_000, pickupsMinor: 30_000, safeDropsMinor: 20_000 } });
    expect((await cashLog(edge)).at(-1)).toMatchObject({ kind: 'close', openingFloatMinor: 250_000, pickupsMinor: 50_000, expectedMinor: 200_000, varianceMinor: 0 });
    expect(edge.tillCashOutbox.unsentCount()).toBe(5);
  }, 30_000);

  it('the close: answer lost → "not known", never "closed"; Close pressed again sends the SAME close → "already closed"; ONE close, the drawer counted once', async () => {
    const edge = await startBox();
    const wire = await lossyWire(edge.lane!.port);
    const till = await tillThrough(edge, wire.port);
    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-11-22T03:30:00.000Z', movementId: 'cm-f' })).toMatchObject({ committed: true });
    const close = { shiftId: 'sh-lost', closedAt: '2026-11-22T15:30:00.000Z', countedMinor: 195_000 };
    wire.lose['/lane/shift-close'] = 1;
    const first = await till.till.close(close);
    expect(first).toMatchObject({ closed: false, refusedBecause: LANE_NO_ANSWER });
    expect((first as { laneMessage: string }).laneMessage).toContain('does not know if the till was closed');
    const again = await till.till.close(close);
    expect(again).toMatchObject({ closed: true, alreadyClosed: true, shiftId: 'sh-lost', countedMinor: 195_000, varianceMinor: -5_000 });
    const closes = (await cashLog(edge)).filter((r) => r.kind === 'close');
    expect(closes).toHaveLength(1);
    // A different shift id would have met a till that is no longer open — the drawer can never be closed (counted) twice.
    expect(await till.till.close({ ...close, shiftId: 'sh-other' })).toMatchObject({ closed: false, refusedBecause: 'no_open_shift' });
    expect((await cashLog(edge)).filter((r) => r.kind === 'close')).toHaveLength(1);
  }, 30_000);

  it('D-130: the line is cut AFTER the store computer wrote the float (and on each quick re-try): the till says it does NOT KNOW — never "NOT recorded"; pressed again under the SAME id → one float', async () => {
    const edge = await startBox();
    const wire = await lossyWire(edge.lane!.port);
    const till = await tillThrough(edge, wire.port);
    const float = { kind: 'float_issue' as const, amountMinor: 200_000, at: '2026-11-22T03:30:00.000Z', movementId: 'cm-float-cut' };
    wire.cut['/lane/cash-movements'] = 4; // every quick re-try of the first press is cut too
    const first = await till.till.moveCash(float);
    expect(first).toMatchObject({ committed: false, refusedBecause: 'lane_unreachable' });
    const words = (first as { laneMessage: string }).laneMessage;
    expect(words).toContain('The till cannot reach the store computer');
    expect(words).toContain('does not know if this cash was recorded');
    expect(words).not.toContain('NOT recorded');
    expect(wire.carried.filter((c) => c === 'POST /lane/cash-movements')).toHaveLength(4); // the same id, four times
    expect((await cashLog(edge)).filter((r) => r.kind === 'movement')).toHaveLength(1); // it IS on the store computer
    expect(await till.till.moveCash(float)).toMatchObject({ committed: true, alreadyRecorded: true, movementId: 'cm-float-cut' });
    expect((await cashLog(edge)).filter((r) => r.kind === 'movement')).toHaveLength(1);

    // The close, cut the same way: not known; Close again → the SAME close, one close.
    const close = { shiftId: 'sh-cut', closedAt: '2026-11-22T15:30:00.000Z', countedMinor: 200_000 };
    wire.cut['/lane/shift-close'] = 4;
    const lost = await till.till.close(close);
    expect(lost).toMatchObject({ closed: false, refusedBecause: 'lane_unreachable' });
    expect((lost as { laneMessage: string }).laneMessage).toContain('does not know if the till was closed');
    expect(await till.till.close(close)).toMatchObject({ closed: true, alreadyClosed: true, varianceMinor: 0 });
    expect((await cashLog(edge)).filter((r) => r.kind === 'close')).toHaveLength(1);
  }, 30_000);

  it('a refusal stays a refusal: a safe drop bigger than the drawer is refused in the store computer\'s words — definitely NOT recorded', async () => {
    const edge = await startBox();
    const wire = await lossyWire(edge.lane!.port);
    const till = await tillThrough(edge, wire.port);
    await till.till.moveCash({ kind: 'float_issue', amountMinor: 100_000, at: '2026-11-22T03:30:00.000Z', movementId: 'cm-f' });
    const r = await till.till.moveCash({ kind: 'safe_drop', amountMinor: 900_000, at: '2026-11-22T05:00:00.000Z', movementId: 'cm-big' });
    expect(r).toMatchObject({ committed: false, refusedBecause: 'insufficient_till_cash' });
    expect((await cashLog(edge)).map((m) => (m.kind === 'movement' ? m.movementId : m.kind))).toEqual(['cm-f']);
  }, 30_000);
});
