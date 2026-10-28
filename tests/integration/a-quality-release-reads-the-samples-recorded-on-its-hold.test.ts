import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';

/**
 * **Round 6 · M10-FR-02 "sampling" — each quality sample is recorded on the hold, and the release reads them.**
 *
 * Before this round a release carried its own samples in its body — the QC's word, judged and forgotten. Now:
 *   • each sample (what was tested, pass / fail / pending, who took it, when, who recorded it) is its own append-only
 *     fact, retained — a pending result is a new version (pending → pass / fail); a final result never changes (409);
 *   • a release is judged on the STORED samples: a failed one refuses it, a pending one refuses it until its result is in;
 *     a release body that sends its own samples is refused (400) — and so is a relayed one from the store (422);
 *   • the store computer's held-batches feed carries each hold's samples to the facilities screen;
 *   • everything survives a cold restart. In memory and on real PostgreSQL. Synthetic data only.
 */

const A = randomUUID(); // a fresh shop per run — the PostgreSQL database outlives the run
const backings = r3OpsBackings();

describe.each(backings)('a quality release reads the samples recorded on its hold — on $name (M10-FR-02)', ({ harness, restart }) => {
  it('records, versions and retains samples; refuses a release on a failed or pending one; reads them after a restart', async () => {
    let h: ApiHarness = harness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-qc', 'store_manager');
    await h.provisionRole(A, 'u-cash', 'cashier');
    const { req, ok, code } = tenantClient(() => h, A);
    const sample = (batchId: string, sampleId: string, body: unknown, userId = 'u-owner') => req('POST', `/v1/quality/holds/${batchId}/samples/${sampleId}`, body, userId);
    const release = (batchId: string, body: unknown = {}) => req('POST', `/v1/quality/holds/${batchId}/release`, body, 'u-qc');

    for (const b of ['B-1', 'B-2']) await ok(req('POST', `/v1/quality/holds/${b}`, { productId: 'p-paneer', reason: 'routine listeria sampling' }), `hold ${b}`);

    // A sample recorded: who took it, when, what — 201; the same again is one fact (200, alreadyRecorded).
    const s1 = await sample('B-1', 'S-1', { test: 'listeria', result: 'pending', takenAt: '2026-10-27T08:00:00.000Z' });
    expect(s1.status).toBe(201);
    expect(s1.body).toMatchObject({ sample: { sampleId: 'S-1', batchId: 'B-1', test: 'listeria', result: 'pending', takenBy: 'u-owner', takenAt: '2026-10-27T08:00:00.000Z', recordedBy: 'u-owner', version: 1 } });
    expect((await sample('B-1', 'S-1', { test: 'listeria', result: 'pending' })).body).toMatchObject({ alreadyRecorded: true });

    // PENDING refuses the release, on the stored sample — the body sends nothing.
    const waiting = await release('B-1');
    expect([waiting.status, code(waiting)]).toEqual([422, 'sample_pending']);
    // A release that types its own samples is refused — samples live on the hold.
    const typed = await release('B-1', { samples: [{ sampleId: 'X', batchId: 'B-1', takenBy: 'u-qc', takenAt: '2026-10-27T08:00:00.000Z', test: 'listeria', result: 'pass' }] });
    expect([typed.status, code(typed)]).toEqual([400, 'samples_are_recorded_on_the_hold']);

    h = restart(h); // ── COLD RESTART ─────────────────────────────────────────────────────────────────────────────────────

    // The result comes back: a NEW version (pending → pass), taken by the same person; both versions are kept.
    const passed = await sample('B-1', 'S-1', { result: 'pass', notes: 'lab report LR-0001' }, 'u-qc');
    expect(passed.status).toBe(200);
    expect(passed.body).toMatchObject({ sample: { result: 'pass', takenBy: 'u-owner', recordedBy: 'u-qc', version: 2, notes: 'lab report LR-0001' } });
    const read = (await req('GET', '/v1/quality/holds/B-1/samples')).body as { samples: { result: string }[]; history: { result: string; version: number }[] };
    expect(read.samples.map((s) => s.result)).toEqual(['pass']);
    expect(read.history.map((v) => `${v.version}:${v.result}`)).toEqual(['1:pending', '2:pass']);
    // A final result never changes.
    const flip = await sample('B-1', 'S-1', { result: 'fail' });
    expect([flip.status, code(flip)]).toEqual([409, 'sample_result_final']);

    // B-2: a FAILED sample refuses its release; a re-test passing beside it does not undo the failure.
    await ok(sample('B-2', 'S-2', { test: 'coliform', result: 'fail' }), 'fail');
    await ok(sample('B-2', 'S-3', { test: 'coliform', result: 'pass' }), 're-test');
    const failed = await release('B-2');
    expect([failed.status, code(failed)]).toEqual([422, 'sample_failed']);
    expect(((await req('GET', '/v1/quality/holds/B-2')).body as { hold: { status: string } }).hold.status).toBe('held');

    // The store computer's feed carries each held batch's samples to the facilities screen.
    await h.provisionRole(A, 'u-box', 'store_computer', ['S1']);
    const feedRes = await req('GET', '/v1/quality/holds-for-release', undefined, 'u-box');
    expect(feedRes.status, JSON.stringify(feedRes.body)).toBe(200);
    const feed = feedRes.body as { holds: { batchId: string; samples: { sampleId: string; result: string }[] }[] };
    expect(feed.holds.find((x) => x.batchId === 'B-2')?.samples.map((s) => `${s.sampleId}:${s.result}`)).toEqual(['S-2:fail', 'S-3:pass']);
    // A relayed release that carries its own samples is refused by name (kept at the store).
    const relayed = await req('POST', '/v1/quality/holds/B-2/release/synced', { batchId: 'B-2', releasedBy: 'u-qc', at: '2026-10-27T09:00:00.000Z', samples: [{ result: 'pass' }] }, 'u-box');
    expect([relayed.status, code(relayed)]).toEqual([422, 'samples_are_recorded_on_the_hold']);
    // …and one without is judged on the stored failure.
    const relayedFail = await req('POST', '/v1/quality/holds/B-2/release/synced', { batchId: 'B-2', releasedBy: 'u-qc', at: '2026-10-27T09:00:00.000Z' }, 'u-box');
    expect([relayedFail.status, code(relayedFail)]).toEqual([422, 'sample_failed']);

    // B-1 now releases: its one sample passed. The release says which samples it was judged on.
    const released = await release('B-1');
    expect(released.status).toBe(200);
    expect((released.body as { samples: { sampleId: string; result: string }[] }).samples).toMatchObject([{ sampleId: 'S-1', result: 'pass' }]);
    // A released hold takes no more samples.
    expect(code(await sample('B-1', 'S-9', { test: 'listeria', result: 'pass' }))).toBe('not_held');

    // Errors and authority: unreadable → 400; unknown hold → 404; a cashier may not record a sample → 403.
    expect(code(await sample('B-2', 'S-4', { test: 'listeria', result: 'maybe' }))).toBe('not_readable_as_a_quality_sample');
    expect(code(await sample('B-2', 'S-4', { result: 'pass' }))).toBe('not_readable_as_a_quality_sample');
    expect((await sample('GHOST', 'S-1', { test: 'listeria', result: 'pass' })).status).toBe(404);
    expect((await sample('B-2', 'S-5', { test: 'listeria', result: 'pass' }, 'u-cash')).status).toBe(403);
  });
});
