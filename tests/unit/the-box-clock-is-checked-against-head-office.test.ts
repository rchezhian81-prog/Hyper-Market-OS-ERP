import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClockGuard, clockObservingFetch, readClockThresholds, verdictFor, OB327_WARN_SECONDS, OB327_FLAG_SECONDS } from '../../edge/store-edge/src/clock-guard';

// §31.1 · OB-327 (owner, in writing, 23 Oct 2026): the store computer measures its clock against head office's on every
// answer; at 2 minutes' difference the screens WARN; at 5 minutes bills still commit (hard rule #1) but are FLAGGED for
// checking; both numbers are changeable in the store computer's settings. The verdict log survives a cold restart.

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const T0 = Date.parse('2026-10-23T09:00:00.000Z');
const header = (ms: number): string => new Date(ms).toUTCString();

describe('the owner\'s clock numbers (OB-327)', () => {
  it('are 2 and 5 minutes unless the store computer\'s settings say otherwise; unreadable or inverted settings fall back to the owner\'s, said', () => {
    expect([OB327_WARN_SECONDS, OB327_FLAG_SECONDS]).toEqual([120, 300]);
    expect(readClockThresholds(undefined, undefined)).toEqual({ thresholds: { warnSeconds: 120, flagSeconds: 300, by: 'owner_decision_ob327' } });
    expect(readClockThresholds('60', '180')).toEqual({ thresholds: { warnSeconds: 60, flagSeconds: 180, by: 'store_computer_setting' } });
    expect(readClockThresholds('ten', undefined).problem).toContain('OB-327');
    expect(readClockThresholds('400', '300')).toMatchObject({ thresholds: { warnSeconds: 120, flagSeconds: 300 }, problem: expect.stringContaining('cannot be sooner') });
    const t = readClockThresholds(undefined, undefined).thresholds;
    expect([verdictFor(119, t), verdictFor(-120, t), verdictFor(299, t), verdictFor(-300, t), verdictFor(3_600, t)]).toEqual(['in_step', 'warning', 'warning', 'flag_bills', 'flag_bills']);
  });
});

describe('the clock guard', () => {
  it('says "not checked" before head office has answered, then the difference in words with its uncertainty, ahead or behind', async () => {
    const g = await ClockGuard.open(readClockThresholds(undefined, undefined).thresholds);
    expect(g.check()).toMatchObject({ verdict: 'not_checked', offsetSeconds: null, needsAttention: false });
    // Head office is 30 s ahead; the reply took 200 ms.
    g.observe(header(T0 + 30_000), T0, T0 + 200);
    expect(g.check()).toMatchObject({ verdict: 'in_step', offsetSeconds: 30, uncertaintySeconds: 1, needsAttention: false });
    expect(g.check().staffMessage).toContain('BEHIND head office');
    // A reply with no Date header, or an unreadable one, teaches nothing.
    g.observe(null, T0, T0 + 10); g.observe('not a date', T0, T0 + 10);
    expect(g.check().offsetSeconds).toBe(30);
    // The box runs 3 minutes fast: a warning, in English and Tamil.
    g.observe(header(T0 - 180_000), T0, T0 + 100);
    expect(g.check()).toMatchObject({ verdict: 'warning', offsetSeconds: -180, needsAttention: true });
    expect(g.check().staffMessage).toContain('AHEAD of head office');
    expect(g.check().staffMessageTa).toContain('எச்சரிக்கை');
    g.observe(header(T0 + 360_000), T0, T0 + 100);
    expect(g.check()).toMatchObject({ verdict: 'flag_bills' });
    expect(g.check().staffMessage).toContain('Bills still go through');
  });

  it('flags the bills taken while the clock was 5+ minutes out — and still does after a cold restart, from its own log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-clock-')); dirs.push(dir);
    const t = readClockThresholds(undefined, undefined).thresholds;
    const g = await ClockGuard.open(t, dir);
    g.observe(header(T0), T0, T0 + 50);                               // 09:00 in step
    g.observe(header(T0 + 600_000 + 400_000), T0 + 600_000, T0 + 600_050); // 09:10 the box is 6m40s slow
    g.observe(header(T0 + 1_200_000), T0 + 1_200_000, T0 + 1_200_050);     // 09:20 corrected
    g.observe(header(T0 + 1_260_000), T0 + 1_260_000, T0 + 1_260_050);     // same verdict: nothing new written
    await g.settled();
    const lines = (await readFile(join(dir, 'clock-checks.log'), 'utf8')).trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { verdict: string }).verdict)).toEqual(['in_step', 'flag_bills', 'in_step']);
    const sales = [
      { id: 's-a', number: 'B1', laneId: 'L1', committedAt: new Date(T0 + 300_000).toISOString() },
      { id: 's-b', number: 'B2', laneId: 'L1', committedAt: new Date(T0 + 900_000).toISOString() },
      { id: 's-c', committedAt: new Date(T0 + 1_500_000).toISOString() },
      { id: 's-d' },
    ];
    expect(g.flaggedBills(sales)).toEqual([{ saleId: 's-b', number: 'B2', laneId: 'L1', committedAt: new Date(T0 + 900_000).toISOString(), offsetSeconds: 400 }]);
    const again = await ClockGuard.open(t, dir);
    expect(again.flaggedBills(sales).map((b) => b.saleId)).toEqual(['s-b']);
    expect(again.check()).toMatchObject({ verdict: 'not_checked' }); // in step when last seen; not measured since this start
  });

  it('a restart while the clock was out keeps saying so until head office is heard again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-clock-')); dirs.push(dir);
    const t = readClockThresholds(undefined, undefined).thresholds;
    const g = await ClockGuard.open(t, dir);
    g.observe(header(T0 + 150_000), T0, T0 + 50);
    await g.settled();
    const again = await ClockGuard.open(t, dir);
    expect(again.check()).toMatchObject({ verdict: 'warning', offsetSeconds: 150, needsAttention: true });
  });

  it('measures every head-office answer through the fetch it wraps, and leaves the call itself untouched', async () => {
    const g = await ClockGuard.open(readClockThresholds(undefined, undefined).thresholds);
    let now = T0;
    const inner = (async () => { now += 100; return new Response('{"ok":true}', { status: 201, headers: { date: header(T0 - 400_000) } }); }) as unknown as typeof fetch;
    const res = await clockObservingFetch(inner, g, () => now)('https://cloud.example.test/v1/x');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(g.check()).toMatchObject({ verdict: 'flag_bills', offsetSeconds: -400 });
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(clockObservingFetch(failing, g)('https://cloud.example.test/v1/x')).rejects.toThrow('ECONNREFUSED');
  });
});
