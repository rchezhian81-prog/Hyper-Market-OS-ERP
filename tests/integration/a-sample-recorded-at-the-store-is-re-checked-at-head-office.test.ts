import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';

/**
 * **M10-FR-02 "Offline (§31): evidence captured offline; queued" — head office's synced sample route.**
 *
 * A quality sample recorded at the store with the line down reaches head office under the store computer's narrow
 * `quality.sample.record.sync` right. Head office trusts only the fact and re-checks everything else on its own records:
 *   • the PERSON named must hold `quality.hold.manage` from their own grants (unknown or without it → 422, kept at the store);
 *   • the hold must be one head office placed, still held, and the SAME hold the store saw — a batch head office already
 *     released, or released and held again since, is a conflict refused by name (hard rule #10, never last-write-wins);
 *   • a final result never changes and a re-test is a new id; the same result again is ONE sample (200);
 *   • a release decided on a store sample that has not arrived yet is 425 (kept and sent again), never refused for want of it;
 *     once the sample is on the hold, it releases — judged on head office's own record of the result.
 * The store computer cannot use the direct sample route, and a person cannot use the relay. In memory and on real
 * PostgreSQL. Synthetic data only (hard rule #7).
 */

const backings = r3OpsBackings();

describe.each(backings)('a sample recorded at the store is re-checked at head office — on $name (M10-FR-02)', ({ harness, restart }) => {
  it('re-checks the recorder and the hold, refuses conflicts by name, books a sample once, and holds a release until its sample arrives', async () => {
    const T = randomUUID();
    let h: ApiHarness = harness();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    await h.provisionRole(T, 'u-qc', 'store_manager', ['S1']);
    await h.provisionRole(T, 'u-cash', 'cashier', ['S1']);
    const { req, ok, code } = tenantClient(() => h, T);
    for (const b of ['B-1', 'B-2', 'B-3']) await ok(req('POST', `/v1/quality/holds/${b}`, { productId: 'CURD', reason: 'chiller ran warm' }), `hold ${b}`);
    const heldAt = async (b: string) => ((await req('GET', `/v1/quality/holds/${b}`)).body as { hold: { heldAt: string } }).hold.heldAt;
    const at = '2026-10-31T08:00:00.000Z';
    const body = async (batchId: string, sampleId: string, extra: Record<string, unknown> = {}) => ({
      batchId, sampleId, holdHeldAt: await heldAt(batchId), storeId: 'S1', test: 'probe and smell', result: 'pass', takenAt: at, recordedBy: 'u-qc', at, source: 'facilities-screen', ...extra,
    });
    const relay = async (batchId: string, sampleId: string, extra: Record<string, unknown> = {}, userId = 'u-box') =>
      req('POST', `/v1/quality/holds/${batchId}/samples/${sampleId}/synced`, await body(batchId, sampleId, extra), userId);
    const release = (batchId: string, extra: Record<string, unknown> = {}) =>
      req('POST', `/v1/quality/holds/${batchId}/release/synced`, { batchId, storeId: 'S1', releasedBy: 'u-qc', at, notes: 'checked', source: 'facilities-screen', ...extra }, 'u-box');
    const samplesOf = async (b: string) => ((await req('GET', `/v1/quality/holds/${b}/samples`)).body as { samples: { sampleId: string; result: string; recordedBy: string; takenBy: string; version: number }[] }).samples;

    // Doors: a person cannot use the store's relay; the store computer cannot use the direct sample route.
    expect((await relay('B-1', 's-1', {}, 'u-qc')).status).toBe(403);
    expect((await req('POST', '/v1/quality/holds/B-1/samples/s-1', { test: 'x', result: 'pass' }, 'u-box')).status).toBe(403);
    // Unreadable → 400 (dead-lettered at the store by name).
    const bad = await relay('B-1', 's-1', { result: 'fine' });
    expect([bad.status, code(bad)]).toEqual([400, 'not_readable_as_a_relayed_sample']);
    expect((await relay('B-1', 's-1', { sampleId: 'other' })).status).toBe(400);

    // The person is re-checked from their own grants.
    const cash = await relay('B-1', 's-1', { recordedBy: 'u-cash' });
    expect([cash.status, code(cash)]).toEqual([422, 'recorder_lacks_authority']);
    const ghost = await relay('B-1', 's-1', { recordedBy: 'u-ghost' });
    expect([ghost.status, code(ghost)]).toEqual([422, 'recorder_unknown_at_head_office']);
    expect(await samplesOf('B-1')).toEqual([]);

    // A release resting on a store sample head office does not hold yet waits (425), and the batch stays held.
    const early = await release('B-1', { samplesRecordedHere: [{ sampleId: 's-1', result: 'pass' }] });
    expect([early.status, code(early)]).toEqual([425, 'samples_not_yet_at_head_office']);
    expect((await release('B-1', { samplesRecordedHere: ['s-1'] })).status).toBe(400);

    // Recorded: 202, in the store person's name; the same again is one sample.
    const first = await relay('B-1', 's-1');
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body).toMatchObject({ sample: { sampleId: 's-1', result: 'pass', takenBy: 'u-qc', recordedBy: 'u-qc', recordedAt: at, version: 1 }, relayedBy: 'u-box' });
    expect((await relay('B-1', 's-1')).body).toMatchObject({ alreadyRecorded: true });
    expect(await samplesOf('B-1')).toHaveLength(1);

    h = restart(h); // ── COLD RESTART ──────────────────────────────────────────────────────────────────────────────────────
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']); // the harness keeps a box's store in memory only

    // A final result never changes; another test under the same id is refused — both by name, as 422 (kept at the store).
    const flip = await relay('B-1', 's-1', { result: 'fail' });
    expect([flip.status, code(flip)]).toEqual([422, 'sample_result_final']);
    const other = await relay('B-1', 's-1', { test: 'coliform' });
    expect([other.status, code(other)]).toEqual([422, 'sample_is_another_test']);

    // Pending at head office, the store's PASS still on its way: the release waits; once it arrives, it releases.
    await ok(relay('B-2', 's-2', { result: 'pending', test: 'listeria' }), 'pending');
    const stillPending = await release('B-2', { samplesRecordedHere: [{ sampleId: 's-2', result: 'pass' }] });
    expect([stillPending.status, code(stillPending)]).toEqual([425, 'samples_not_yet_at_head_office']);
    const passed = await relay('B-2', 's-2', { result: 'pass', test: 'listeria', at: '2026-10-31T08:30:00.000Z' });
    expect(passed.body).toMatchObject({ sample: { result: 'pass', version: 2 } });

    // B-1 releases on its sample, judged on head office's record of it.
    const released = await release('B-1', { samplesRecordedHere: [{ sampleId: 's-1', result: 'pass' }] });
    expect(released.status, JSON.stringify(released.body)).toBe(202);
    expect((await release('B-2', { samplesRecordedHere: [{ sampleId: 's-2', result: 'pass' }] })).status).toBe(202);

    // Hard rule #10: a sample recorded at the store on a batch head office has since released is a conflict, said by name.
    const late = await relay('B-1', 's-9', { result: 'fail', holdHeldAt: (await body('B-1', 's-9'))['holdHeldAt'] });
    expect([late.status, code(late)]).toEqual([422, 'batch_no_longer_held']);
    expect((late.body as { error: { whatHappened: string } }).error.whatHappened).toContain('already released by u-qc');
    // …but the sample it already holds, sent again after the release, is still the one sample (a lost reply, resent).
    expect((await relay('B-1', 's-1')).body).toMatchObject({ alreadyRecorded: true });

    // A sample taken on a hold head office has since released and placed again is not the hold in force.
    const oldHold = await heldAt('B-3');
    await ok(req('POST', '/v1/quality/holds/B-3/samples/s-3', { test: 'probe', result: 'pass' }), 'B-3 sample');
    await ok(req('POST', '/v1/quality/holds/B-3/release', {}), 'B-3 release');
    await new Promise((r) => setTimeout(r, 5));
    await ok(req('POST', '/v1/quality/holds/B-3', { productId: 'CURD', reason: 'held again' }), 'B-3 re-hold');
    expect(await heldAt('B-3')).not.toBe(oldHold);
    const stale = await req('POST', '/v1/quality/holds/B-3/samples/s-4/synced', { ...(await body('B-3', 's-4')), holdHeldAt: oldHold }, 'u-box');
    expect([stale.status, code(stale)]).toEqual([422, 'hold_changed_since']);
    const noHold = await req('POST', '/v1/quality/holds/B-404/samples/s-1/synced', { ...(await body('B-3', 's-1')), batchId: 'B-404' }, 'u-box');
    expect([noHold.status, code(noHold)]).toEqual([422, 'no_hold_on_record']);
    expect(await samplesOf('B-3')).toEqual([]);
  }, 60_000);
});
