import { describe, it, expect } from 'vitest';
import {
  parseSemgrepJson, parseTrivyJson, parseZapJson, parsePnpmAuditJson, readScanReport, importScan, blockingObservations,
  recordPersonFinding, markPersonFindingFixed, assignFindingOwner, findingBlocks, overdueFindings, summariseFindings,
  findingIdOf, fixDueByFor, shortDigest,
  NotAScanReportError, StaleScanError, ScannerFindingCloseError, FixNeedsEvidenceError, NotAPersonFindingError,
  type ScanReport, type SecurityFinding, type FindingObservation,
} from '../../packages/compliance/src/index';

// QG-03 / QG-06 (roadmap §22 "zero open critical/high findings", §32 "emergency fix ≤72 h", §35 "SAST/DAST/SCA/
// container/IaC/secret scans"): scanner output becomes recorded findings. These prove the engine that turns each
// tool's own JSON into findings, and the rules for how a finding opens, reopens, closes and blocks a gate.

const T0 = '2026-10-23T08:00:00.000Z';
const T1 = '2026-10-24T08:00:00.000Z';

const semgrep = {
  results: [
    { check_id: 'javascript.express.security.audit.xss.direct-response-write', path: 'services/a.ts', start: { line: 10 }, extra: { message: 'Direct response write\nmore', severity: 'ERROR' } },
    { check_id: 'javascript.express.security.audit.xss.direct-response-write', path: 'services/a.ts', start: { line: 40 }, extra: { message: 'Direct response write', severity: 'ERROR' } },
    { check_id: 'javascript.lang.correctness.useless-eqeq', path: 'services/b.ts', start: { line: 3 }, extra: { message: 'useless', severity: 'WARNING' } },
    { check_id: 'x.info', path: 'services/c.ts', start: { line: 1 }, extra: { message: 'fyi', severity: 'INFO' } },
  ],
  errors: [
    { level: 'warn', type: 'Timeout', path: 'big.ts' }, { level: 'warn', type: 'Timeout', path: 'big.ts' },
    { level: 'error', type: 'Syntax error', path: 'broken.ts' }, { level: 'warn', type: ['PartialParsing', []], spans: [{ file: 'part.ts' }] },
  ],
};

const trivyImage = {
  ArtifactName: 'sre-api:ci',
  Results: [
    { Target: 'sre-api:ci (debian 12.8)', Vulnerabilities: [
      { VulnerabilityID: 'CVE-2026-0001', PkgName: 'openssl', InstalledVersion: '3.0.1', FixedVersion: '3.0.9', Severity: 'CRITICAL', Title: 'buffer overflow' },
      { VulnerabilityID: 'CVE-2026-0002', PkgName: 'zlib', InstalledVersion: '1.2', Severity: 'LOW', Title: 'minor' },
      { VulnerabilityID: 'CVE-2026-0003', PkgName: 'libx', InstalledVersion: '1', Severity: 'UNKNOWN' },
    ] },
    { Target: 'app/node_modules', Secrets: [{ RuleID: 'aws-access-key-id', Title: 'AWS Access Key', Severity: 'CRITICAL', StartLine: 3, Match: 'AKIA-the-real-thing' }] },
  ],
};

const trivyConfig = {
  ArtifactName: 'infra',
  Results: [
    { Target: 'docker/api.Dockerfile', Misconfigurations: [
      { ID: 'DS002', Title: 'Image user should not be root', Severity: 'HIGH', Status: 'FAIL', Message: 'Specify at least 1 USER', CauseMetadata: { StartLine: 0 } },
      { ID: 'DS026', Title: 'No HEALTHCHECK', Severity: 'LOW', Status: 'PASS' },
    ] },
  ],
};

const zap = {
  site: [{ '@name': 'http://127.0.0.1:8081', alerts: [
    { pluginid: '10038', alert: 'Content Security Policy (CSP) Header Not Set', riskcode: '2', instances: [{ uri: 'http://127.0.0.1:8081/readyz?x=1', method: 'GET' }, { uri: 'http://127.0.0.1:8081/', method: 'GET' }] },
    { pluginid: '40012', alert: 'Cross Site Scripting (Reflected)', riskcode: '3', instances: [{ uri: 'http://127.0.0.1:8081/search', method: 'GET', param: 'q' }] },
    { pluginid: '10096', alert: 'Timestamp Disclosure', riskcode: '0', instances: [] },
  ] }],
};

const audit = { advisories: { '1': { id: 1, module_name: 'lodash', severity: 'high', title: 'Prototype pollution', github_advisory_id: 'GHSA-aaaa' }, '2': { id: 2, module_name: 'ms', severity: 'moderate', title: 'ReDoS' } } };

const report = (observations: readonly FindingObservation[], over: Partial<ScanReport> = {}): ScanReport => ({
  tool: observations[0]?.tool ?? 'semgrep', source: observations[0]?.source ?? 'sast', runId: 'run-1', scannedAt: T0, complete: true, observations, ...over,
});

describe('each scanner\'s own JSON becomes findings, with the tool\'s severity word kept (§35)', () => {
  it('Semgrep: ERROR → high, WARNING → medium, INFO → low; any file it could not fully scan makes the run incomplete', () => {
    const { observations, incompleteBecause } = parseSemgrepJson(semgrep);
    expect(observations.map((o) => [o.severity, o.toolSeverity])).toEqual([['high', 'ERROR'], ['high', 'ERROR'], ['medium', 'WARNING'], ['low', 'INFO']]);
    expect(observations[0]).toMatchObject({ source: 'sast', tool: 'semgrep', location: 'services/a.ts:10', title: 'Direct response write' });
    // Two hits of one rule in one file are two findings, keyed by which occurrence — not by the line number.
    expect(new Set(observations.map((o) => o.fingerprint)).size).toBe(4);
    // A rule that timed out is a gap even at "warn" level — each gap named once.
    expect(incompleteBecause).toEqual([
      'semgrep could not fully scan big.ts: Timeout', 'semgrep could not fully scan broken.ts: Syntax error', 'semgrep could not fully scan part.ts: PartialParsing',
    ]);
  });

  it('Semgrep: a rule loaded from a local folder is named by its own id, the same on every machine', () => {
    const local = (folder: string) => parseSemgrepJson({ results: [{ ...semgrep.results[0]!, check_id: `${folder}.sast-rules.javascript.express.xss` }] }).observations[0]!;
    expect(local('home.runner.work._temp').ruleId).toBe('javascript.express.xss');
    expect(local('tmp.scratch').fingerprint).toBe(local('home.runner.work._temp').fingerprint);
  });

  it('Semgrep: the same problem moved down the file keeps its fingerprint (its 72-hour clock is not reset by an edit)', () => {
    const moved = { results: [{ ...semgrep.results[2]!, start: { line: 300 } }] };
    expect(parseSemgrepJson(moved).observations[0]!.fingerprint).toBe(parseSemgrepJson({ results: [semgrep.results[2]] }).observations[0]!.fingerprint);
  });

  it('Trivy image: vulnerabilities by severity, an UNKNOWN kept as said and rated medium, secrets never copied', () => {
    const obs = parseTrivyJson(trivyImage, 'container');
    expect(obs.map((o) => [o.ruleId, o.severity, o.toolSeverity])).toEqual([
      ['CVE-2026-0001', 'critical', 'CRITICAL'], ['CVE-2026-0002', 'low', 'LOW'], ['CVE-2026-0003', 'medium', 'UNKNOWN'], ['aws-access-key-id', 'critical', 'CRITICAL'],
    ]);
    expect(obs[0]!.title).toContain('fixed in 3.0.9');
    expect(obs[1]!.title).toContain('no fix released yet');
    expect(JSON.stringify(obs)).not.toContain('AKIA-the-real-thing'); // hard rule #4: the matched secret never reaches the register
  });

  it('Trivy config: only FAILED checks, with the file and line', () => {
    const obs = parseTrivyJson(trivyConfig, 'iac');
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ source: 'iac', tool: 'trivy-config', ruleId: 'DS002', severity: 'high', location: 'docker/api.Dockerfile' });
    // A config run is its own tool: it never closes an image vulnerability it did not look for.
    const image = importScan([], report(parseTrivyJson(trivyImage, 'container'))).changes;
    expect(image.every((f) => f.tool === 'trivy-image')).toBe(true);
    expect(importScan(image, report(obs, { scannedAt: T1 })).summary.fixed).toBe(0);
  });

  it('ZAP: riskcode 3 → high, 2 → medium, 0 → info; one finding per alert × URL (query dropped) × parameter', () => {
    const obs = parseZapJson(zap);
    expect(obs.map((o) => [o.ruleId, o.severity, o.location])).toEqual([
      ['10038', 'medium', 'GET http://127.0.0.1:8081/readyz'], ['10038', 'medium', 'GET http://127.0.0.1:8081/'],
      ['40012', 'high', 'GET http://127.0.0.1:8081/search (q)'], ['10096', 'info', 'http://127.0.0.1:8081'],
    ]);
  });

  it('pnpm audit: moderate → medium; one finding per advisory', () => {
    const obs = parsePnpmAuditJson(audit);
    expect(obs.map((o) => [o.ruleId, o.severity])).toEqual([['GHSA-aaaa', 'high'], ['2', 'medium']]);
  });

  it('refuses a document that is not the tool\'s report rather than reading it as "nothing found" (P-08)', () => {
    expect(() => parseSemgrepJson({})).toThrow(NotAScanReportError);
    expect(() => parseTrivyJson([], 'container')).toThrow(NotAScanReportError);
    expect(() => parseZapJson({ sites: [] })).toThrow(NotAScanReportError);
    expect(() => parsePnpmAuditJson({ vulnerabilities: {} })).toThrow(NotAScanReportError);
  });

  it('a CI run fails on exactly the critical and high observations', () => {
    const obs = [...parseTrivyJson(trivyImage, 'container')];
    expect(blockingObservations({ observations: obs }).map((o) => o.ruleId)).toEqual(['CVE-2026-0001', 'aws-access-key-id']);
    expect(blockingObservations({ observations: parseSemgrepJson({ results: [semgrep.results[2]] }).observations })).toEqual([]);
  });
});

describe('a scan report is checked before anything is recorded', () => {
  it('names every problem at once', () => {
    try {
      readScanReport({ tool: '', source: 'pentest', runId: 1, scannedAt: 'yesterday', observations: [{}] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NotAScanReportError);
      const p = (e as NotAScanReportError).problems.join(' | ');
      for (const word of ['tool', 'source', 'runId', 'scannedAt', 'complete', 'observation 0']) expect(p).toContain(word);
    }
  });

  it('reads a well-formed report, keeping why it was incomplete', () => {
    const obs = parseSemgrepJson(semgrep).observations;
    const r = readScanReport({ tool: 'semgrep', source: 'sast', runId: 'r', scannedAt: T0, complete: false, incompleteBecause: ['x'], observations: obs, commit: 'abc' });
    expect(r).toMatchObject({ complete: false, incompleteBecause: ['x'], commit: 'abc' });
    expect(r.observations).toHaveLength(4);
  });
});

describe('importing runs: open, still open, fixed by a clean complete scan, reopened', () => {
  const obsA = parseTrivyJson(trivyImage, 'container');

  it('opens a finding per observation; a critical gets the §32 72-hour clock, nothing else does', () => {
    const { changes, summary } = importScan([], report(obsA));
    expect(summary).toMatchObject({ opened: 4, fixed: 0, reopened: 0, complete: true });
    const crit = changes.find((f) => f.ruleId === 'CVE-2026-0001')!;
    expect(crit).toMatchObject({ status: 'open', firstSeenAt: T0, openedAt: T0, openedBy: 'scan:run-1', reopenCount: 0 });
    expect(crit.fixDueBy).toBe('2026-10-26T08:00:00.000Z');
    expect(changes.find((f) => f.ruleId === 'CVE-2026-0002')!.fixDueBy).toBeUndefined();
    expect(crit.ownerUserId).toBeUndefined();
  });

  it('a second run that still sees them changes nothing (no noise on the register)', () => {
    const first = importScan([], report(obsA)).changes;
    const second = importScan(first, report(obsA, { runId: 'run-2', scannedAt: T1 }), T0);
    expect(second.changes).toEqual([]);
    expect(second.summary).toMatchObject({ stillOpen: 4, opened: 0, fixed: 0 });
  });

  it('a COMPLETE run that no longer sees one closes it, naming the run as the evidence', () => {
    const first = importScan([], report(obsA)).changes;
    const second = importScan(first, report(obsA.slice(1), { runId: 'run-2', scannedAt: T1, commit: 'c0ffee' }), T0);
    expect(second.summary.fixed).toBe(1);
    expect(second.changes[0]).toMatchObject({ ruleId: 'CVE-2026-0001', status: 'fixed', fixedAt: T1, fixedBy: 'scan:run-2' });
    expect(second.changes[0]!.fixedEvidence).toContain('complete trivy-image scan run-2 of commit c0ffee');
  });

  it('a PARTIAL run closes nothing — a scan that did not look is not evidence the problem is gone', () => {
    const first = importScan([], report(obsA)).changes;
    const partial = importScan(first, report([], { tool: 'trivy-image', source: 'container', runId: 'run-2', scannedAt: T1, complete: false }), T0);
    expect(partial.changes).toEqual([]);
    expect(partial.summary).toMatchObject({ fixed: 0, closedNothingBecausePartial: true });
  });

  it('a finding that comes back is REOPENED and its clock restarts from the reopen', () => {
    const first = importScan([], report(obsA)).changes;
    const fixed = importScan(first, report(obsA.slice(1), { runId: 'run-2', scannedAt: T1 }), T0).changes;
    const register = [...first.filter((f) => f.ruleId !== 'CVE-2026-0001'), ...fixed];
    const back = importScan(register, report(obsA, { runId: 'run-3', scannedAt: '2026-10-25T08:00:00.000Z' }), T1);
    expect(back.summary.reopened).toBe(1);
    expect(back.changes[0]).toMatchObject({ status: 'open', firstSeenAt: T0, openedAt: '2026-10-25T08:00:00.000Z', reopenCount: 1, openedBy: 'scan:run-3' });
    expect(back.changes[0]!.fixDueBy).toBe('2026-10-28T08:00:00.000Z');
    expect(back.changes[0]!.fixedAt).toBeUndefined();
  });

  it('a re-rated finding is a new state; it never touches another tool\'s findings', () => {
    const first = importScan([], report(obsA)).changes;
    const rerated = obsA.map((o) => (o.ruleId === 'CVE-2026-0002' ? { ...o, severity: 'high' as const } : o));
    const second = importScan(first, report(rerated, { runId: 'run-2', scannedAt: T1 }), T0);
    expect(second.changes.map((f) => [f.ruleId, f.severity])).toEqual([['CVE-2026-0002', 'high']]);
    const semgrepRun = importScan(first, report(parseSemgrepJson(semgrep).observations, { scannedAt: T1 }));
    expect(semgrepRun.summary.fixed).toBe(0); // the trivy findings are not semgrep's to close
  });

  it('refuses a run older than the newest one already imported', () => {
    expect(() => importScan([], report(obsA, { scannedAt: T0 }), T1)).toThrow(StaleScanError);
  });

  it('a run that reports one thing twice records it once', () => {
    const twice = importScan([], report([obsA[0]!, obsA[0]!]));
    expect(twice.changes).toHaveLength(1);
  });
});

describe('a person\'s finding (penetration test, review), owners, and how it closes', () => {
  const pt = (over: Partial<Parameters<typeof recordPersonFinding>[0]> = {}) => recordPersonFinding({
    findingId: 'PT-2026-01', source: 'pentest', title: 'Session not revoked on logout', severity: 'critical', location: '/v1/identity', recordedBy: 'u-owner', at: T0, ...over,
  });

  it('records it in a named person\'s name with the clock; restating keeps the first sighting', () => {
    const f = pt();
    expect(f).toMatchObject({ status: 'open', openedBy: 'person:u-owner', fixDueBy: '2026-10-26T08:00:00.000Z', source: 'pentest' });
    const restated = pt({ title: 'Session not revoked on logout (all tabs)', at: T1, prior: f, ownerUserId: 'u-dev' });
    expect(restated).toMatchObject({ firstSeenAt: T0, openedAt: T0, fixDueBy: f.fixDueBy, ownerUserId: 'u-dev' });
  });

  it('refuses a scanner source, a bad id, a missing severity, and restating a scanner finding by hand', () => {
    expect(() => pt({ source: 'sast' })).toThrow(NotAPersonFindingError);
    expect(() => pt({ findingId: 'a/b' })).toThrow(NotAPersonFindingError);
    expect(() => pt({ severity: 'severe' })).toThrow(NotAPersonFindingError);
    const scanner = importScan([], report(parseTrivyJson(trivyImage, 'container'))).changes[0]!;
    expect(() => pt({ findingId: scanner.findingId, prior: scanner })).toThrow(/scanner finding and cannot be restated/);
  });

  it('a person\'s finding closes with a named fixer and written evidence; a scanner finding never by hand', () => {
    const fixed = markPersonFindingFixed(pt(), 'u-dev', ' retested by the tester on 25 Oct ', T1);
    expect(fixed).toMatchObject({ status: 'fixed', fixedBy: 'u-dev', fixedEvidence: 'retested by the tester on 25 Oct', fixedAt: T1 });
    expect(() => markPersonFindingFixed(pt(), 'u-dev', '  ', T1)).toThrow(FixNeedsEvidenceError);
    const scanner = importScan([], report(parseTrivyJson(trivyImage, 'container'))).changes[0]!;
    expect(() => markPersonFindingFixed(scanner, 'u-dev', 'trust me', T1)).toThrow(ScannerFindingCloseError);
    expect(assignFindingOwner(scanner, ' u-dev ').ownerUserId).toBe('u-dev');
    expect(() => assignFindingOwner(scanner, '')).toThrow(NotAPersonFindingError);
  });
});

describe('what the gates read (§22 QG-06 "zero open critical/high findings"; QG-03 "security scans … green")', () => {
  const register = (): SecurityFinding[] => [...importScan([], report(parseTrivyJson(trivyImage, 'container'))).changes];

  it('an open critical or high blocks QG-06, and QG-03 too when a CI scanner raised it; medium/low/info never block', () => {
    const blocks = findingBlocks(register());
    expect(blocks.map((b) => `${b.gate}:${b.severity}`).sort()).toEqual(['QG-03:critical', 'QG-03:critical', 'QG-06:critical', 'QG-06:critical']);
    expect(blocks[0]!.reason).toContain('nobody owns it yet');
    const person = recordPersonFinding({ findingId: 'PT-1', source: 'pentest', title: 't', severity: 'high', location: 'x', recordedBy: 'u', at: T0, ownerUserId: 'u-dev' });
    expect(findingBlocks([person]).map((b) => b.gate)).toEqual(['QG-06']);
    expect(findingBlocks([person])[0]!.reason).toContain('u-dev owns it');
  });

  it('a fixed finding blocks nothing', () => {
    const p = markPersonFindingFixed(recordPersonFinding({ findingId: 'PT-1', source: 'pentest', title: 't', severity: 'critical', location: 'x', recordedBy: 'u', at: T0 }), 'u', 'done', T1);
    expect(findingBlocks([p])).toEqual([]);
  });

  it('an open critical past 72 hours is overdue and counted; the summary counts open by severity and the unowned', () => {
    const r = register();
    expect(overdueFindings(r, '2026-10-26T07:59:59.000Z')).toEqual([]);
    expect(overdueFindings(r, '2026-10-26T08:00:01.000Z').map((f) => f.ruleId)).toEqual(['CVE-2026-0001', 'aws-access-key-id']);
    expect(summariseFindings(r, '2026-10-27T00:00:00.000Z')).toEqual({
      open: { critical: 2, high: 0, medium: 1, low: 1, info: 0 }, openBlocking: 2, overdueCritical: 2, unowned: 4, fixed: 0,
    });
  });
});

describe('ids and clocks', () => {
  it('ids are stable, URL-safe and distinct; the clock exists only for a critical', () => {
    expect(findingIdOf('Trivy', 'a')).toBe(findingIdOf('Trivy', 'a'));
    expect(findingIdOf('Trivy', 'a')).not.toBe(findingIdOf('Trivy', 'b'));
    expect(findingIdOf('pnpm audit', 'a')).toMatch(/^pnpm-audit-[0-9a-f]{16}$/);
    expect(shortDigest('')).toMatch(/^[0-9a-f]{16}$/);
    expect(fixDueByFor('high', T0)).toBeUndefined();
    expect(fixDueByFor('critical', T0)).toBe('2026-10-26T08:00:00.000Z');
  });
});
