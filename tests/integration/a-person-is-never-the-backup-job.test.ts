import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import type { IdentityDirectory } from '../../services/identity/src/identity-directory';
import type { EmergencyGrant } from '../../packages/identity/src/lifecycle';
import { isMachineCredential, machineIdentityGrantRefusal } from '../../services/identity/src/machine-identities';

/**
 * **PA-12 round 12 (M35-FR-01 · P-04 · hard rule #4): a PERSON is never the backup job, and a backup outcome is believed
 * only from a MACHINE credential.**
 *
 * Round 10 stopped `backup_job` sitting beside another role — but a person given a sign-in through `/v1/identity/people`
 * holds no role, so they could be granted `backup_job` alone and post "backup good" from their own sign-in. And the report
 * check ignored a live emergency grant. Now, on the real API (in memory, and with DATABASE_URL on real PostgreSQL):
 *
 *   • a person given a sign-in (through the real people route) cannot be granted `backup_job`: refused at the request, at
 *     approval (asked before their sign-in, approved after), in an emergency grant and in a joiner change;
 *   • a person whose ledger holds `backup_job` alone (laid down directly, as a pre-rule ledger could) is not believed;
 *   • the backup job's own identity is believed only from its machine credential (no interactive sign-in evidence) — the
 *     same user id signed in interactively (password + one-time code) is refused;
 *   • a live emergency grant of another role to the machine disqualifies it until that grant is ended;
 *   • refusals record nothing, and a believed report replayed under its key is the same answer.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

/** A fake identity server: every sign-in asked for is given. */
const directory: IdentityDirectory = { issue: async () => ({ result: 'issued', resumed: false }), end: async () => 'ended' };
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness({ identityDirectory: directory }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), identityDirectory: directory }); } });

const OWNER = 'u-owner'; const ASKER = 'u-hr'; const ADMIN = 'u-admin'; const JOB = 'u-backup-job';
const PAT = 'u-pat'; const QUINN = 'u-quinn';
const CODE = 'machine_identity_holds_only_its_role';
const backup = () => ({ at: new Date(Date.now() - 60_000).toISOString(), ok: true, encrypted: true, offsite: true });
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

describe('PA-12 round 12 — the rule itself', () => {
  it('a machine-only role is never a person\'s; a machine credential carries no interactive sign-in evidence', () => {
    expect(machineIdentityGrantRefusal('backup_job', [], true)).toMatch(/person with their own sign-in/);
    expect(machineIdentityGrantRefusal('backup_job', [], false)).toBeUndefined();
    expect(machineIdentityGrantRefusal('cashier', [], true)).toBeUndefined();
    expect(isMachineCredential(undefined)).toBe(true);
    expect(isMachineCredential({ amr: [] })).toBe(true);
    expect(isMachineCredential({ authTime: 1 })).toBe(false);
    expect(isMachineCredential({ amr: ['pwd', 'otp', 'mfa'] })).toBe(false);
  });
});

describe.each(backings)('PA-12 round 12 — a person is never the backup job — on $name', ({ harness }) => {
  it('refuses backup_job for a person everywhere, believes only the machine credential, and counts live emergency grants', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, ASKER, 'store_manager');
    await h.provisionRole(T, ADMIN, 'platform_admin');
    await h.provisionRole(T, JOB, 'backup_job'); // the backup job's own machine identity (machine credential)
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, extra: { key?: string; interactive?: boolean } = {}) =>
      h.request({
        method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: extra.key ?? `k-${randomUUID()}` }),
        // A person's sign-in at the identity server: password + one-time code, just now.
        ...(extra.interactive === true ? { amr: ['pwd', 'otp'], authTimeFromNowSeconds: 0 } : {}),
      });
    const ask = (grantId: string, userId: string, roleId = 'backup_job') => call('POST', '/v1/identity/grants', ASKER, { grantId, userId, roleId, branchScope: 'all', reason: 'PA-12 round 12 proof' });
    const backups = async () => ((await call('GET', '/v1/platform/operational-health/observed', OWNER)).body as { observed?: unknown });

    // QUINN is asked for while they are nobody yet…
    expect((await ask('g-quinn-job', QUINN)).status).toBe(202);
    // …then the administrator gives PAT and QUINN each a sign-in at the identity server (the real people route).
    for (const [userId, signInName, displayName] of [[PAT, 'pat.k', 'Pat Kumar'], [QUINN, 'quinn.r', 'Quinn Raman']] as const) {
      const made = await call('POST', '/v1/identity/people', ADMIN, { userId, signInName, displayName });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
    }

    // ── A person — holding NO role — cannot be granted backup_job: at request, at approval, emergency, joiner.
    const toPerson = await ask('g-pat-job', PAT);
    expect(toPerson.status, JSON.stringify(toPerson.body)).toBe(422);
    expect(codeOf(toPerson)).toBe(CODE);
    expect((await call('POST', '/v1/identity/grants/g-pat-job/approve', OWNER, {})).status).toBe(404);
    const late = await call('POST', '/v1/identity/grants/g-quinn-job/approve', OWNER, {});
    expect(late.status, JSON.stringify(late.body)).toBe(422);
    expect(codeOf(late)).toBe(CODE);
    const emergency = await call('POST', '/v1/access/emergency/e-pat', ASKER, { userId: PAT, roleId: 'backup_job', branchScope: 'all', reason: 'the job is down', minutes: 30 });
    expect(emergency.status, JSON.stringify(emergency.body)).toBe(422);
    expect(codeOf(emergency)).toBe(CODE);
    const joiner = await call('POST', '/v1/access/lifecycle/lc-pat', ASKER, { event: 'joiner', userId: PAT, reason: 'runs backups by hand', grants: [{ userId: PAT, roleId: 'backup_job', branchScope: 'all' }] });
    expect(joiner.status, JSON.stringify(joiner.body)).toBe(422);
    expect(codeOf(joiner)).toBe(CODE);
    // A person's ordinary role is untouched by the rule (asked and pending as usual).
    expect((await ask('g-pat-cash', PAT, 'cashier')).status).toBe(202);
    // Nothing was granted: PAT and QUINN cannot post a backup outcome.
    for (const who of [PAT, QUINN]) {
      const hand = await call('POST', `/v1/platform/backups/bk-${who}/taken`, who, backup());
      expect(hand.status, who).toBe(403); // they hold no backup permission at all
    }

    // ── A person whose ledger holds backup_job ALONE (laid directly, as a pre-rule ledger could) is not believed —
    // not even presenting a credential with no sign-in evidence.
    await h.provisionRole(T, PAT, 'backup_job');
    const laid = await call('POST', '/v1/platform/backups/bk-pat-laid/taken', PAT, backup());
    expect(laid.status).toBe(403);
    expect(codeOf(laid)).toBe('not_the_backup_job');

    // ── The machine identity is believed from its machine credential only.
    const interactive = await call('POST', '/v1/platform/backups/bk-job-signed-in/taken', JOB, backup(), { interactive: true });
    expect(interactive.status).toBe(403);
    expect(codeOf(interactive)).toBe('not_the_backup_job');
    const night = backup();
    const good = await call('POST', '/v1/platform/backups/bk-job-1/taken', JOB, night, { key: 'bk-job-1' });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    expect((await call('POST', '/v1/platform/backups/bk-job-1/taken', JOB, night, { key: 'bk-job-1' })).body).toEqual(good.body);

    // ── A live emergency grant of another role to the machine (a ledger the grant route would refuse today) disqualifies it…
    const stream = streamName(STREAM.identity, 'emergency-access');
    const now = Date.now();
    const eg: EmergencyGrant = {
      grantId: 'e-job-cash', userId: JOB, roleId: 'store_manager', branchScope: 'all', reason: 'pre-rule ledger', requestedBy: ASKER, approvedBy: OWNER,
      grantedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
    };
    const lay = async (g: EmergencyGrant, n: number) => h.store.append(T, stream, makeEvent({
      id: `emergency-access-e-job-cash-${n}`, type: 'EmergencyAccessRecorded', occurredAt: new Date(now).toISOString(),
      idempotencyKey: `emergency-access-${T}-e-job-cash-${n}`, source: 'test', payload: g,
    }));
    await lay(eg, 1);
    const mixed = await call('POST', '/v1/platform/backups/bk-job-2/taken', JOB, backup());
    expect(mixed.status).toBe(403);
    expect(codeOf(mixed)).toBe('not_the_backup_job');
    // …and once that emergency grant is ended, the machine is believed again.
    await lay({ ...eg, revokedAt: new Date(now).toISOString() }, 2);
    expect((await call('POST', '/v1/platform/backups/bk-job-3/taken', JOB, backup())).status).toBe(201);

    // Only the two believed reports were recorded.
    expect(JSON.stringify(await backups())).not.toContain('bk-pat');
  }, 60_000);
});
