import { describe, it, expect } from 'vitest';
import {
  correlateLosses, readCctvReference, cctvEvidenceRef, CCTV_VIDEO_FIELDS,
  type TillExceptionFact, type ShrinkFact, type CountDifferenceFact,
} from '../../packages/loss-prevention/src/correlate';

// D-21 (R4, OB-217): one view of till exceptions, waste/shrink and count differences for a product or a cashier and a
// period; it proposes a case and opens nothing; CCTV is a reference only.

const TILL: TillExceptionFact[] = [
  { ref: 'till-activity:V-1', kind: 'void', cashierId: 'u-ravi', productIds: ['p-ghee'], valueMinor: 64_000, day: '2026-10-10' },
  { ref: 'till-activity:O-1', kind: 'price_override', cashierId: 'u-ravi', productIds: ['p-ghee'], valueMinor: 14_000, day: '2026-10-11' },
  { ref: 'till-activity:N-1', kind: 'no_sale', cashierId: 'u-ravi', productIds: [], valueMinor: 0, day: '2026-10-11' },
  { ref: 'return:RT-1', kind: 'refund', cashierId: 'u-meena', productIds: ['p-ghee', 'p-tea'], valueMinor: 70_000, day: '2026-10-12' },
  { ref: 'till-activity:V-9', kind: 'void', cashierId: 'u-ravi', productIds: ['p-ghee'], valueMinor: 64_000, day: '2026-09-01' }, // outside
];
const SHRINK: ShrinkFact[] = [
  { ref: 'write-off:W-1', productId: 'p-ghee', lossType: 'damage', reasonCode: 'damage', quantityMinor: 1, valueMinor: 50_000, day: '2026-10-12' },
  { ref: 'write-off:W-2', productId: 'p-rice', lossType: 'wastage', reasonCode: 'spoiled', quantityMinor: 5, valueMinor: 20_000, day: '2026-10-12' },
];
const COUNTS: CountDifferenceFact[] = [
  { ref: 'count:C-1', productId: 'p-ghee', varianceMinor: -2, valueMinor: -100_000, day: '2026-10-13' },
  { ref: 'count:C-2', productId: 'p-ghee', varianceMinor: 1, valueMinor: 50_000, day: '2026-10-13' },
  { ref: 'count:C-3', productId: 'p-ghee', varianceMinor: 0, valueMinor: 0, day: '2026-10-13' },
];
const period = { from: '2026-10-01', to: '2026-10-31', tillExceptions: TILL, shrink: SHRINK, countDifferences: COUNTS };

describe('D-21 — till, shrink and counts in one view', () => {
  it('for a product: every till exception on it, its write-offs and its count differences — a case PROPOSED, nothing opened', () => {
    const v = correlateLosses({ ...period, subject: { kind: 'product', productId: 'p-ghee' } });
    expect(v.tillExceptions.map((t) => t.ref)).toEqual(['till-activity:V-1', 'till-activity:O-1', 'return:RT-1']);
    expect(v.totals.tillExceptions).toEqual({ void: 1, no_sale: 0, price_override: 1, refund: 1 });
    expect(v.shrink.map((s) => s.ref)).toEqual(['write-off:W-1']);
    expect(v.countDifferences.map((c) => c.ref)).toEqual(['count:C-1', 'count:C-2']); // a zero difference is not one
    expect(v.totals).toMatchObject({ shrinkValueMinor: 50_000, countShortageValueMinor: 100_000, countOverValueMinor: 50_000 });
    expect(v.proposal).toMatchObject({ propose: true, subjectRef: 'product:p-ghee', raisedFromRef: 'lp-correlation:product:p-ghee:2026-10-01:2026-10-31', valueMinor: 150_000 });
    expect(v.proposal.summary).toMatch(/no finding about anyone/);
    expect(v.proposal.evidenceRefs).toEqual(['till-activity:V-1', 'till-activity:O-1', 'return:RT-1', 'write-off:W-1', 'count:C-1']);
    expect(v.opened).toBe(false);
  });

  it('for a cashier: their exceptions (a no-sale included), joined to the products those exceptions touched', () => {
    const v = correlateLosses({ ...period, subject: { kind: 'cashier', cashierId: 'u-ravi' } });
    expect(v.tillExceptions.map((t) => t.kind)).toEqual(['void', 'no_sale', 'price_override']); // by day, then reference
    expect(v.productsJoined).toEqual(['p-ghee']);
    expect(v.shrink.map((s) => s.productId)).toEqual(['p-ghee']); // the rice write-off is not theirs to look at
    expect(v.proposal).toMatchObject({ propose: true, subjectRef: 'cashier:u-ravi' });
  });

  it('one kind alone proposes nothing, and says why', () => {
    const lossOnly = correlateLosses({ ...period, subject: { kind: 'product', productId: 'p-rice' } });
    expect(lossOnly.proposal.propose).toBe(false);
    expect(lossOnly.proposal.because).toMatch(/losses with no till exception beside them/);
    const tillOnly = correlateLosses({ ...period, subject: { kind: 'product', productId: 'p-tea' } });
    expect(tillOnly.proposal.propose).toBe(false);
    expect(tillOnly.proposal.because).toMatch(/till exceptions with no loss beside them/);
    const none = correlateLosses({ ...period, subject: { kind: 'cashier', cashierId: 'u-nobody' } });
    expect(none.proposal).toMatchObject({ propose: false, valueMinor: 0 });
    expect(none.proposal.because).toMatch(/nothing recorded/);
  });
});

describe('D-21 — CCTV as a reference only (OB-217)', () => {
  const ok = { cameraId: 'CAM-3 (till 2)', from: '2026-10-11T10:00:00+05:30', to: '2026-10-11T10:20:00+05:30', collectedBy: 'u-mgr' };
  it('keeps the camera, the time from and to, and who collected it — as a reference string', () => {
    const r = readCctvReference(ok);
    expect(r).toEqual({ ok: true, ref: { cameraId: 'CAM-3 (till 2)', from: '2026-10-11T04:30:00.000Z', to: '2026-10-11T04:50:00.000Z', collectedBy: 'u-mgr' } });
    if (r.ok) expect(cctvEvidenceRef(r.ref)).toBe('cctv:camera=CAM-3 (till 2);from=2026-10-11T04:30:00.000Z;to=2026-10-11T04:50:00.000Z');
  });
  it('refuses any video, file or link by name — and a period that runs backwards', () => {
    for (const f of CCTV_VIDEO_FIELDS) expect(readCctvReference({ ...ok, [f]: 'x' })).toMatchObject({ ok: false, refusal: 'video_not_stored' });
    expect(readCctvReference({ ...ok, from: ok.to, to: ok.from })).toMatchObject({ ok: false, refusal: 'cctv_period_backwards' });
    expect(readCctvReference({ cameraId: 'CAM-3' })).toMatchObject({ ok: false, refusal: 'not_readable_as_a_cctv_reference' });
  });
});
