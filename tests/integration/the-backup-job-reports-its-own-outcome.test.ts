import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, readdirSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **PA-12 (round 6) — the REAL backup job reports its own outcome, success AND failure, and a backup that never reports
 * is raised as MISSED by itself (M35-FR-01/03/04 · §32 · P-08 no silent failure · hard rule #4).**
 *
 * Before, backup health rested on a record somebody posted by hand: the job never said anything. Here the REAL job —
 * `infra/pilot/backup/encrypted-backup.sh` itself, running `scripts/backup.mjs` (pg_dump from one snapshot), REAL `age`
 * encryption to a recipient key made for this run, and `scripts/report-backup.mjs` — talks over HTTP to the REAL API
 * (`startApi`) on REAL PostgreSQL, signed in as its OWN machine identity (role `backup_job`, granted by two people the
 * way the product grants roles), with the sign-in handed to it in its environment exactly as the operator's
 * EnvironmentFile would (the token is built at run time by the test identity provider; nothing is in the repo).
 *   • a good night: head office keeps what the job MEASURED — start and end, the encrypted file's size and sha256 (equal
 *     to the bytes on disk), encrypted, and the off-site copy confirmed by the operator's copy step;
 *   • a failed night: the job reports ITSELF as failed, naming the step; the ops-alert worker raises it to its named
 *     owner with nobody pressing anything;
 *   • without its sign-in, or with a forged one, the job fails loudly — NOT REPORTED — and nothing is recorded;
 *   • the job's identity can do nothing else; a cashier cannot report a backup;
 *   • a backup that never reports by its expected time is raised as MISSED by itself — never-reported and overdue.
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['backup', 'job', 'reports', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const PRIYA = 'u-hr';
const JOB = 'u-backup-job';
const SCRIPT = resolve('infra/pilot/backup/encrypted-backup.sh');
const RULES = (maxAge?: number) => ({
  rules: [{ alertId: 'backup', component: 'backup', firesAt: 'degraded', ownerUserId: PRIYA, ownerName: 'Priya (store manager)', ackWithinMinutes: 15, escalatesToUserId: OWNER }],
  ...(maxAge === undefined ? {} : { backupMaxAgeSeconds: maxAge }),
});

interface Live { alert: { alertId: string; ownerUserId: string; detail: string; status: string }; state: string; occurrence: number }
interface BackupSeen { backupId: string; at: string; endedAt?: string; ok: boolean; encrypted: boolean; offsite: boolean; sizeBytes?: number; checksum?: string; detail?: string; recordedBy: string }

describe.skipIf(!DATABASE_URL)('PA-12 r6 — the backup job reports its own outcome; silence is MISSED — real job, real API, real PostgreSQL', () => {
  const clouds: RealCloud[] = [];
  const dirs: string[] = [];
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { for (const c of clouds) await c.stop(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  const boot = async (): Promise<RealCloud> => {
    const c = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY, providers: { opsAlertWorkerIntervalMs: 50 } });
    clouds.push(c);
    return c;
  };
  const callAs = (cloud: RealCloud) => (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }) });
  const passes = async (cloud: RealCloud, n = 2): Promise<void> => {
    const target = cloud.opsAlertWorker!.total() + n;
    for (let i = 0; i < 400 && cloud.opsAlertWorker!.total() < target; i += 1) await sleep(10);
    expect(cloud.opsAlertWorker!.total()).toBeGreaterThanOrEqual(target);
  };
  const lastBackup = async (cloud: RealCloud): Promise<BackupSeen | null> =>
    ((await callAs(cloud)('GET', '/v1/platform/operational-health/observed', OWNER)).body as { observed: { lastBackup: BackupSeen | null } }).observed.lastBackup;
  const backupComponent = async (cloud: RealCloud): Promise<{ status: string; detail: string }> =>
    ((await callAs(cloud)('GET', '/v1/platform/operational-health/observed', OWNER)).body as { health: { components: { name: string; status: string; detail: string }[] } })
      .health.components.find((c) => c.name === 'backup')!;
  const inbox = async (cloud: RealCloud, who: string): Promise<Live[]> => ((await callAs(cloud)('GET', '/v1/platform/alerts/inbox', who)).body as { alerts: Live[] }).alerts;

  /** The box's folders, made for this run: a recipient key (the private half stays here, "with the owner"), the
   *  database settings file, the backup folder and an off-site folder the operator's copy step copies into. */
  function box(dbName: string) {
    const dir = mkdtempSync(join(tmpdir(), 'sre-backup-job-'));
    dirs.push(dir);
    execFileSync('age-keygen', ['-o', join(dir, 'owner.key')], { stdio: 'ignore' });
    writeFileSync(join(dir, 'recipient.txt'), `${execFileSync('age-keygen', ['-y', join(dir, 'owner.key')]).toString().trim()}\n`);
    const db = new URL(DATABASE_URL!);
    writeFileSync(join(dir, 'env.pilot'), [`POSTGRES_USER=${decodeURIComponent(db.username)}`, `POSTGRES_PORT=${db.port || '5432'}`, `POSTGRES_DB=${dbName}`, `POSTGRES_PASSWORD=${decodeURIComponent(db.password)}`].join('\n') + '\n');
    mkdirSync(join(dir, 'offsite'));
    writeFileSync(join(dir, 'offsite.sh'), `#!/usr/bin/env bash\nset -e\ncp "$1" "${join(dir, 'offsite')}/"\n`);
    chmodSync(join(dir, 'offsite.sh'), 0o755);
    return dir;
  }
  function runJob(dir: string, reporter: { url?: string; token?: string }, offsite = true) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'], HOME: process.env['HOME'],
      SRE_BACKUP_REPO: resolve('.'), SRE_BACKUP_ENV_FILE: join(dir, 'env.pilot'), SRE_BACKUP_OUT: join(dir, 'backups'), SRE_BACKUP_RECIPIENT: join(dir, 'recipient.txt'),
      ...(offsite ? { SRE_BACKUP_OFFSITE_CMD: join(dir, 'offsite.sh') } : {}),
      ...(reporter.url === undefined ? {} : { SRE_BACKUP_REPORT_API_URL: reporter.url }),
      ...(reporter.token === undefined ? {} : { SRE_BACKUP_REPORT_TOKEN: reporter.token }),
    };
    // Asynchronously: the API answering the job runs in THIS process, so the test must not block its event loop.
    return new Promise<{ status: number | null; out: string; err: string }>((done) => {
      const child = spawn('bash', [SCRIPT], { env, timeout: 120_000 });
      let out = ''; let err = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      child.on('close', (status) => done({ status, out, err }));
    });
  }
  const dbName = (): string => new URL(DATABASE_URL!).pathname.slice(1);

  it('a GOOD night: the real job reports what it measured — size and sha256 of the encrypted file, encrypted, off-site confirmed', async () => {
    const cloud = await boot();
    await cloud.grant(JOB, 'backup_job');
    expect((await callAs(cloud)('PUT', '/v1/platform/alert-rules', OWNER, RULES())).status).toBe(200);
    const dir = box(dbName());

    const run = await runJob(dir, { url: cloud.baseUrl, token: cloud.token(JOB) });
    expect(run.err).not.toMatch(/NOT REPORTED/);
    expect(run.status, run.err).toBe(0);
    expect(run.out).toMatch(/reported\s+bk-.*completed — counts as a good backup/);
    expect(run.out + run.err).not.toContain(cloud.token(JOB).split('.')[2]!); // the sign-in is never printed

    const kept = readdirSync(join(dir, 'backups')).find((f) => f.endsWith('.dump.age'))!;
    const file = join(dir, 'backups', kept);
    const seen = (await lastBackup(cloud))!;
    expect(seen).toMatchObject({
      backupId: kept.replace(/\.dump\.age$/, ''), ok: true, encrypted: true, offsite: true, recordedBy: JOB,
      sizeBytes: statSync(file).size,
      checksum: `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`,
    });
    expect(Date.parse(seen.endedAt!)).toBeGreaterThanOrEqual(Date.parse(seen.at));
    expect(readdirSync(join(dir, 'offsite'))).toEqual([kept]);           // the operator's copy step really copied it
    expect(readFileSync(file).subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect((await backupComponent(cloud)).status).toBe('ok');
    await passes(cloud);
    expect(await inbox(cloud, PRIYA)).toEqual([]);
  }, 120_000);

  it('a FAILED night reports itself as failed, naming the step — and the worker raises it to Priya with nobody pressing anything', async () => {
    const cloud = await boot();
    await cloud.grant(JOB, 'backup_job');
    expect((await callAs(cloud)('PUT', '/v1/platform/alert-rules', OWNER, RULES())).status).toBe(200);
    const dir = box(`no_such_db_${Date.now()}`); // pg_dump cannot reach the database: the night fails

    const run = await runJob(dir, { url: cloud.baseUrl, token: cloud.token(JOB) });
    expect(run.status).not.toBe(0);
    expect(run.out).toMatch(/reported\s+bk-run-.*FAILED — does not count: it did not complete/);
    const seen = (await lastBackup(cloud))!;
    expect(seen).toMatchObject({ ok: false, recordedBy: JOB });
    expect(seen.detail).toMatch(/the backup job failed: exited \d+ while taking the database dump/);
    expect(readdirSync(join(dir, 'backups'))).toEqual([]);                // nothing half-made was kept

    await passes(cloud);
    const mine = await inbox(cloud, PRIYA);
    expect(mine).toEqual([expect.objectContaining({ state: 'open', alert: expect.objectContaining({ alertId: 'backup', ownerUserId: PRIYA, status: 'degraded' }) })]);
    expect(mine[0]!.alert.detail).toMatch(/did not complete/);
  }, 120_000);

  it('without its sign-in, or with a forged one, the job fails loudly — NOT REPORTED — and nothing is recorded', async () => {
    const cloud = await boot();
    await cloud.grant(JOB, 'backup_job');
    const failing = box(`no_such_db_${Date.now()}`);
    // No sign-in configured: the failure cannot be reported, says so, and the job still exits non-zero.
    const none = await runJob(failing, {});
    expect(none.status).not.toBe(0);
    expect(none.err).toMatch(/NOT REPORTED — backup bk-run-.* \(FAILED\) could not be reported to head office: SRE_BACKUP_REPORT_API_URL, SRE_BACKUP_REPORT_TOKEN not set/);
    // A forged sign-in (signed with a key head office does not trust): head office refuses it; NOT REPORTED.
    const [h, p] = cloud.token(JOB).split('.');
    const forged = await runJob(failing, { url: cloud.baseUrl, token: `${h}.${p}.${Buffer.from('not-the-signature').toString('base64url')}` });
    expect(forged.status).not.toBe(0);
    expect(forged.err).toMatch(/NOT REPORTED — head office answered 401/);
    // A good night with no sign-in: the backup is taken, but the job FAILS (exit 3) rather than stay quiet.
    const good = await runJob(box(dbName()), {});
    expect(good.status).toBe(3);
    expect(good.err).toMatch(/RED — the backup was taken but head office was NOT told/);
    expect(await lastBackup(cloud)).toBeNull();
  }, 180_000);

  it('the job\'s identity can only report backups, and a cashier cannot report one', async () => {
    const cloud = await boot();
    await cloud.grant(JOB, 'backup_job');
    await cloud.grant('u-cash', 'cashier');
    const call = callAs(cloud);
    const body = { at: new Date().toISOString(), ok: true, encrypted: true, offsite: true };
    expect((await call('POST', '/v1/platform/backups/bk-cashier/taken', 'u-cash', body)).status).toBe(403);
    expect((await call('GET', '/v1/platform/operational-health/observed', JOB)).status).toBe(403);
    expect((await call('POST', '/v1/platform/operational-health/observed/raise', JOB, {})).status).toBe(403);
    expect((await call('PUT', '/v1/platform/alert-rules', JOB, RULES())).status).toBe(403);
    expect((await call('POST', '/v1/platform/backups/bk-job/taken', JOB, { ...body, checksum: 'md5:abc' })).status).toBe(400);
    expect((await call('POST', '/v1/platform/backups/bk-job/taken', JOB, body)).status).toBe(201);
    expect(await lastBackup(cloud)).toMatchObject({ backupId: 'bk-job', recordedBy: JOB });
  }, 60_000);

  it('a backup that never reports by its expected time is raised as MISSED by itself — never reported, then overdue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = Date.parse('2026-10-12T20:00:00.000Z');
    const travel = (minutes: number): void => { vi.setSystemTime(new Date(T0 + minutes * 60_000)); };
    travel(0);
    const cloud = await boot();
    await cloud.grant(JOB, 'backup_job');
    const call = callAs(cloud);
    // A backup is due within an hour of the rules coming into force.
    expect((await call('PUT', '/v1/platform/alert-rules', OWNER, RULES(3600))).status).toBe(200);
    await passes(cloud);
    expect(await inbox(cloud, PRIYA)).toEqual([]);                       // not due yet: nothing to say

    // 61 minutes, and the job has said NOTHING: missed — raised to Priya by the worker on its own.
    travel(61);
    await passes(cloud, 3);
    const missed = await inbox(cloud, PRIYA);
    expect(missed).toEqual([expect.objectContaining({ state: 'open', occurrence: 1, alert: expect.objectContaining({ alertId: 'backup', status: 'down' }) })]);
    expect(missed[0]!.alert.detail).toMatch(/^MISSED — no good backup has reported since backups became expected \(2026-10-12T20:00:00\.000Z\); one was due by 2026-10-12T21:00:00\.000Z/);
    // Redefining the rules does not reset the clock (it is carried from the first version).
    travel(62);
    expect((await call('PUT', '/v1/platform/alert-rules', OWNER, RULES(3600))).status).toBe(200);
    expect((await backupComponent(cloud)).status).toBe('down');

    // The job reports a good backup: the alert clears (kept). An hour later with no further report: MISSED again, new.
    travel(63);
    await passes(cloud);
    expect((await call('POST', '/v1/platform/backups/bk-night-1/taken', JOB, { at: new Date(Date.now()).toISOString(), ok: true, encrypted: true, offsite: true })).status).toBe(201);
    await passes(cloud, 3);
    expect(await inbox(cloud, PRIYA)).toEqual([]);
    travel(63 + 61);
    await passes(cloud, 3);
    const again = await inbox(cloud, PRIYA);
    expect(again).toEqual([expect.objectContaining({ state: 'open', occurrence: 2, alert: expect.objectContaining({ status: 'down' }) })]);
    expect(again[0]!.alert.detail).toMatch(/^MISSED — the next good backup was due by 2026-10-12T22:03:00\.000Z \(the last good one was bk-night-1/);
  }, 60_000);
});
