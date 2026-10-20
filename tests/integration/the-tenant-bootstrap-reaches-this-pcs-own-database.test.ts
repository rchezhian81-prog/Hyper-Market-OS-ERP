import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings } from '../support/r3-ops-backings';

/**
 * Gap W-2 (owner guide, Part 15): on the store PC `.env.real` names the database by its compose service name, `db`, which
 * does not exist on the PC itself, so `tenant:bootstrap`'s real run died with `getaddrinfo ENOTFOUND db`. The built
 * command now reaches this computer's own published database port (POSTGRES_PORT) instead — the same translation the demo
 * smoke uses. Run here as the owner runs it: the built tool, a settings file that says `db`, a real PostgreSQL; the first
 * run seeds the first people, the second refuses to widen them. Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
r3OpsBackings(); // runs the migrations on the test database first

describe.skipIf(DATABASE_URL === undefined)('tenant:bootstrap reaches this PC\'s own database from a settings file that names "db" (W-2)', () => {
  let envFile = '';
  beforeAll(async () => {
    execFileSync(process.execPath, ['scripts/build-service.mjs', 'tools', '--quiet'], { stdio: 'ignore' });
    const real = new URL(DATABASE_URL!);
    const compose = new URL(DATABASE_URL!);
    compose.hostname = 'db';
    compose.port = '5432';
    const dir = await mkdtemp(join(tmpdir(), 'sre-w2-'));
    envFile = join(dir, '.env.real');
    await writeFile(envFile, `MIGRATION_TARGET_KIND=rehearsal\nPOSTGRES_PORT=${real.port || '5432'}\nDATABASE_URL=${compose.toString()}\nDEMO_TENANT_IDS=pilot-demo\n`, { mode: 0o600 });
  }, 120_000);

  it('seeds the first people through this PC\'s own database port, then refuses a second bootstrap', () => {
    const tenant = randomUUID();
    const run = () => spawnSync(process.execPath, ['scripts/dist/bootstrap-tenant.js', '--tenant', tenant, '--owner', 'u-owner', '--admin', 'u-ca:chartered_accountant', '--operator', 'Test Owner', '--env-file', envFile], { encoding: 'utf8' });
    const first = run();
    expect(first.stdout, first.stderr).toContain("The database is reached on this computer's own database port");
    expect(first.stdout).toContain('SEEDED — 2 grant(s) recorded in one atomic append.');
    expect(first.stdout).not.toContain('ENOTFOUND');
    expect(first.status).toBe(0);
    const second = run();
    expect(second.stdout).toContain('NOT CHANGED');
    expect(second.status).toBe(1);
  }, 60_000);
});
