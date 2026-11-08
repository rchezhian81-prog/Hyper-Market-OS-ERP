#!/usr/bin/env node
// CR-01 step 1 · ADR-0032 — THE PROOF ON A CLEAN WINDOWS MACHINE. Run by the `store-pc-windows` job in
// .github/workflows/ci.yml after `store-computer prepare`, `till:install` and `store-computer install-services`, on one of
// GitHub's throw-away Windows machines. It asks WINDOWS itself — never the tool that installed — and says PASS or FAIL
// per claim, then writes the record to the file named by its first argument (uploaded as the job's evidence).
//
//   node tests/windows/store-pc-on-windows.check.mjs <record.json> [<data folder>]
//
// It reads the settings file only to look for its secrets where they must NOT be; it never prints one.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { parseEnvText } from '../../scripts/lib/store-computer.mjs';
import { SERVICES, SERVICE_ORDER, accountOf, serviceSid } from '../../scripts/lib/store-computer-services.mjs';

const out = process.argv[2] ?? 'store-pc-windows-proof.json';
const dataRoot = process.argv[3] ?? 'C:\\SRE-data';
const results = [];
const check = (claim, pass, detail) => { results.push({ claim, pass: Boolean(pass), detail }); process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${claim} — ${detail}\n`); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false, ...opts });
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const sc = (...a) => { const r = run('sc.exe', a); return `${r.stdout ?? ''}${r.stderr ?? ''}`; };
const state = (name) => /STATE\s*:\s*\d+\s+(\w+)/.exec(sc('query', name))?.[1] ?? 'MISSING';
async function until(fn, ms, every = 2_000) { const end = Date.now() + ms; for (;;) { try { if (await fn()) return true; } catch { /* not yet */ } if (Date.now() > end) return false; await sleep(every); } }
const get = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(5_000) }); return { status: r.status, text: await r.text() }; };
const apiReady = async () => { const r = await get('http://127.0.0.1:8081/readyz'); return r.status === 200 && JSON.parse(r.text).ready === true; };

const settings = parseEnvText(readFileSync(path.join(dataRoot, '.env.real'), 'utf8'));
const till = parseEnvText(readFileSync(path.join(dataRoot, 'till', 'till.env'), 'utf8'));
const secrets = ['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY'].map((k) => settings[k]).filter((v) => typeof v === 'string' && v.length >= 16);
const screenPort = till.EDGE_SCREEN_PORT ?? '8091';
const lanePort = till.EDGE_LANE_PORT ?? '8090';
const dbPort = settings.POSTGRES_PORT || '5432';

// 1 — Each service: installed, running, starts by itself, under its own virtual account whose SID is the one we grant by.
for (const name of SERVICE_ORDER) {
  const qc = sc('qc', name);
  const account = /SERVICE_START_NAME\s*:\s*(.+)/.exec(qc)?.[1]?.trim() ?? '';
  const auto = /START_TYPE\s*:\s*2\b/.test(qc);
  const sid = /SERVICE SID:\s*(S-[\d-]+)/i.exec(sc('showsid', name))?.[1] ?? '';
  check(`${name} runs, starts by itself at boot, as ${accountOf(name)}`, state(name) === 'RUNNING' && auto && account.toLowerCase() === accountOf(name).toLowerCase(), `state ${state(name)}; auto ${auto}; account ${account || 'unknown'}`);
  check(`${name}'s account SID is the one its folder rights were given to`, sid === serviceSid(name), `Windows: ${sid || 'none'}; ours: ${serviceSid(name)}`);
}
const deps = (name) => /DEPENDENCIES[ \t]*:[ \t]*([^\r\n]*)/.exec(sc('qc', name))?.[1]?.trim() ?? '';
check('the API waits for the database; the till waits for nothing (P-01)', deps(SERVICES.api).includes(SERVICES.database) && deps(SERVICES.till) === '', `API depends on "${deps(SERVICES.api)}"; till on "${deps(SERVICES.till)}"`);

// 2 — They answer, on this PC.
check('the office API says READY', await until(apiReady, 60_000), 'GET http://127.0.0.1:8081/readyz');
const page = await get(`http://127.0.0.1:${screenPort}/pos/`).catch((e) => ({ status: 0, text: String(e) }));
check('the till screen is served', page.status === 200 && page.text.includes('pos.bundle.js'), `GET /pos/ → ${page.status}`);
const lane = await get(`http://127.0.0.1:${lanePort}/`).catch((e) => ({ status: 0, text: String(e) }));
check('the till\'s save socket answers', lane.status === 404 && lane.text.includes('the lane socket serves'), `GET lane / → ${lane.status}`);

// 3 — This PC only: every listener on these ports is a loopback address, and the API refuses the PC's own network address.
const ports = [dbPort, '8081', lanePort, screenPort];
const listen = ps(`Get-NetTCPConnection -State Listen -LocalPort ${ports.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.LocalAddress)|$($_.LocalPort)" }`);
const rows = String(listen.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.lastIndexOf('|'); return { address: l.slice(0, i), port: l.slice(i + 1) }; });
const wide = rows.filter((r) => r.address !== '127.0.0.1' && r.address !== '::1');
const heard = new Set(rows.map((r) => r.port));
check('the database, the API and the till listen on this PC only (127.0.0.1)', wide.length === 0 && ports.every((p) => heard.has(p)), `listeners: ${rows.map((r) => `${r.address}:${r.port}`).join(', ') || 'none'}`);
const lanIp = Object.values(networkInterfaces()).flat().find((n) => n?.family === 'IPv4' && !n.internal)?.address;
if (lanIp !== undefined) {
  const reached = await get(`http://${lanIp}:8081/livez`).then(() => true, () => false);
  check('the API cannot be reached on the PC\'s network address', !reached, `http://${lanIp}:8081/livez ${reached ? 'ANSWERED' : 'refused'}`);
}

// 4 — The application login the API uses is not an administrator of the database (row-level security binds it).
const role = run(path.join(process.env.PG_BIN ?? '', 'psql.exe'), ['-h', '127.0.0.1', '-p', dbPort, '-U', settings.POSTGRES_USER, '-d', settings.POSTGRES_DB, '-Atc', `SELECT rolsuper::text || '|' || rolbypassrls::text FROM pg_roles WHERE rolname = '${settings.APP_DB_USER || 'sre_app'}'`], { env: { ...process.env, PGPASSWORD: settings.POSTGRES_PASSWORD } });
check('the API\'s database login is not a superuser and does not bypass row-level security', String(role.stdout ?? '').trim() === 'false|false', `rolsuper|rolbypassrls = ${String(role.stdout ?? '').trim() || String(role.stderr ?? '').trim().slice(0, 120)}`);
const tables = run(path.join(process.env.PG_BIN ?? '', 'psql.exe'), ['-h', '127.0.0.1', '-p', dbPort, '-U', settings.POSTGRES_USER, '-d', settings.POSTGRES_DB, '-Atc', 'SELECT count(*) FROM schema_migrations'], { env: { ...process.env, PGPASSWORD: settings.POSTGRES_PASSWORD } });
check('the database tables were built by the API service at its start (migrations)', Number(String(tables.stdout ?? '').trim()) > 0, `schema_migrations rows: ${String(tables.stdout ?? '').trim() || 'none'}`);

// 5 — No secret in a service definition, the registry's command lines, or a log.
const places = [];
for (const name of SERVICE_ORDER) places.push({ where: `${name} command line (registry)`, text: /BINARY_PATH_NAME\s*:\s*(.+)/.exec(sc('qc', name))?.[1] ?? '' });
const servicesDir = path.join(dataRoot, 'run', 'services');
for (const f of existsSync(servicesDir) ? readdirSync(servicesDir).filter((x) => x.endsWith('.xml')) : []) places.push({ where: f, text: readFileSync(path.join(servicesDir, f), 'utf8') });
const logsDir = path.join(dataRoot, 'logs');
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((x) => { const p = path.join(d, x); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
for (const f of walk(logsDir)) places.push({ where: path.relative(dataRoot, f), text: readFileSync(f, 'latin1') });
const leaks = places.filter((pl) => secrets.some((s) => pl.text.includes(s))).map((pl) => pl.where);
check('no secret is in any service definition, command line or log', leaks.length === 0 && secrets.length >= 5, `${places.length} places looked at; ${leaks.length === 0 ? 'none holds a secret' : `a secret is in: ${leaks.join(', ')}`}`);

// 6 — Windows restarts the API by itself when its program dies.
const pidOf = () => String(ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*store-computer-service.mjs*' -and $_.CommandLine -like '* api *' } | Select-Object -ExpandProperty ProcessId").stdout ?? '').trim().split(/\s+/)[0];
const before = pidOf();
if (before) run('taskkill.exe', ['/PID', before, '/F']);
const back = await until(async () => { const now = pidOf(); return now !== '' && now !== before && await apiReady(); }, 120_000);
check('the API comes back by itself after its program is killed', before !== '' && back, `killed PID ${before || 'none found'}; back ${back ? `as PID ${pidOf()}` : 'NOT within 2 minutes'}`);

// 7 — P-01: with the API and the database both stopped, the till still serves and its save socket still answers.
sc('stop', SERVICES.api);
await until(() => state(SERVICES.api) === 'STOPPED', 60_000);
sc('stop', SERVICES.database);
await until(() => state(SERVICES.database) === 'STOPPED', 60_000);
const alone = await get(`http://127.0.0.1:${screenPort}/pos/`).catch(() => ({ status: 0 }));
const aloneLane = await get(`http://127.0.0.1:${lanePort}/`).catch(() => ({ status: 0 }));
check('the till keeps serving with the office API and the database stopped (P-01)', state(SERVICES.api) === 'STOPPED' && state(SERVICES.database) === 'STOPPED' && alone.status === 200 && aloneLane.status === 404, `API ${state(SERVICES.api)}, database ${state(SERVICES.database)}; till page ${alone.status}, save socket ${aloneLane.status}`);

// 8 — Starting the API alone brings the database up first (what Windows does at boot), and the API is ready again.
sc('start', SERVICES.api);
const again = await until(apiReady, 180_000);
check('starting the API starts the database first, and the API is ready again', again && state(SERVICES.database) === 'RUNNING', `database ${state(SERVICES.database)}; API ready ${again}`);

writeFileSync(out, `${JSON.stringify({ kind: 'cr01-step1-store-pc-on-windows', at: new Date().toISOString(), os: String(ps('(Get-CimInstance Win32_OperatingSystem).Caption').stdout ?? '').trim(), node: process.version, results }, null, 2)}\n`);
const failed = results.filter((r) => !r.pass).length;
process.stdout.write(`\n${results.length - failed} of ${results.length} claims PASS.${failed === 0 ? '' : ` ${failed} FAIL.`} Record: ${out}\n`);
process.exitCode = failed === 0 ? 0 : 1;
