import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { sealedDecision } from '../support/store-seal';
import { recordLoadAs } from '../support/load-record';
import { dayDigestOf } from '../../packages/migration/src/parallel-day-sign';

/**
 * **MG-10 — a parallel-run day is signed by the named reconciler, and never with an unexplained material difference
 * (§34.1 daily parallel controls · R-05 · G10 · hard rules #1 #10).**
 *
 * On the real API, in memory and on PostgreSQL, with a cold restart: the owner writes the terms; the reconciler records
 * the old ERP's totals beside the new system's; the payments difference beyond tolerance stops the signature (by name);
 * a cashier and a stranger are refused; the difference is explained and the day signed; a day entered again with other
 * figures is unsigned again. The screen's path is proven too: the store box relays the day and the signature (sealed for
 * the person it verified); an unsealed one, or one from somebody who is not the reconciler, is KEPT as refused — and the
 * screen's feed carries the signatures, the witness figures and the operator from the stored load record.
 * Synthetic data only.
 */

const backings = r3OpsBackings();
const OWNER = 'u-owner'; const RECON = 'u-recon'; const CASHIER = 'u-cash'; const SYNC = 'u-sync'; const OTHER = 'u-other'; const LOADER = 'u-loader';
const D1 = '2026-10-10'; const D2 = '2026-10-11';
const COMPARISONS = [
  { area: 'sales_value', legacyValue: 10_000_000, newValue: 10_000_000, toleranceMinor: 0 },
  { area: 'payments', legacyValue: 10_000_000, newValue: 9_950_000, toleranceMinor: 100 },
  { area: 'sales_count', legacyValue: 412, newValue: 412, toleranceMinor: 0 },
];
const STATEMENT = 'compared the old day-end report with the new day book, area by area';

describe.each(backings)('a parallel-run day cannot be signed with an unexplained difference — on $name (MG-10)', ({ harness, restart }) => {
  it('refused by name while unexplained → explained → signed; re-recorded with other figures → unsigned again', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, RECON, 'store_manager');
    await h.provisionRole(T, OTHER, 'store_manager');
    await h.provisionRole(T, CASHIER, 'cashier');
    const { req, ok, code } = tenantClient(() => h, T);
    // Before the owner writes the terms there is no run, so nothing can be signed.
    expect(code(await req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: STATEMENT }, RECON))).toBe('parallel_run_not_started');
    // The owner writes the terms (R-05): the named reconciler, the clean days required, the maximum length.
    const policy = await h.request({ method: 'PUT', path: '/v1/migration/parallel-run/policy', userId: OWNER, tenantId: T, idempotencyKey: `pol-${T}`, body: { cutoverId: 'CUT-1', dailyReconcilerUserId: RECON, requiredCleanDays: 2, maxParallelDays: 14, startedOn: D1 } });
    expect(policy.status).toBe(201);
    await ok(req('POST', `/v1/migration/parallel-run/days/${D1}`, { comparisons: COMPARISONS }, RECON), 'record the day');
    expect(code(await req('POST', `/v1/migration/parallel-run/days/${D2}/signature`, { statement: STATEMENT }, RECON))).toBe('day_not_recorded');

    // ── refused while the payments difference has no reason — and the refusal names it ───────────────────────
    const refused = await req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: STATEMENT }, RECON);
    expect(refused.status).toBe(422);
    expect(code(refused)).toBe('unexplained_material_difference');
    expect(JSON.stringify(refused.body)).toMatch(/PD-2026-10-10-001/);
    expect((await req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: STATEMENT }, CASHIER)).status).toBe(403);
    expect(code(await req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: STATEMENT }, OTHER))).toBe('not_the_named_reconciler');
    expect(code(await req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: STATEMENT, signedBy: OWNER }, RECON))).toBe('not_readable_as_a_day_signature');
    // Owning it is not explaining it.
    await ok(req('POST', '/v1/migration/parallel-run/differences/PD-2026-10-10-001/own', {}, RECON), 'own');
    expect(code(await req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: STATEMENT }, RECON))).toBe('unexplained_material_difference');

    h = restart(h); // ── COLD RESTART ─────────────────────────────────────────────────────────────────────────────

    await ok(req('POST', '/v1/migration/parallel-run/differences/PD-2026-10-10-001/own', { explanation: 'a UPI refund of 500 keyed only in the old system', wrongSide: 'legacy' }, RECON), 'explain');
    expect(code(await req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: 'ok' }, RECON))).toBe('statement_says_nothing');
    const signed = await ok(req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: STATEMENT }, RECON), 'sign');
    expect(signed.status).toBe(201);
    expect(signed.body).toMatchObject({ signature: { businessDate: D1, signedBy: RECON, dayDigest: dayDigestOf(COMPARISONS as never), differences: [{ differenceId: 'PD-2026-10-10-001', wrongSide: 'legacy' }] } });
    expect((await req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: STATEMENT }, RECON)).body).toMatchObject({ alreadySigned: true });

    h = restart(h); // ── COLD RESTART ─────────────────────────────────────────────────────────────────────────────

    // The feed carries the signature (still applying); new figures for the day make it unsigned again.
    const feed1 = (await ok(req('GET', '/v1/migration/screen', undefined, OWNER), 'feed')).body as { parallelDaySignatures: { businessDate: string; stillApplies: boolean }[] };
    expect(feed1.parallelDaySignatures).toEqual([expect.objectContaining({ businessDate: D1, stillApplies: true })]);
    await ok(req('POST', `/v1/migration/parallel-run/days/${D1}`, { comparisons: COMPARISONS.map((c) => (c.area === 'sales_count' ? { ...c, newValue: 411 } : c)) }, RECON), 're-record');
    const feed2 = (await ok(req('GET', '/v1/migration/screen', undefined, OWNER), 'feed')).body as { parallelDaySignatures: { stillApplies: boolean }[] };
    expect(feed2.parallelDaySignatures).toEqual([expect.objectContaining({ stillApplies: false })]);
    expect(code(await req('POST', `/v1/migration/parallel-run/days/${D1}/signature`, { statement: STATEMENT }, RECON))).toBe('unexplained_material_difference');
    // The old signature is still in the ledger (hard rule #6).
    expect(await h.store.readStream(T, 'migration', { type: 'ParallelDaySigned' })).toHaveLength(1);
  });

  it('the screen\'s day and signature, relayed by the store box: applied for the reconciler, kept as refused otherwise', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, RECON, 'store_manager');
    await h.provisionRole(T, OTHER, 'store_manager');
    await h.provisionRole(T, LOADER, 'store_manager');
    await h.provisionRole(T, SYNC, 'store_computer', ['S1']);
    const { req, ok } = tenantClient(() => h, T);
    const put = await h.request({ method: 'PUT', path: '/v1/migration/parallel-run/policy', userId: OWNER, tenantId: T, idempotencyKey: `pol-${T}`, body: { cutoverId: 'CUT-1', dailyReconcilerUserId: RECON, requiredCleanDays: 2, maxParallelDays: 14, startedOn: D1 } });
    expect(put.status).toBe(201);
    expect((await recordLoadAs(h, T, LOADER)).status).toBe(201);
    const entered = (over: Record<string, unknown> = {}) => ({ businessDate: D1, enteredBy: RECON, comparisons: COMPARISONS, explanations: [], enteredAt: '2026-10-11T08:00:00.000Z', ...over });

    // A cashier's credential cannot relay; an unsealed day and somebody else's day are KEPT as refused (202).
    expect((await req('POST', `/v1/migration/parallel-run/days/${D1}/synced`, sealedDecision(T, 'MigrationParallelDayEntered', entered()), CASHIER)).status).toBe(403);
    const unsealed = await ok(req('POST', `/v1/migration/parallel-run/days/${D1}/synced`, entered(), SYNC), 'unsealed');
    expect(unsealed.body).toMatchObject({ applied: false, refusedBecause: 'decider_not_verified_at_store' });
    const other = await ok(req('POST', `/v1/migration/parallel-run/days/${D1}/synced`, sealedDecision(T, 'MigrationParallelDayEntered', entered({ enteredBy: OTHER })), SYNC), 'other');
    expect(other.body).toMatchObject({ applied: false, refusedBecause: 'not_the_named_reconciler' });

    // The reconciler's day lands; its signature is refused while the payments difference has no reason.
    const day = await ok(req('POST', `/v1/migration/parallel-run/days/${D1}/synced`, sealedDecision(T, 'MigrationParallelDayEntered', entered()), SYNC), 'day');
    expect(day.body).toMatchObject({ applied: true, explained: [] });
    const signBody = { businessDate: D1, signedBy: RECON, statement: STATEMENT, dayDigest: dayDigestOf(COMPARISONS as never), signedAt: '2026-10-11T08:05:00.000Z' };
    const early = await ok(req('POST', `/v1/migration/parallel-run/days/${D1}/signature/synced`, sealedDecision(T, 'MigrationParallelDaySigned', signBody), SYNC), 'early');
    expect(early.body).toMatchObject({ applied: false, refusedBecause: 'unexplained_material_difference' });

    h = restart(h); // ── COLD RESTART ─────────────────────────────────────────────────────────────────────────────
    await h.provisionRole(T, SYNC, 'store_computer', ['S1']); // the new API's harness learns which store the box's credential is for

    // The same figures again with the reason: the day is not re-recorded, the reason lands; then the signature.
    const explained = await ok(req('POST', `/v1/migration/parallel-run/days/${D1}/synced`, sealedDecision(T, 'MigrationParallelDayEntered', entered({ explanations: [{ area: 'payments', explanation: 'a UPI refund of 500 keyed only in the old system', wrongSide: 'legacy' }] })), SYNC), 'explained');
    expect(explained.body).toMatchObject({ applied: true, explained: ['PD-2026-10-10-001'] });
    expect(await h.store.readStream(T, 'migration', { type: 'ParallelDayCompared' })).toHaveLength(1);
    const stale = await ok(req('POST', `/v1/migration/parallel-run/days/${D1}/signature/synced`, sealedDecision(T, 'MigrationParallelDaySigned', { ...signBody, dayDigest: 'day-not-these-figures' }), SYNC), 'stale');
    expect(stale.body).toMatchObject({ applied: false, refusedBecause: 'day_changed' });
    const signed = await ok(req('POST', `/v1/migration/parallel-run/days/${D1}/signature/synced`, sealedDecision(T, 'MigrationParallelDaySigned', signBody), SYNC), 'signed');
    expect(signed.body).toMatchObject({ applied: true });
    expect((await ok(req('POST', `/v1/migration/parallel-run/days/${D1}/signature/synced`, sealedDecision(T, 'MigrationParallelDaySigned', signBody), SYNC), 'replay')).body).toMatchObject({ applied: true, alreadyApplied: true });

    // The feed: every refused relay is visible; the signature, the witness position and the load operator are there.
    const feed = (await ok(req('GET', '/v1/migration/screen', undefined, OWNER), 'feed')).body as {
      refusedDecisions: { kind: string; refusedBecause: string }[]; parallelDaySignatures: { signedBy: string; stillApplies: boolean }[];
      loadOperator?: string; loadOperatorSource?: string; verification: { findings: unknown[]; missing: string[] }; policy: { dailyReconcilerUserId: string };
    };
    expect(feed.refusedDecisions.map((r) => r.refusedBecause).sort()).toEqual(['day_changed', 'decider_not_verified_at_store', 'not_the_named_reconciler', 'unexplained_material_difference']);
    expect(feed.parallelDaySignatures).toEqual([expect.objectContaining({ signedBy: RECON, stillApplies: true })]);
    expect(feed).toMatchObject({ loadOperator: LOADER, loadOperatorSource: 'load_record', policy: { dailyReconcilerUserId: RECON } });
    expect(feed.verification.findings).toEqual([]);
    expect(feed.verification.missing.length).toBeGreaterThan(0);
  });
});
