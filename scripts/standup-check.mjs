#!/usr/bin/env node
// Stand-up readiness check — the green light before day 1 of the pilot (M35 operational health, P-08).
//
// The pilot plan's one precondition is that the system is "stood up in the store and signed off."
// This is the one command that answers, in plain English, whether that is actually true — so a
// non-programmer pilot lead sees GREEN / RED per piece instead of having to read `docker compose ps`,
// `curl /readyz` and a wall of logs and interpret them.
//
// ── What it checks, and what it deliberately does NOT ────────────────────────
//
// It checks that the PIECES ARE UP AND HEALTHY AND CONFIGURED: the settings file has no leftover
// placeholders, the cloud API is live and ready, the till screen is being served, and whether the
// store box is set to sync to the books or is (safely) selling-and-queuing only.
//
// It does NOT ring a test sale through to the books. That proof is a real, authenticated action a
// real person does on day 1 with the real cashier login (pilot plan, signal 1) — and the code path
// it exercises is exactly the one the automated end-to-end test already guards
// (`tests/e2e/core-one-lane.test.ts`). An operational health probe that minted itself a token and
// wrote a sale would be doing the one thing this system refuses to let software do on its own; the
// honest boundary is that infrastructure readiness is a machine check and "money reached the books"
// is a person's check. This says which is which rather than blur them.
//
// Read-only and credential-free: it makes only unauthenticated GETs to the health/shell endpoints
// and reads the local settings file. It writes nothing and needs no token.
//
// Usage:  node scripts/standup-check.mjs   (or: pnpm run standup:check)
// Reads infra/compose/.env for ports and the edge sync setting; override with STANDUP_ENV_FILE.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// ── Pure helpers (unit-tested; the runner below is a thin shell over these) ───

/** The placeholder token every value in .env.example carries until a real one replaces it. */
export const PLACEHOLDER = 'REPLACE_WITH';

/**
 * Parse a KEY=VALUE settings file into a map, ignoring blank lines and `#` comments. Values keep
 * everything after the first `=` verbatim (so a `=` inside a URL survives).
 */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The settings that must be filled in before anything is safe to start, and why each one bites if
 * it is left as the placeholder. Returns a finding per unfilled value — empty means the file is
 * complete. This mirrors the reasons the API itself refuses to start, so the check fails on the
 * same things the deployment would, only sooner and in words.
 */
export function findUnsetSettings(env) {
  const required = [
    ['POSTGRES_PASSWORD', 'the database has no password set'],
    ['DATABASE_URL', 'nothing can reach the database'],
    ['PACK_SIGNING_KEY', 'the price list every till trades on would be unsigned'],
    ['IDP_SIGNING_KEY', 'the system could not tell a real login from a forged one'],
    ['IDP_ISSUER', 'the system does not know whose logins to trust'],
    ['EDGE_TENANT_ID', 'the store box does not know which shop it belongs to'],
  ];
  const findings = [];
  for (const [key, why] of required) {
    const value = env[key];
    if (value === undefined || value === '' || value.includes(PLACEHOLDER)) {
      findings.push({ key, why });
    }
  }
  return findings;
}

/** Turn a health-probe HTTP result into a check outcome. `body` is the parsed JSON, or null. */
export function interpretProbe(kind, ok, status, body) {
  // kind is 'livez' (is the program broken?) or 'readyz' (should it be given work?).
  const flag = kind === 'livez' ? 'live' : 'ready';
  if (ok && body && body[flag] === true) {
    return { ok: true, detail: kind === 'livez' ? 'the API is running' : 'the API is ready to take work' };
  }
  if (status === 503 && kind === 'readyz') {
    return {
      ok: false,
      detail: 'the API is running but NOT ready — it cannot reach something it needs (usually the database)',
      fix: 'Leave the API alone and check the database is up: `docker compose ps` and `docker compose logs db`.',
    };
  }
  return {
    ok: false,
    detail: status === 0 ? 'the API did not answer at all' : `the API answered ${status}, not a healthy 200`,
    fix: 'Is the stack up? `docker compose up -d`, then `docker compose ps` — `db`, `api` and `web` running, `migrate` exited (0).',
  };
}

/**
 * The edge sync setting is advisory, not pass/fail: a store box with no cloud URL is the safe
 * offline-first default (it sells and queues), which is a fine state to *start* a pilot in — but
 * the pilot's signal 1 (sales appearing on the owner dashboard) needs sync ON, so the check says
 * plainly which one this is rather than staying silent.
 */
export function interpretSync(cloudUrl) {
  if (cloudUrl === undefined || cloudUrl === '') {
    return {
      ok: true, advisory: true,
      detail: 'the store box is selling-and-queuing only — it is NOT yet syncing to the books',
      note: 'Fine to stand up and start on. Signal 1 of the pilot (sales on your dashboard) needs sync turned on: set CLOUD_API_URL and a store token (see login provisioning).',
    };
  }
  return { ok: true, advisory: true, detail: `the store box is set to sync to the books at ${cloudUrl}` };
}

/** Roll individual results up into an overall verdict. Advisory items never fail the gate. */
export function rollup(results) {
  const failed = results.filter((r) => r.ok === false);
  return {
    ready: failed.length === 0,
    failed,
    total: results.length,
    passed: results.filter((r) => r.ok === true).length,
  };
}

/** Render the whole thing as plain English a non-programmer can act on. */
export function renderReport(results) {
  const mark = (r) => (r.ok === false ? '✕ NOT READY' : r.advisory ? '•' : '✓ ready');
  const lines = ['', 'Stand-up readiness check — SRE Retail OS', '─'.repeat(44)];
  for (const r of results) {
    lines.push(`${mark(r)}  ${r.name}`);
    if (r.detail) lines.push(`        ${r.detail}`);
    if (r.note) lines.push(`        → ${r.note}`);
    if (r.ok === false && r.fix) lines.push(`        Fix: ${r.fix}`);
  }
  const v = rollup(results);
  lines.push('─'.repeat(44));
  lines.push(v.ready
    ? `GREEN — ${v.passed} of ${v.total} checks passed. The infrastructure is stood up and healthy.`
    : `RED — ${v.failed.length} of ${v.total} check(s) not ready. Fix the ✕ line(s) above, then run this again.`);
  lines.push(v.ready
    ? 'Next: the "money reaches the books" proof is day 1 of the pilot, with the real cashier login (signal 1).'
    : '');
  return lines.filter((l) => l !== undefined).join('\n');
}

// ── The runner: read settings, probe the endpoints, print, set the exit code ──

/** GET a URL and report {ok, status, body} without ever throwing (a dead endpoint is a result). */
async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON (e.g. the HTML shell) — status is enough */ }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

async function main() {
  const envFile = process.env['STANDUP_ENV_FILE'] ?? join(REPO, 'infra', 'compose', '.env');
  const results = [];

  // 1 — Settings filled in.
  let env = {};
  try {
    env = parseEnv(await readFile(envFile, 'utf8'));
    const unset = findUnsetSettings(env);
    results.push(unset.length === 0
      ? { name: 'Settings', ok: true, detail: 'every required setting has a real value' }
      : {
          name: 'Settings', ok: false,
          detail: `still unfilled: ${unset.map((u) => `${u.key} (${u.why})`).join('; ')}`,
          fix: 'Open infra/compose/.env and replace each placeholder with a real value (see infra/compose/.env.example).',
        });
  } catch {
    results.push({
      name: 'Settings', ok: false, detail: `no settings file at ${envFile}`,
      fix: 'From infra/compose, run: cp .env.example .env — then fill it in (see docs/runbooks/pilot-deployment.md).',
    });
  }

  const host = '127.0.0.1';
  const apiPort = env['API_PORT'] ?? '8081';
  const webPort = env['WEB_PORT'] ?? '8080';

  // 2 — API alive.
  const live = await probe(`http://${host}:${apiPort}/livez`);
  results.push({ name: 'Cloud API — running', ...interpretProbe('livez', live.ok, live.status, live.body) });

  // 3 — API ready (can reach the database).
  const ready = await probe(`http://${host}:${apiPort}/readyz`);
  results.push({ name: 'Cloud API — ready for work', ...interpretProbe('readyz', ready.ok, ready.status, ready.body) });

  // 4 — Till screen served.
  const pos = await probe(`http://${host}:${webPort}/pos/`);
  results.push(pos.ok
    ? { name: 'Till screen — served', ok: true, detail: 'the Sale screen is being served' }
    : { name: 'Till screen — served', ok: false, detail: `the till screen did not load (answered ${pos.status || 'nothing'})`, fix: 'Is the web container up? `docker compose ps` should show `web` running.' });

  // 5 — Edge sync setting (advisory).
  results.push({ name: 'Store box — sync setting', ...interpretSync(env['CLOUD_API_URL']) });

  console.log(renderReport(results));
  process.exitCode = rollup(results).ready ? 0 : 1;
}

// Run only when invoked directly, so the pure helpers can be imported by tests without probing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
