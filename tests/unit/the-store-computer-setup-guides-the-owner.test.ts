import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  backupVerdict, check, checkTable, composeEnv, dockerProblem, doctorRows, layout, main, overall, parseCommandLine, planSettings, prepare, refusals,
  renderSettings, up, waitReady, CHECK_TITLES, COMPOSE_BASE, SECRET_KEYS, THRESHOLDS, type CheckResult,
} from '../../scripts/lib/store-computer.mjs';
import { settingsOf, world, type World } from '../support/store-computer-world';

/**
 * OB-240 · OB-244 — the owner's guided store-computer setup (`pnpm run store-computer -- doctor|prepare|up|check`).
 * The owner, not a programmer, runs every step himself on a Windows PC. These tests drive the engine with a pretend
 * Docker, a pretend API and every line it says captured: no Docker, no network, no real data.
 */

const SECRETS = ['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY'];

/** Every secret this copy holds must be absent from everything the owner sees and every record written. */
function expectNoSecretShown(w: World, extra: string[] = []): void {
  const s = settingsOf(w);
  const seen = [...w.said, ...extra].join('\n');
  for (const k of SECRETS) {
    expect(s[k]!.length, k).toBeGreaterThanOrEqual(32);
    expect(seen.includes(s[k]!), `${k} was shown`).toBe(false);
    // Not even a recognisable piece of it.
    expect(seen.includes(s[k]!.slice(0, 16)), `part of ${k} was shown`).toBe(false);
  }
}

const recordsOf = (w: World, dir = join(w.data, 'records')): string[] =>
  existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')) : [];

describe('prepare — this copy\'s settings, made once, secrets never shown', () => {
  it('writes .env.real with every Step 1 setting, fresh distinct secrets, and says only the names and the tenant id', async () => {
    const w = world();
    expect(await prepare(w.deps)).toBe(0);
    const s = settingsOf(w);
    expect(s).toMatchObject({
      POSTGRES_DB: 'sre_real', MIGRATION_TARGET_KIND: 'rehearsal', DEMO_TENANT_IDS: 'pilot-demo', CLOUD_API_URL: '', CLOUD_API_TOKEN: '',
      SRE_PUBLIC_HOST: '', SRE_STAFF_ROUTE: 'staff-not-public', IDP_AUDIENCE: 'sre-real-api',
    });
    expect(s['EDGE_TENANT_ID']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(s['IDP_ISSUER']).toBe(`sre-real-store-computer-${s['EDGE_TENANT_ID']}`);
    const secrets = SECRETS.map((k) => s[k]!);
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(s['POSTGRES_PASSWORD']).toMatch(/^[0-9a-f]{48}$/);
    for (const k of ['PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY']) expect(s[k]).toMatch(/^[A-Za-z0-9_-]{64}$/);
    // Nothing seeds a person.
    expect(Object.keys(s).filter((k) => k.startsWith('BOOTSTRAP_OWNER'))).toEqual([]);

    const out = w.said.join('\n');
    expect(out).toContain(`This copy's tenant id: ${s['EDGE_TENANT_ID']}`);
    for (const k of SECRETS) expect(out).toMatch(new RegExp(`^ {2}${k} {3}\\(a new secret`, 'm'));
    expect(out).toMatch(/No person was set up/);
    expectNoSecretShown(w);
  });

  it('never overwrites an existing settings file — and says so without touching it', async () => {
    const w = world();
    expect(await prepare(w.deps)).toBe(0);
    const before = readFileSync(join(w.data, '.env.real'), 'utf8');
    w.said.length = 0;
    expect(await prepare(w.deps)).toBe(2);
    expect(w.said[0]).toBe(`REFUSED — ${join(w.data, '.env.real')} already exists. It is never overwritten: it holds this copy's secrets.`);
    expect(readFileSync(join(w.data, '.env.real'), 'utf8')).toBe(before);
  });

  it('refuses when a value it would write is already in the demo\'s settings on this computer — naming only the setting', async () => {
    const w = world();
    const demo = 'POSTGRES_PASSWORD=not-this-one-0123456789abcdef0123456789\nIDP_AUDIENCE=sre-real-api\nPOSTGRES_DB=other\n';
    writeFileSync(join(w.root, 'infra', 'compose', '.env.pilot'), demo);
    expect(await prepare(w.deps)).toBe(2);
    expect(existsSync(join(w.data, '.env.real'))).toBe(false);
    expect(w.said.join('\n')).toContain('REFUSED — the value this would write for IDP_AUDIENCE is already in infra/compose/.env.pilot on this computer. Nothing was written.');
    expect(w.said.join('\n')).not.toContain('sre-real-api');
    expect(w.said.join('\n')).not.toContain('not-this-one');
  });

  it('refuses a window that says production, and never reads or writes anything for it', async () => {
    const w = world({ env: { MIGRATION_TARGET_KIND: ' Production ' } });
    expect(await prepare(w.deps)).toBe(2);
    expect(w.said.join('\n')).toMatch(/REFUSED — this window has MIGRATION_TARGET_KIND=production set/);
    expect(existsSync(join(w.data, '.env.real'))).toBe(false);
  });

  it('renders every planned value in place, and adds DEMO_TENANT_IDS (which the example lacks) at the end', () => {
    let n = 0;
    const { planned } = planSettings({ APP_DB_USER: 'sre_app' }, { random: (k) => Buffer.alloc(k, (n += 1)), uuid: () => '0b1c2d3e-4f50-4617-8899-aabbccddeeff' });
    const text = renderSettings('# c\nPOSTGRES_DB=x\nPACK_SIGNING_KEY=REPLACE_WITH_A_GENERATED_VALUE\n', planned, '2026-10-20T04:30:00.000Z');
    expect(text).toMatch(/^POSTGRES_DB=sre_real$/m);
    expect(text).not.toContain('REPLACE_WITH');
    expect(text.trimEnd().split('\n').pop()).toMatch(/^[A-Z_]+=/);
    expect(text).toMatch(/^DEMO_TENANT_IDS=pilot-demo$/m);
    expect(planned['DATABASE_URL']).toBe(['postgres', '://', 'sre_app', ':', planned['POSTGRES_PASSWORD'], '@db:5432/', 'sre_real'].join(''));
  });

  it('makes each secret distinct even if the random source repeats itself', () => {
    let calls = 0;
    const same = (k: number) => { calls += 1; return Buffer.alloc(k, calls <= 2 ? 7 : calls); };
    const { planned } = planSettings({}, { random: same, uuid: () => '0b1c2d3e-4f50-4617-8899-aabbccddeeff' });
    const keys = [planned['PACK_SIGNING_KEY'], planned['BOX_HISTORY_SEAL_KEY'], planned['IDP_SIGNING_KEY']];
    expect(new Set(keys).size).toBe(3);
  });
});

describe('the refusals every command makes', () => {
  it('production (in the file or the window), the demo tenant, and seeding people', () => {
    expect(refusals({ MIGRATION_TARGET_KIND: 'production' })).toEqual([expect.stringMatching(/never works on a production box/)]);
    expect(refusals({ MIGRATION_TARGET_KIND: 'rehearsal' }, { MIGRATION_TARGET_KIND: 'PRODUCTION' })).toEqual([expect.stringMatching(/this window has MIGRATION_TARGET_KIND=production/)]);
    expect(refusals({ EDGE_TENANT_ID: 'pilot-demo' })).toEqual([expect.stringMatching(/demo tenant/)]);
    expect(refusals({ EDGE_TENANT_ID: 'b-demo', DEMO_TENANT_IDS: 'a-demo, b-demo' })).toHaveLength(1);
    expect(refusals({ EDGE_TENANT_ID: 'x', BOOTSTRAP_OWNER_TENANT_ID: 'x', BOOTSTRAP_OWNER_USER_ID: 'o' })).toEqual([
      expect.stringMatching(/BOOTSTRAP_OWNER_TENANT_ID.*tenant:bootstrap.*OB-243/), expect.stringMatching(/BOOTSTRAP_OWNER_USER_ID/),
    ]);
    expect(refusals({ MIGRATION_TARGET_KIND: 'rehearsal', EDGE_TENANT_ID: '0b1c2d3e-4f50-4617-8899-aabbccddeeff', BOOTSTRAP_OWNER_TENANT_ID: '' })).toEqual([]);
  });

  it('the file decides, never the window: every setting the file holds, and every COMPOSE_* override, is taken out of the shell', () => {
    const env = composeEnv({ PATH: '/bin', MIGRATION_TARGET_KIND: 'production', EDGE_TENANT_ID: 'pilot-demo', COMPOSE_FILE: 'docker-compose.pilot.yml', COMPOSE_PROJECT_NAME: 'sre-pilot' }, { MIGRATION_TARGET_KIND: 'rehearsal', EDGE_TENANT_ID: 't' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('up and check refuse a production settings file before running a single program', async () => {
    for (const run of [(d: World['deps']) => up(d), (d: World['deps']) => check(d, { by: 'Owner' })]) {
      const w = world();
      expect(await prepare(w.deps)).toBe(0);
      const f = join(w.data, '.env.real');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/^MIGRATION_TARGET_KIND=rehearsal$/m, 'MIGRATION_TARGET_KIND=production'));
      w.calls.length = 0;
      expect(await run(w.deps)).toBe(2);
      expect(w.calls).toEqual([]);
      expect(w.said.join('\n')).toMatch(/REFUSED — this copy's settings say MIGRATION_TARGET_KIND=production/);
      expect(recordsOf(w)).toEqual([]);
    }
  });
});

describe('up — starts this copy only, and says plainly what is wrong', () => {
  const ready = async (): Promise<World> => { const w = world(); expect(await prepare(w.deps)).toBe(0); w.said.length = 0; w.calls.length = 0; return w; };

  it('starts db, migrate and api in project sre-real from the base file and .env.real, shows ps, and waits for READY', async () => {
    const w = await ready();
    w.api.readyAfter = 2;
    w.deps = { ...w.deps, env: { PATH: '/bin', MIGRATION_TARGET_KIND: 'production-ish', COMPOSE_FILE: 'docker-compose.pilot.yml' } };
    expect(await up(w.deps)).toBe(0);
    const compose = w.calls.filter((c) => c.args[0] === 'compose' && c.args.length > 2);
    expect(compose.map((c) => c.args.join(' '))).toEqual([
      `compose -p sre-real -f docker-compose.yml --env-file ${join(w.data, '.env.real')} up -d db migrate api`,
      `compose -p sre-real -f docker-compose.yml --env-file ${join(w.data, '.env.real')} ps`,
    ]);
    for (const c of compose) {
      expect(c.cwd).toBe(join(w.root, 'infra', 'compose'));
      expect(c.env).toEqual({ PATH: '/bin' });
    }
    expect(w.calls.some((c) => c.args.some((a) => a.includes('pilot')) && c.args[0] !== 'ps')).toBe(false);
    expect(w.api.asked).toBe(3);
    expect(w.said.join('\n')).toMatch(/READY — this copy is up on this computer, and needs no internet\./);
    expectNoSecretShown(w);
  });

  it('Docker missing, Docker Desktop stopped, compose missing: each one plain sentence and the one thing to do', async () => {
    const cases: [Partial<World['docker']>, RegExp, RegExp][] = [
      [{ installed: false }, /Docker is not installed on this computer/, /Install Docker Desktop \(guide Part 2\)/],
      [{ running: false }, /Docker Desktop is installed but not running\./, /Open Docker Desktop from the Start menu, wait until it says "Engine running"/],
      [{ compose: false }, /Docker's compose part is missing\./, /Update Docker Desktop/],
    ];
    for (const [docker, what, fix] of cases) {
      const w = await ready();
      Object.assign(w.docker, docker);
      expect(await up(w.deps)).toBe(1);
      expect(w.said[0]).toMatch(/^NOT STARTED — /);
      expect(w.said[1]).toMatch(/^ {2}What to do: /);
      expect(w.calls.some((c) => c.args.includes('up'))).toBe(false);
      // The words on the owner's Windows PC.
      const onWindows = dockerProblem({ ...w.deps, platform: 'win32' })!;
      expect(onWindows.what).toMatch(what);
      expect(onWindows.fix).toMatch(fix);
    }
  });

  it('a port already taken stops it before Docker is asked to start anything', async () => {
    const w = await ready();
    w.ports.add(5432);
    expect(await up(w.deps)).toBe(1);
    expect(w.said.join('\n')).toMatch(/port 5432 on this computer is already taken by another program, so this copy's database cannot start/);
    expect(w.calls.some((c) => c.args.includes('up'))).toBe(false);
  });

  it('a port held by this copy itself is not a clash: it is already running, and is brought up to date', async () => {
    const w = await ready();
    w.ports.add(5432).add(8081);
    w.docker.ownRunning = ['sre-real-db-1', 'sre-real-api-1'];
    expect(await up(w.deps)).toBe(0);
    expect(w.said.join('\n')).toMatch(/already running — bringing it up to date/);
  });

  it('refuses when the demo\'s containers are on this computer — and starts or stops nothing', async () => {
    const w = await ready();
    w.docker.demoContainers = ['sre-pilot-api-1'];
    expect(await up(w.deps)).toBe(2);
    expect(w.said[0]).toMatch(/REFUSED — the demo's containers \(project sre-pilot\) are on this computer/);
    expect(w.calls.some((c) => c.args.includes('up') || c.args.includes('down') || c.args.includes('stop'))).toBe(false);
  });

  it('a failed start or an API that never says ready is said plainly, with what to send', async () => {
    const w = await ready();
    w.docker.upStatus = 1;
    expect(await up(w.deps)).toBe(1);
    expect(w.said.join('\n')).toMatch(/send me a photo of the red text/);
    const v = await ready();
    v.api.ready = false;
    expect(await up(v.deps)).toBe(1);
    expect(v.said.join('\n')).toMatch(/NOT READY — the API did not say ready within 5 minutes/);
  });

  it('refuses with no settings file: prepare first', async () => {
    const w = world();
    expect(await up(w.deps)).toBe(2);
    expect(w.said[0]).toMatch(/Run first: pnpm run store-computer -- prepare/);
  });

  it('waitReady polls until ready or the wait is over', async () => {
    const w = world();
    w.api.readyAfter = 4;
    expect(await waitReady(w.deps, 8081, 60_000)).toBe(true);
    const v = world();
    v.api.ready = false;
    expect(await waitReady(v.deps, 8081, 9_000)).toBe(false);
    expect(v.api.asked).toBe(4);
  });
});

describe('check — the ten G4 isolation checks (gap G-RD-1)', () => {
  const prepared = async (over: Partial<World['deps']> = {}): Promise<World> => { const w = world(over); expect(await prepare(w.deps)).toBe(0); w.said.length = 0; w.calls.length = 0; return w; };
  const byNumber = (w: World): Record<number, string> => {
    const rec = JSON.parse(recordsOf(w).at(-1)!) as { results: { n: number; result: string }[] };
    return Object.fromEntries(rec.results.map((r) => [r.n, r.result]));
  };

  it('needs a name: --by is required', async () => {
    const w = await prepared();
    expect(await check(w.deps, {})).toBe(2);
    expect(await check(w.deps, { by: '   ' })).toBe(2);
    expect(w.said.join('\n')).toMatch(/say who is running the check/);
    expect(recordsOf(w)).toEqual([]);
  });

  it('a first run: eight pass, and 3, 5 and 10 say honestly what the tool could not do here — G4 is NOT passed', async () => {
    const w = await prepared();
    expect(await check(w.deps, { by: 'S. Rajendran' })).toBe(1);
    expect(byNumber(w)).toEqual({ 1: 'PASS', 2: 'PASS', 3: 'NEEDS-YOU', 4: 'PASS', 5: 'NEEDS-YOU', 6: 'PASS', 7: 'PASS', 8: 'PASS', 9: 'PASS', 10: 'NEEDS-YOU' });
    const out = w.said.join('\n');
    expect(out).toContain("not checked here: the demo's settings are not on this computer, which is itself the expected state");
    expect(out).toMatch(/unplug the INTERNET cable.*--offline-confirmed/);
    expect(out).toMatch(/G4 NOT PASSED — 3 need you\. No real data may be loaded until G4 passes\./);
    expect(out).not.toMatch(/G4 PASSED/);
    expectNoSecretShown(w, recordsOf(w));
  });

  it('checks 7 and 8 run the loader\'s refusal path on an empty temporary folder, and 8 uses a settings copy with no secrets that is then deleted', async () => {
    const w = await prepared();
    await check(w.deps, { by: 'Owner' });
    const slices = w.calls.filter((c) => c.args[0]?.includes('migration-slice'));
    expect(slices).toHaveLength(2);
    for (const c of slices) {
      expect(c.args).toEqual(expect.arrayContaining(['--stage', '--offline', '--settings']));
      const dir = c.args[c.args.indexOf('--dir') + 1]!;
      expect(existsSync(dir)).toBe(false); // the temporary folder is gone
    }
    expect(slices[0]!.args[slices[0]!.args.indexOf('--settings') + 1]).toBe(join(w.data, '.env.real'));
    const copyPath = slices[1]!.args[slices[1]!.args.indexOf('--settings') + 1]!;
    expect(existsSync(copyPath)).toBe(false);
    const copy = w.sliceSettingsSeen[1]!;
    expect(copy).toMatch(/^MIGRATION_TARGET_KIND=production$/m);
    const s = settingsOf(w);
    for (const k of SECRETS) expect(copy.includes(s[k]!), k).toBe(false);
    expect(copy).toContain(`EDGE_TENANT_ID=${s['EDGE_TENANT_ID']}`);
  });

  it('a loader that does NOT refuse fails the check — the tool believes the loader\'s words, not its own hopes', async () => {
    const w = world({}, { sliceStdout: () => ({ status: 0, stdout: 'staged 0 rows\n' }) });
    expect(await prepare(w.deps)).toBe(0);
    await check(w.deps, { by: 'Owner' });
    expect(byNumber(w)).toMatchObject({ 7: 'FAIL', 8: 'FAIL' });
  });

  it('with the cable unplugged (--offline-confirmed) and a backup record on another drive, all ten pass: G4 PASSED', async () => {
    const w = await prepared();
    writeFileSync(join(w.root, 'infra', 'compose', '.env'), 'POSTGRES_PASSWORD=someone-elses-0123456789abcdef0123456789\nIDP_ISSUER=https://demo.invalid/idp\n');
    const record = join(w.root, '..', `rehearsal-${Date.now()}.json`);
    writeFileSync(record, JSON.stringify({ outcome: 'restored_and_reconciled', offsiteDir: '/media/owner-drive/sre-real' }));
    expect(await check(w.deps, { by: 'S. Rajendran', offlineConfirmed: true, backupRecord: record })).toBe(0);
    expect(Object.values(byNumber(w))).toEqual(Array(10).fill('PASS'));
    expect(w.said.join('\n')).toMatch(/^G4 PASSED — all ten isolation checks pass\.$/m);
    const rec = JSON.parse(recordsOf(w).at(-1)!) as Record<string, unknown>;
    expect(rec).toMatchObject({ kind: 'g4-isolation-check', by: 'S. Rajendran', project: 'sre-real', tenantId: settingsOf(w)['EDGE_TENANT_ID'], computer: 'Linux', offlineConfirmed: true, overall: 'G4 PASSED', at: '2026-10-20T04:30:00.000Z' });
    expectNoSecretShown(w, recordsOf(w));
  });

  it('check 3 FAILS when a secret equals a value in another settings file here — naming the setting, never the value', async () => {
    const w = await prepared();
    const s = settingsOf(w);
    writeFileSync(join(w.root, 'infra', 'compose', '.env'), `SOMETHING=${s['PACK_SIGNING_KEY']}\n`);
    await check(w.deps, { by: 'Owner' });
    expect(byNumber(w)[3]).toBe('FAIL');
    expect(w.said.join('\n')).toMatch(/PACK_SIGNING_KEY equals a value in infra\/compose\/\.env/);
    expectNoSecretShown(w, recordsOf(w));
  });

  it('check 4 FAILS on an outside address in .env.real or the till\'s settings; check 1 on demo storage; check 2 on a demo database', async () => {
    const w = await prepared();
    const f = join(w.data, '.env.real');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^CLOUD_API_URL=$/m, 'CLOUD_API_URL=https://demo.example.org'));
    w.docker.volumes = ['sre-real_db-data', 'sre-pilot_db-data'];
    w.docker.databases = ['postgres', 'sre_real', 'sre_pilot'];
    await check(w.deps, { by: 'Owner' });
    expect(byNumber(w)).toMatchObject({ 1: 'FAIL', 2: 'FAIL', 4: 'FAIL' });
    expect(w.said.join('\n')).not.toContain('demo.example.org');
  });

  it('Docker stopped: checks 1 and 2 fail with the plain fix, the rest still run, and a record is still written', async () => {
    const w = await prepared({ platform: 'linux' });
    w.docker.running = false;
    await check(w.deps, { by: 'Owner' });
    expect(byNumber(w)).toMatchObject({ 1: 'FAIL', 2: 'FAIL', 6: 'PASS', 9: 'PASS' });
    expect(recordsOf(w)).toHaveLength(1);
  });

  it('check 10: a backup record that did not restore, or a copy left on the computer\'s own drive, FAILS', async () => {
    const w = await prepared();
    const bad = join(w.root, 'bad.json');
    writeFileSync(bad, JSON.stringify({ outcome: 'restore_not_accepted', offsiteDir: '/media/x' }));
    await check(w.deps, { by: 'Owner', backupRecord: bad });
    expect(byNumber(w)[10]).toBe('FAIL');
    const inside = join(w.root, 'inside.json');
    writeFileSync(inside, JSON.stringify({ outcome: 'restored_and_reconciled', offsiteDir: join(w.root, 'backups') }));
    await check(w.deps, { by: 'Owner', backupRecord: inside });
    expect(byNumber(w)[10]).toBe('FAIL');
  });

  it('every run writes a NEW dated record, never overwriting one, into --out when given', async () => {
    const w = await prepared();
    const out = join(w.root, 'my-records');
    await check(w.deps, { by: 'Owner', out });
    await check(w.deps, { by: 'Owner', out });
    const files = readdirSync(out).sort();
    expect(files).toEqual(['g4-check-2026-10-20T04-30-00-000Z-2.json', 'g4-check-2026-10-20T04-30-00-000Z.json']);
  });
});

describe('the check table and the overall answer', () => {
  const all = (status: CheckResult['status']): CheckResult[] => CHECK_TITLES.map((title, i) => ({ n: i + 1, title, status, detail: 'd' }));

  it('"G4 PASSED" only when all ten pass — a NEEDS-YOU, a FAIL or a missing check is never a pass', () => {
    expect(overall(all('PASS'))).toEqual({ passed: true, line: 'G4 PASSED — all ten isolation checks pass.' });
    const one = all('PASS'); one[2] = { ...one[2]!, status: 'NEEDS-YOU' };
    expect(overall(one).passed).toBe(false);
    const fail = all('PASS'); fail[6] = { ...fail[6]!, status: 'FAIL' };
    expect(overall(fail).line).toMatch(/^G4 NOT PASSED — 1 failed\./);
    expect(overall(all('PASS').slice(0, 9)).line).toMatch(/1 not run/);
  });

  it('the table lists all ten, each with its result and its detail', () => {
    const t = checkTable(all('PASS'));
    expect(t).toHaveLength(21);
    expect(t[1]).toBe(' 1  PASS       Own project, own storage');
    expect(t[19]).toBe('10  PASS       Backups go to the owner\'s drive only');
  });
});

describe('doctor — the prerequisites, each OK or FIX with the fix', () => {
  const rows = (over: Partial<World['deps']>) => Object.fromEntries(doctorRows(world(over).deps).map((r) => [r.name, r]));

  it('a good Windows 11 PC is all OK', () => {
    const r = rows({ platform: 'win32', repoRoot: 'C:\\SRE', os: { totalmem: () => 7.8 * 1024 ** 3, release: () => '10.0.22631', version: () => 'Windows 11 Home' }, timeZone: () => 'Asia/Calcutta', env: { npm_config_user_agent: 'pnpm/10.33.0 npm/? node/v22.11.0 win32 x64' } });
    expect(Object.values(r).filter((x) => x.status === 'FIX')).toEqual([]);
    expect(r['Windows']!.detail).toBe('Windows 11 Home (build 22631)');
  });

  it('the thresholds: memory 7.5 GB, free disk 50 GB, Node 22, Windows build 19041, Asia/Kolkata', () => {
    expect(THRESHOLDS).toMatchObject({ ramBytes: 7.5 * 1024 ** 3, diskBytes: 50 * 1024 ** 3, minNodeMajor: 22, minWindowsBuild: 19041 });
    expect(rows({ os: { totalmem: () => 4 * 1024 ** 3, release: () => '6.8', version: () => 'Linux' } })['Memory']!.status).toBe('FIX');
    expect(rows({ freeDiskBytes: () => 49.9 * 1024 ** 3 })['Free disk']!.status).toBe('FIX');
    expect(rows({ freeDiskBytes: () => 50 * 1024 ** 3 })['Free disk']!.status).toBe('OK');
    expect(rows({ freeDiskBytes: () => { throw new Error('no'); } })['Free disk']!.status).toBe('FIX');
    expect(rows({ nodeVersion: 'v20.18.0' })['Node.js']).toMatchObject({ status: 'FIX', fix: expect.stringMatching(/Node\.js 22 LTS/) });
    expect(rows({ nodeVersion: 'v22.0.0' })['Node.js']!.status).toBe('OK');
    expect(rows({ platform: 'win32', repoRoot: 'C:\\SRE', os: { totalmem: () => 16 * 1024 ** 3, release: () => '10.0.18363', version: () => 'Windows 10 Pro' } })['Windows']).toMatchObject({ status: 'FIX', fix: expect.stringMatching(/Windows Update/) });
    expect(rows({ platform: 'win32', repoRoot: 'C:\\SRE', os: { totalmem: () => 16 * 1024 ** 3, release: () => '10.0.19041', version: () => 'Windows 10 Pro' } })['Windows']!.status).toBe('OK');
    expect(rows({ platform: 'win32', repoRoot: 'C:\\SRE', timeZone: () => 'UTC' })['Time zone']).toMatchObject({ status: 'FIX', fix: expect.stringMatching(/\(UTC\+05:30\) Chennai, Kolkata, Mumbai, New Delhi/) });
    expect(rows({ platform: 'darwin' })['System']!.status).toBe('FIX');
  });

  it('pnpm is read from how it was started; Docker problems carry their fix', () => {
    expect(rows({ env: {} })['pnpm']).toMatchObject({ status: 'FIX', fix: expect.stringMatching(/npm install -g pnpm/) });
    expect(rows({ env: { npm_config_user_agent: 'pnpm/10.33.0 npm/? node/v22 linux x64' } })['pnpm']).toMatchObject({ status: 'OK', detail: 'pnpm 10.33.0' });
    const w = world();
    w.docker.running = false;
    expect(Object.fromEntries(doctorRows(w.deps).map((r) => [r.name, r]))['Docker']!.status).toBe('FIX');
  });

  it('Windows folders: a space in the path, or a cloud-synced folder (which would copy the secrets away), is a FIX', () => {
    expect(rows({ platform: 'win32', repoRoot: 'C:\\Users\\Raj Kumar\\Downloads\\SRE' })['Folder']).toMatchObject({ status: 'FIX', fix: expect.stringMatching(/space.*C:\\SRE/) });
    expect(rows({ platform: 'win32', repoRoot: 'C:\\Users\\raj\\OneDrive\\Desktop\\SRE' })['Folder']).toMatchObject({ status: 'FIX', fix: expect.stringMatching(/cloud-synced/) });
    expect(rows({ platform: 'win32', repoRoot: 'C:\\SRE' })['Folder']!.status).toBe('OK');
  });

  it('reports a production settings file as a FIX', async () => {
    const w = world();
    expect(await prepare(w.deps)).toBe(0);
    const f = join(w.data, '.env.real');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^MIGRATION_TARGET_KIND=rehearsal$/m, 'MIGRATION_TARGET_KIND=production'));
    expect(doctorRows(w.deps).find((r) => r.name === 'This copy')!.status).toBe('FIX');
  });
});

describe('Windows paths and the command line', () => {
  it('lays every file out with Windows separators under C:\\SRE', () => {
    const L = layout('C:\\SRE', 'win32');
    expect(L.settings).toBe('C:\\SRE\\infra\\compose\\.env.real');
    expect(L.records).toBe('C:\\SRE\\infra\\compose\\records');
    expect(L.others.map((o) => o.path)).toEqual(['C:\\SRE\\infra\\compose\\.env', 'C:\\SRE\\infra\\compose\\.env.pilot']);
    expect(L.sliceScript).toBe('scripts\\dist\\migration-slice.js');
    expect(L.tillEnv).toBe('C:\\SRE\\till\\till.env');
  });

  it('check 10 on Windows: a backup on C: or on the repository\'s drive fails; on E: (the owner\'s drive) it passes', () => {
    const ok = { outcome: 'restored_and_reconciled' };
    const win = { platform: 'win32', repoRoot: 'C:\\SRE', systemDrive: 'C:' };
    expect(backupVerdict({ ...ok, offsiteDir: 'C:\\Backups\\sre-real' }, win).status).toBe('FAIL');
    expect(backupVerdict({ ...ok, offsiteDir: 'c:\\sre-real' }, win).status).toBe('FAIL');
    expect(backupVerdict({ ...ok, offsiteDir: 'D:\\sre-real' }, { ...win, repoRoot: 'D:\\SRE' }).status).toBe('FAIL');
    expect(backupVerdict({ ...ok, offsiteDir: 'E:\\sre-real' }, win)).toEqual({ status: 'PASS', detail: expect.stringContaining('E:\\sre-real') });
    expect(backupVerdict({ ...ok, offsiteDir: 'E:\\sre-real' }, { platform: 'win32', repoRoot: 'C:\\SRE' }).status).toBe('PASS');
    expect(backupVerdict({ outcome: 'restore_not_accepted', offsiteDir: 'E:\\sre-real' }, win).status).toBe('FAIL');
    expect(backupVerdict(undefined, win).status).toBe('FAIL');
    expect(backupVerdict({ ...ok }, win).status).toBe('FAIL');
    expect(backupVerdict({ ...ok, offsiteDir: '/srv/sre/backups' }, { platform: 'linux', repoRoot: '/srv/sre' }).status).toBe('FAIL');
    expect(backupVerdict({ ...ok, offsiteDir: '/media/owner/sre-real' }, { platform: 'linux', repoRoot: '/srv/sre' }).status).toBe('PASS');
  });

  it('takes the "--" pnpm passes through, names unknown options, and refuses a missing --by value', async () => {
    expect(parseCommandLine(['--', 'check', '--by', 'S. Rajendran', '--offline-confirmed'])).toMatchObject({ command: 'check', by: 'S. Rajendran', offlineConfirmed: true, problems: [] });
    expect(parseCommandLine(['check', '--by'])).toMatchObject({ problems: ['--by needs a value'] });
    expect(parseCommandLine(['up', '--force'])).toMatchObject({ problems: ['unknown option --force'] });
    const w = world();
    expect(await main(['--', 'seed'], w.deps)).toBe(2);
    expect(w.said[0]).toBe('Not understood: the command "seed"');
  });

  it('every compose command names project sre-real, the base file and .env.real — never the demo overlay', () => {
    expect(COMPOSE_BASE).toEqual(['compose', '-p', 'sre-real', '-f', 'docker-compose.yml', '--env-file', '.env.real']);
    expect(SECRET_KEYS).toEqual(expect.arrayContaining(SECRETS));
  });
});

describe('the settings file on disk', () => {
  it('is readable by its owner only (Linux); Windows keeps it in the user\'s own folder', async () => {
    const w = world();
    expect(await prepare(w.deps)).toBe(0);
    expect(statSync(join(w.data, '.env.real')).mode & 0o077).toBe(0);
  });
});
