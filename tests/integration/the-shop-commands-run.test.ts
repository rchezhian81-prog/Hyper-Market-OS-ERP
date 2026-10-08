import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { tenantEntitlementResolver } from '../../services/api/src/access';

/**
 * **The shop list and a shop's features, run for real on a real PostgreSQL ledger (OB-15-d-3 · owner decision OB-21 "A").**
 *
 * The built commands a person runs on the server (`pnpm run shop:list`, `pnpm run shop:features`), driven as child
 * processes with an env file. Two shops are made with the new-shop command; then:
 *   • the list shows both, each with its own name, area and address;
 *   • a feature change for ONE shop is recorded in that shop's own history — head office's own entitlement reader sees
 *     it exactly as if its own switch had made it — and the OTHER shop is untouched;
 *   • a dry run writes nothing; a bad request writes nothing and says why; a production box is refused.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const ROOT = process.cwd();

const run = (bundle: string, args: readonly string[]): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv['DATABASE_URL'];
  execFile(process.execPath, [join(ROOT, 'scripts', 'dist', bundle), ...args], { encoding: 'utf8', cwd: ROOT, env: childEnv }, (err, stdout, stderr) => {
    resolve({ code: err === null ? 0 : (typeof err.code === 'number' ? err.code : 1), out: `${stdout}${stderr}` });
  });
});

describe.skipIf(DATABASE_URL === undefined)('the shop list and a shop\'s features, on a real ledger (OB-21)', () => {
  let dir = '';
  let db: Pool;
  const anna = randomUUID();
  const tnagar = randomUUID();
  const env = () => join(dir, 'env');

  beforeAll(async () => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-service.mjs'), 'tools'], { stdio: 'ignore', cwd: ROOT });
    dir = mkdtempSync(join(tmpdir(), 'sre-shops-'));
    writeFileSync(env(), `DATABASE_URL=${DATABASE_URL}\nMIGRATION_TARGET_KIND=rehearsal\n`);
    writeFileSync(join(dir, 'env-prod'), `DATABASE_URL=${DATABASE_URL}\nMIGRATION_TARGET_KIND=production\n`);
    db = new Pool({ connectionString: DATABASE_URL, max: 2 });
    for (const [id, name, realm] of [[anna, 'SRE Anna Nagar Proof', 'sre-anna-proof'], [tnagar, 'SRE T Nagar Proof', 'sre-tnagar-proof']] as const) {
      const made = await run('new-shop.js', ['--tenant', id, '--name', name, '--owner', `u-owner-${id.slice(0, 4)}`, '--operator', 'Test-operator', '--realm', realm, '--origin', 'https://x.example.test', '--env-file', env(), '--out', join(dir, `${realm}.json`)]);
      expect(made.code, made.out).toBe(0);
    }
  }, 120_000);
  afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await db?.end(); });

  it('the list shows each shop with its own name, area and address', async () => {
    const listed = await run('shops.js', ['list', '--env-file', env()]);
    expect(listed.code, listed.out).toBe(0);
    // Other suites register shops in the same database: find OUR two in the list, and print the whole list if not.
    const blockOf = (id: string): string => listed.out.split('\n\n').find((b) => b.includes(id)) ?? `(shop ${id} not listed)\n${listed.out}`;
    expect(blockOf(anna), blockOf(anna)).toMatch(new RegExp(`^SRE Anna Nagar Proof — ${anna}\\n  sign-in area: sre-anna-proof · address: https://x\\.example\\.test`));
    expect(blockOf(tnagar), blockOf(tnagar)).toMatch(new RegExp(`^SRE T Nagar Proof — ${tnagar}\\n  sign-in area: sre-tnagar-proof`));
  });

  it('a change to ONE shop is in that shop\'s own history, read by head office as its own; the other shop is untouched', async () => {
    const dry = await run('shops.js', ['features', '--tenant', anna, '--operator', 'Test-operator', '--on', 'loyalty', '--dry-run', '--env-file', env()]);
    expect(dry.out).toContain('DRY RUN — nothing was written.');
    const resolver = tenantEntitlementResolver(new SqlEventStore(pgPoolClient(db)));
    expect(await resolver(anna)).toEqual([]);

    const changed = await run('shops.js', ['features', '--tenant', anna, '--operator', 'Test-operator', '--on', 'loyalty,delivery', '--env-file', env()]);
    expect(changed.code, changed.out).toBe(0);
    expect(changed.out).toMatch(/CHANGED — recorded in shop .* by Test-operator\. Features on now: delivery, loyalty\./);
    expect([...await resolver(anna)].sort()).toEqual(['delivery', 'loyalty']);
    expect(await resolver(tnagar)).toEqual([]);
    const by = (await db.query(`SELECT payload->>'by' AS by FROM event_ledger WHERE tenant_id = $1 AND type = 'TenantEntitlementSet'`, [anna])).rows as { by: string }[];
    expect(by.map((r) => r.by)).toEqual(['operator:Test-operator', 'operator:Test-operator']);

    const off = await run('shops.js', ['features', '--tenant', anna, '--operator', 'Test-operator', '--off', 'delivery', '--on', 'loyalty', '--env-file', env()]);
    expect(off.out).toMatch(/turn OFF delivery[\s\S]*already so: loyalty/);
    expect(await resolver(anna)).toEqual(['loyalty']);
  });

  it('a bad request and a production box write nothing, and say why', async () => {
    const bad = await run('shops.js', ['features', '--tenant', randomUUID(), '--operator', '', '--on', 'teleport', '--env-file', env()]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/NOT CHANGED[\s\S]*--operator[\s\S]*There is no shop[\s\S]*not a feature/);
    const prod = await run('shops.js', ['features', '--tenant', tnagar, '--operator', 'Test-operator', '--on', 'b2b', '--env-file', join(dir, 'env-prod')]);
    expect(prod.code).toBe(1);
    expect(prod.out).toMatch(/production box/);
    expect(await tenantEntitlementResolver(new SqlEventStore(pgPoolClient(db)))(tnagar)).toEqual([]);
  });
});
