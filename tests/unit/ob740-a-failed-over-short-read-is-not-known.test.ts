import { describe, it, expect, afterEach } from 'vitest';
import { createCashOfficeSession, type CashOverShortData, type OverShortView } from '../../apps/web-erp/src/cash-office-session';
import { cashOfficePortsFromData, bootCashOffice, fetchOverShortWorklist } from '../../apps/web-erp/src/browser-entry';
import { cashOfficePayload, todayFigures, materialCloses, BOX_OVERSHORT_DAYS, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { emptyPack, known, type StorePack } from '../../edge/store-edge/src/store-pack';
import type { TillShiftCloseRecord } from '../../edge/store-edge/src/till-cash';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **D-2 (pilot-first audit · OB-739 / OB-740 · M14-FR-02 · P-08 "no silent failure"): a till closed ₹649.50 short and the
 * cash office's over/short page said "No over/shorts to account for — every drawer is signed off".**
 *
 * The page booted on an EMPTY worklist and, when its live read of head office failed, kept it — so a read that failed
 * read exactly like a read that found nothing. These pin the rule: the all-clear ONLY when head office's worklist was
 * READ and came back empty; a read not made, refused or unreachable is "Not known — why" (English and Tamil); and the
 * drawers this store computer ITSELF recorded closing over/short are shown even when head office cannot be read. Today
 * counts the box's own closes too, so "Exceptions open: 0" never stands alone beside a short drawer.
 */

const DAY = '2026-11-14';
const ALL_CLEAR = 'No over/shorts to account for — every drawer is signed off.';
/** The audit's repro, as the box records it: float ₹2,000, a ₹149.50 cash sale, counted ₹1,500 — short ₹649.50. */
const close = (over: Partial<TillShiftCloseRecord> = {}): TillShiftCloseRecord => ({
  kind: 'close', shiftId: 'sh-1', tillId: 'lane-1', laneId: 'lane-1', cashierId: 'u-ravi', tradingDay: DAY,
  openedAt: `${DAY}T03:30:00.000Z`, closedAt: `${DAY}T14:00:00.000Z`,
  openingFloatMinor: 200_000, cashSalesMinor: 14_950, pickupsMinor: 0, cashRefundsMinor: 0,
  countedMinor: 150_000, expectedMinor: 214_950, varianceMinor: -64_950, exceptionRaised: true,
  reasonCode: 'gave_wrong_change', toleranceMinor: 10_000, toleranceKnown: true, currency: 'INR', ...over,
});
const asView = (c: TillShiftCloseRecord): OverShortView => ({ shiftId: c.shiftId, tillId: c.tillId, cashierId: c.cashierId, tradingDay: c.tradingDay, varianceMinor: c.varianceMinor, reasonCode: c.reasonCode });
const MGR = { userId: 'u-mgr', permissions: ['till.shift.read', 'till.overshort.review'] };
const EMPTY: CashOverShortData = { openCount: 0, totalVarianceMinor: 0, open: [] };

describe('the over/short page says the all-clear only on a worklist head office really returned empty', () => {
  it('booted with no worklist read yet, it is NOT KNOWN — never "every drawer is signed off"', () => {
    const view = bootCashOffice(MGR)!.view('en');
    expect(view.known).toBe(false);
    expect(view.screenState.label).toMatch(/^Not known — head office has not been read yet/);
    expect(view.screenState.label).not.toBe(ALL_CLEAR);
    expect(view.screenState.tone).toBe('error');
  });

  it('a read that could not reach head office, or that head office refused, says so in both languages', () => {
    const unreachable = createCashOfficeSession({ userId: 'u-mgr' }, cashOfficePortsFromData(MGR, undefined, undefined, 'unreachable'));
    expect(unreachable.view('en').screenState.label).toBe('Not known — head office could not be reached, so whether any drawer is waiting to be signed off cannot be told');
    expect(unreachable.view('ta').screenState.label).toMatch(/^தெரியவில்லை — தலைமை அலுவலகத்தை அடைய முடியவில்லை/);
    const refused = createCashOfficeSession({ userId: 'u-mgr' }, cashOfficePortsFromData(MGR, undefined, undefined, 'refused'));
    expect(refused.view('en').screenState.label).toMatch(/^Not known — head office would not show the over\/shorts for your sign-in/);
  });

  it('a read that SUCCEEDED and returned nothing is the all-clear — the only way to it', () => {
    const view = createCashOfficeSession({ userId: 'u-mgr' }, cashOfficePortsFromData(MGR, EMPTY)).view('en');
    expect(view.known).toBe(true);
    expect(view.screenState.label).toBe(ALL_CLEAR);
  });

  it('when head office cannot be read, the drawer THIS store computer recorded closing short is shown — and cannot be signed off', async () => {
    const data = { ...MGR, boxOverShort: { days: BOX_OVERSHORT_DAYS, closes: [asView(close())] } };
    const session = createCashOfficeSession({ userId: 'u-mgr' }, cashOfficePortsFromData(data, undefined, { post: async () => 'signed' }, 'unreachable'));
    const view = session.view('en');
    expect(view.known).toBe(false);
    expect(view.open).toEqual([]);
    expect(view.boxRecorded?.rows.map((r) => `${r.direction} ${r.amount} ${r.tillId}`)).toEqual(['Short ₹649.50 lane-1']);
    expect(view.boxRecorded?.lead).toMatch(/last 7 trading days, by this store computer’s own records\. Whether head office has signed them off is not known/);
    expect(await session.signOff('sh-1', 'miscount', '')).toBe('refused');
    // The box recorded nothing: it says THAT, and that a drawer closed elsewhere is not known — still no all-clear.
    const none = createCashOfficeSession({ userId: 'u-mgr' }, cashOfficePortsFromData({ ...MGR, boxOverShort: { days: 7, closes: [] } }, undefined, undefined, 'unreachable')).view('en');
    expect(none.boxRecorded?.rows).toEqual([]);
    expect(none.boxRecorded?.lead).toMatch(/recorded no drawer .* but head office could not be read/);
  });
});

describe('the live read says WHY it failed, never hands back an empty list', () => {
  const saved = globalThis.fetch;
  afterEach(() => { globalThis.fetch = saved; });

  it('no connection → unreachable; a refusal → refused; a body → the open rows', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await fetchOverShortWorklist()).toEqual({ result: 'unreachable' });
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    expect(await fetchOverShortWorklist()).toEqual({ result: 'refused' });
    globalThis.fetch = (async () => new Response(JSON.stringify({ overShort: [{ ...asView(close()), reviewed: false }, { ...asView(close({ shiftId: 'sh-0' })), reviewed: true }] }), { status: 200 })) as unknown as typeof fetch;
    const read = await fetchOverShortWorklist();
    expect(read.result).toBe('read');
    if (read.result === 'read') expect(read.worklist).toMatchObject({ openCount: 1, totalVarianceMinor: -64_950 });
  });
});

const input = (pack: StorePack, tillCloses?: readonly TillShiftCloseRecord[]): ScreenInput =>
  ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: `${DAY}T15:00:00.000Z`, tradingDay: DAY, ...(tillCloses === undefined ? {} : { tillCloses }) }) as unknown as ScreenInput;
const withCashOffice = (): StorePack => ({ ...emptyPack('test'), cashOfficePolicy: known({ userId: 'u-mgr', permissions: MGR.permissions }) }) as StorePack;

describe('the store computer hands the desk its own record of drawers that closed over/short', () => {
  it('the payload carries the material closes of the last 7 trading days, biggest first — not a close within tolerance, not an older one', () => {
    const closes = [
      close(),
      close({ shiftId: 'sh-small', varianceMinor: -5_000, exceptionRaised: false }), // within tolerance
      close({ shiftId: 'sh-over', varianceMinor: 80_000, tradingDay: '2026-11-08' }), // 6 days back — kept
      close({ shiftId: 'sh-old', varianceMinor: -90_000, tradingDay: '2026-11-07' }), // 7 days back — out
    ];
    const payload = cashOfficePayload(input(withCashOffice(), closes))!;
    expect(payload['boxOverShort']).toEqual({
      days: 7,
      closes: [
        { shiftId: 'sh-over', tillId: 'lane-1', cashierId: 'u-ravi', tradingDay: '2026-11-08', varianceMinor: 80_000, reasonCode: 'gave_wrong_change' },
        { shiftId: 'sh-1', tillId: 'lane-1', cashierId: 'u-ravi', tradingDay: DAY, varianceMinor: -64_950, reasonCode: 'gave_wrong_change' },
      ],
    });
    expect(materialCloses(closes, DAY, 0).map((c) => c.shiftId)).toEqual(['sh-1']);
    // A box with no till-cash log carries nothing — the page then says only that head office could not be read.
    expect(cashOfficePayload(input(withCashOffice()))!['boxOverShort']).toBeUndefined();
  });

  it('Today counts the drawers closed over/short today, with the till and the amount, in both languages', () => {
    const figures = todayFigures(input(withCashOffice(), [close(), close({ shiftId: 'sh-y', tradingDay: '2026-11-13' })]));
    expect(figures['drawersOverShortToday']).toEqual({
      known: true, value: 1,
      note: 'lane-1 short ₹649.50 — closed today on this store computer; signing off is on the Cash over/short page',
      noteTa: 'lane-1 குறைவு ₹649.50 — இன்று இந்தக் கடைக் கணினியில் மூடப்பட்டது; கையொப்பம் கூடுதல்/குறைவு பக்கத்தில்',
    });
    expect(todayFigures(input(withCashOffice(), []))['drawersOverShortToday']).toEqual({ known: true, value: 0 });
    expect(todayFigures(input(withCashOffice()))['drawersOverShortToday']).toBeUndefined();
  });
});
