import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { sealExtract, simpleHasher } from '../../packages/migration/src/index';

/**
 * **The operator's load command runs.**
 *
 * `scripts/migration-load.ts` and `scripts/bootstrap-tenant.ts` are the doors a person in the shop
 * touches on load night, so they are exercised here as real subprocesses of the real bundle
 * (`node scripts/build-service.mjs tools`, exactly what `pnpm run migration:load` builds), against a
 * real folder, a real env file, and — for the load — a real HTTP hop into the in-process API, minting
 * the operator's token from the env file the way the box will. A tool tested only through its library
 * is a tool whose argument handling, exit codes, token and output nobody has ever checked.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const REAL = 'ab000000-0000-4000-8000-000000000042';
const OPERATOR = 'u-chezhian';

const FILES: Record<string, string> = {
  'categories.csv': ['category_id,name,parent_id,regulated', 'grocery,Grocery,,', 'staples,Staples,grocery,food', 'home,Home care,,'].join('\n'),
  'tax-rates.csv': ['hsn_code,effective_from,rate_percent', '1006,2017-07-01,5', '3402,2017-07-01,18'].join('\n'),
  'products.csv': [
    'item_code,description,uom,category,hsn,mrp,selling_price,cost_price,barcodes,allergens,country_of_origin,status',
    'P-RICE,Ponni raw rice 5 kg,each,staples,1006,450.00,420.00,360.00,8901234567890,none,IN,active',
    'P-SOAP,Dish wash bar,each,home,3402,25.00,25.00,18.00,8901234567891|INT-77,,,active',
  ].join('\n'),
  'suppliers.csv': ['supplier_code,supplier_name', 'SUP-1,Kaveri Traders'].join('\n'),
  'customers.csv': ['customer_code,loyalty_points', 'C-1,120', 'C-2,'].join('\n'),
  'opening-stock.csv': ['item_code,qty,uom,cost,batch,expiry', 'P-RICE,40,each,360.00,B1,2027-03-31', 'P-SOAP,200,each,18.00,,'].join('\n'),
};

let dir: string;
let envFile: string;
let h: ApiHarness;
let server: Server;
let api: string;

// ASYNC on purpose: the HTTP shim below runs on this very event loop, so a synchronous spawn would
// block the server the subprocess is trying to reach and the two would wait on each other forever.
const run = (bundle: string, args: readonly string[]): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, 'scripts', 'dist', bundle), ...args], { encoding: 'utf8', cwd: ROOT }, (err, stdout, stderr) => {
      const code = err === null ? 0 : (err as { code?: number | string }).code;
      resolve({ code: typeof code === 'number' ? code : -1, out: `${stdout}${stderr}` });
    });
  });

const writeFolder = (): void => {
  const dataRows = (text: string): number => text.split('\n').length - 1;
  const files: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(FILES)) {
    writeFileSync(join(dir, name), text, 'utf8');
    const sealed = sealExtract({ extractId: `x-${name}`, tenantId: REAL, sourceId: 'legacy-erp', material: text, rowCount: dataRows(text), extractedBy: OPERATOR, backupVerifiedAt: '2026-09-30T20:00:00.000Z', hasher: simpleHasher, now: '2026-09-30T21:00:00.000Z' });
    files[name] = { seal: sealed.extract, declaredRows: dataRows(text) };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ loadId: 'load-2026-10-01', tenantId: REAL, operator: OPERATOR, stockLocationId: 'STORE-MAIN', receivedOnDate: '2026-10-01', files }, null, 2), 'utf8');
  writeFileSync(join(dir, 'exceptions.json'), JSON.stringify({ exceptions: [] }), 'utf8');
};

const writeEnv = (targetKind: string): void => {
  const p = TEST_IDP.policy();
  writeFileSync(envFile, [`MIGRATION_TARGET_KIND=${targetKind}`, `IDP_SIGNING_KEY=${p.secret}`, `IDP_ISSUER=${p.issuer}`, `IDP_AUDIENCE=${p.audience}`, ''].join('\n'), 'utf8');
};

beforeAll(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-service.mjs'), 'tools'], { stdio: 'ignore', cwd: ROOT });
  dir = mkdtempSync(join(tmpdir(), 'sre-load-'));
  envFile = join(dir, 'box.env');
  writeFolder();
  writeEnv('rehearsal');
  h = apiHarness();
  await h.seedOwner(REAL, OPERATOR);
  // The wire: a real HTTP server in front of the in-process API, so the bundle's fetch, headers and
  // token travel exactly as they will to the box's API.
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => { data += c.toString('utf8'); });
    req.on('end', async () => {
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const key = req.headers['idempotency-key'];
      const r = await h.raw({
        method: req.method as 'GET' | 'POST', path: req.url ?? '/',
        ...(token === undefined ? {} : { token }),
        ...(data === '' ? {} : { body: JSON.parse(data) as unknown }),
        ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
      });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body ?? null));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  api = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : '';
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('scripts/migration-load — the operator\'s load, as a subprocess', () => {
  it('a dry run without an API plans everything, says the target was not checked, and sends nothing (exit 0)', async () => {
    const r = await run('migration-load.js', ['--dir', dir, '--env-file', envFile, '--dry-run']);
    expect(r.out).toContain('Seal verified — products.csv');
    expect(r.out).toContain('NOT CHECKED');
    expect(r.out).toContain('Plan: 14 step(s)');
    expect(r.out).toContain('DRY RUN');
    expect(r.code).toBe(0);
  });
  it('loads over HTTP with a token minted from the env file, writes the outcome, and stock reads back (exit 0)', async () => {
    const outFile = join(dir, 'outcome.json');
    const r = await run('migration-load.js', ['--dir', dir, '--env-file', envFile, '--api', api, '--out', outFile]);
    expect(r.out).toContain('Target tenant holds no products');
    expect(r.out).toContain('LOADED');
    expect(r.code).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    const outcome = JSON.parse(readFileSync(outFile, 'utf8')) as { exitCode: number; report: { landed: Record<string, number> } };
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.landed).toEqual({ tax: 2, product: 2, barcode: 3, price: 2, supplier: 1, customer: 3, stock: 1 });
    expect(readFileSync(outFile, 'utf8')).not.toMatch(/eyJ/); // no token in the evidence file
    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: REAL })).body as { rows: { productId: string; onHandMinor: number }[] };
    expect(avail.rows.map((x) => [x.productId, x.onHandMinor]).sort()).toEqual([['P-RICE', 40], ['P-SOAP', 200]]);
  });
  it('running the same load again resumes and doubles nothing (exit 0)', async () => {
    const r = await run('migration-load.js', ['--dir', dir, '--env-file', envFile, '--api', api]);
    expect(r.out).toContain('an earlier run of this load');
    expect(r.code).toBe(0);
    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: OPERATOR, tenantId: REAL })).body as { rows: { onHandMinor: number }[] };
    expect(avail.rows.map((x) => x.onHandMinor).sort((a, b) => a - b)).toEqual([40, 200]);
  });
  it('a production box is refused by the env file alone (exit 1)', async () => {
    writeEnv('production');
    const r = await run('migration-load.js', ['--dir', dir, '--env-file', envFile, '--dry-run']);
    writeEnv('rehearsal');
    expect(r.out).toContain('production_target');
    expect(r.code).toBe(1);
  });
  it('a tenant named as demo is refused before any call (exit 1)', async () => {
    const r = await run('migration-load.js', ['--dir', dir, '--env-file', envFile, '--dry-run', '--demo-tenant', REAL]);
    expect(r.out).toContain('demo_tenant');
    expect(r.code).toBe(1);
  });
  it('a folder without a manifest cannot be read (exit 2); no arguments prints usage (exit 2)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sre-empty-'));
    const r = await run('migration-load.js', ['--dir', empty, '--env-file', envFile, '--dry-run']);
    rmSync(empty, { recursive: true, force: true });
    expect(r.out).toContain('no manifest');
    expect(r.code).toBe(2);
    expect((await run('migration-load.js', [])).code).toBe(2);
  });
});

describe('scripts/bootstrap-tenant — a second real tenant, as a subprocess', () => {
  it('a dry run lists the initial admin set, owner first (exit 0)', async () => {
    const r = await run('bootstrap-tenant.js', ['--tenant', 'cd000000-0000-4000-8000-000000000077', '--owner', 'u-owner2', '--admin', 'u-ca:chartered_accountant', '--operator', 'u-tech', '--env-file', envFile, '--dry-run']);
    expect(r.out).toContain('u-owner2 as owner');
    expect(r.out).toContain('u-ca as chartered_accountant');
    expect(r.out).toContain('DRY RUN');
    expect(r.code).toBe(0);
  });
  it('refuses a label instead of a UUID, the demo tenant, a production box, and an unknown role (exit 1)', async () => {
    const base = ['--owner', 'u-owner2', '--operator', 'u-tech', '--env-file', envFile, '--dry-run'];
    expect((await run('bootstrap-tenant.js', ['--tenant', 'sre-real', ...base])).out).toContain('not_a_uuid');
    expect((await run('bootstrap-tenant.js', ['--tenant', REAL, '--demo-tenant', REAL, ...base])).out).toContain('demo_tenant');
    expect((await run('bootstrap-tenant.js', ['--tenant', REAL, '--admin', 'u-x:superuser', ...base])).out).toContain('unknown_role');
    writeEnv('production');
    const prod = await run('bootstrap-tenant.js', ['--tenant', REAL, ...base]);
    writeEnv('rehearsal');
    expect(prod.out).toContain('production_target');
    expect(prod.code).toBe(1);
  });
  it('a real run without a database address writes nothing and says so (exit 2)', async () => {
    const r = await run('bootstrap-tenant.js', ['--tenant', REAL, '--owner', 'u-owner2', '--operator', 'u-tech', '--env-file', envFile]);
    expect(r.out).toContain('DATABASE_URL');
    expect(r.code).toBe(2);
  });
});
