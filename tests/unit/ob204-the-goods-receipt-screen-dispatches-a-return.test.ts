import { describe, it, expect } from 'vitest';
import {
  GOODS_RECEIPT_COPY, COPY_KEYS, createGoodsReceiptSession,
  type GoodsReceiptPorts, type GoodsReceiptData, type GrnRecordView, type GrnReturnLineView, type GrnLineReturnPort,
  type GrnLineDispatchPort, type LineDispatchPostResult, type LineDispatchOutcome, type GrnReturnDispatchView,
} from '../../apps/web-erp/src/goods-receipt-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **OB-204 (owner, 18 Oct 2026, in writing): a "Dispatch" button on the goods-receipt page for supplier returns above the
 * e-way-bill threshold.** Head office already holds the rule (OB-194): such a return is dispatched first, refused by name
 * (`ewb_required`) unless a generated e-way bill exists for its movement; only then is it recorded as gone back. The
 * screen's session proven here: the state in plain words in English and Tamil (no e-way bill yet · waiting · generated
 * with its number · dispatched), Dispatch offered only to a reader with the stock-movement right, a refusal said and the
 * return left undispatched, a success showing the number and opening "gone back", and no connection said as such.
 */

const MOV = 'supplier-return-g-big-line-L1';
const grn = (over: Partial<GrnRecordView> = {}): GrnRecordView => ({
  grnId: 'g-big', number: 'GRN-BIG', poId: 'po-rice', warehouseId: 'WH', receivedBy: 'u-recv', receivedAt: '2026-10-18T08:00:00.000Z',
  requiresApproval: false, discrepancyValueMinor: 0, currency: 'INR', sellableMinor: 0, quarantinedMinor: 1_001, rejectedMinor: 0, discrepancies: [],
  ...over,
});
const disp = (over: Partial<GrnReturnDispatchView> = {}): GrnReturnDispatchView => ({
  state: 'no_ewb', movementId: MOV, ewbNo: null, ewbState: 'none', detail: `movement ${MOV} is worth ₹1,00,100.00, above the ₹1,00,000.00 threshold`, ...over,
});
const ret = (over: Partial<GrnReturnLineView> = {}): GrnReturnLineView => ({
  lineId: 'L1', productId: 'p-rice', quantityMinor: 1_001, uom: 'ea', valueMinor: 10_010_000, currency: 'INR', decidedBy: 'u-boss',
  state: 'awaiting_return', returnedBy: null, needsCount: false, ...over,
});
const dataWith = (d: GrnReturnDispatchView | undefined, over: Partial<GrnReturnLineView> = {}): GoodsReceiptData => ({
  receipts: [grn({ returnLines: [ret({ ...(d === undefined ? {} : { dispatch: d }), ...over })] })],
});
const session = (data: GoodsReceiptData, ports: Partial<GoodsReceiptPorts> = {}, userId: string | null = 'u-recv') =>
  createGoodsReceiptSession({ userId }, { snapshot: () => data, mayRead: () => true, ...ports });
const wired = (answer: LineDispatchPostResult, over: Partial<GoodsReceiptPorts> = {}) => {
  const sent: unknown[] = [];
  const returned: unknown[] = [];
  const dispatchPort: GrnLineDispatchPort = { post: async (i) => { sent.push(i); return answer; } };
  const returnPort: GrnLineReturnPort = { post: async (i) => { returned.push(i); return { result: 'returned' }; } };
  const ports: Partial<GoodsReceiptPorts> = { mayRecordReturn: () => true, returnPort: () => returnPort, dispatchPort: () => dispatchPort, ...over };
  return { sent, returned, ports };
};
const lineOf = (s: ReturnType<typeof session>, lang: 'en' | 'ta' = 'en') => s.view(lang).receipts[0]!.returnLines[0]!;

describe('OB-204 · the dispatch words are complete in both languages', () => {
  it('has no gap across the whole vocabulary, the new words included', () => {
    expect(bilingualGaps(GOODS_RECEIPT_COPY, COPY_KEYS)).toEqual({ en: [], ta: [] });
    for (const k of ['dispNoEwb', 'dispWaiting', 'dispGenerated', 'dispDispatched', 'dispatchBtn', 'dispatchLostLink', 'returnNeedsDispatch'] as const) {
      expect(COPY_KEYS).toContain(k);
      expect(GOODS_RECEIPT_COPY.ta[k]).not.toBe(GOODS_RECEIPT_COPY.en[k]);
    }
  });
});

describe('OB-204 · a return above the e-way-bill limit is dispatched first, from the screen', () => {
  it('says each state in plain words, in English and Tamil — no e-way bill yet, waiting, generated with its number, dispatched', () => {
    const { ports } = wired({ result: 'lost_link' });
    const cases: [GrnReturnDispatchView, string, string, string][] = [
      [disp(), 'error', 'no e-way bill yet', 'இன்னும் இ-வே பில் இல்லை'],
      [disp({ state: 'ewb_waiting', ewbState: 'pending_unknown' }), 'pending', 'E-way bill waiting', 'இ-வே பில் காத்திருக்கிறது'],
      [disp({ state: 'ewb_not_usable', ewbState: 'cancelled' }), 'error', 'rejected or cancelled', 'ரத்து'],
      [disp({ state: 'ewb_generated', ewbState: 'generated', ewbNo: '391000654321' }), 'ok', 'E-way bill 391000654321 generated', 'இ-வே பில் 391000654321 உருவானது'],
      [disp({ state: 'dispatched', ewbState: 'generated', ewbNo: '391000654321' }), 'ok', 'Dispatched under e-way bill 391000654321', '391000654321 உடன் அனுப்பப்பட்டது'],
      [disp({ state: 'not_known', ewbState: null }), 'unknown', 'not known just now', 'தெரியவில்லை'],
    ];
    for (const [d, tone, en, ta] of cases) {
      const s = session(dataWith(d), ports);
      expect(lineOf(s).dispatchState, d.state).toMatchObject({ tone, detail: d.detail });
      expect(lineOf(s).dispatchState!.label, d.state).toContain(en);
      expect(lineOf(s, 'ta').dispatchState!.label, d.state).toContain(ta);
      // Dispatch is offered for every state still to go; never once dispatched.
      expect(lineOf(s).canDispatch, d.state).toBe(d.state !== 'dispatched');
      // "Gone back" waits for the dispatch.
      expect(s.view('en').awaitingReturn.length, d.state).toBe(d.state === 'dispatched' ? 1 : 0);
    }
    expect(lineOf(session(dataWith(disp({ state: 'dispatched', ewbNo: null })), ports)).dispatchState!.label).toBe('Dispatched — no e-way bill was needed');
    // At or below the limit — or with no dispatch step wired — nothing new is said and the return is offered as before.
    for (const d of [disp({ state: 'not_required', ewbState: null }), undefined]) {
      const s = session(dataWith(d), ports);
      expect(lineOf(s)).toMatchObject({ dispatchState: null, needsDispatch: false, canDispatch: false });
      expect(s.view('en').awaitingReturn.map((a) => a.line.lineId)).toEqual(['L1']);
    }
    // A return already gone carries its dispatch in words, and nothing to press.
    const gone = session(dataWith(disp({ state: 'dispatched', ewbNo: '391000654321' }), { state: 'returned', returnedBy: 'u-recv' }), ports);
    expect(lineOf(gone)).toMatchObject({ canDispatch: false, needsDispatch: false, dispatchState: { label: 'Dispatched under e-way bill 391000654321' } });
  });

  it('refused without an e-way bill: the reason is said plainly and the return stays undispatched — "gone back" still waits', async () => {
    const why = `This supplier return cannot leave without an e-way bill: movement ${MOV} is worth ₹1,00,100.00, above the ₹1,00,000.00 threshold, and no e-way bill has been generated for it.`;
    const { sent, returned, ports } = wired({ result: 'ewb_required', reason: why });
    const s = session(dataWith(disp()), ports);
    const o = await s.dispatchReturn({ grnId: 'g-big', lineId: 'L1', reason: 'supplier lorry TN-01-AB-1234' });
    expect(o).toEqual({ outcome: 'ewb_required', reason: why });
    expect(sent).toEqual([{ grnId: 'g-big', lineId: 'L1', reason: 'supplier lorry TN-01-AB-1234' }]);
    const shown = s.presentDispatchOutcome('en', o);
    expect(shown).toMatchObject({ tone: 'error', needsAttention: true });
    expect(shown.label).toBe(`Not dispatched — it needs a generated e-way bill first. Head office said: ${why}`);
    expect(s.presentDispatchOutcome('ta', o).label).toContain('அனுப்பப்படவில்லை');
    expect(lineOf(s)).toMatchObject({ needsDispatch: true, canDispatch: true, dispatchState: { tone: 'error' } });
    expect(s.view('en').awaitingReturn).toEqual([]);
    expect(await s.recordReturn({ grnId: 'g-big', lineId: 'L1', reason: 'collected' })).toEqual({ outcome: 'needs_dispatch' });
    expect(returned).toEqual([]);
    expect(s.presentReturnOutcome('en', { outcome: 'needs_dispatch' }).label).toMatch(/^Dispatch it first/);
  });

  it('dispatched under a generated e-way bill: the number is shown and "gone back" is offered at once — even before the list is read again', async () => {
    const { returned, ports } = wired({ result: 'dispatched', ewbNo: '391000654321' });
    const s = session(dataWith(disp({ state: 'ewb_generated', ewbState: 'generated', ewbNo: '391000654321' })), ports);
    const o = await s.dispatchReturn({ grnId: 'g-big', lineId: 'L1', reason: 'supplier lorry TN-01-AB-1234' });
    expect(o).toEqual({ outcome: 'dispatched', ewbNo: '391000654321' });
    expect(s.presentDispatchOutcome('en', o)).toMatchObject({ tone: 'ok', label: 'Dispatched under e-way bill 391000654321. You can now record it as gone back.' });
    expect(lineOf(s)).toMatchObject({ needsDispatch: false, canDispatch: false, dispatchState: { label: 'Dispatched under e-way bill 391000654321', tone: 'ok' } });
    expect(s.view('en').awaitingReturn.map((a) => a.line.lineId)).toEqual(['L1']);
    expect(await s.recordReturn({ grnId: 'g-big', lineId: 'L1', reason: 'collected by the lorry' })).toEqual({ outcome: 'returned' });
    expect(returned).toEqual([{ grnId: 'g-big', lineId: 'L1', reason: 'collected by the lorry' }]);
    // A resend is head office's "already dispatched" — the same, said as such.
    const again = wired({ result: 'already_dispatched', ewbNo: '391000654321' });
    const s2 = session(dataWith(disp({ state: 'ewb_generated', ewbNo: '391000654321' })), again.ports);
    expect(await s2.dispatchReturn({ grnId: 'g-big', lineId: 'L1', reason: 'lorry' })).toEqual({ outcome: 'already_dispatched', ewbNo: '391000654321' });
    expect(s2.presentDispatchOutcome('en', { outcome: 'already_dispatched', ewbNo: '391000654321' }).label).toBe('This return was already dispatched. You can record it as gone back.');
    expect(s2.presentDispatchOutcome('en', { outcome: 'dispatched', ewbNo: null }).label).toBe('Dispatched — no e-way bill was needed. You can now record it as gone back.');
  });

  it('no connection is "needs connection", never success; nothing is pretended', async () => {
    const { ports } = wired({ result: 'lost_link' });
    const s = session(dataWith(disp({ state: 'ewb_generated', ewbNo: '391000654321' })), ports);
    const o = await s.dispatchReturn({ grnId: 'g-big', lineId: 'L1', reason: 'lorry TN-01' });
    expect(o).toEqual({ outcome: 'lost_link' });
    expect(s.presentDispatchOutcome('en', o)).toMatchObject({ tone: 'degraded', label: expect.stringMatching(/^Needs connection — /) as unknown as string });
    expect(s.presentDispatchOutcome('ta', o).label).toMatch(/^இணைப்பு தேவை/);
    expect(lineOf(s)).toMatchObject({ needsDispatch: true, canDispatch: true });
    expect(s.view('en').awaitingReturn).toEqual([]);
    // No dispatch link at all (a page that cannot reach head office): Dispatch is not offered, and pressing says why.
    const offline = session(dataWith(disp()), { mayRecordReturn: () => true, dispatchPort: () => null });
    expect(lineOf(offline)).toMatchObject({ needsDispatch: true, canDispatch: false });
    expect(offline.presentDispatchOutcome('en', await offline.dispatchReturn({ grnId: 'g-big', lineId: 'L1', reason: 'lorry' })).label).toMatch(/^Needs connection — this page cannot reach head office/);
  });

  it('refuses — with nothing sent — without the right, with nobody named, for a return with no dispatch step, needing a count, or with no reason', async () => {
    const cases: [Partial<GoodsReceiptPorts>, string | null, GoodsReceiptData, { grnId: string; lineId: string; reason: string }, LineDispatchOutcome['outcome']][] = [
      [{ mayRecordReturn: () => false }, 'u-recv', dataWith(disp()), { grnId: 'g-big', lineId: 'L1', reason: 'lorry' }, 'not_permitted'],
      [{}, null, dataWith(disp()), { grnId: 'g-big', lineId: 'L1', reason: 'lorry' }, 'not_permitted'],
      [{}, 'u-recv', dataWith(disp()), { grnId: 'g-big', lineId: 'L9', reason: 'lorry' }, 'line_unknown'],
      [{}, 'u-recv', dataWith(disp({ state: 'not_required' })), { grnId: 'g-big', lineId: 'L1', reason: 'lorry' }, 'not_needed'],
      [{}, 'u-recv', dataWith(disp({ state: 'dispatched', ewbNo: '391000654321' })), { grnId: 'g-big', lineId: 'L1', reason: 'lorry' }, 'not_needed'],
      [{}, 'u-recv', dataWith(undefined), { grnId: 'g-big', lineId: 'L1', reason: 'lorry' }, 'not_needed'],
      [{}, 'u-recv', dataWith(disp(), { needsCount: true }), { grnId: 'g-big', lineId: 'L1', reason: 'lorry' }, 'needs_count'],
      [{}, 'u-recv', dataWith(disp()), { grnId: 'g-big', lineId: 'L1', reason: '  ' }, 'reason_missing'],
    ];
    for (const [over, userId, data, input, outcome] of cases) {
      const { sent, ports } = wired({ result: 'dispatched', ewbNo: '391000654321' }, over);
      const s = session(data, ports, userId);
      expect(await s.dispatchReturn(input), outcome).toEqual({ outcome });
      expect(sent, outcome).toEqual([]);
      expect(s.presentDispatchOutcome('en', { outcome } as LineDispatchOutcome).label.length, outcome).toBeGreaterThan(0);
      expect(s.presentDispatchOutcome('ta', { outcome } as LineDispatchOutcome).label.length, outcome).toBeGreaterThan(0);
    }
    // Without the right the state is still said, but there is nothing to press.
    expect(lineOf(session(dataWith(disp()), { mayRecordReturn: () => false }))).toMatchObject({ canDispatch: false, needsDispatch: true, dispatchState: { tone: 'error' } });
    // A line needing a count first is not offered Dispatch either.
    expect(lineOf(session(dataWith(disp(), { needsCount: true }), wired({ result: 'lost_link' }).ports)).canDispatch).toBe(false);
    // Head office's other refusals pass through verbatim.
    const other = wired({ result: 'refused', reason: 'The return of line L1 on g-big was already recorded.' });
    const s = session(dataWith(disp()), other.ports);
    const o = await s.dispatchReturn({ grnId: 'g-big', lineId: 'L1', reason: 'lorry' });
    expect(s.presentDispatchOutcome('en', o).label).toBe('Not dispatched — head office refused it: The return of line L1 on g-big was already recorded.');
  });
});
