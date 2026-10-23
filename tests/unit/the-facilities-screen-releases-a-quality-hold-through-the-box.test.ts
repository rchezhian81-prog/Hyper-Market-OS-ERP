import { describe, it, expect } from 'vitest';
import { createQualityReleaseQueue, QUALITY_RELEASE_COPY, QUALITY_HOLD_RELEASE_DECIDED, type HeldQualityHolds, type CopyKey } from '../../apps/web-erp/src/quality-release-queue';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { bilingualGaps } from '../../packages/ui/src/index';
import { RELAYABLE_DEVICE_EVENTS } from '../../packages/sync/src/device-relay';
import { EVENT_ROUTES } from '../../edge/sync-agent/src/http-transport';
import { ROLE_CATALOGUE, STORE_COMPUTER_ROLE_ID } from '../../services/api/src/roles';
import { qualityHoldWork } from '../../edge/store-edge/src/store-work';

// OB-333 (owner, 23 Oct 2026): a quality-hold RELEASE at the store with the line down — the facilities screen's queue,
// the box's relay allow-list and the store computer's narrow right. The box can never place a hold.

const held: HeldQualityHolds = { asAt: '2026-10-23T05:00:00.000Z', ageMinutes: 30, holds: [
  { batchId: 'B-1', productId: 'CURD', reason: 'chiller ran warm', heldAt: '2026-10-23T04:00:00.000Z' },
  { batchId: 'B-2', productId: 'PANEER', reason: 'supplier notice', heldAt: '2026-10-23T04:00:00.000Z', releasedOnThisBox: true },
] };
const queue = (permissions: readonly string[], over: { userId?: string | null; storeId?: string | null } = {}, outbox = new SyncOutbox()) =>
  ({ outbox, q: createQualityReleaseQueue({ userId: over.userId === undefined ? 'u-qc' : over.userId, storeId: over.storeId === undefined ? 'S1' : over.storeId, permissions, now: () => '2026-10-23T06:00:00.000Z' }, held, outbox) });

describe('the facilities screen\'s quality-hold releases (OB-333)', () => {
  it('copy has no gap in either language', () => {
    const gaps = bilingualGaps(QUALITY_RELEASE_COPY, Object.keys(QUALITY_RELEASE_COPY.en) as CopyKey[]);
    expect(gaps).toEqual({ en: [], ta: [] });
  });

  it('lists the held batches, with a batch the box already holds a release of shown as released; only the release right may release', () => {
    const { q } = queue(['quality.hold.release']);
    expect(q.view('en').rows.map((r) => [r.batchId, r.state, r.canRelease])).toEqual([['B-1', 'held', true], ['B-2', 'released_here', false]]);
    expect(queue(['facilities.task.record']).q.view('en').rows.every((r) => !r.canRelease)).toBe(true);
    expect(createQualityReleaseQueue({ userId: 'u', storeId: 'S1', permissions: [], now: () => 'x' }, null, new SyncOutbox()).view('ta')).toMatchObject({ known: false, rows: [] });
  });

  it('refuses, in words, before anything is saved: nobody, no store, no right, an unknown batch, nothing written; then queues ONE release in the person\'s name', () => {
    expect(queue(['quality.hold.release'], { userId: null }).q.release('en', { batchId: 'B-1', notes: 'x' })).toMatchObject({ ok: false, code: 'nobody' });
    expect(queue(['quality.hold.release'], { storeId: null }).q.release('en', { batchId: 'B-1', notes: 'x' })).toMatchObject({ ok: false, code: 'no_store' });
    expect(queue([]).q.release('ta', { batchId: 'B-1', notes: 'x' })).toMatchObject({ ok: false, code: 'no_right' });
    const { q, outbox } = queue(['quality.hold.release']);
    expect(q.release('en', { batchId: 'B-9', notes: 'x' })).toMatchObject({ ok: false, code: 'unknown_batch' });
    expect(q.release('en', { batchId: 'B-1', notes: '  ' })).toMatchObject({ ok: false, code: 'notes_required' });
    expect(outbox.all()).toHaveLength(0);
    expect(q.release('en', { batchId: 'B-1', notes: 'probe 3°C' })).toEqual({ ok: true });
    expect(q.release('en', { batchId: 'B-1', notes: 'again' })).toMatchObject({ ok: false, code: 'already_released_here' });
    expect(outbox.all().map((i) => [i.key, i.event.type, i.event.payload])).toEqual([['quality-release:B-1', QUALITY_HOLD_RELEASE_DECIDED, { batchId: 'B-1', storeId: 'S1', releasedBy: 'u-qc', at: '2026-10-23T06:00:00.000Z', notes: 'probe 3°C', source: 'facilities-screen' }]]);
  });

  it('the box relays a release and nothing that places a hold; the store computer holds the release-only right and no hold right', () => {
    expect(RELAYABLE_DEVICE_EVENTS['QualityHoldReleaseDecided']).toEqual({ surfaces: ['manager'] });
    expect(Object.keys(RELAYABLE_DEVICE_EVENTS).filter((t) => /hold/i.test(t) && !/release/i.test(t))).toEqual([]);
    expect(EVENT_ROUTES['QualityHoldReleaseDecided']).toBe('/v1/quality/holds/:batchId/release/synced');
    const box = ROLE_CATALOGUE.find((r) => r.id === STORE_COMPUTER_ROLE_ID)!.permissions;
    expect(box).toContain('quality.hold.release.sync');
    expect(box.filter((p) => p.startsWith('quality.hold.') && p !== 'quality.hold.release.sync')).toEqual([]);
  });

  it('the box marks a batch it holds a release of, unless head office refused it', () => {
    const work = (state: string) => qualityHoldWork({
      now: '2026-10-23T06:00:00.000Z', workFeeds: { 'quality-holds': { receivedAt: held.asAt, feed: { name: 'quality-holds', asAt: held.asAt, body: { holds: held.holds.slice(0, 1) } } } },
      boxQualityReleases: [{ batchId: 'B-1', releasedBy: 'u-qc', at: 'x', state }],
    } as never) as { qualityHolds: { holds: { releasedOnThisBox?: boolean }[] } };
    expect(work('pending').qualityHolds.holds[0]?.releasedOnThisBox).toBe(true);
    expect(work('dead_letter').qualityHolds.holds[0]?.releasedOnThisBox).toBeUndefined();
  });
});
