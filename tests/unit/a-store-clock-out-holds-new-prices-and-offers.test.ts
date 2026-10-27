import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClockGuard, readClockThresholds } from '../../edge/store-edge/src/clock-guard';
import { activationHoldReport, offerHeld } from '../../edge/store-edge/src/activation-hold';
import { posLanePayload, cataloguePayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { clockReport } from '../../edge/sync-agent/src/box-health-report';
import { readBoxHealthReport } from '../../services/platform/src/box-health';
import { boxClockView } from '../../apps/web-erp/src/box-clock-view';
import { PosSession, taxRateFromPercent } from '../../apps/pos/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';
import type { Promotion } from '../../packages/promotions/src/promotions';
import type { StorePack } from '../../edge/store-edge/src/store-pack';

/**
 * **§31.1 · OB-403 "A" (owner, 27 Oct 2026, in writing) — while the store computer's clock is 5+ minutes out (OB-327's flag,
 * or this box's own setting), it keeps the prices and offers ALREADY in force and starts no NEW price, offer or bill-number
 * year until its clock is back in step. Selling never stops (hard rule #1); the hold is said in words (P-08).**
 *
 *   • the hold comes ONLY at the flag (not at the 2-minute warning, never before the first check) and lifts once back in step;
 *   • "already in force" is judged by BOTH clocks at the moment the clock was found out — a box running AHEAD starts no offer
 *     head office has not reached, a box running BEHIND starts none it has not reached itself;
 *   • it comes from the box's fsync'd clock log, so a cold restart holds exactly the same;
 *   • offers due after the cut-off and price entries dated after the cut-off's day are named; the Products and prices screen
 *     decides today's price by the cut-off's day; the till is told the cut-off and leaves later offers out of its pricing —
 *     and applies them again the moment the hold lifts (nothing lost);
 *   • the manager's clock strip says "Price change held: store clock is X min out", in English and Tamil;
 *   • what rides to head office is the facts and ids only, and head office reads it back (or refuses it by name).
 */

const T = readClockThresholds(undefined, undefined).thresholds; // OB-327: 2 and 5 minutes
const NOW = Date.parse('2026-10-27T06:00:00.000Z'); // 11:30 in the shop (Asia/Kolkata)
const iso = (ms: number): string => new Date(ms).toISOString();
// Head office's Date header that makes this box `offsetMs` behind (positive) or ahead (negative) at `at`.
// (The guard reads the header as the middle of its whole second, so it is given half a second early.)
const header = (at: number, offsetMs: number): string => new Date(at + offsetMs - 500).toUTCString();
const pack = { policies: { known: true, value: { tradingDayCutoff: '00:00', timeZone: 'Asia/Kolkata' } } } as const;

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe('OB-403 — the clock guard holds new activations only at the 5-minute flag', () => {
  it('no hold before the first check, in step, or at the 2-minute warning; a hold at the flag; lifted back in step', async () => {
    const g = await ClockGuard.open(T);
    expect(g.activationHold()).toEqual({ held: false });
    g.observe(header(NOW, 30_000), NOW, NOW);
    expect(g.activationHold()).toEqual({ held: false });
    g.observe(header(NOW + 1_000, 180_000), NOW + 1_000, NOW + 1_000); // 3 minutes: a warning only
    expect(g.check().verdict).toBe('warning');
    expect(g.activationHold()).toEqual({ held: false });
    g.observe(header(NOW + 2_000, 360_000), NOW + 2_000, NOW + 2_000); // 6 minutes: flagged
    expect(g.activationHold()).toMatchObject({ held: true, since: iso(NOW + 2_000), offsetSeconds: 360, flagSeconds: 300 });
    g.observe(header(NOW + 3_000, 2_000), NOW + 3_000, NOW + 3_000); // corrected
    expect(g.activationHold()).toEqual({ held: false });
  });

  it('the cut-off is the EARLIER of the two clocks at the flag: a box ahead by an hour holds from head office\'s time; one behind, from its own', async () => {
    const ahead = await ClockGuard.open(T);
    ahead.observe(header(NOW, -3_600_000), NOW, NOW); // the box is an hour AHEAD
    const a = ahead.activationHold();
    expect(a.held && a.cutoffAt).toBe(iso(NOW - 3_600_000));
    const behind = await ClockGuard.open(T);
    behind.observe(header(NOW, 600_000), NOW, NOW); // ten minutes BEHIND
    const b = behind.activationHold();
    expect(b.held && b.cutoffAt).toBe(iso(NOW));
  });

  it('a cold restart reads the hold from the fsync\'d clock log, before any new check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob403-')); dirs.push(dir);
    await writeFile(join(dir, 'clock-checks.log'), `${JSON.stringify({ at: iso(NOW - 60_000), verdict: 'flag_bills', offsetSeconds: -420 })}\n`, 'utf8');
    const g = await ClockGuard.open(T, dir);
    expect(g.activationHold()).toEqual({ held: true, since: iso(NOW - 60_000), cutoffAt: iso(NOW - 60_000 - 420_000), offsetSeconds: -420, flagSeconds: 300 });
  });
});

describe('OB-403 — what the hold holds, named, in words', () => {
  const hold = { held: true as const, since: iso(NOW), cutoffAt: iso(NOW), offsetSeconds: -360, flagSeconds: 300 };
  const promotions = [
    { id: 'running', startsAt: iso(NOW - 86_400_000), status: 'active' },
    { id: 'due-now', startsAt: iso(NOW + 60_000), status: 'active' },
    { id: 'next-week', startsAt: iso(NOW + 7 * 86_400_000), status: 'active' },
  ];
  const priceEntries = [
    { id: 'pe-old', productId: 'p1', effectiveFrom: '2026-10-01', status: 'active' },
    { id: 'pe-tomorrow', productId: 'p1', effectiveFrom: '2026-10-28', status: 'active' },
  ];

  it('offers due by the box\'s clock after the cut-off and prices dated after the cut-off\'s day are held; running ones stay', () => {
    // The box's own clock says it is the next morning: a price dated the 28th would be "today's" by it.
    const r = activationHoldReport({ hold, pack, now: iso(NOW + 86_400_000), tradingDay: '2026-10-28', promotions, priceEntries });
    expect(r).toMatchObject({ held: true, cutoffAt: iso(NOW), priceDay: '2026-10-27' });
    expect(r.heldPromotions).toEqual([{ id: 'due-now', startsAt: iso(NOW + 60_000) }]); // next week's is not due yet; the running one stays
    expect(r.heldPrices).toEqual([{ id: 'pe-tomorrow', productId: 'p1', effectiveFrom: '2026-10-28' }]);
    expect(r.staffMessage).toContain('Price change held: store clock is 6 min out');
    expect(r.staffMessage).toContain('offer due-now');
    expect(r.staffMessage).toContain('price pe-tomorrow for p1');
    expect(r.staffMessage).toContain('Selling goes on');
    expect(r.staffMessageTa).toMatch(/[஀-௿]/);
    expect(offerHeld('running', iso(NOW))).toBe(true); // an unreadable start fails safe (held)
    expect(offerHeld(iso(NOW - 1), iso(NOW))).toBe(false);
  });

  it('nothing is held when the clock is trusted — and the screens use the box\'s own day', () => {
    const r = activationHoldReport({ hold: { held: false }, pack, now: iso(NOW), tradingDay: '2026-10-27', promotions, priceEntries });
    expect(r).toMatchObject({ held: false, cutoffAt: null, priceDay: null, heldPromotions: [], heldPrices: [] });
  });

  it('the till is told the cut-off; the Products and prices screen decides today\'s price by the cut-off\'s day', () => {
    const r = activationHoldReport({ hold, pack, now: iso(NOW + 86_400_000), tradingDay: '2026-10-28', promotions, priceEntries });
    const registers = {
      policies: { known: true, value: { storeId: 'S1', branchId: 'S1', branchName: 'Main', tradingDayCutoff: '00:00', timeZone: 'Asia/Kolkata', staleAfterSeconds: 300, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0 } },
      pricingPolicy: { known: true, value: { userId: 'u-pricing', approvers: ['u-owner'], marginFloorBps: 0 } },
      priceEntries: { known: true, value: priceEntries.map((e) => ({ ...e, scope: 'store', scopeRef: 'S1', priceMinor: 100, version: 1 })) },
    };
    // Every other register of the store pack: not known (the screen then leaves it out).
    const storePack = new Proxy(registers, { get: (t, k) => (k in t ? t[k as keyof typeof t] : { known: false }) }) as unknown as StorePack;
    const input = { pack: storePack, tradingDay: '2026-10-28', now: iso(NOW + 86_400_000), activationHold: r } as unknown as ScreenInput;
    expect(posLanePayload(input, 'lane-1')['offerHold']).toEqual({ held: true, cutoffAt: iso(NOW) });
    const cat = cataloguePayload(input)!;
    expect(cat['today']).toBe('2026-10-27');
    expect(cat['activationHold']).toMatchObject({ held: true, heldPrices: [{ id: 'pe-tomorrow' }] });
    const free = cataloguePayload({ ...input, activationHold: activationHoldReport({ hold: { held: false }, pack, now: iso(NOW), tradingDay: '2026-10-28' }) } as ScreenInput)!;
    expect(free['today']).toBe('2026-10-28');
    expect(free['activationHold']).toBeUndefined();
  });

  it('the manager\'s clock strip says the hold in words beside a shape, English and Tamil; nothing when not held', () => {
    const r = activationHoldReport({ hold, pack, now: iso(NOW + 86_400_000), tradingDay: '2026-10-28', promotions, priceEntries });
    const check = { verdict: 'flag_bills', offsetSeconds: -360, lastCheckedAt: iso(NOW), needsAttention: true, staffMessage: 'en', staffMessageTa: 'ta' };
    const v = boxClockView('en', check, [], null, r);
    expect(v).toMatchObject({ show: true, tone: 'error' });
    expect(v.holdWords).toContain('Price change held: store clock is 6 min out');
    expect(boxClockView('ta', check, [], null, r).holdWords).toMatch(/[஀-௿]/);
    const inStep = { ...check, verdict: 'in_step', needsAttention: false };
    expect(boxClockView('en', inStep, [], null, activationHoldReport({ hold: { held: false }, pack, now: iso(NOW), tradingDay: '2026-10-27' }))).toMatchObject({ show: false, holdWords: '' });
  });
});

describe('OB-403 — the till applies no offer that starts after the cut-off, and applies it again when the hold lifts', () => {
  it('a 10% offer that started after the cut-off is not applied while held; the same basket gets it once lifted', () => {
    const session = new PosSession(
      { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2026-10-27', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }),
    );
    session.setNow(iso(NOW + 3_600_000)); // the till's own clock says the offer has started
    session.loadPromotions([
      { id: 'old-5', kind: 'percent_off', startsAt: iso(NOW - 86_400_000), endsAt: iso(NOW + 86_400_000), status: 'active', productIds: ['p2'], percentBps: 500 } as Promotion,
      { id: 'new-10', kind: 'percent_off', startsAt: iso(NOW + 60_000), endsAt: iso(NOW + 86_400_000), status: 'active', productIds: ['p1'], percentBps: 1000 } as Promotion,
    ]);
    session.scan({ productId: 'p1', description: 'Oil 1L', unitPrice: money(200_00, 'INR'), quantityMinor: 1, uom: 'ea' });
    session.scan({ productId: 'p2', description: 'Dal 1kg', unitPrice: money(100_00, 'INR'), quantityMinor: 1, uom: 'ea' });
    expect(session.totals().payable.minor).toBe(300_00 - 20_00 - 5_00); // both offers, before any hold
    session.holdOffersStartingAfter(iso(NOW));
    expect(session.heldOffers()).toEqual(['new-10']);
    expect(session.totals().payable.minor).toBe(300_00 - 5_00); // the running offer stays; the new one waits
    session.holdOffersStartingAfter(null);
    expect(session.heldOffers()).toEqual([]);
    expect(session.totals().payable.minor).toBe(300_00 - 20_00 - 5_00); // nothing lost
  });
});

describe('OB-403 — the hold rides to head office as facts and ids, and head office reads it back', () => {
  it('the report carries verdict, offset, thresholds and the held ids; an unreadable one is refused by name', () => {
    const report = clockReport({
      check: { verdict: 'flag_bills', offsetSeconds: -360, lastCheckedAt: iso(NOW), thresholds: { warnSeconds: 120, flagSeconds: 300 } },
      hold: { held: true, since: iso(NOW), heldPromotions: [{ id: 'due-now' }], heldPrices: [{ id: 'pe-tomorrow' }] },
    });
    expect(report).toEqual({ verdict: 'flag_bills', offsetSeconds: -360, lastCheckedAt: iso(NOW), warnSeconds: 120, flagSeconds: 300, hold: { held: true, since: iso(NOW), heldPromotions: ['due-now'], heldPrices: ['pe-tomorrow'] } });
    const base = {
      observedAt: iso(NOW), disk: { freeBytes: 1, totalBytes: 2, salesLogUsedBytes: 0, salesLogCapacityBytes: 10, reserveBytes: 0 },
      queue: { unsent: 0, deadLettered: 0 }, tills: [],
    };
    const read = readBoxHealthReport({ ...base, clockCheck: report }, iso(NOW + 1_000));
    expect('problems' in read ? read.problems : read.clockCheck).toEqual(report);
    const bad = readBoxHealthReport({ ...base, clockCheck: { ...report, verdict: 'roughly' } }, iso(NOW + 1_000));
    expect('problems' in bad && bad.problems.join(' ')).toMatch(/clockCheck needs verdict/);
  });
});
