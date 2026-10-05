#!/usr/bin/env node
// The evidence ledger (independent audit of 4 Oct 2026: GT-08, PF-15, GT-09 · QG-02 · hard rule #9 · P-08).
//
// For every one of the 104 controlling requirements in docs/completion-status.json this says WHAT KIND of proof
// exists — a unit test, an in-process integration test, a test on real PostgreSQL, a browser test against a stub
// cloud, a browser test connected to the real cloud, a device session, a staff acceptance session — and whether the
// item's maturity label is ALLOWED by that proof. Nothing here is typed: the kinds are derived from the test tree
// (which files cite the requirement, where they live, whether they need a database) and from the SP-10 staff/device
// register; the label rule is in docs/evidence/TEST-SCOPE.md and in `labelHolds` below, and the guardrail
// tests/guardrails/the-evidence-ledger-is-current-and-honest.test.ts fails the build if a label outruns its proof
// or the committed ledger has drifted from the tree.
//
//   node scripts/evidence-ledger.mjs           write docs/evidence/evidence-ledger.{md,json}
//   node scripts/evidence-ledger.mjs --check   exit 1 if the committed ledger differs from the tree, or a label does not hold
//
// What a citation is: a test file cites a requirement when its text names the ID (M12 or any M12-FR-nn, D04, WF-10,
// QG-05, A06, MG-04), OR when the ledger item's own evidence prose names the test file by path. Both are kept, because
// the stage-gate suites cite roadmap stages and audit findings rather than module IDs, and the ledger is where a
// person records which suite proves which requirement. A file under tests/guardrails, tests/performance or
// tests/support is never evidence of a requirement's behaviour and is not counted.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCOPE_VERSION = 'v1';
export const LEDGER_FILE = 'docs/completion-status.json';
export const REGISTER_FILE = 'docs/registers/sp10-staff-uat.md';
export const SCOPE_FILE = 'docs/evidence/TEST-SCOPE.md';
export const OUT_MD = 'docs/evidence/evidence-ledger.md';
export const OUT_JSON = 'docs/evidence/evidence-ledger.json';
export const KINDS = Object.freeze(['unit', 'integration', 'realDb', 'browser', 'connected', 'device', 'uat']);
export const KIND_TITLES = Object.freeze({
  unit: 'Unit', integration: 'Integration (in-process)', realDb: 'Real PostgreSQL', browser: 'Browser (stub cloud)',
  connected: 'Browser (connected)', device: 'Device', uat: 'Staff UAT',
});
/** Where each family of evidence lives. Anything else under tests/ is not evidence of a requirement's behaviour. */
export const FAMILIES = Object.freeze({
  unit: ['tests/unit'],
  integration: ['tests/integration', 'tests/migration', 'tests/security', 'tests/contract'],
  browser: ['tests/e2e'],
});

/** The requirement IDs a text cites. M12-FR-02 counts for M12 (the ledger's items are modules, not FRs). */
export function citationsOf(text) {
  const ids = new Set();
  for (const m of text.matchAll(/\bM(\d{2})(?:-FR-\d{2})?\b/g)) ids.add(`M${m[1]}`);
  for (const re of [/\bD\d{2}\b/g, /\bWF-\d{2}\b/g, /\bQG-\d{2}\b/g, /\bA\d{2}\b/g, /\bMG-\d{2}\b/g]) {
    for (const m of text.matchAll(re)) ids.add(m[0]);
  }
  return ids;
}

/** Which family a test file belongs to by where it lives, and whether it needs a real database. */
export function classify(path, source) {
  const family = Object.entries(FAMILIES).find(([, dirs]) => dirs.some((d) => path === d || path.startsWith(`${d}/`)))?.[0] ?? null;
  return { family, realDb: /DATABASE_URL/.test(source) };
}

/** Test file paths a ledger item's evidence prose names, that exist. */
export function namedTests(text, exists = (p) => existsSync(join(ROOT, p))) {
  const found = new Set();
  for (const m of (text ?? '').matchAll(/tests\/[a-z0-9-]+\/[A-Za-z0-9._/-]+\.ts/g)) if (exists(m[0])) found.add(m[0]);
  return found;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every evidence test file: its citations, family and database need. */
export function scanTests(root = ROOT) {
  const tests = new Map();
  for (const dirs of Object.values(FAMILIES)) {
    for (const dir of dirs) {
      for (const abs of walk(join(root, dir))) {
        const path = relative(root, abs).split('\\').join('/');
        const source = readFileSync(abs, 'utf8');
        tests.set(path, { citations: citationsOf(source), ...classify(path, source) });
      }
    }
  }
  return tests;
}

/**
 * The SP-10 register's sessions. A session is a `### UAT-S-<n> — <date> — …` block carrying three machine-readable
 * lines: `**Covers:** M12, M14` (the requirement IDs the session exercised), `**Device:** <real hardware, or none>`
 * and `**Outcome:** PASS|FAIL`. Only a PASS session is evidence; a session on real hardware is device evidence too.
 */
export function parseRegister(markdown) {
  const sessions = [];
  // The register's own template sits inside a fenced code block and names the session `UAT-S-<n>`: fences are
  // dropped and only a numbered session counts, so a template can never be read as a session.
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  const blocks = prose.split(/(?=^### UAT-S-)/m).filter((b) => b.startsWith('### UAT-S-'));
  for (const block of blocks) {
    const head = /^### (UAT-S-\d+)\s*—\s*([^—\n]+)/.exec(block);
    if (!head) continue;
    const covers = /\*\*Covers:\*\*\s*([^\n]+)/.exec(block)?.[1] ?? '';
    const device = (/\*\*Device:\*\*\s*([^\n]+)/.exec(block)?.[1] ?? 'none').trim();
    const outcome = (/\*\*Outcome:\*\*\s*([A-Z]+)/.exec(block)?.[1] ?? 'PENDING').trim();
    sessions.push({ id: head[1], date: head[2].trim(), covers: citationsOf(covers), device: !/^none\b/i.test(device) && device !== '' && !/^<.*>$/.test(device), deviceText: device, outcome });
  }
  return sessions;
}

/** The kinds of proof an item has, as file (or session) lists per kind. */
export function evidenceFor(item, tests, sessions, exists) {
  const ev = Object.fromEntries(KINDS.map((k) => [k, []]));
  const named = namedTests(item.evidence, exists);
  for (const [path, t] of [...tests.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!t.citations.has(item.id) && !named.has(path)) continue;
    if (t.family === 'unit') ev.unit.push(path);
    else if (t.family === 'browser') { ev.browser.push(path); if (t.realDb) ev.connected.push(path); }
    else if (t.family === 'integration') { ev.integration.push(path); if (t.realDb) ev.realDb.push(path); }
  }
  for (const s of sessions) {
    if (s.outcome !== 'PASS' || !s.covers.has(item.id)) continue;
    ev.uat.push(s.id);
    if (s.device) ev.device.push(`${s.id} (${s.deviceText})`);
  }
  return ev;
}

/** The label rule (docs/evidence/TEST-SCOPE.md §4): what each maturity label needs before it may be claimed. */
export function labelHolds(label, ev) {
  const n = (k) => ev[k].length;
  const integration = n('integration') > 0;
  const browser = n('browser') > 0;
  const cloudEffect = n('realDb') > 0 || n('connected') > 0;
  switch (label) {
    case 'NOT_STARTED': case 'ENGINE_ONLY': case 'PARTIALLY_WIRED': case 'WIRED':
      return { holds: true, why: 'no evidence kind is required below INTEGRATION_TESTED (the completion-ladder guardrail holds WIRED+ to a registered file)' };
    case 'INTEGRATION_TESTED':
      return integration ? { holds: true, why: 'an integration test cites it' } : { holds: false, why: 'INTEGRATION_TESTED needs at least one integration test that cites the requirement' };
    case 'E2E_VERIFIED': {
      const missing = [];
      if (!integration) missing.push('an integration test');
      if (!browser) missing.push('a browser test (the user boundary)');
      if (!cloudEffect) missing.push('a real-PostgreSQL test or a connected browser test (the cloud effect)');
      return missing.length === 0
        ? { holds: true, why: n('connected') > 0 ? 'browser boundary and cloud effect proven in ONE connected run' : 'browser boundary and cloud effect proven in separate runs (no connected browser test yet)' }
        : { holds: false, why: `E2E_VERIFIED needs ${missing.join(', ')}` };
    }
    case 'UAT_VERIFIED': {
      const e2e = labelHolds('E2E_VERIFIED', ev);
      if (!e2e.holds) return { holds: false, why: `UAT_VERIFIED first needs E2E_VERIFIED to hold: ${e2e.why}` };
      return n('uat') > 0 ? { holds: true, why: 'a PASS session in the SP-10 register covers it' } : { holds: false, why: 'UAT_VERIFIED needs a PASS session in the SP-10 register that covers the requirement' };
    }
    case 'PRODUCTION_VERIFIED':
      return { holds: false, why: 'no production evidence kind is defined yet (TEST-SCOPE v1); the label cannot be claimed' };
    default:
      return { holds: false, why: `unknown label ${label}` };
  }
}

/** Build the whole ledger from the tree. */
export function buildLedger(root = ROOT) {
  const ledger = JSON.parse(readFileSync(join(root, LEDGER_FILE), 'utf8'));
  const tests = scanTests(root);
  const register = existsSync(join(root, REGISTER_FILE)) ? readFileSync(join(root, REGISTER_FILE), 'utf8') : '';
  const sessions = parseRegister(register);
  const exists = (p) => existsSync(join(root, p));
  const items = (ledger.items ?? []).map((item) => {
    const ev = evidenceFor(item, tests, sessions, exists);
    const verdict = labelHolds(item.label, ev);
    return { id: item.id, label: item.label, counts: Object.fromEntries(KINDS.map((k) => [k, ev[k].length])), files: ev, holds: verdict.holds, why: verdict.why };
  });
  const totals = Object.fromEntries(KINDS.map((k) => [k, items.filter((i) => i.counts[k] > 0).length]));
  const labels = {};
  for (const i of items) labels[i.label] = (labels[i.label] ?? 0) + 1;
  return {
    scopeVersion: SCOPE_VERSION,
    sources: { ledger: LEDGER_FILE, register: REGISTER_FILE, scope: SCOPE_FILE },
    testFiles: tests.size,
    sessions: { total: sessions.length, pass: sessions.filter((s) => s.outcome === 'PASS').length, onDevice: sessions.filter((s) => s.outcome === 'PASS' && s.device).length },
    labels, totals,
    notHolding: items.filter((i) => !i.holds).map((i) => i.id),
    items,
  };
}

export function renderMarkdown(l) {
  const L = [];
  L.push(`# Evidence ledger ${l.scopeVersion} — what kind of proof each controlling requirement has`);
  L.push('');
  L.push(`_Generated by \`scripts/evidence-ledger.mjs\` from \`${l.sources.ledger}\`, the test tree and \`${l.sources.register}\`. Do not edit by hand:_`);
  L.push(`_\`node scripts/evidence-ledger.mjs\` rewrites it and \`--check\` (run by CI) refuses a stale copy. The kinds, the suites that produce them and the label rule are stated in \`${l.sources.scope}\` (${l.scopeVersion})._`);
  L.push('');
  L.push('## What the columns mean');
  L.push('');
  L.push('| Column | A requirement has it when |');
  L.push('|---|---|');
  L.push('| Unit | a test under `tests/unit` cites it (an engine in isolation) |');
  L.push('| Integration (in-process) | a test under `tests/integration`, `tests/migration`, `tests/security` or `tests/contract` cites it (the real API or box assembly, in one process) |');
  L.push('| Real PostgreSQL | such a test needs `DATABASE_URL` — it runs on a real database in the required CI job |');
  L.push('| Browser (stub cloud) | a test under `tests/e2e` cites it — real Chromium drives the real screen against a stub or in-process cloud |');
  L.push('| Browser (connected) | that browser test also needs `DATABASE_URL` — the screen, the box and the real cloud on PostgreSQL in one run |');
  L.push('| Device | a PASS session in the SP-10 register on real hardware covers it |');
  L.push('| Staff UAT | a PASS session in the SP-10 register covers it |');
  L.push('| Label holds | the item\'s maturity label is allowed by the kinds it has (the rule in TEST-SCOPE §4) |');
  L.push('');
  L.push('## Totals');
  L.push('');
  L.push(`- Evidence test files scanned: ${l.testFiles}. SP-10 sessions: ${l.sessions.total} (${l.sessions.pass} PASS, ${l.sessions.onDevice} on real hardware).`);
  L.push(`- Requirements with at least one proof of each kind: ${KINDS.map((k) => `${KIND_TITLES[k]} ${l.totals[k]}`).join(' · ')}.`);
  L.push(`- Labels: ${Object.entries(l.labels).sort().map(([k, v]) => `${k} ${v}`).join(' · ')}.`);
  L.push(`- Labels that do NOT hold: ${l.notHolding.length === 0 ? 'none' : l.notHolding.join(', ')}.`);
  L.push('');
  L.push('## The ledger');
  L.push('');
  L.push(`| ID | Label | ${KINDS.map((k) => KIND_TITLES[k]).join(' | ')} | Label holds |`);
  L.push(`|---|---|${KINDS.map(() => '---:').join('|')}|---|`);
  for (const i of l.items) {
    L.push(`| ${i.id} | ${i.label} | ${KINDS.map((k) => (i.counts[k] === 0 ? '·' : String(i.counts[k]))).join(' | ')} | ${i.holds ? '✓' : '✗'} ${i.why} |`);
  }
  L.push('');
  L.push('## The files behind the counts');
  L.push('');
  L.push('_The JSON twin (`evidence-ledger.json`) lists every file and session per item. Here, the browser and connected files only — the ones a label rests on._');
  L.push('');
  for (const i of l.items) {
    if (i.files.browser.length === 0 && i.files.uat.length === 0) continue;
    const parts = [];
    if (i.files.browser.length > 0) parts.push(`browser: ${i.files.browser.map((f) => `\`${f.replace('tests/e2e/', '')}\``).join(', ')}`);
    if (i.files.connected.length > 0) parts.push(`connected: ${i.files.connected.map((f) => `\`${f.replace('tests/e2e/', '')}\``).join(', ')}`);
    if (i.files.realDb.length > 0) parts.push(`real PostgreSQL: ${i.files.realDb.map((f) => `\`${f.replace(/^tests\/[a-z-]+\//, '')}\``).join(', ')}`);
    if (i.files.uat.length > 0) parts.push(`UAT: ${i.files.uat.join(', ')}`);
    L.push(`- **${i.id}** — ${parts.join(' · ')}`);
  }
  L.push('');
  return `${L.join('\n')}\n`;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes('--check');
  const ledger = buildLedger();
  const md = renderMarkdown(ledger);
  const json = `${JSON.stringify(ledger, null, 2)}\n`;
  const sha = process.env['GITHUB_SHA'] ? ` at ${process.env['GITHUB_SHA'].slice(0, 7)}` : '';
  if (check) {
    const problems = [];
    const have = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');
    if (have(OUT_MD) !== md) problems.push(`${OUT_MD} differs from the tree — run: node scripts/evidence-ledger.mjs`);
    if (have(OUT_JSON) !== json) problems.push(`${OUT_JSON} differs from the tree — run: node scripts/evidence-ledger.mjs`);
    if (ledger.notHolding.length > 0) problems.push(`labels that outrun their proof: ${ledger.notHolding.join(', ')} (see ${OUT_MD})`);
    if (problems.length > 0) { console.error(`::error::${problems.join('; ')}`); process.exit(1); }
    console.log(`evidence ledger ${SCOPE_VERSION}${sha}: current; ${ledger.items.length} items, every label holds; ${ledger.testFiles} test files, ${ledger.sessions.total} SP-10 sessions`);
  } else {
    writeFileSync(join(ROOT, OUT_MD), md);
    writeFileSync(join(ROOT, OUT_JSON), json);
    console.log(`wrote ${OUT_MD} and ${OUT_JSON}${sha}: ${ledger.items.length} items; labels not holding: ${ledger.notHolding.length === 0 ? 'none' : ledger.notHolding.join(', ')}`);
  }
}
