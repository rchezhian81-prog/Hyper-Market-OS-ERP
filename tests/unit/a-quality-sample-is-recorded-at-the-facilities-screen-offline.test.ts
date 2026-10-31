import { describe, it, expect } from 'vitest';
import {
  createQualityReleaseQueue, QUALITY_RELEASE_COPY, QUALITY_SAMPLE_RECORDED, qualitySampleKeyFor,
  type HeldQualityHolds, type CopyKey,
} from '../../apps/web-erp/src/quality-release-queue';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { bilingualGaps } from '../../packages/ui/src/index';
import { pathFor } from '../../edge/sync-agent/src/http-transport';
import { makeEvent } from '../../packages/contracts/src/event';
import { judgeSample, type StoredQualitySample } from '../../services/inventory/src/quality-hold';
import { qualityHoldWork } from '../../edge/store-edge/src/store-work';
import type { ScreenInput } from '../../edge/store-edge/src/screen-data';

/**
 * M10-FR-02 "Offline (§31): evidence captured offline; queued", with OB-513 (a held food batch needs a recorded sample before
 * release) and OB-333 (the release is decided at the store with the line down). The facilities screen records a SAMPLE on a
 * held batch: saved on the device's durable queue, said plainly as waiting to reach head office, and honoured by the release
 * on this screen exactly as head office will judge it — a pass lets a held food batch go, a failed one never, a pending one
 * waits; one head office refused never counts and shows why. The release carries which store samples it rests on, so head
 * office waits for them. Synthetic data only.
 */

const HELD_AT = '2026-10-31T07:00:00.000Z';
const NOW = '2026-10-31T09:05:00.000Z';
const food = { required: true, because: 'food' as const };
const held = (extra: Partial<HeldQualityHolds['holds'][number]> = {}): HeldQualityHolds => ({
  asAt: '2026-10-31T09:00:00.000Z', ageMinutes: 5,
  holds: [{ batchId: 'B-1', productId: 'CURD', reason: 'chiller ran warm', heldAt: HELD_AT, samples: [], sampleRule: food, ...extra }],
});
let n = 0;
const queue = (h: HeldQualityHolds = held(), permissions = ['quality.hold.manage', 'quality.hold.release'], outbox = new SyncOutbox()) => ({
  outbox,
  q: createQualityReleaseQueue({ userId: 'u-qc', storeId: 'S1', permissions, now: () => NOW, newId: () => `id${(n += 1)}` }, h, outbox),
});
const row = (q: ReturnType<typeof queue>['q'], lang: 'en' | 'ta' = 'en') => q.view(lang).rows[0]!;

describe('the facilities screen records a quality sample with the line down (M10-FR-02 · OB-513)', () => {
  it('every new word is in English and Tamil', () => {
    expect(bilingualGaps(QUALITY_RELEASE_COPY, Object.keys(QUALITY_RELEASE_COPY.en) as CopyKey[])).toEqual({ en: [], ta: [] });
  });

  it('refuses in words: nobody, no right, no test, a result that is not one, a batch not held here — nothing saved', () => {
    const { q, outbox } = queue(held(), ['quality.hold.release']);
    expect(q.recordSample('en', { batchId: 'B-1', test: 'probe', result: 'pass' })).toMatchObject({ ok: false, code: 'no_right', words: expect.stringContaining('may not record a quality sample') });
    expect(row(q).canRecordSample).toBe(false);
    const ok = queue();
    expect(ok.q.recordSample('en', { batchId: 'B-1', test: '  ', result: 'pass' })).toMatchObject({ ok: false, code: 'test_required' });
    expect(ok.q.recordSample('en', { batchId: 'B-1', test: 'probe', result: 'fine' })).toMatchObject({ ok: false, code: 'bad_result' });
    expect(ok.q.recordSample('ta', { batchId: 'B-9', test: 'probe', result: 'pass' })).toMatchObject({ ok: false, code: 'unknown_batch' });
    const nobody = createQualityReleaseQueue({ userId: null, storeId: 'S1', permissions: ['quality.hold.manage'], now: () => NOW }, held(), new SyncOutbox());
    expect(nobody.recordSample('en', { batchId: 'B-1', test: 'probe', result: 'pass' })).toMatchObject({ ok: false, code: 'nobody' });
    expect(outbox.all()).toHaveLength(0);
    expect(ok.outbox.all()).toHaveLength(0);
  });

  it('a recorded sample is saved on the device queue for head office, said plainly, and lets the held food batch be released', () => {
    const { q, outbox } = queue();
    expect(row(q)).toMatchObject({ canRelease: false, canRecordSample: true, blockedWords: expect.stringContaining('No sample is recorded yet') });
    expect(q.release('en', { batchId: 'B-1', notes: 'looked fine' })).toMatchObject({ ok: false, code: 'sample_required' });
    expect(q.recordSample('en', { batchId: 'B-1', test: 'probe and smell', result: 'pass', notes: 'probe 3°C' })).toEqual({ ok: true });
    const [item] = outbox.all();
    expect(item?.key).toBe(qualitySampleKeyFor('B-1', 's-id1', 'pass'));
    expect(item?.event.type).toBe(QUALITY_SAMPLE_RECORDED);
    expect(item?.event.payload).toEqual({
      batchId: 'B-1', sampleId: 's-id1', holdHeldAt: HELD_AT, storeId: 'S1', test: 'probe and smell', result: 'pass',
      takenAt: NOW, recordedBy: 'u-qc', at: NOW, notes: 'probe 3°C', source: 'facilities-screen',
    });
    expect(isRelayable(QUALITY_SAMPLE_RECORDED, 'manager')).toBe(true);
    expect(pathFor(item!.event)).toBe('/v1/quality/holds/B-1/samples/s-id1/synced');
    // The screen says where the sample is, in both languages, and the release is now offered.
    const r = row(q);
    expect(r.samples).toMatchObject([{ sampleId: 's-id1', result: 'pass', resultWord: 'Passed', here: { state: 'saved_here', stateWord: expect.stringContaining('waiting to reach the store computer') } }]);
    expect(row(q, 'ta').samples?.[0]?.here?.stateWord).toContain('இந்தத் திரையில் சேமிக்கப்பட்டது');
    expect(q.text('en', 'qsSaved')).toContain('saved on the store computer');
    expect(r).toMatchObject({ canRelease: true });
    expect(r).not.toHaveProperty('blockedWords');
    // The release goes behind the sample on the same queue and names the store sample it rests on.
    expect(q.release('en', { batchId: 'B-1', notes: 'sample passed' })).toEqual({ ok: true });
    expect(outbox.all().map((i) => i.event.type)).toEqual([QUALITY_SAMPLE_RECORDED, 'QualityHoldReleaseDecided']);
    expect(outbox.all()[1]?.event.payload).toMatchObject({ batchId: 'B-1', releasedBy: 'u-qc', samplesRecordedHere: [{ sampleId: 's-id1', result: 'pass' }] });
    // Once the batch is released here, no more samples are added to it here.
    expect(row(q).canRecordSample).toBe(false);
    expect(q.recordSample('en', { batchId: 'B-1', test: 'x', result: 'pass' })).toMatchObject({ ok: false, code: 'not_held' });
    expect(q.handedKeys()).toEqual([]);
  });

  it('a failed sample here takes the release away; a pending one waits, and its result coming back lets it go', () => {
    const fail = queue();
    expect(fail.q.recordSample('en', { batchId: 'B-1', test: 'coliform', result: 'fail' })).toEqual({ ok: true });
    expect(row(fail.q)).toMatchObject({ canRelease: false, blockedWords: 'A sample failed — this batch cannot be released for sale.' });
    expect(fail.q.release('en', { batchId: 'B-1', notes: 'x' })).toMatchObject({ ok: false, code: 'sample_failed' });

    const wait = queue();
    expect(wait.q.recordSample('en', { batchId: 'B-1', test: 'listeria', result: 'pending' })).toEqual({ ok: true });
    expect(wait.q.release('en', { batchId: 'B-1', notes: 'x' })).toMatchObject({ ok: false, code: 'sample_pending' });
    const pendingId = row(wait.q).samples![0]!.sampleId;
    // The same pending result again is the same sample — nothing new queued.
    expect(wait.q.recordSample('en', { batchId: 'B-1', sampleId: pendingId, result: 'pending' })).toEqual({ ok: true });
    expect(wait.outbox.all()).toHaveLength(1);
    // A different test under that id is refused; the result coming back is a new version of the same sample.
    expect(wait.q.recordSample('en', { batchId: 'B-1', sampleId: pendingId, test: 'coliform', result: 'pass' })).toMatchObject({ ok: false, code: 'sample_is_another_test' });
    expect(wait.q.recordSample('en', { batchId: 'B-1', sampleId: pendingId, result: 'pass' })).toEqual({ ok: true });
    expect(wait.outbox.all().map((i) => (i.event.payload as { result: string }).result)).toEqual(['pending', 'pass']);
    expect(wait.outbox.all()[1]?.event.payload).toMatchObject({ sampleId: pendingId, test: 'listeria', takenAt: NOW });
    expect(row(wait.q).samples).toMatchObject([{ sampleId: pendingId, result: 'pass' }]);
    // A final result never changes here either.
    expect(wait.q.recordSample('en', { batchId: 'B-1', sampleId: pendingId, result: 'fail' })).toMatchObject({ ok: false, code: 'sample_result_final', words: expect.stringContaining('re-test') });
    expect(wait.q.release('en', { batchId: 'B-1', notes: 'listeria clear' })).toEqual({ ok: true });
    expect(wait.outbox.all()[2]?.event.payload).toMatchObject({ samplesRecordedHere: [{ sampleId: pendingId, result: 'pass' }] });
  });

  it('a pending sample at head office is overtaken by its result recorded here; a result head office already holds is head office\'s', () => {
    const ho = { sampleId: 'S-1', test: 'listeria', result: 'pending' as const, takenBy: 'u-owner', takenAt: HELD_AT };
    const { q, outbox } = queue(held({ samples: [ho] }));
    expect(q.recordSample('en', { batchId: 'B-1', sampleId: 'S-1', result: 'pass' })).toEqual({ ok: true });
    expect(outbox.all()[0]?.event.payload).toMatchObject({ sampleId: 'S-1', test: 'listeria', takenAt: HELD_AT });
    expect(row(q).samples).toMatchObject([{ sampleId: 'S-1', result: 'pass', takenBy: 'u-owner', here: { state: 'saved_here' } }]);
    expect(q.release('en', { batchId: 'B-1', notes: 'clear' })).toEqual({ ok: true });
    expect(outbox.all()[1]?.event.payload).toMatchObject({ samplesRecordedHere: [{ sampleId: 'S-1', result: 'pass' }] });

    // Head office's feed already holds the pass: the sample is head office's, nothing is waiting.
    const done = queue(held({ samples: [{ ...ho, result: 'pass' }], samplesOnThisBox: [{ sampleId: 'S-1', test: 'listeria', result: 'pass', takenAt: HELD_AT, recordedBy: 'u-qc', at: NOW, state: 'acknowledged' }] }));
    expect(row(done.q).samples).toEqual([expect.not.objectContaining({ here: expect.anything() })]);
    expect(done.q.release('en', { batchId: 'B-1', notes: 'clear' })).toEqual({ ok: true });
    expect(done.outbox.all()[0]?.event.payload).not.toHaveProperty('samplesRecordedHere');
  });

  it('a sample recorded on another screen of this store computer counts; one head office refused never counts and says why', () => {
    const onBox = { sampleId: 's-other', test: 'probe', result: 'pass', takenAt: NOW, recordedBy: 'u-qc2', at: NOW, key: 'quality-sample:B-1:s-other:pass' };
    const waiting = queue(held({ samplesOnThisBox: [{ ...onBox, state: 'pending', reason: null }] }));
    expect(row(waiting.q)).toMatchObject({ canRelease: true, samples: [{ sampleId: 's-other', here: { state: 'on_box', stateWord: 'Saved on the store computer — waiting to reach head office' } }] });

    const refused = queue(held({ samplesOnThisBox: [{ ...onBox, state: 'dead_letter', reason: 'the cloud answered 422 for QualitySampleRecorded (batch_no_longer_held)' }] }));
    const r = row(refused.q);
    expect(r).toMatchObject({ canRelease: false, blockedWords: expect.stringContaining('No sample is recorded yet') });
    expect(r.samples).toMatchObject([{ sampleId: 's-other', here: { state: 'refused', stateWord: expect.stringContaining('does not count'), reason: expect.stringContaining('batch_no_longer_held') } }]);
    expect(refused.q.release('en', { batchId: 'B-1', notes: 'x' })).toMatchObject({ ok: false, code: 'sample_required' });
  });

  it('the box\'s word on this screen\'s own sample: with the store computer, then recorded at head office, or refused there', () => {
    const outbox = new SyncOutbox();
    const words = new Map();
    const q = createQualityReleaseQueue({ userId: 'u-qc', storeId: 'S1', permissions: ['quality.hold.manage'], now: () => NOW, newId: () => 'k' }, held(), outbox, words);
    q.recordSample('en', { batchId: 'B-1', test: 'probe', result: 'pass' });
    const key = outbox.all()[0]!.key;
    outbox.acknowledge(key);
    expect(q.handedKeys()).toEqual([key]);
    expect(row(q).samples?.[0]?.here?.state).toBe('on_box');
    q.noteBoxStatus([{ key, state: 'posted', attempts: 1 }]);
    expect(row(q).samples?.[0]?.here).toMatchObject({ state: 'at_head_office', stateWord: 'Recorded at head office' });
    q.noteBoxStatus([{ key, state: 'refused', attempts: 1, reason: 'recorder_lacks_authority' }]);
    expect(row(q)).toMatchObject({ canRelease: false, samples: [{ here: { state: 'refused', reason: 'recorder_lacks_authority' } }] });
  });
});

describe('the store computer tells the screen the samples recorded on it, on the hold head office last said', () => {
  it('only samples on the same hold (its heldAt) ride with it; a hold with none is unchanged', () => {
    const feed = { name: 'quality-holds', asAt: NOW, body: { holds: [
      { batchId: 'B-1', productId: 'CURD', reason: 'x', heldAt: HELD_AT },
      { batchId: 'B-2', productId: 'MILK', reason: 'y', heldAt: HELD_AT },
    ] } };
    const sample = (batchId: string, holdHeldAt: string) => ({ batchId, sampleId: 's', holdHeldAt, test: 't', result: 'pass', takenAt: NOW, recordedBy: 'u', at: NOW, state: 'pending', reason: null });
    const out = qualityHoldWork({
      now: NOW, workFeeds: { 'quality-holds': { receivedAt: NOW, feed } },
      boxQualitySamples: [sample('B-1', HELD_AT), sample('B-1', '2026-10-01T00:00:00.000Z')],
    } as unknown as ScreenInput) as { qualityHolds: { holds: Record<string, unknown>[] } };
    expect(out.qualityHolds.holds[0]?.['samplesOnThisBox']).toEqual([sample('B-1', HELD_AT)]);
    expect(out.qualityHolds.holds[1]).not.toHaveProperty('samplesOnThisBox');
  });
});

describe('one sample recording judged against the sample on the hold (shared by head office\'s direct and synced routes)', () => {
  const base = { batchId: 'B', sampleId: 'S', holdHeldAt: 'H', test: 'listeria', takenAt: 'T0', notes: undefined, recordedBy: 'u-qc', recordedAt: 'T1' };
  const stored = (result: StoredQualitySample['result']): StoredQualitySample => ({ ...base, notes: 'n', result, takenBy: 'u-owner', version: 1, recordedBy: 'u-owner', recordedAt: 'T0' });
  it('new → version 1 taken by the recorder; the same result → same; pending → pass is version 2 by the first taker; final and other-test refused', () => {
    expect(judgeSample(undefined, { ...base, result: 'pass' })).toMatchObject({ kind: 'record', sample: { version: 1, takenBy: 'u-qc', takenAt: 'T0', recordedAt: 'T1' } });
    expect(judgeSample(undefined, { ...base, test: undefined, result: 'pass' })).toMatchObject({ kind: 'refuse', code: 'no_test' });
    expect(judgeSample(stored('pending'), { ...base, result: 'pending' })).toMatchObject({ kind: 'same' });
    expect(judgeSample(stored('pending'), { ...base, test: undefined, result: 'pass' })).toMatchObject({ kind: 'record', sample: { version: 2, takenBy: 'u-owner', recordedBy: 'u-qc', notes: 'n' } });
    expect(judgeSample(stored('pass'), { ...base, result: 'fail' })).toMatchObject({ kind: 'refuse', code: 'sample_result_final' });
    expect(judgeSample(stored('pending'), { ...base, test: 'coliform', result: 'pass' })).toMatchObject({ kind: 'refuse', code: 'sample_is_another_test' });
  });
  it('the store\'s device event for a sample has a route; one with no batch has none (dead-lettered by name)', () => {
    const ev = (payload: Record<string, unknown>) => makeEvent({ id: 'k', type: QUALITY_SAMPLE_RECORDED, occurredAt: NOW, idempotencyKey: 'k', source: 't', payload });
    expect(pathFor(ev({ batchId: 'B 1', sampleId: 's/1' }))).toBe('/v1/quality/holds/B%201/samples/s%2F1/synced');
    expect(pathFor(ev({ sampleId: 's' }))).toBeUndefined();
  });
});
