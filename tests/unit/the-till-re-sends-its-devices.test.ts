import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDeviceHeartbeat, DEVICE_HEARTBEAT_INTERVAL_MS } from '../../apps/pos/src/device-heartbeat';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CommitOutcome } from '../../edge/store-edge/src/durability';

/**
 * **D04-FR-05 · M35-FR-03 · P-08 · P-01 · hard rule #1 — a signed-in till keeps re-sending its last known device states,
 * so a healthy, quiet till never reads "unknown" at head office; it never sends during a sale's write.**
 *
 * Fake timers drive the real heartbeat (`apps/pos/src/device-heartbeat.ts`) and the real till shell (`bootPos`), whose
 * only network call here is the `/lane/peripherals` post (captured). Proves: the 5-minute cadence (well inside the
 * 15-minute stale threshold); an immediate send on a change and none for an unchanged report; nothing with nobody
 * signed in, and the cadence stops on sign-out; nothing while a sale is being written to the box — it goes once the
 * write has answered — and the sale never waits on it.
 */

const OK = [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'ok' }];
const PAPER_OUT = [{ kind: 'scanner', state: 'ok' }, { kind: 'printer', state: 'failed', detail: 'paper out' }];

describe('the device heartbeat (pure)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = (over: { signedIn?: () => boolean; committing?: () => boolean; send?: (d: unknown) => Promise<unknown> } = {}) => {
    const sent: unknown[] = [];
    const hb = createDeviceHeartbeat({
      send: over.send ?? (async (d) => { sent.push(d); }),
      signedIn: over.signedIn ?? (() => true),
      committing: over.committing ?? (() => false),
    });
    return { hb, sent };
  };

  it('the cadence is 5 minutes — a third of the 15-minute stale threshold', () => {
    expect(DEVICE_HEARTBEAT_INTERVAL_MS).toBe(300_000);
    expect(DEVICE_HEARTBEAT_INTERVAL_MS * 3).toBeLessThanOrEqual(15 * 60_000);
  });

  it('re-sends the last known states every 5 minutes while signed in; a change goes at once; an unchanged report does not', async () => {
    const { hb, sent } = make();
    hb.remember(OK);
    hb.start();
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([OK]);
    await vi.advanceTimersByTimeAsync(40 * 60_000 - DEVICE_HEARTBEAT_INTERVAL_MS);
    expect(sent).toHaveLength(8); // 40 minutes = 8 re-sends; never a gap of 15 minutes
    // The printer runs out of paper: sent at once, not at the next tick.
    hb.update(PAPER_OUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(9);
    expect(sent[8]).toEqual(PAPER_OUT);
    // The adapter says the same again: no extra send; the cadence carries the new state.
    hb.update(PAPER_OUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS);
    expect(sent).toHaveLength(10);
    expect(sent[9]).toEqual(PAPER_OUT);
  });

  it('stops on sign-out: nothing is sent while nobody is signed in — not on the cadence, not on a change', async () => {
    let signedIn = true;
    const { hb, sent } = make({ signedIn: () => signedIn });
    hb.remember(OK);
    hb.start();
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS);
    expect(sent).toHaveLength(1);
    hb.stop();
    signedIn = false;
    expect(hb.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    hb.update(PAPER_OUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0); // no timer left behind
    // The next sign-in starts again, with the last known states.
    signedIn = true;
    hb.start();
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS);
    expect(sent).toEqual([OK, PAPER_OUT]);
    // Even with the timer running, a tick finds nobody signed in (signed out by another path): nothing goes.
    signedIn = false;
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS);
    expect(sent).toHaveLength(2);
  });

  it('nothing goes while a sale is being written; it goes once the write has answered', async () => {
    let committing = false;
    const { hb, sent } = make({ committing: () => committing });
    hb.remember(OK);
    hb.start();
    committing = true;
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS);
    hb.update(PAPER_OUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(0);
    committing = false;
    hb.commitEnded();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([PAPER_OUT]);
  });

  it('a box that cannot be reached never throws to the till, and one send at a time — a slow box never piles them up', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const { hb } = make({ send: () => { calls += 1; return calls === 1 ? new Promise<void>((r) => { release = r; }) : Promise.reject(new Error('ECONNREFUSED')); } });
    hb.remember(OK);
    hb.start();
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS * 3); // the first send hangs: the next two ticks wait
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS);
    expect(calls).toBe(2);
    await expect(hb.tick()).resolves.toBe(true); // a refused send still resolves
  });
});

describe('DEV-1 (round 16): an adapter time is a liveness signal only when the adapter offers a clock', () => {
  const send = (sent: (string | null)[]) => async (_d: unknown, at?: string) => { sent.push(at ?? null); };
  const base = { signedIn: () => true, committing: () => false, every: () => () => {}, soon: () => {} };
  it('a time given only WITH A CHANGE goes with that change, never with a later re-send (the verifier\'s zz-v16-hb probe)', async () => {
    const sent: (string | null)[] = [];
    const hb = createDeviceHeartbeat({ ...base, send: send(sent) });
    hb.start();
    hb.update([{ kind: 'printer', state: 'ok' }], '2026-10-07T08:00:00.000Z');
    await hb.tick(); await hb.tick(); await hb.tick();
    expect(sent).toEqual(['2026-10-07T08:00:00.000Z', null, null]);
    // A new change carries its own time once; an unchanged re-said state is no change and carries nothing.
    hb.update([{ kind: 'printer', state: 'failed' }], '2026-10-07T08:30:00.000Z');
    await hb.tick();
    hb.update([{ kind: 'printer', state: 'failed' }], '2026-10-07T08:31:00.000Z');
    await hb.tick();
    expect(sent.slice(3)).toEqual(['2026-10-07T08:30:00.000Z', null]);
    expect(hb.lastObservedAt()).toBe('2026-10-07T08:31:00.000Z'); // evidence of the last answer, not liveness
  });
  it('an adapter that offers its own clock has it carried on EVERY send (so a hung one reads stale); one that throws says nothing', async () => {
    const sent: (string | null)[] = [];
    let clock: () => unknown = () => '2026-10-07T08:00:00.000Z';
    const hb = createDeviceHeartbeat({ ...base, send: send(sent), adapterObservedAt: () => clock() });
    hb.start();
    hb.update([{ kind: 'printer', state: 'ok' }], '2026-10-07T07:59:00.000Z');
    await hb.tick(); await hb.tick();
    clock = () => { throw new Error('adapter gone'); };
    await hb.tick();
    expect(sent).toEqual(['2026-10-07T08:00:00.000Z', '2026-10-07T08:00:00.000Z', null]);
  });
  it('the till shell offers liveness only while the adapter gave it a clock (offersLiveness)', async () => {
    const sent: (string | null)[] = [];
    let offered = false;
    const hb = createDeviceHeartbeat({ ...base, send: send(sent), adapterObservedAt: () => '2026-10-07T09:00:00.000Z', offersLiveness: () => offered });
    hb.start();
    hb.update([{ kind: 'printer', state: 'ok' }], '2026-10-07T08:00:00.000Z');
    await hb.tick(); await hb.tick();
    offered = true;
    await hb.tick();
    expect(sent).toEqual(['2026-10-07T08:00:00.000Z', null, '2026-10-07T09:00:00.000Z']);
  });
});

describe('the till shell re-sends its devices (bootPos, the real wiring)', () => {
  const savedFetch = globalThis.fetch;
  let posts: { url: string; body: unknown }[];
  beforeEach(() => {
    vi.useFakeTimers();
    posts = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) as unknown });
      return new Response(JSON.stringify({ recorded: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => { globalThis.fetch = savedFetch; vi.useRealTimers(); });

  it('signed in: the first report is remembered and re-sent every 5 minutes; a change goes at once; sign-out stops it', async () => {
    const pos = bootPos({ laneId: 'lane-1', tradingDay: '2026-10-12', lanePort: 8090 });
    // Nobody signed in: a device change is kept, never sent.
    pos.devicesSaid(OK);
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS * 2);
    expect(posts).toHaveLength(0);
    expect(pos.deviceHeartbeat.running()).toBe(false);

    pos.signIn('u-meena');
    expect(pos.deviceHeartbeat.running()).toBe(true);
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS);
    expect(posts).toEqual([{ url: 'http://127.0.0.1:8090/lane/peripherals', body: { devices: OK } }]);
    pos.devicesSaid(PAPER_OUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.map((p) => p.body)).toEqual([{ devices: OK }, { devices: PAPER_OUT }]);
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS * 2);
    expect(posts).toHaveLength(4);

    pos.signOut();
    expect(pos.deviceHeartbeat.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    pos.devicesSaid(OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(4);
  });

  it('the explicit report at sign-in is remembered, so the cadence carries it on', async () => {
    const pos = bootPos({ laneId: 'lane-1', tradingDay: '2026-10-12', lanePort: 8090 });
    pos.signIn('u-meena');
    expect(await pos.reportDevices(PAPER_OUT)).toEqual({ recorded: true });
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS);
    expect(posts.map((p) => p.body)).toEqual([{ devices: PAPER_OUT }, { devices: PAPER_OUT }]);
  });

  it('never during a sale\'s write: a tick that falls while the box is writing the sale waits; the sale never waits on it', async () => {
    let answer: (o: CommitOutcome) => void = () => {};
    const durable = vi.fn(() => new Promise<CommitOutcome>((r) => { answer = r; }));
    const pos = bootPos({ laneId: 'lane-1', tradingDay: '2026-10-12', lanePort: 8090, durable });
    pos.signIn('u-meena');
    pos.devicesSaid(OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1); // the first report

    pos.scan({ productId: 'P1', description: 'Rice 1kg', unitPriceMinor: 10_000, qty: 1 });
    const paying = pos.tenderCash('S-1', 'R-1', '2026-10-12T05:00:00.000Z');
    await vi.advanceTimersByTimeAsync(0);
    expect(durable).toHaveBeenCalledTimes(1); // the sale is being written to the box
    // Five minutes pass while the write is open (a slow disk): the re-send does NOT go; a device change does not either.
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS);
    pos.devicesSaid(PAPER_OUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);
    // The box answers: the sale completes first, then the owed report goes, off the sale's path.
    answer({ committed: true, durable: true, detail: 'test', laneMessage: 'Sale complete.' });
    await expect(paying).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.map((p) => p.body)).toEqual([{ devices: OK }, { devices: PAPER_OUT }]);
  });

  it('a box that cannot be reached never troubles the till: the re-send fails quietly and the next one tries again', async () => {
    globalThis.fetch = (async () => { posts.push({ url: 'x', body: null }); throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch;
    const pos = bootPos({ laneId: 'lane-1', tradingDay: '2026-10-12', lanePort: 8090 });
    pos.signIn('u-meena');
    pos.devicesSaid(OK);
    await vi.advanceTimersByTimeAsync(DEVICE_HEARTBEAT_INTERVAL_MS * 2);
    expect(posts).toHaveLength(3);
  });
});
