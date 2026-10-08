import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { withDeciderSeal } from '../../edge/store-edge/src/decision-seal';
import { tillSealKey } from '../../packages/identity/src/till-seal';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { SyncAgent } from '../../edge/sync-agent/src/agent';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { createMigrationSession, type MigrationPorts, type MigrationConfig } from '../../apps/web-erp/src/migration-session';
import type { MigrationException } from '../../packages/migration/src/cleaning';
import type { ControlTotal } from '../../packages/migration/src/reconcile';

/**
 * **The migration screen's decisions reach the cloud (MG-04 · MG-06 · §31 · hard rule #1) — Stage C3a.**
 *
 * On the night, a named person resolves an exception and signs a control total on the migration screen at
 * the store box. The screen commits each decision locally and QUEUES a `MigrationExceptionResolved` /
 * `MigrationTotalSigned` event. Until this slice those events had NO route: the sync agent dead-lettered
 * them, and the decision existed only on the box. Now the REAL session model queues them, the REAL sync
 * agent + transport relay them under the store's sync token to the cloud's synced decision routes, which
 * re-check the DECIDER's own authority and apply them into the ledger — or record them as refused.
 */

const T = 'ab000000-0000-4000-8000-000000000044';
const AT = '2026-10-10T21:00:00.000Z';
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CA = 'u-ca'; const LOADER = 'u-loader'; const SYNC = 'u-sync';

const EX: MigrationException = { exceptionId: 'EX-1', tenantId: T, kind: 'duplicate_product', severity: 'low', confidence: 'probable', legacyIds: ['L-1', 'L-2'], evidence: 'same name and pack' };
const TOTAL: ControlTotal = { totalId: 'CT-STOCK', tenantId: T, kind: 'stock', name: 'Stock units', unit: 'quantity', legacyValue: 1000, loadedValue: 1000, legacyDerivation: 'SUM(qty) FROM legacy stock', loadedDerivation: 'count of opening movements' };

const post = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string) => h.request({ method: 'GET', path, userId: OWNER, tenantId: T });

async function scene(screenUser: string) {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager');
  await h.provisionRole(T, CA, 'chartered_accountant');
  await h.provisionRole(T, LOADER, 'store_manager');
  await h.provisionRole(T, SYNC, 'cashier'); // the box's sync identity: migration.decision.sync and nothing more
  await h.provisionRole(T, 'u-cash', 'cashier');
  expect((await post(h, '/v1/migration/extraction-runs/run-1', OWNER, 'er1', { operatorId: LOADER })).status).toBe(201);
  expect((await post(h, '/v1/migration/exceptions', MGR, 'x1', { exceptions: [EX] })).status).toBe(201);
  expect((await post(h, '/v1/migration/control-totals', MGR, 't1', { totals: [TOTAL] })).status).toBe(201);

  // The REAL screen session, as the box builds it, over the same exception and total the cloud holds.
  const outbox = new SyncOutbox();
  const ports: MigrationPorts = {
    sources: () => undefined, exceptions: () => [EX], totals: () => [TOTAL], parallelDays: () => undefined, parallelDifferences: () => undefined,
    exclusions: () => undefined, archive: () => undefined, edgeUnsyncedItems: () => outbox.pending().length, deltaAppliedAt: () => undefined,
    rollbackDemonstratedAt: () => undefined, namedTeam: () => undefined, ownerGoBy: () => undefined, openAssessments: () => undefined, outbox: () => outbox,
  };
  const config: MigrationConfig = { tenantId: T, userId: screenUser, now: AT, cutoverId: 'cut-1', requiredCleanDays: 3, loadOperator: LOADER, cutoverAccepted: false };
  const session = createMigrationSession(config, ports);

  const token = TEST_IDP.issue({ sub: SYNC, tenantId: T });
  const apiFetch = (async (url: string, init: RequestInit): Promise<Response> => {
    const hdr = init.headers as Record<string, string>;
    const res = await h.raw({ method: 'POST', path: new URL(url).pathname, token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'], body: JSON.parse(String(init.body)) as unknown });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;
  const transport = httpTransport({ baseUrl: 'https://cloud.example.test', token, fetch: apiFetch, timeoutMs: 5_000 });
  // The store computer between the screen and head office (2b-vi-c-3): it takes the screen's queue and seals each decision for
  // the person signed in at the screen — the box's own function, under the key head office runs with.
  const boxOutbox = new SyncOutbox();
  const relay = () => {
    for (const item of outbox.pending()) {
      if (boxOutbox.find(item.event.idempotencyKey) === undefined) {
        boxOutbox.enqueue(withDeciderSeal(tillSealKey(TEST_PACK_KEY), T, item.event, { userId: screenUser, via: 'verified_sign_in', laneId: 'lane-1' }));
      }
    }
  };
  return { h, session, outbox, drain: () => { relay(); return new SyncAgent(boxOutbox, transport).drain({ at: AT }); } };
}

describe('the migration screen\'s decisions reach the cloud and are applied under the decider (MG-04 / MG-06, §31)', () => {
  it('an owner at the box resolves an exception and signs a total → both delivered, both applied in the ledger', async () => {
    const s = await scene(OWNER);
    expect(s.session.resolve({ exceptionId: 'EX-1', action: 'migrate_as_is', reason: 'both are genuinely sold' }).ok).toBe(true);
    expect(s.session.sign({ totalId: 'CT-STOCK', signerRole: 'owner', statement: 'counted a 40-line sample myself' }).ok).toBe(true);
    expect(s.outbox.pending().map((p) => p.event.type)).toEqual(['MigrationExceptionResolved', 'MigrationTotalSigned']);

    const result = await s.drain();
    expect(result.acknowledged).toBe(2);
    expect(result.deadLettered).toBe(0);

    const ex = (await get(s.h, '/v1/migration/exceptions')).body as { exceptions: { resolution?: { decidedBy: string; action: string } }[]; outstanding: { clearForCutover: boolean } };
    expect(ex.exceptions[0]?.resolution).toMatchObject({ decidedBy: OWNER, action: 'migrate_as_is' });
    const totals = (await get(s.h, '/v1/migration/control-totals')).body as { totals: { signature?: { signedBy: string; signerRole: string } }[]; reconciliation: { qg07Passed: boolean } };
    expect(totals.totals[0]?.signature).toMatchObject({ signedBy: OWNER, signerRole: 'owner' });
    expect(totals.reconciliation.qg07Passed).toBe(true);
    // A re-drain (the box restarts and re-queues) applies nothing twice and dead-letters nothing.
    expect((await s.drain()).deadLettered).toBe(0);
  });

  it('a cashier at the box: the screen lets them decide, the cloud RECORDS both decisions as refused and neither is applied', async () => {
    const s = await scene('u-cash');
    // The screen has no role read of its own — it trusts the box's named user; the cloud does not.
    expect(s.session.resolve({ exceptionId: 'EX-1', action: 'exclude', reason: 'obsolete' }).ok).toBe(true);
    expect(s.session.sign({ totalId: 'CT-STOCK', signerRole: 'owner', statement: 'looks fine' }).ok).toBe(true);
    const result = await s.drain();
    expect(result.acknowledged).toBe(2); // acknowledged so the box stops retrying — but NOT applied
    expect(result.deadLettered).toBe(0);
    const ex = (await get(s.h, '/v1/migration/exceptions')).body as { exceptions: { resolution?: unknown }[]; refusedDecisions: { attemptedBy: string; refusedBecause: string }[] };
    expect(ex.exceptions[0]?.resolution).toBeUndefined();
    expect(ex.refusedDecisions).toEqual([expect.objectContaining({ attemptedBy: 'u-cash', refusedBecause: 'decider_lacks_authority' })]);
    const totals = (await get(s.h, '/v1/migration/control-totals')).body as { totals: { signature?: unknown }[]; refusedDecisions: { attemptedBy: string; refusedBecause: string }[] };
    expect(totals.totals[0]?.signature).toBeUndefined();
    expect(totals.refusedDecisions).toEqual([expect.objectContaining({ attemptedBy: 'u-cash', refusedBecause: 'signer_lacks_authority' })]);
  });
});
