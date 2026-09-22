import { describe, it, expect } from 'vitest';
import {
  PRODUCTION_COPY, COPY_KEYS, createProductionSession,
  type ProductionPorts, type ProductionData, type ProductionRun, type ReleaseResult,
} from '../../apps/web-erp/src/production-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The in-store production quality-release screen (M11-FR-03 · API-04 · P-03 · P-04 · P-05 · P-08). It shows every
// finished batch still in QUARANTINE — worst-first (a production EXCEPTION outranks a cost-unknown batch outranks
// a yield drift outranks a clean awaiting one), each reading as attention (never a bare colour); the one action
// is RELEASE FOR SALE, or HOLD on a failed check (a human write in the releaser's name). It refuses locally
// before any POST without the release permission, when nobody is named, or for a run it does not hold / already
// released.

const run = (over: Partial<ProductionRun> & Pick<ProductionRun, 'runId'>): ProductionRun => ({
  departmentId: 'bakery', outputProductId: 'p-loaf', outputBatchId: `B-${over.runId}`,
  outputQuantityMinor: 12000, outputUom: 'ea', expiresAt: '2026-09-28T00:00:00.000Z',
  outputUnitCostMinor: 25000, currency: 'INR', costKnown: true, uncostedProducts: [],
  yieldVerdict: 'as_expected', exceptions: [], ...over,
});
const data = (over: Partial<ProductionData> = {}): ProductionData => ({ runs: [], ...over });

const session = (
  d: ProductionData,
  ports: Partial<ProductionPorts> = {},
  userId: string | null = 'u-qc',
) =>
  createProductionSession({ userId }, {
    worklist: () => d,
    mayRead: () => true,
    mayRelease: () => true,
    releasePort: () => ({ post: async () => 'released' as ReleaseResult }),
    ...ports,
  });

describe('the production copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(PRODUCTION_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...PRODUCTION_COPY.en }, ta: { ...PRODUCTION_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('the board lists batches awaiting release, worst first, each as attention (never colour alone)', () => {
  it('orders exception before cost-unknown before yield-off before a clean awaiting batch', () => {
    const view = session(data({
      runs: [
        run({ runId: 'r-clean' }),
        run({ runId: 'r-yield', yieldVerdict: 'low_yield' }),
        run({ runId: 'r-cost', costKnown: false, uncostedProducts: ['p-flour'] }),
        run({ runId: 'r-exc', exceptions: [{ kind: 'yield_variance', detail: 'made 8, planned 12' }] }),
      ],
    })).view('en');
    expect(view.runs.map((r) => r.runId)).toEqual(['r-exc', 'r-cost', 'r-yield', 'r-clean']);
  });

  it('an exception is an error tone with an icon and a word; a clean awaiting batch is neutral but still attention', () => {
    const view = session(data({
      runs: [
        run({ runId: 'r-exc', exceptions: [{ kind: 'no_output', detail: 'nothing came out' }] }),
        run({ runId: 'r-clean' }),
      ],
    })).view('en');
    const exc = view.runs.find((r) => r.runId === 'r-exc')!;
    const clean = view.runs.find((r) => r.runId === 'r-clean')!;
    expect(exc.status.tone).toBe('error');
    expect(exc.status.icon.trim().length).toBeGreaterThan(0);
    expect(exc.severityWord).toBe(PRODUCTION_COPY.en.exceptionWord);
    expect(exc.exceptionDetails).toEqual(['nothing came out']);
    expect(exc.needsAttention).toBe(true);
    expect(clean.status.tone).toBe('idle');
    expect(clean.severityWord).toBe(PRODUCTION_COPY.en.awaitingWord);
    expect(clean.needsAttention).toBe(true);
  });

  it('shows the unit cost when known, and NEVER fakes it as zero when an ingredient is uncosted (P-08)', () => {
    const view = session(data({
      runs: [
        run({ runId: 'r-costed', outputUnitCostMinor: 25000, currency: 'INR' }),
        run({ runId: 'r-uncosted', costKnown: false, uncostedProducts: ['p-flour'] }),
      ],
    })).view('en');
    expect(view.runs.find((r) => r.runId === 'r-costed')!.cost).toBe('₹250.00');
    expect(view.runs.find((r) => r.runId === 'r-uncosted')!.cost).toBeNull();
  });

  it('a released batch drops off the board (it is sellable, no longer the QC operator\'s work)', () => {
    const view = session(data({
      runs: [run({ runId: 'r-open' }), run({ runId: 'r-done', released: true })],
    })).view('en');
    expect(view.runs.map((r) => r.runId)).toEqual(['r-open']);
    expect(view.toReleaseCount).toBe(1);
  });

  it('a board with nothing awaiting reads as all-released, not as unknown', () => {
    const view = session(data({ runs: [run({ runId: 'r-done', released: true })] })).view('en');
    expect(view.toReleaseCount).toBe(0);
    expect(view.screenState.label).toBe(PRODUCTION_COPY.en.scrEmpty);
  });
});

describe('permission gating (P-04 least privilege)', () => {
  it('a user without read permission sees a not-permitted state and no runs', () => {
    const view = session(data({ runs: [run({ runId: 'r-1' })] }), { mayRead: () => false }).view('en');
    expect(view.runs).toHaveLength(0);
    expect(view.screenState.label).toBe(PRODUCTION_COPY.en.stateNotPermitted);
  });

  it('a reader without release permission sees the board but is not offered the release action', () => {
    const view = session(data({ runs: [run({ runId: 'r-1' })] }), { mayRelease: () => false }).view('en');
    expect(view.runs).toHaveLength(1);
    expect(view.mayRelease).toBe(false);
  });

  it('flags when the box was not told who is at the screen', () => {
    expect(session(data(), {}, null).view('en').nobodyNamed).toBe(true);
    expect(session(data(), {}, 'u-qc').view('en').nobodyNamed).toBe(false);
  });
});

describe('releasing is a human write, gated and checked before any POST (§28/P-04/P-05)', () => {
  const filled = () => data({ runs: [run({ runId: 'r-1' })] });

  it('a pass POSTs qcPassed true and reports released', async () => {
    const calls: { runId: string; qcPassed: boolean }[] = [];
    const s = session(filled(), { releasePort: () => ({ post: async (i) => { calls.push(i); return 'released'; } }) });
    const out = await s.release('r-1', true);
    expect(out).toBe('released');
    expect(calls).toEqual([{ runId: 'r-1', qcPassed: true }]);
  });

  it('a fail POSTs qcPassed false and reports held (the batch stays in quarantine, recorded)', async () => {
    const calls: { runId: string; qcPassed: boolean }[] = [];
    const s = session(filled(), { releasePort: () => ({ post: async (i) => { calls.push(i); return 'held'; } }) });
    const out = await s.release('r-1', false, 'smelled off');
    expect(out).toBe('held');
    expect(calls[0]!.qcPassed).toBe(false);
  });

  it('refuses without the release permission, before any POST', async () => {
    let posted = false;
    const s = session(filled(), { mayRelease: () => false, releasePort: () => ({ post: async () => { posted = true; return 'released'; } }) });
    expect(await s.release('r-1', true)).toBe('refused');
    expect(posted).toBe(false);
  });

  it('refuses to release when the box was not told who is releasing, before any POST', async () => {
    let posted = false;
    const s = session(filled(), { releasePort: () => ({ post: async () => { posted = true; return 'released'; } }) }, null);
    expect(await s.release('r-1', true)).toBe('refused');
    expect(posted).toBe(false);
  });

  it('refuses a run the box does not hold, or one already released, before any POST', async () => {
    let posted = false;
    const s = session(data({ runs: [run({ runId: 'r-1' }), run({ runId: 'r-done', released: true })] }), {
      releasePort: () => ({ post: async () => { posted = true; return 'released'; } }),
    });
    expect(await s.release('r-nope', true)).toBe('refused');
    expect(await s.release('r-done', true)).toBe('refused');
    expect(posted).toBe(false);
  });

  it('surfaces a lost link honestly (P-08), not a false released', async () => {
    const s = session(filled(), { releasePort: () => ({ post: async () => 'lost_link' as ReleaseResult }) });
    const out = await s.release('r-1', true);
    expect(out).toBe('lost_link');
    expect(s.presentReleaseResult('en', out).needsAttention).toBe(true);
  });

  it('presents each outcome as one glanceable status', () => {
    const s = session(filled());
    expect(s.presentReleaseResult('en', 'released').tone).toBe('ok');
    expect(s.presentReleaseResult('en', 'held').tone).toBe('degraded');
    expect(s.presentReleaseResult('en', 'refused').tone).toBe('error');
    expect(s.presentReleaseResult('en', 'lost_link').tone).toBe('degraded');
  });
});
