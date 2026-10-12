import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { machineIdentityGrantRefusal, machineIdentitySetRefusal } from '../../services/identity/src/machine-identities';

/**
 * **PA-12 round 10 (M35-FR-01 · hard rule #4): the backup job is a MACHINE-ONLY identity.**
 *
 * The backup's outcome is believed only from a grant of `backup_job` (round 7) — but nothing stopped a PERSON's user id
 * from also being granted `backup_job`, and then that person could post "backup good" themselves. Now, on the real API
 * (in memory, and on real PostgreSQL through the production assembly):
 *
 *   • asking for `backup_job` for a user who holds any other role is refused (422 `machine_identity_holds_only_its_role`)
 *     before anybody is asked to approve it — and so is asking for any role for the backup job's identity;
 *   • judged again at APPROVAL: a request made while the user held nothing is refused once they hold a person's role;
 *   • an emergency grant and a joiner/mover change cannot mix it either;
 *   • nothing was granted by any refusal: the person still cannot post a backup outcome (403 `not_the_backup_job`);
 *   • a ledger from before the rule that already mixes them (laid down directly) is not believed at report time.
 */

const OWNER = 'u-owner'; const ASKER = 'u-hr';
const JOB = 'u-backup-job'; const MGR = 'u-mgr'; const LATER = 'u-later';
const CODE = 'machine_identity_holds_only_its_role';

interface Reply { readonly status: number; readonly body: unknown }
type Call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) => Promise<Reply>;
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const backup = { at: new Date().toISOString(), ok: true, encrypted: true, offsite: true };

async function ask(call: Call, grantId: string, userId: string, roleId: string): Promise<Reply> {
  return call('POST', '/v1/identity/grants', ASKER, { grantId, userId, roleId, branchScope: 'all', reason: 'PA-12 round 10 proof' });
}
async function grant(call: Call, grantId: string, userId: string, roleId: string): Promise<void> {
  const asked = await ask(call, grantId, userId, roleId);
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  const approved = await call('POST', `/v1/identity/grants/${grantId}/approve`, OWNER, {});
  expect(approved.status, JSON.stringify(approved.body)).toBe(201);
}

async function machineOnly(call: Call): Promise<void> {
  await grant(call, 'g-job', JOB, 'backup_job');
  await grant(call, 'g-mgr', MGR, 'store_manager');

  // A person (the manager) cannot be given the backup job's role — refused at the request, nothing pending.
  const toPerson = await ask(call, 'g-mgr-job', MGR, 'backup_job');
  expect(toPerson.status, JSON.stringify(toPerson.body)).toBe(422);
  expect(codeOf(toPerson)).toBe(CODE);
  expect((await call('POST', '/v1/identity/grants/g-mgr-job/approve', OWNER, {})).status).toBe(404);
  // …and the backup job's identity cannot be given a person's role.
  const toJob = await ask(call, 'g-job-cash', JOB, 'cashier');
  expect(toJob.status).toBe(422);
  expect(codeOf(toJob)).toBe(CODE);

  // Judged again at approval: asked while u-later held nothing, approved after they became a cashier — refused.
  expect((await ask(call, 'g-later-job', LATER, 'backup_job')).status).toBe(202);
  await grant(call, 'g-later-cash', LATER, 'cashier');
  const late = await call('POST', '/v1/identity/grants/g-later-job/approve', OWNER, {});
  expect(late.status, JSON.stringify(late.body)).toBe(422);
  expect(codeOf(late)).toBe(CODE);

  // An emergency grant cannot do it either (refused before any approval is looked for), nor a joiner/mover change.
  const emergency = await call('POST', '/v1/access/emergency/e-r10', ASKER, { userId: MGR, roleId: 'backup_job', branchScope: 'all', reason: 'the job is down', minutes: 30 });
  expect(emergency.status, JSON.stringify(emergency.body)).toBe(422);
  expect(codeOf(emergency)).toBe(CODE);
  const joiner = await call('POST', '/v1/access/lifecycle/lc-r10', ASKER, { event: 'joiner', userId: 'u-new', reason: 'new hire', grants: [{ userId: 'u-new', roleId: 'cashier', branchScope: 'all' }, { userId: 'u-new', roleId: 'backup_job', branchScope: 'all' }] });
  expect(joiner.status, JSON.stringify(joiner.body)).toBe(422);
  expect(codeOf(joiner)).toBe(CODE);

  // Nothing was granted by any refusal: neither person can post a backup outcome; the job alone still can.
  for (const who of [MGR, LATER]) {
    const hand = await call('POST', `/v1/platform/backups/bk-${who}/taken`, who, backup);
    expect(hand.status, who).toBe(403);
  }
  expect((await call('POST', '/v1/platform/backups/bk-job-r10/taken', JOB, backup)).status).toBe(201);
}

describe('PA-12 round 10 — the rule itself', () => {
  it('backup_job never sits beside another role, either way round; other roles are untouched', () => {
    expect(machineIdentityGrantRefusal('backup_job', [])).toBeUndefined();
    expect(machineIdentityGrantRefusal('backup_job', ['backup_job'])).toBeUndefined();          // a re-grant of itself
    expect(machineIdentityGrantRefusal('backup_job', ['store_manager'])).toMatch(/machine identity that holds nothing else/);
    expect(machineIdentityGrantRefusal('cashier', ['backup_job'])).toMatch(/is the backup_job machine identity/);
    expect(machineIdentityGrantRefusal('cashier', ['store_manager'])).toBeUndefined();
    expect(machineIdentitySetRefusal(['backup_job', 'cashier'])).toBeDefined();
    expect(machineIdentitySetRefusal(['backup_job', 'backup_job'])).toBeUndefined();
    expect(machineIdentitySetRefusal(['cashier', 'store_manager'])).toBeUndefined();
  });
});

describe('PA-12 round 10 — a person is never the backup job (real API, in memory)', () => {
  const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaa0pa12';
  let h: ApiHarness;
  let call: Call;
  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(tenant, OWNER);
    await h.provisionRole(tenant, ASKER, 'store_manager');
    // PA-12 r12: the backup job presents its MACHINE credential (no interactive sign-in evidence), as issued out-of-band.
    call = (method, path, userId, body) => h.request({ method, path, userId, tenantId: tenant, ...(userId === JOB ? { amr: null, authTimeFromNowSeconds: null } : {}), ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }) });
  });
  it('refused at request, at approval, in an emergency and in a joiner change; the person still cannot post a backup', async () => {
    await machineOnly(call);
  });
  it('a ledger from before the rule that already mixes them is not believed when it reports', async () => {
    await h.provisionRole(tenant, 'u-mixed', 'store_manager');
    await h.provisionRole(tenant, 'u-mixed', 'backup_job'); // laid on the ledger directly, as a pre-rule seed could have
    const hand = await call('POST', '/v1/platform/backups/bk-mixed/taken', 'u-mixed', backup);
    expect(hand.status).toBe(403);
    expect(codeOf(hand)).toBe('not_the_backup_job');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('PA-12 round 10 — on real PostgreSQL through the production API assembly', () => {
  let cloud: RealCloud;
  let call: Call;
  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: ['pa12', 'machine', 'key'].join('-').padEnd(48, '0') });
    call = (method, path, userId, body) => cloud.request({ method, path, userId, machine: userId === JOB, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }) });
  }, 120_000);
  afterAll(async () => { await cloud?.stop(); });
  it('refused at request, at approval, in an emergency and in a joiner change; the person still cannot post a backup', async () => {
    await machineOnly(call);
  }, 60_000);
});
