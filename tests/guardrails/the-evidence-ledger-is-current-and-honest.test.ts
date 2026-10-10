import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { buildLedger, parseRegister, renderMarkdown, LEDGER_FILE, OUT_JSON, OUT_MD, REGISTER_FILE, SCOPE_FILE, SCOPE_VERSION } from '../../scripts/evidence-ledger.mjs';

/**
 * **The evidence ledger is current and honest (audit GT-08 · PF-15 · GT-09 · QG-02 · hard rule #9 · P-08).**
 *
 * The completion ledger says how mature each of the 104 controlling requirements is; the evidence ledger says what
 * KIND of proof stands behind that label — unit, in-process integration, real PostgreSQL, browser against a stub
 * cloud, browser connected to the real cloud, device, staff UAT — derived from the test tree and the SP-10 register.
 * This pins what makes it a control rather than a document:
 *
 *   1. the committed ledger equals what the tree says right now (`--check`), so it cannot go stale silently;
 *   2. every label is allowed by the kinds behind it (the rule in TEST-SCOPE §4) — a label that outruns its proof
 *      fails the build, and a label can only move up by adding the proof;
 *   3. the test-scope statement and the ledger carry the same version, and the statement names the CI jobs that
 *      actually exist and are required;
 *   4. CI runs the check on every build;
 *   5. the SP-10 register is the only source of device and staff evidence, its session count agrees with its own
 *      status line, and no item claims staff acceptance while the register is empty;
 *   6. the ledger's own evidence prose names only files that exist (a cited file that was renamed is a lie).
 */

const ledger = buildLedger();
const scope = readFileSync(SCOPE_FILE, 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const register = readFileSync(REGISTER_FILE, 'utf8');

describe('the committed ledger is what the tree says', () => {
  it('--check passes: the markdown and the JSON equal a fresh generation and every label holds', () => {
    const out = execFileSync(process.execPath, ['scripts/evidence-ledger.mjs', '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/evidence ledger v\d+.*: current; 104 items, every label holds/);
  });

  it('the committed markdown is the rendering of the committed JSON (no hand edits)', () => {
    expect(existsSync(OUT_MD) && existsSync(OUT_JSON)).toBe(true);
    const json = JSON.parse(readFileSync(OUT_JSON, 'utf8')) as Parameters<typeof renderMarkdown>[0];
    expect(readFileSync(OUT_MD, 'utf8')).toBe(renderMarkdown(json));
  });
});

describe('every label is allowed by the kinds behind it', () => {
  it('no label outruns its proof', () => {
    expect(ledger.notHolding, 'items whose label the evidence rule refuses').toEqual([]);
  });

  it('E2E_VERIFIED items each have a browser test, an integration test and a cloud-effect proof on PostgreSQL', () => {
    for (const item of ledger.items.filter((i) => i.label === 'E2E_VERIFIED')) {
      expect(item.counts['browser'], `${item.id} browser`).toBeGreaterThan(0);
      expect(item.counts['integration'], `${item.id} integration`).toBeGreaterThan(0);
      expect((item.counts['realDb'] ?? 0) + (item.counts['connected'] ?? 0), `${item.id} cloud effect`).toBeGreaterThan(0);
    }
  });

  it('INTEGRATION_TESTED items each have an integration test; nothing claims UAT or production yet', () => {
    for (const item of ledger.items.filter((i) => i.label === 'INTEGRATION_TESTED')) expect(item.counts['integration'], item.id).toBeGreaterThan(0);
    expect(ledger.items.filter((i) => i.label === 'UAT_VERIFIED' || i.label === 'PRODUCTION_VERIFIED')).toEqual([]);
  });

  it('the ledger covers exactly the 104 controlling requirements of the completion ledger', () => {
    const ids = (JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ledger.items.map((i) => i.id)).toEqual(ids);
    expect(ids.length).toBe(104);
  });
});

describe('the test-scope statement and the ledger agree', () => {
  it('carry the same version', () => {
    expect(scope).toMatch(new RegExp(`^# Test scope statement — ${SCOPE_VERSION} `, 'm'));
    expect(ledger.scopeVersion).toBe(SCOPE_VERSION);
    expect(readFileSync(OUT_MD, 'utf8')).toMatch(new RegExp(`^# Evidence ledger ${SCOPE_VERSION} `, 'm'));
  });

  it('the statement names the five CI jobs, and each exists in the workflow and is needed by the release', () => {
    const jobs = ['Type check, lint, tests, secret & dependency scan', 'Stage gate suites (real PostgreSQL)', 'The container builds, starts, and refuses a bad configuration', 'Browser suites (real Chromium) — required, never skip', 'Performance suites — required, never skip'];
    for (const name of jobs) {
      expect(scope, `statement names "${name}"`).toContain(name);
      expect(ci, `workflow has "${name}"`).toContain(`name: ${name}`);
    }
    expect(ci).toMatch(/needs: \[verify, integration, deploy, browser, performance, identity\]/);
  });

  it('the statement states the label rule the script applies, kind by kind', () => {
    for (const phrase of ['≥ 1 integration test', '≥ 1 browser test', 'real-PostgreSQL test or connected browser test', 'PASS session in the SP-10 register', 'not claimable under v1']) {
      expect(scope, phrase).toContain(phrase);
    }
  });

  it('CI runs the check on every build', () => {
    expect(ci).toMatch(/run: node scripts\/evidence-ledger\.mjs --check/);
  });
});

describe('the SP-10 register is the one source of device and staff evidence', () => {
  it('its sessions parse, and their count agrees with the status line it states about itself', () => {
    const sessions = parseRegister(register);
    const stated = /\| Sessions run \| \*\*(\d+)\*\*/.exec(register);
    expect(stated, 'the register states "Sessions run"').not.toBeNull();
    expect(sessions.length).toBe(Number(stated![1]));
    expect(ledger.sessions.total).toBe(sessions.length);
  });

  it('the session template carries the three lines the ledger reads', () => {
    for (const line of ['**Covers:**', '**Device:**', '**Outcome:**']) expect(register, line).toContain(line);
  });

  it('tripwire — a PASS session on hardware becomes device and UAT evidence; a FAIL or a pending one does not', () => {
    const md = '### UAT-S-1 — 2026-10-20 — store PC abc / demo box def\n**Covers:** M12, M14\n**Device:** Posiflex store PC + Zebra DS2208 scanner\n**Outcome:** PASS\n\n### UAT-S-2 — 2026-10-21 — store PC abc / demo box def\n**Covers:** M09\n**Device:** none\n**Outcome:** FAIL\n';
    const sessions = parseRegister(md);
    expect(sessions.map((s) => [s.id, s.outcome, s.device, [...s.covers]])).toEqual([['UAT-S-1', 'PASS', true, ['M12', 'M14']], ['UAT-S-2', 'FAIL', false, ['M09']]]);
  });
});

describe('the ledger\'s own evidence prose names only files that exist', () => {
  it('every tests/… path cited in completion-status.json is on disk', () => {
    const text = readFileSync(LEDGER_FILE, 'utf8');
    const missing = [...new Set([...text.matchAll(/tests\/[a-z0-9-]+\/[A-Za-z0-9._/-]+\.ts/g)].map((m) => m[0]))].filter((p) => !existsSync(p));
    expect(missing, 'cited test files that do not exist').toEqual([]);
  });
});
