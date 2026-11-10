// The FIRST-RUN SCREENS' server — CR-01 step 2b (OI-02). Started by SRE-Setup.exe (through `store-computer setup-screens`)
// once its files are copied; it opens the screens in this PC's browser and stops itself after the setup has run.
//
//   node scripts/dist/setup-server.js [--port 8099] [--no-browser] [--shortcut <file.url>] [--log <file>]
//
// Started by SRE-Setup.exe (which runs as administrator) it is given --shortcut and --log: it opens NO browser itself, but
// writes its address into that shortcut ("Finish SRE setup" on the person's desktop), and SRE-Setup.exe opens the address
// as the person (scripts/lib/setup-handoff.mjs says why). Every line it says is also kept in the log.
//
// It listens on 127.0.0.1 only, and every call must carry the one-time key in the page's address (scripts/lib/setup-app.ts,
// createSetupDoor). Everything it does is what the store-computer tool and the owner setup steps already do, joined in
// order: `setup` (this PC), the first two people (as tenant:bootstrap), each person's own till PIN (as till:pin), and the
// owner setup step `shop` (prepared by the owner, approved by the accountant, each with their own PIN). It never says,
// logs or writes a PIN, a token or a key.

import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { heldFetch } from './lib/held-fetch.mjs';
import { argValue, loggedSay, removeHandoff, screensUrl, writeHandoff } from './lib/setup-handoff.mjs';
import { createSetupDoor, install, type InstallSteps, type Progress, type SetupState } from './lib/setup-app';
import { buildPersonToken, demoTenantIds, parseEnvText, tokenPolicyFromEnv } from './lib/operator-env';
import { pinVerifier } from './lib/owner-setup-pins';
import { databaseUrlFromTheHost } from './lib/database-url-from-the-host';
import { runOwnerSetup, type SetupClient } from '../packages/migration/src/owner-steps-command';
import { planTenantBootstrap } from '../packages/migration/src/tenant-bootstrap';
import { runTillPinCommand } from '../edge/store-edge/src/till-pin-command';
import { SqlEventStore } from '../packages/persistence/src/event-store';
import { pgPoolClient } from '../packages/persistence/src/pg-client';
import { seedInitialAdmins } from '../services/api/src/access';
import { OWNER_ROLE_ID, ROLE_CATALOGUE } from '../services/api/src/roles';

const argv = process.argv.slice(2);
const port = Number(argValue(argv, '--port') ?? '') || 8099;
const shortcut = argValue(argv, '--shortcut');
const key = randomBytes(24).toString('base64url');
const out = loggedSay(nodeFs, argValue(argv, '--log'), (line: string): void => { process.stdout.write(`${line}\n`); });
// The shortcut holds the key: it goes when this server goes, however it stops.
if (shortcut !== undefined) process.on('exit', () => { removeHandoff(nodeFs, shortcut); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { process.exit(0); });
process.on('uncaughtException', (e) => { out(`The setup screens stopped: ${e instanceof Error ? e.message : 'an error'}.`); process.exit(1); });

/** The release (or repository) folder: the nearest folder above this file that holds package.json. */
const ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
})();
const TOOL = join(ROOT, 'scripts', 'store-computer.mjs');

/** The store-computer tool, run as its own program (as a person would run it), each line it says handed on. */
function runTool(args: readonly string[], say: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { cwd: ROOT, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let rest = '';
    const take = (chunk: Buffer): void => {
      rest += chunk.toString('utf8');
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const line of parts) if (line.trim() !== '') say(line);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => { if (rest.trim() !== '') say(rest); resolve(code ?? 1); });
    child.on('error', () => { say('The store-computer tool could not be started.'); resolve(1); });
  });
}

interface ToolState extends SetupState { readonly settingsPath: string; readonly tillEnvPath: string }
/** What the tool says about this PC now (`store-computer setup-state`). */
function toolState(): ToolState {
  const r = spawnSync(process.execPath, [TOOL, 'setup-state'], { cwd: ROOT, env: process.env, encoding: 'utf8', windowsHide: true });
  const line = String(r.stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
  try { return JSON.parse(line) as ToolState; } catch { return { setUp: false, drives: [], settingsPath: '', tillEnvPath: '' }; }
}

const readIfThere = (file: string | undefined): string | undefined => {
  if (file === undefined || file === '' || !existsSync(file)) return undefined;
  try { return readFileSync(file, 'utf8'); } catch { return undefined; }
};
/** This copy's settings and its till's, read now (never shown). */
function settingsNow(): { settings: Record<string, string>; tillEnv: Record<string, string> | undefined } | undefined {
  const st = toolState();
  const text = readIfThere(st.settingsPath);
  if (!st.setUp || text === undefined) return undefined;
  const tillText = readIfThere(st.tillEnvPath);
  return { settings: parseEnvText(text), tillEnv: tillText === undefined ? undefined : parseEnvText(tillText) };
}

const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const steps: InstallSteps = {
  async setUpThisPc(dataDrive, say) {
    return runTool(['setup', '--data-drive', dataDrive], say);
  },

  async seedPeople(owner, second, say) {
    const s = settingsNow();
    if (s === undefined) return { problem: 'this PC\'s settings cannot be read' };
    const plan = planTenantBootstrap({
      tenantId: s.settings['EDGE_TENANT_ID'] ?? '', owner: owner.login, admins: [{ userId: second.login, roleId: second.role }],
      targetKind: s.settings['MIGRATION_TARGET_KIND'], demoTenantIds: demoTenantIds(s.settings, undefined),
      knownRoleIds: ROLE_CATALOGUE.map((r) => r.id), operator: owner.name, ownerRoleId: OWNER_ROLE_ID,
    });
    if (!plan.ok) return { problem: `${plan.refusedBecause} — ${plan.detail}` };
    const url = databaseUrlFromTheHost(s.settings['DATABASE_URL'] ?? '', s.settings);
    const db = new Pool({ connectionString: url.url, max: 2 });
    try {
      const outcome = await seedInitialAdmins(new SqlEventStore(pgPoolClient(db)), plan.tenantId, plan.admins, plan.operator, new Date().toISOString());
      if (outcome.outcome === 'already_bootstrapped') return 'already';
      say(`${outcome.granted} grant(s) recorded in one step.`);
      return 'seeded';
    } catch (e) {
      return { problem: `the database could not be written (${e instanceof Error ? e.message : 'error'})` };
    } finally {
      await db.end().catch(() => undefined);
    }
  },

  async setPin(login, pin, by, say) {
    const s = settingsNow();
    if (s?.tillEnv === undefined) { say('The till\'s settings cannot be read.'); return false; }
    // The person typed their PIN twice on the screen and the two matched; till:pin is handed it the same way.
    const result = await runTillPinCommand(['--user', login, '--by', by], s.tillEnv, { readSecret: async () => pin, say: () => {} });
    for (const line of result.lines) say(line);
    return result.ok;
  },

  async shop(values, pinOf, say) {
    const s = settingsNow();
    if (s === undefined) { say('This PC\'s settings cannot be read.'); return false; }
    const idp = tokenPolicyFromEnv(s.settings);
    if (idp.policy === undefined) { say('This PC\'s sign-in settings are not complete.'); return false; }
    const base = `http://127.0.0.1:${s.settings['API_PORT'] || '8081'}`;
    const client: SetupClient = {
      request: async ({ method, path, userId, tenantId, body, idempotencyKey, signedInAt }) => {
        // Minted per call, for THIS person, only after their own PIN matched; five minutes; it never leaves this process.
        const token = buildPersonToken({ sub: userId, tenantId, ttlSeconds: 300, authTimeSec: Math.floor(Date.parse(signedInAt) / 1000) }, idp.policy!, Date.now());
        let res: Response;
        try {
          res = await heldFetch(`${base}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }, 30_000);
        } catch {
          return { status: 503, body: { error: { code: 'not_reachable', whatHappened: 'the office service on this PC did not answer' } } };
        }
        const text = await res.text();
        let parsed: unknown = text;
        try { parsed = text === '' ? undefined : JSON.parse(text); } catch { /* keep the text */ }
        return { status: res.status, body: parsed };
      },
    };
    const outcome = await runOwnerSetup({
      step: 'shop', tenantId: s.settings['EDGE_TENANT_ID'] ?? '', targetKind: s.settings['MIGRATION_TARGET_KIND'],
      demoTenantIds: demoTenantIds(s.settings, undefined), values, today: today(), now: () => new Date().toISOString(),
    }, {
      client,
      confirm: async () => true, // the owner confirmed on the screens' last page, having read what will be done
      askPin: async (userId) => pinOf(userId),
      verifyPin: pinVerifier({ tillEnv: s.tillEnv, settings: s.settings, readFile: readIfThere }),
      say,
    });
    return outcome.exitCode === 0;
  },
};

function state(): SetupState {
  const st = toolState();
  return { setUp: st.setUp, drives: st.drives, ...(st.tenantId === undefined ? {} : { tenantId: st.tenantId }), ...(st.dataRoot === undefined ? {} : { dataRoot: st.dataRoot }), ...(st.release === undefined ? {} : { release: st.release }) };
}

// It stops by itself: ten minutes after the setup has run (so the last screen can be read), or after two hours unused.
let stopping = false;
const markDone = (p: Progress): void => {
  if (!p.done || stopping) return;
  stopping = true;
  setTimeout(() => { process.exit(p.ok ? 0 : 1); }, 10 * 60_000);
};
setTimeout(() => { if (!stopping) process.exit(0); }, 2 * 3600_000).unref();
const handle = createSetupDoor({
  key,
  page: readFileSync(join(ROOT, 'scripts', 'setup-page', 'index.html'), 'utf8'),
  state,
  install: async (a, p) => { const ok = await install(a, steps, p); markDone(p); return ok; },
  shortcuts: async (chosen) => {
    const lines: string[] = [];
    const code = await runTool(['shortcuts', '--only', chosen.join(',')], (l) => { lines.push(l); });
    return { ok: code === 0, lines };
  },
  keep: async (p) => {
    const code = await runTool(['setup'], (l) => { p.lines.push(l); });
    p.done = true;
    p.ok = code === 0;
    markDone(p);
    return p.ok;
  },
});

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 64 * 1024) req.destroy(); });
  req.on('end', () => {
    let body: unknown;
    try { body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    void handle({ method: req.method ?? 'GET', path: req.url ?? '/', headers, body }).then((r) => {
      res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
      res.end(r.body);
    });
  });
});

server.on('error', (e: NodeJS.ErrnoException) => {
  out(e.code === 'EADDRINUSE'
    ? `The setup screens could not start: port ${port} is already in use on this PC (an earlier setup screen may still be open — restart the PC and run SRE-Setup.exe again).`
    : `The setup screens could not start: ${e.message}.`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = screensUrl(port, key);
  out(`The setup screens are open on this PC only: http://127.0.0.1:${port}/setup/`);
  if (shortcut !== undefined) {
    // Started by SRE-Setup.exe: the setup program opens this address as the person who started it. Never the key in the log.
    if (writeHandoff(nodeFs, shortcut, url)) out(`Their address is in the shortcut "${shortcut}" — double-click it if the browser did not open.`);
    else { out(`The shortcut "${shortcut}" could not be written; the setup screens cannot be opened.`); process.exit(1); }
  } else if (!argv.includes('--no-browser') && process.platform === 'win32') {
    // A person ran it themselves (not as administrator): Windows opens their own browser. Never hidden.
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    process.stdout.write(`Open: ${url}\n`); // to the person's own window only, never into the log
  }
});
