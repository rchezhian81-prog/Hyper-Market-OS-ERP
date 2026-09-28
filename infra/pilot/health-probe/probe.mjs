#!/usr/bin/env node
// Hosted demo — scheduled health probe → Healthchecks.io (runbook §9.5; owner decision 28 Sep 2026, option A).
//
// Runs every 5 minutes (systemd timer, see sre-pilot-health.timer). Checks the MONITORING-AND-ALERTS
// watch-list on the box and reports to one Healthchecks.io check:
//   all OK      → ping            (Healthchecks marks the check "up")
//   any failure → ping /fail + the plain-English list of what failed (Healthchecks emails the owner)
//   no ping     → the box itself is down or unreachable; Healthchecks emails after the grace period —
//                 the case a box can never report about itself.
//
// The ping URL is a credential (anyone holding it can fake "up"/"down"), so it lives ONLY in a root-only
// file on the box (/etc/sre-pilot/healthchecks-url), never in git, config or output. The report body
// carries no secret: every line is built here from fixed text and numbers, and redact() strips anything
// shaped like a connection string or token as a second line of defence.
//
//   node infra/pilot/health-probe/probe.mjs            # one real probe
//   node infra/pilot/health-probe/probe.mjs --test     # send a clearly-labelled TEST alert (/fail)
//   node infra/pilot/health-probe/probe.mjs --dry-run  # run the checks, print, send nothing

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/** How long unsent sales may sit without draining before it is an alert (MONITORING-AND-ALERTS). */
export const UNSENT_ALERT_MINUTES = 30;
/** Disk use at or above which to alert (MONITORING-AND-ALERTS: alert ≥ 85%). */
export const DISK_ALERT_PERCENT = 85;

/** Count length-prefixed frames (`<bytes> <record>\n`) in an edge log, walking by offset as the edge does. */
export function countFrames(buffer) {
  let at = 0;
  let count = 0;
  while (at < buffer.length) {
    const space = buffer.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(buffer.subarray(at, space).toString('utf8'));
    if (!Number.isSafeInteger(length) || length < 0) break;
    const end = space + 1 + length;
    if (end > buffer.length) break; // a torn tail is not a record
    count += 1;
    at = end + 1; // skip the trailing newline
  }
  return count;
}

/**
 * The unsent-sales rule with memory: a backlog is only an alert when it has persisted, not draining, for
 * longer than UNSENT_ALERT_MINUTES. `state` carries when the current backlog was first seen.
 */
export function unsentVerdict(unsent, state, nowMs) {
  if (unsent <= 0) return { ok: true, state: {}, line: 'Unsent sales: 0 — the store box is in step with the books.' };
  const since = typeof state.backlogSinceMs === 'number' && unsent >= (state.lastUnsent ?? 0) ? state.backlogSinceMs : nowMs;
  const minutes = Math.floor((nowMs - since) / 60_000);
  const next = { backlogSinceMs: since, lastUnsent: unsent };
  if (minutes >= UNSENT_ALERT_MINUTES) {
    return { ok: false, state: next, line: `Unsent sales: ${unsent}, not draining for ${minutes} min — sales are safe on the store box, but the books are behind. Check the box's cloud connection.` };
  }
  return { ok: true, state: next, line: `Unsent sales: ${unsent} (for ${minutes} min — alert after ${UNSENT_ALERT_MINUTES}).` };
}

/** Remove anything shaped like a secret before text leaves the box. */
export function redact(text) {
  return String(text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s@/]*:[^\s@/]*@[^\s]*/gi, '[redacted connection string]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/https?:\/\/hc-ping\.com\/\S+/g, '[redacted ping url]');
}

/** Roll the checks up into the one report Healthchecks receives. */
export function summarise(checks, { test = false, host = 'demo box' } = {}) {
  const failed = checks.filter((c) => !c.ok);
  const head = test
    ? `TEST ALERT — SRE demo pilot (${host}). This is a deliberate test of the alert path; nothing is wrong.`
    : failed.length === 0
      ? `OK — SRE demo pilot (${host}): all ${checks.length} checks passed.`
      : `PROBLEM — SRE demo pilot (${host}): ${failed.length} of ${checks.length} checks failed.`;
  const lines = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.line}`);
  return { fail: test || failed.length > 0, body: redact([head, '', ...lines].join('\n')).slice(0, 10_000) };
}

// ── The checks (run on the box) ───────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const ENV_FILE = join(REPO, 'infra', 'compose', '.env.pilot');
const URL_FILE = '/etc/sre-pilot/healthchecks-url';
const STATE_FILE = '/var/lib/sre-pilot/health-probe-state.json';
const SERVICES = ['sre-pilot-db-1', 'sre-pilot-api-1', 'sre-pilot-web-1', 'sre-pilot-demo-login-1', 'sre-pilot-edge-1'];

const quiet = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue;
    out[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
  }
  return out;
}

function runChecks(nowMs) {
  const env = parseEnv(readFileSync(ENV_FILE, 'utf8'));
  const checks = [];

  // 1. Every demo service is running.
  const down = SERVICES.filter((name) => quiet('docker', ['inspect', '-f', '{{.State.Running}}', name]).stdout.trim() !== 'true');
  checks.push({ name: 'Services', ok: down.length === 0, line: down.length === 0 ? `all ${SERVICES.length} running` : `not running: ${down.join(', ')}` });

  // 2. Whole-stack readiness (settings, API live + ready, till screen served, sync setting).
  const standup = quiet(process.execPath, [join(REPO, 'scripts', 'standup-check.mjs')], { cwd: REPO, env: { ...process.env, STANDUP_ENV_FILE: ENV_FILE } });
  checks.push({ name: 'Readiness (standup:check)', ok: standup.status === 0, line: standup.status === 0 ? 'GREEN' : 'RED — run `pnpm run standup:check` on the box for the failing line' });

  // 3. Dead letters at the store box: any is an alert; they are read by a person, never deleted.
  const dl = quiet('docker', ['exec', 'sre-pilot-edge-1', 'sh', '-c', 'cd /var/lib/sre-edge && wc -c dead-letters dead-letters-returns dead-letters-completions dead-letters-day-close']);
  const dlBytes = dl.status === 0 ? dl.stdout.trim().split('\n').filter((l) => !/total$/.test(l)).map((l) => Number(l.trim().split(/\s+/)[0])) : [];
  const dlOk = dl.status === 0 && dlBytes.every((b) => b === 0);
  checks.push({ name: 'Dead letters (store box)', ok: dlOk, line: dl.status !== 0 ? 'could not read the store box' : dlOk ? 'none' : 'there are dead-lettered items — a person must review them (never delete)' });

  // 4. Unsent sales, with memory (alert only when not draining for > 30 min).
  let state = {};
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
  const log = quiet('docker', ['exec', 'sre-pilot-edge-1', 'cat', '/var/lib/sre-edge/sales.log'], { encoding: 'buffer' });
  const cursor = quiet('docker', ['exec', 'sre-pilot-edge-1', 'cat', '/var/lib/sre-edge/sync-cursor']);
  if (log.status === 0) {
    const unsent = countFrames(log.stdout) - Number((cursor.stdout ?? '').trim() || '0');
    const v = unsentVerdict(unsent, state, nowMs);
    checks.push({ name: 'Unsent sales (sync lag)', ok: v.ok, line: v.line });
    state = v.state;
  } else {
    checks.push({ name: 'Unsent sales (sync lag)', ok: false, line: 'could not read the store box sales log' });
  }

  // 5. Disk.
  const df = quiet('df', ['--output=pcent', '/']);
  const pct = Number((df.stdout.split('\n')[1] ?? '').replace('%', '').trim());
  checks.push({ name: 'Disk', ok: Number.isFinite(pct) && pct < DISK_ALERT_PERCENT, line: `${pct}% used (alert at ${DISK_ALERT_PERCENT}%)` });

  // 6. Audit chain (tamper-evidence). The connection string is built here and never printed.
  const dbUrl = `postgres://${env['POSTGRES_USER']}:${env['POSTGRES_PASSWORD']}@127.0.0.1:${env['POSTGRES_PORT'] ?? '5432'}/${env['POSTGRES_DB']}`;
  const audit = quiet(process.execPath, ['--experimental-strip-types', '--no-warnings', join(REPO, 'scripts', 'verify-audit-chain.mts')], { cwd: REPO, env: { ...process.env, DATABASE_URL: dbUrl } });
  checks.push({ name: 'Audit chain', ok: audit.status === 0, line: audit.status === 0 ? 'intact' : 'BROKEN or unreadable — treat as a security incident (security-incident.md)' });

  try { writeFileSync(STATE_FILE, `${JSON.stringify(state)}\n`, { mode: 0o600 }); } catch { /* next run starts fresh */ }
  return checks;
}

async function ping(url, fail, body) {
  const res = await fetch(fail ? `${url.replace(/\/+$/, '')}/fail` : url, {
    method: 'POST', body, headers: { 'content-type': 'text/plain; charset=utf-8' }, signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

async function main() {
  const test = process.argv.includes('--test');
  const dry = process.argv.includes('--dry-run');
  const nowMs = Date.now();
  const host = quiet('hostname', []).stdout.trim() || 'demo box';
  const checks = test ? [{ name: 'Alert path', ok: false, line: 'deliberate test from the demo box' }] : runChecks(nowMs);
  const report = summarise(checks, { test, host });
  console.log(report.body);
  if (dry) return 0;
  if (!existsSync(URL_FILE)) {
    console.error(`\nNOT SENT — no Healthchecks ping URL on this box (${URL_FILE}). Nothing was reported.`);
    return 2;
  }
  const url = readFileSync(URL_FILE, 'utf8').trim();
  if (!/^https:\/\/hc-ping\.com\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/.test(url)) {
    console.error('\nNOT SENT — the ping URL file does not hold an https://hc-ping.com/… address.');
    return 2;
  }
  const status = await ping(url, report.fail, report.body);
  console.log(`\nReported to Healthchecks.io as ${report.fail ? 'FAIL' : 'OK'} — HTTP ${status}.`);
  return status >= 200 && status < 300 ? (report.fail && !test ? 1 : 0) : 3;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
