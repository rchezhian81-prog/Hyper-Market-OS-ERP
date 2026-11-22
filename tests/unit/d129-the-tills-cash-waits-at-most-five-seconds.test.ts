import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { laneCashMovement, laneShiftClose, NO_ANSWER_WORDS, LANE_NO_ANSWER } from '../../apps/pos/src/browser-entry';
import { TILL_CASH_WORDS } from '../../edge/store-edge/src/till-cash';

/**
 * D-129 · OB-911 · P-08: the till's float, cash loan, pickup, safe drop and shift close asked the store computer with no
 * time limit (and up to four times). A store computer that took the call and never answered left the cashier waiting with
 * nothing on the screen. These stand up a store computer that takes the call and never answers — proved first, before the
 * fix — and hold the till to the same bounded wait as every other cashier call (OB-908), in words that never say
 * "recorded" or "NOT recorded" when the till does not know.
 */

const servers: Server[] = [];
const netServers: NetServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); });
  for (const s of netServers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** A store computer that reads the call and then says nothing (or answers `answer` after `lateMs`). */
const silentBox = async (late?: { readonly ms: number; readonly answer: unknown }): Promise<{ port: number; calls: string[] }> => {
  const calls: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    calls.push(`${req.method} ${req.url}`);
    req.resume();
    if (late !== undefined) setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(late.answer)); }, late.ms);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, calls };
};

/** A port where nothing can be reached: every caller is hung up on before a request is read. */
const deadBox = async (): Promise<{ port: number; connections: () => number }> => {
  let n = 0;
  const server = createNetServer((socket) => { n += 1; socket.destroy(); });
  netServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, connections: () => n };
};

const FLOAT = { movementId: 'cm-float-1', movementKind: 'float_issue' as const, amountMinor: 200_000, at: '2026-11-22T03:30:00.000Z', custodianId: 'u-meena', performedBy: 'u-meena' };
const CLOSE = { shiftId: 'sh-1', closedAt: '2026-11-22T15:30:00.000Z', cashierId: 'u-meena', countedMinor: 200_000 };

describe('the till\'s cash calls wait a bounded time for the store computer (D-129 · OB-911)', () => {
  for (const kind of ['float_issue', 'loan', 'pickup', 'safe_drop'] as const) {
    it(`a ${kind} the store computer never answers: the till says it does NOT KNOW within the wait — asked once, never "recorded" or "NOT recorded"`, async () => {
      const box = await silentBox();
      const started = Date.now();
      const r = await laneCashMovement(box.port, { waitMs: 300 })({ ...FLOAT, movementId: `cm-${kind}`, movementKind: kind });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(r).toMatchObject({ committed: false, refusedBecause: LANE_NO_ANSWER });
      const said = (r as { laneMessage: string }).laneMessage;
      expect(said).toBe(NO_ANSWER_WORDS.cash.en);
      expect(said).toContain('does not know if this cash was recorded');
      expect(said).toContain('Do not move the cash again');
      expect(said).not.toMatch(/NOT recorded|^Recorded/);
      expect((r as { laneMessageTa?: string }).laneMessageTa).toBe(NO_ANSWER_WORDS.cash.ta);
      // A call that ran out of wait is not asked again behind the cashier's back — one wait, then the words (OB-909).
      expect(box.calls).toEqual(['POST /lane/cash-movements']);
    }, 8_000);
  }

  it('a close the store computer never answers: the till does not know if the till was closed — never "closed", asked once', async () => {
    const box = await silentBox();
    const started = Date.now();
    const r = await laneShiftClose(box.port, { waitMs: 300 })(CLOSE);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r).toMatchObject({ closed: false, refusedBecause: LANE_NO_ANSWER });
    const said = (r as { laneMessage: string }).laneMessage;
    expect(said).toBe(NO_ANSWER_WORDS.close.en);
    expect(said).toContain('does not know if the till was closed');
    expect(said).toContain('Do not count the drawer again');
    expect((r as { laneMessageTa?: string }).laneMessageTa).toBe(NO_ANSWER_WORDS.close.ta);
    expect(box.calls).toEqual(['POST /lane/shift-close']);
  }, 8_000);

  it('the shop\'s default wait is five seconds — a store computer that answers in under it is waited for, and its answer is the answer', async () => {
    const recorded = { committed: true, movementId: 'cm-float-1', kind: 'float_issue', custodian: 'u-meena', tradingDay: '2026-11-22', laneMessage: 'Recorded on the store computer.' };
    const box = await silentBox({ ms: 400, answer: recorded });
    expect(await laneCashMovement(box.port)(FLOAT)).toEqual(recorded);
    const closed = { closed: true, shiftId: 'sh-1', tradingDay: '2026-11-22', countedMinor: 200_000, varianceMinor: 0, exceptionRaised: false, reasonCode: null, laneMessage: 'Closed.' };
    const box2 = await silentBox({ ms: 400, answer: closed });
    expect(await laneShiftClose(box2.port)(CLOSE)).toEqual(closed);
  }, 8_000);

  it('a call that cannot be completed (cannot reach, or the line cut): asked a few times quickly under the same id, then NOT KNOWN — never "NOT recorded" (D-130)', async () => {
    const box = await deadBox();
    const started = Date.now();
    const r = await laneCashMovement(box.port, { waitMs: 300 })(FLOAT);
    expect(r).toMatchObject({ committed: false, refusedBecause: 'lane_unreachable', laneMessage: NO_ANSWER_WORDS.cashUnreachable.en, laneMessageTa: NO_ANSWER_WORDS.cashUnreachable.ta });
    expect(NO_ANSWER_WORDS.cashUnreachable.en).toBe(TILL_CASH_WORDS.lane_unreachable);
    expect(TILL_CASH_WORDS.lane_unreachable).toContain('The till cannot reach the store computer');
    expect(TILL_CASH_WORDS.lane_unreachable).toContain('does not know if this cash was recorded');
    expect(TILL_CASH_WORDS.lane_unreachable).not.toContain('NOT recorded');
    expect(box.connections()).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(3_000);
    const close = await laneShiftClose(box.port, { waitMs: 300 })(CLOSE);
    expect(close).toMatchObject({ closed: false, refusedBecause: 'lane_unreachable', laneMessage: NO_ANSWER_WORDS.closeUnreachable.en });
    expect(NO_ANSWER_WORDS.closeUnreachable.en).toContain('does not know if the till was closed');
  }, 8_000);

  it('"NOT recorded" is never said by the till itself: every till-side sentence for a call without an answer says "does not know"', () => {
    expect(TILL_CASH_WORDS.lane_no_answer).toBe(NO_ANSWER_WORDS.cash.en);
    for (const w of [NO_ANSWER_WORDS.cash, NO_ANSWER_WORDS.cashUnreachable, NO_ANSWER_WORDS.close, NO_ANSWER_WORDS.closeUnreachable]) {
      expect(w.en).toContain('does not know');
      expect(w.en).not.toMatch(/NOT recorded|Till closed/);
      expect(w.ta).toContain('தெரியவில்லை');
    }
  });
});
