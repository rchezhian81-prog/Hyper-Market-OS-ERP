import { describe, it, expect } from 'vitest';
import { createQualityReleaseQueue, QUALITY_RELEASE_COPY, type HeldQualityHolds, type CopyKey } from '../../apps/web-erp/src/quality-release-queue';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { bilingualGaps } from '../../packages/ui/src/index';
import { currentSamples, type StoredQualitySample } from '../../services/inventory/src/quality-hold';

/**
 * Round 6 · M10-FR-02 — the facilities screen's quality-release list shows the samples recorded on each hold (from head
 * office's feed, through the store computer): each result in words beside an icon; "not told" is said, never shown as
 * "no samples"; a failed or pending sample takes the release away and says why — the same rule head office releases by.
 */

const sample = (sampleId: string, result: 'pass' | 'fail' | 'pending') => ({ sampleId, test: 'listeria', result, takenBy: 'u-qc', takenAt: '2026-10-27T08:00:00.000Z' });
const held: HeldQualityHolds = { asAt: '2026-10-27T09:00:00.000Z', ageMinutes: 5, holds: [
  { batchId: 'B-PASS', productId: 'CURD', reason: 'sampling', heldAt: '2026-10-27T07:00:00.000Z', samples: [sample('S-1', 'pass')] },
  { batchId: 'B-FAIL', productId: 'PANEER', reason: 'sampling', heldAt: '2026-10-27T07:00:00.000Z', samples: [sample('S-2', 'fail'), sample('S-3', 'pass')] },
  { batchId: 'B-WAIT', productId: 'MILK', reason: 'sampling', heldAt: '2026-10-27T07:00:00.000Z', samples: [sample('S-4', 'pending')] },
  { batchId: 'B-NONE', productId: 'GHEE', reason: 'sampling', heldAt: '2026-10-27T07:00:00.000Z', samples: [] },
  { batchId: 'B-OLD', productId: 'BUTTER', reason: 'sampling', heldAt: '2026-10-27T07:00:00.000Z' },
] };
const q = () => createQualityReleaseQueue({ userId: 'u-qc', storeId: 'S1', permissions: ['quality.hold.release'], now: () => '2026-10-27T09:05:00.000Z' }, held, new SyncOutbox());

describe('the release screen shows the samples recorded on each hold (M10-FR-02)', () => {
  it('every new word is in English and Tamil', () => {
    expect(bilingualGaps(QUALITY_RELEASE_COPY, Object.keys(QUALITY_RELEASE_COPY.en) as CopyKey[])).toEqual({ en: [], ta: [] });
  });

  it('each sample with its result in words and an icon; "no samples" and "not told" are different words', () => {
    const rows = new Map(q().view('en').rows.map((r) => [r.batchId, r]));
    expect(rows.get('B-PASS')?.samples).toMatchObject([{ sampleId: 'S-1', resultWord: 'Passed', icon: '✓' }]);
    expect(rows.get('B-FAIL')?.samples?.map((s) => s.resultWord)).toEqual(['Failed', 'Passed']);
    expect(rows.get('B-NONE')).toMatchObject({ samples: [], samplesWords: 'No sample is recorded on this hold.' });
    expect(rows.get('B-OLD')).toMatchObject({ samples: null, samplesWords: 'The store computer was not told this hold\'s samples.' });
    const ta = new Map(q().view('ta').rows.map((r) => [r.batchId, r]));
    expect(ta.get('B-WAIT')?.samples?.[0]?.resultWord).toBe('முடிவுக்குக் காத்திருக்கிறது');
  });

  it('a failed or pending sample takes the release away and says why; a clean one may be released', () => {
    const rows = new Map(q().view('en').rows.map((r) => [r.batchId, r]));
    expect(rows.get('B-PASS')).toMatchObject({ canRelease: true });
    expect(rows.get('B-PASS')).not.toHaveProperty('blockedWords');
    expect(rows.get('B-FAIL')).toMatchObject({ canRelease: false, blockedWords: 'A sample failed — this batch cannot be released for sale.' });
    expect(rows.get('B-WAIT')).toMatchObject({ canRelease: false, blockedWords: expect.stringContaining('has not come back yet') });
    const queue = q();
    expect(queue.release('en', { batchId: 'B-FAIL', notes: 'looked fine' })).toMatchObject({ ok: false, code: 'sample_failed' });
    expect(queue.release('ta', { batchId: 'B-WAIT', notes: 'x' })).toMatchObject({ ok: false, code: 'sample_pending' });
    expect(queue.release('en', { batchId: 'B-PASS', notes: 'sample passed, probe 3°C' })).toEqual({ ok: true });
  });
});

describe('the stored samples fold to one current result per sample, on the hold in force', () => {
  const v = (sampleId: string, version: number, result: StoredQualitySample['result'], holdHeldAt = 'H1'): StoredQualitySample => ({
    sampleId, batchId: 'B', holdHeldAt, version, result, test: 't', takenBy: 'u', takenAt: '2026-10-27T08:00:00.000Z', recordedBy: 'u', recordedAt: `2026-10-27T08:0${version}:00.000Z`,
  });
  it('the latest version wins; a sample from an earlier hold of the same batch is not this hold\'s', () => {
    const now = currentSamples([v('S-1', 1, 'pending'), v('S-1', 2, 'pass'), v('S-2', 1, 'fail', 'H0')], { batchId: 'B', heldAt: 'H1' });
    expect(now.map((s) => `${s.sampleId}:${s.result}`)).toEqual(['S-1:pass']);
  });
});
