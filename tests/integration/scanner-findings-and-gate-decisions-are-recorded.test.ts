import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { parseTrivyJson, parseSemgrepJson, type FindingObservation } from '../../packages/compliance/src/index';

/**
 * QG-03 · QG-06 · QG-08 · QG-12 (roadmap §22, §32, §35, §36; OB-288 gates lane), on the real API — in memory and (with
 * DATABASE_URL) on real PostgreSQL, with a cold restart:
 *   • a scanner run imported through the API becomes findings; an open critical/high blocks QG-06 (and QG-03); a
 *     scanner finding cannot be closed by hand; a clean COMPLETE run closes it; a run is imported once, never older;
 *   • a person's (penetration-test) finding is recorded, owned and fixed with evidence, in named people's names;
 *   • the gate register starts with every gate undecided (no default); a GO needs evidence and is refused by name while
 *     a finding, a risk or the QG-08 rehearsal reading blocks it; HOLD is recorded; only the owner decides;
 *   • QG-08's reading is GO only after the four rehearsals passed; QG-12 cannot be GO while another gate is undecided;
 *   • `can-pass` agrees with the gate register; everything survives a restart.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash';
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const EVIDENCE = [{ label: 'CI run — every scan green', ref: 'https://github.com/rchezhian81-prog/Hyper-Market-OS-ERP/actions' }];

const IMAGE_SCAN = {
  ArtifactName: 'sre-api:ci',
  Results: [{ Target: 'sre-api:ci (debian 12)', Vulnerabilities: [
    { VulnerabilityID: 'CVE-2026-1111', PkgName: 'openssl', InstalledVersion: '3.0.1', FixedVersion: '3.0.9', Severity: 'CRITICAL', Title: 'overflow' },
    { VulnerabilityID: 'CVE-2026-2222', PkgName: 'zlib', InstalledVersion: '1.2', Severity: 'MEDIUM', Title: 'minor' },
  ] }],
};
const report = (observations: readonly FindingObservation[], runId: string, scannedAt: string, complete = true) =>
  ({ tool: 'trivy-image', source: 'container', runId, scannedAt, complete, commit: 'a'.repeat(40), observations });

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly name: string; readonly make: () => { harness: (store?: EventStore) => ApiHarness } }
const backings: Backing[] = [{
  name: 'the in-memory event store',
  make: () => { let kept: EventStore | undefined; return { harness: (store) => { const h = apiHarness(store === undefined ? {} : { store }); kept = kept ?? h.store; return h; } }; },
}];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    make: () => ({ harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } }),
  });
}

describe.each(backings)('scanner findings and gate decisions are recorded — on $name', ({ make }) => {
  it('findings block QG-06/QG-03 until a clean complete scan; the gate register refuses GO over a blocker; QG-08 and QG-12 read their own conditions; a cold restart keeps it all', async () => {
    const world = make();
    const h = world.harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASHIER, 'cashier');
    const call = (hh: ApiHarness, method: 'GET' | 'POST', path: string, user: string, body?: unknown, query?: Record<string, string>) =>
      hh.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    type Reg = { gates: { gate: string; state: string; decision: string | null; blockers: { kind: string; ref: string }[] }[]; summary: { undecided: number } };
    const register = async (hh: ApiHarness = h) => (await ok(call(hh, 'GET', '/v1/compliance/gate-register', MGR, undefined, { release: 'R5' }), 'register')).body as Reg;
    const gateOf = async (gate: string, hh: ApiHarness = h) => (await register(hh)).gates.find((g) => g.gate === gate)!;
    const decide = (gate: string, decision: string, user = OWNER, evidence: unknown = EVIDENCE, hh: ApiHarness = h) =>
      call(hh, 'POST', `/v1/compliance/gate-decisions/${gate}/R5`, user, { decision, evidence, rationale: `${decision} on the recorded evidence` });

    // ── 0 · A fresh register: every gate undecided, none GO and none HOLD (silence is not approval).
    const fresh = await register();
    expect(fresh.gates).toHaveLength(12);
    expect(fresh.gates.every((g) => g.state === 'undecided' && g.decision === null)).toBe(true);
    expect(fresh.summary.undecided).toBe(12);

    // ── 1 · A container-image scan arrives: one critical, one medium.
    const obs = parseTrivyJson(IMAGE_SCAN, 'container');
    const imported = await ok(call(h, 'POST', '/v1/compliance/finding-scans', MGR, { report: report(obs, 'ci-100', '2026-10-23T08:00:00.000Z') }), 'import');
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ scan: { opened: 2, fixed: 0, blockingObserved: 1, importedBy: MGR, complete: true }, changed: 2 });
    type FList = { findings: { findingId: string; ruleId: string; status: string; severity: string; fixDueBy?: string; ownerUserId?: string }[]; summary: { openBlocking: number; unowned: number }; blocks: { gate: string }[] };
    const list = (await ok(call(h, 'GET', '/v1/compliance/findings', OWNER), 'list')).body as FList;
    const crit = list.findings.find((f) => f.ruleId === 'CVE-2026-1111')!;
    expect(list.findings[0]!.ruleId).toBe('CVE-2026-1111'); // the critical first
    expect(crit).toMatchObject({ status: 'open', severity: 'critical', fixDueBy: '2026-10-26T08:00:00.000Z' });
    expect(list.summary).toMatchObject({ openBlocking: 1, unowned: 2 });
    expect(list.blocks.map((b) => b.gate).sort()).toEqual(['QG-03', 'QG-06']);

    // The same run again, or an older run, is refused; a broken report and a person without the right are refused.
    expect(codeOf(await call(h, 'POST', '/v1/compliance/finding-scans', MGR, { report: report(obs, 'ci-100', '2026-10-23T08:00:00.000Z') }))).toBe('scan_run_already_imported');
    expect(codeOf(await call(h, 'POST', '/v1/compliance/finding-scans', MGR, { report: report(obs, 'ci-099', '2026-10-22T08:00:00.000Z') }))).toBe('scan_older_than_the_register');
    expect(codeOf(await call(h, 'POST', '/v1/compliance/finding-scans', MGR, { report: { tool: 'trivy' } }))).toBe('not_readable_as_a_scan_report');
    expect((await call(h, 'POST', '/v1/compliance/finding-scans', CASHIER, { report: report(obs, 'ci-101', '2026-10-23T09:00:00.000Z') })).status).toBe(403);
    expect((await call(h, 'GET', '/v1/compliance/findings', CASHIER)).status).toBe(403);

    // A scanner finding cannot be closed by hand — that would silence the scanner. It can be given an owner.
    expect(codeOf(await call(h, 'POST', `/v1/compliance/findings/${crit.findingId}/fixed`, MGR, { evidence: 'patched, trust me' }))).toBe('scanner_finding_closes_on_a_clean_scan');
    await ok(call(h, 'POST', `/v1/compliance/findings/${crit.findingId}/owner`, MGR, { ownerUserId: 'u-dev' }), 'owner');
    expect((await call(h, 'POST', '/v1/compliance/findings/nope/owner', MGR, { ownerUserId: 'u-dev' })).status).toBe(404);

    // ── 2 · QG-06 cannot be GO; can-pass agrees; HOLD is recorded with the evidence; a manager cannot decide.
    expect(codeOf(await decide('QG-06', 'GO'))).toBe('go_refused_while_blocked');
    const canPass = (await ok(call(h, 'GET', '/v1/compliance/gates/QG-06/can-pass', OWNER), 'can-pass')).body as { canPass: boolean; alsoBlockedBy: { kind: string }[] };
    expect(canPass.canPass).toBe(false);
    expect(canPass.alsoBlockedBy.map((b) => b.kind)).toEqual(['finding']);
    expect((await decide('QG-06', 'HOLD', MGR)).status).toBe(403);
    expect(codeOf(await decide('QG-06', 'HOLD', OWNER, []))).toBe('gate_decision_not_readable'); // no evidence, no decision
    expect((await ok(decide('QG-06', 'HOLD'), 'hold')).body).toMatchObject({ decision: { decision: 'HOLD', decidedBy: OWNER } });
    expect(await gateOf('QG-06')).toMatchObject({ state: 'HOLD', decision: 'HOLD' });

    // A partial scan that does not see the critical closes nothing.
    const partial = await ok(call(h, 'POST', '/v1/compliance/finding-scans', MGR, { report: report([], 'ci-101', '2026-10-23T10:00:00.000Z', false) }), 'partial');
    expect(partial.body).toMatchObject({ scan: { fixed: 0, closedNothingBecausePartial: true } });

    // ── 3 · The image is rebuilt; a COMPLETE scan no longer sees the critical → it is fixed, QG-06 may now be GO.
    const clean = await ok(call(h, 'POST', '/v1/compliance/finding-scans', MGR, { report: report(obs.filter((o) => o.severity !== 'critical'), 'ci-102', '2026-10-24T08:00:00.000Z') }), 'clean');
    expect(clean.body).toMatchObject({ scan: { fixed: 1, stillOpen: 1 } });
    expect((await ok(call(h, 'GET', '/v1/compliance/gates/QG-06/can-pass', OWNER), 'can-pass 2')).body).toMatchObject({ canPass: true });

    // A risk registered against QG-06 blocks the GO too, by name.
    await ok(call(h, 'POST', '/v1/compliance/risks/R-PT', MGR, { title: 'no penetration test yet', severity: 'high', ownerUserId: OWNER, blocksGates: ['QG-06'] }), 'risk');
    const refusedByRisk = await decide('QG-06', 'GO');
    expect(codeOf(refusedByRisk)).toBe('go_refused_while_blocked');
    expect(JSON.stringify(refusedByRisk.body)).toContain('no penetration test yet');

    // ── 4 · A penetration-test finding, recorded, owned and fixed in named people's names.
    const pt = await ok(call(h, 'POST', '/v1/compliance/findings/PT-2026-01', MGR, { source: 'pentest', title: 'Session survives logout', severity: 'high', location: '/v1/identity/session' }), 'pentest');
    expect(pt.body).toMatchObject({ finding: { status: 'open', openedBy: `person:${MGR}` } });
    expect(codeOf(await call(h, 'POST', '/v1/compliance/findings/PT-2026-02', MGR, { source: 'sast', title: 'x', severity: 'high', location: 'x' }))).toBe('not_readable_as_a_finding');
    expect(codeOf(await call(h, 'POST', '/v1/compliance/findings/PT-2026-01/fixed', MGR, { evidence: ' ' }))).toBe('fix_needs_evidence');
    expect((await ok(call(h, 'POST', '/v1/compliance/findings/PT-2026-01/fixed', MGR, { evidence: 'retested by the tester, 24 Oct' }), 'pt fixed')).body).toMatchObject({ status: 'fixed', fixedBy: MGR });

    // ── 5 · QG-08: the reading is HOLD until all four rehearsals passed; a GO is refused while it reads HOLD.
    type Rec = { verdict: string; rehearsals: { kind: string; state: string }[] };
    expect(((await ok(call(h, 'GET', '/v1/platform/recovery-gate', OWNER), 'recovery')).body as Rec).verdict).toBe('HOLD');
    expect(codeOf(await decide('QG-08', 'GO'))).toBe('go_refused_while_blocked');
    expect(codeOf(await call(h, 'POST', '/v1/platform/dr-drills', OWNER, { drillId: 'x', rehearsal: 'rollback', service: 'cloud', dataLossSeconds: 0, recoverySeconds: 1 }))).toBe('rehearsal_target_is_fixed');
    expect(codeOf(await call(h, 'POST', '/v1/platform/dr-drills', OWNER, { drillId: 'x', rehearsal: 'fire_drill', dataLossSeconds: 0, recoverySeconds: 1 }))).toBe('unknown_rehearsal_kind');
    for (const [kind, secs] of [['backup_restore', 3_600], ['store_recovery', 600], ['rollback', 900]] as const) {
      await ok(call(h, 'POST', '/v1/platform/dr-drills', OWNER, { drillId: `q4-${kind}`, rehearsal: kind, dataLossSeconds: 0, recoverySeconds: secs }), kind);
    }
    // Incident escalation acknowledged in 20 minutes — over the §32 15-minute target: a FAILED rehearsal, kept.
    await ok(call(h, 'POST', '/v1/platform/dr-drills', OWNER, { drillId: 'q4-esc-1', rehearsal: 'incident_escalation', dataLossSeconds: 0, recoverySeconds: 1_200 }), 'esc fail');
    const afterFail = (await ok(call(h, 'GET', '/v1/platform/recovery-gate', OWNER), 'recovery 2')).body as Rec;
    expect(afterFail.verdict).toBe('HOLD');
    expect(afterFail.rehearsals.find((r) => r.kind === 'incident_escalation')!.state).toBe('failed');
    await ok(call(h, 'POST', '/v1/platform/dr-drills', OWNER, { drillId: 'q4-esc-2', rehearsal: 'incident_escalation', dataLossSeconds: 0, recoverySeconds: 600 }), 'esc pass');
    expect(((await ok(call(h, 'GET', '/v1/platform/recovery-gate', OWNER), 'recovery 3')).body as Rec).verdict).toBe('GO');
    expect((await ok(decide('QG-08', 'GO'), 'qg08 go')).body).toMatchObject({ decision: { decision: 'GO' } });
    expect((await call(h, 'GET', '/v1/platform/recovery-gate', CASHIER)).status).toBe(403);

    // ── 6 · QG-12 cannot be GO while another gate of R5 is undecided; unknown gates/releases are refused by name.
    const q12 = await decide('QG-12', 'GO');
    expect(codeOf(q12)).toBe('go_refused_while_blocked');
    expect(JSON.stringify(q12.body)).toContain('has no GO, HOLD or REWORK decision for R5 yet');
    expect(codeOf(await decide('QG-13', 'HOLD'))).toBe('unknown_gate');
    expect(codeOf(await call(h, 'POST', '/v1/compliance/gate-decisions/QG-01/R9', OWNER, { decision: 'HOLD', evidence: EVIDENCE, rationale: 'x' }))).toBe('unknown_release');
    expect(codeOf(await call(h, 'GET', '/v1/compliance/gate-register', OWNER))).toBe('register_needs_a_release');
    expect((await call(h, 'GET', '/v1/compliance/gate-register', CASHIER, undefined, { release: 'R5' })).status).toBe(403);

    // ── 7 · A later finding turns an earlier GO into GO_NOW_BLOCKED — never quietly still GO (P-08).
    await ok(decide('QG-03', 'HOLD'), 'qg03 hold first');
    // (QG-03 is blocked only by scanner findings; none critical/high is open now, so GO is allowed.)
    await ok(decide('QG-03', 'GO'), 'qg03 go');
    expect(await gateOf('QG-03')).toMatchObject({ state: 'GO', decision: 'GO' });
    const semgrep = parseSemgrepJson({ results: [{ check_id: 'js.xss', path: 'apps/x.ts', start: { line: 4 }, extra: { message: 'xss', severity: 'ERROR' } }] }).observations;
    await ok(call(h, 'POST', '/v1/compliance/finding-scans', MGR, { report: { tool: 'semgrep', source: 'sast', runId: 'ci-103', scannedAt: '2026-10-25T08:00:00.000Z', complete: true, observations: semgrep } }), 'sast');
    expect(await gateOf('QG-03')).toMatchObject({ state: 'GO_NOW_BLOCKED', decision: 'GO' });
    const history = (await ok(call(h, 'GET', '/v1/compliance/gate-decisions/QG-03/R5', OWNER), 'history')).body as { history: { decision: string }[] };
    expect(history.history.map((d) => d.decision)).toEqual(['HOLD', 'GO']); // nothing overwritten

    // ── 8 · Cold restart: a new surface over the same store reads the same registers.
    const restarted = world.harness(h.store);
    expect(await gateOf('QG-08', restarted)).toMatchObject({ state: 'GO' });
    expect(await gateOf('QG-06', restarted)).toMatchObject({ state: 'HOLD' });
    expect(await gateOf('QG-03', restarted)).toMatchObject({ state: 'GO_NOW_BLOCKED' });
    const after = (await ok(call(restarted, 'GET', '/v1/compliance/findings', OWNER), 'list after')).body as FList;
    expect(after.findings.find((f) => f.ruleId === 'CVE-2026-1111')).toMatchObject({ status: 'fixed', ownerUserId: 'u-dev' });
    expect(((await ok(call(restarted, 'GET', '/v1/compliance/finding-scans', OWNER), 'scans')).body as { count: number }).count).toBe(4);
  }, 120_000);
});
