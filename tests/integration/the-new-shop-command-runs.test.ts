import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/**
 * **The new-shop command, run for real against a real PostgreSQL ledger (OB-15-d-2 · owner decision OB-20 "A").**
 *
 * The bundle a person runs on the server (`pnpm run shop:new`, `scripts/dist/new-shop.js`), driven as a child process with
 * an env file — the process environment's database address deliberately removed, as on the box. It proves:
 *   • a dry run writes nothing;
 *   • a real run records the shop and its first owner, the shop's name on the platform's record, and writes its realm
 *     file — for THIS shop, with no secret — then prints the next steps;
 *   • a second run for the same shop changes nothing; a bad request writes nothing and says every problem;
 *   • a production box is refused.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const ROOT = process.cwd();

const run = (args: readonly string[]): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv['DATABASE_URL'];
  execFile(process.execPath, [join(ROOT, 'scripts', 'dist', 'new-shop.js'), ...args], { encoding: 'utf8', cwd: ROOT, env: childEnv }, (err, stdout, stderr) => {
    resolve({ code: err === null ? 0 : (typeof err.code === 'number' ? err.code : 1), out: `${stdout}${stderr}` });
  });
});

describe.skipIf(DATABASE_URL === undefined)('the new-shop command creates a shop on a real ledger (OB-20)', () => {
  let dir = '';
  let db: Pool;
  const shop = randomUUID();
  const ledgerTypes = async (tenant: string): Promise<string[]> =>
    (await db.query('SELECT type FROM event_ledger WHERE tenant_id = $1 ORDER BY type', [tenant])).rows.map((r: { type: string }) => r.type);

  beforeAll(() => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-service.mjs'), 'tools'], { stdio: 'ignore', cwd: ROOT });
    dir = mkdtempSync(join(tmpdir(), 'sre-new-shop-'));
    writeFileSync(join(dir, 'env'), `DATABASE_URL=${DATABASE_URL}\nMIGRATION_TARGET_KIND=rehearsal\n`);
    writeFileSync(join(dir, 'env-prod'), `DATABASE_URL=${DATABASE_URL}\nMIGRATION_TARGET_KIND=production\n`);
    db = new Pool({ connectionString: DATABASE_URL, max: 2 });
  }, 120_000);
  afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await db?.end(); });

  const args = (over: Record<string, string> = {}, extra: readonly string[] = []) => {
    const a: Record<string, string> = {
      name: 'SRE Anna Nagar', owner: 'u-anna-owner', operator: 'Test-operator', realm: 'sre-anna',
      origin: 'https://anna.example.test', tenant: shop, 'env-file': join(dir, 'env'), out: join(dir, 'realm-sre-anna.json'), ...over,
    };
    return [...Object.entries(a).flatMap(([k, v]) => [`--${k}`, v]), ...extra];
  };

  it('a dry run writes nothing; a production box is refused', async () => {
    const dry = await run(args({}, ['--dry-run']));
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('DRY RUN — nothing was written.');
    expect(existsSync(join(dir, 'realm-sre-anna.json'))).toBe(false);
    const prod = await run(args({ 'env-file': join(dir, 'env-prod') }));
    expect(prod.code).toBe(1);
    expect(prod.out).toMatch(/NOT CREATED[\s\S]*production/);
    expect(await ledgerTypes(shop)).toEqual([]);
  });

  it('a real run: the shop and its owner recorded, its name on the platform record, its realm file — then the next steps', async () => {
    const made = await run(args());
    expect(made.code, made.out).toBe(0);
    expect(made.out).toMatch(/CREATED — the shop and its 1 first grant\(s\) recorded/);
    expect(made.out).toMatch(/Next, in order:[\s\S]*1\. Load the sign-in area[\s\S]*2\. Tell head office[\s\S]*3\. Give the owner/);
    expect(await ledgerTypes(shop)).toEqual(['RoleGranted', 'ShopRegistered']);
    const registered = (await db.query(`SELECT payload FROM event_ledger WHERE tenant_id = $1 AND type = 'ShopRegistered'`, [shop])).rows[0] as { payload: Record<string, unknown> };
    expect(registered.payload).toMatchObject({ tenantId: shop, name: 'SRE Anna Nagar', realm: 'sre-anna', webOrigin: 'https://anna.example.test', createdBy: 'Test-operator' });
    const realm = readFileSync(join(dir, 'realm-sre-anna.json'), 'utf8');
    expect(realm).toContain(shop);
    expect(realm).not.toMatch(/\$\{SRE_|"(secret|password)"\s*:\s*"/);
  });

  it('a second run for the same shop changes nothing; a bad request writes nothing and says every problem', async () => {
    const again = await run(args({ owner: 'u-somebody-else', out: join(dir, 'second.json') }));
    expect(again.code).toBe(1);
    expect(again.out).toContain('NOT CHANGED');
    expect(existsSync(join(dir, 'second.json'))).toBe(false);
    expect(await ledgerTypes(shop)).toEqual(['RoleGranted', 'ShopRegistered']);
    const bad = await run(args({ name: 'X', tenant: 'nope', realm: 'Anna', origin: 'http://x/y', out: join(dir, 'bad.json') }));
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/NOT CREATED — nothing was written:[\s\S]*2 to 80[\s\S]*not a UUID[\s\S]*sre-<shop>[\s\S]*no path/);
    expect(existsSync(join(dir, 'bad.json'))).toBe(false);
  });
});
