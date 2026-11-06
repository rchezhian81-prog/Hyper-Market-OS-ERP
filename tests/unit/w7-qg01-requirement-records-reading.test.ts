import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  readRequirementRecords, requirementRecordsReport, qg01RequirementRecordsBlockers, qg01ReadingOf, missingFields, REQUIREMENT_RECORDS_TOOL,
  findingBlocks, type SecurityFinding,
} from '../../packages/compliance/src/index';
import { createGatesSession, qg01ReadingView, gatesWords } from '../../apps/web-erp/src/gates-session';

// W7 · QG-01 (roadmap §22 "No build without approved ID, rules, actors, errors, permissions and testable acceptance") — the
// requirement-records reading: the CI guardrail's own check, turned into a findings report head office holds the gate on,
// and the Quality gates page's words for it. Never "passed": a clean reading is evidence for the owner's decision (QG-12).

const rec = (id: string, fields: string) => `## ${id} — something\n\n${fields}\n`;
const FULL = '- **Actors/scope:** Owner.\n- **Rules:** one.\n- **Alt/error:** refused clearly.\n- **Permissions:** owner.\n- **Acceptance:** shown.';
const file = (name: string, ids: readonly string[], body = FULL) => ({ name, text: `# ${name}\n\n${ids.map((i) => rec(i, body)).join('\n')}` });

describe('W7 · QG-01: the requirement-records reading', () => {
  it('reads every record with the guardrail\'s check: complete, missing a field, or not read in full', () => {
    const ok = readRequirementRecords([file('M98.md', ['M98-FR-01', 'M98-FR-02'])], 2);
    expect(ok).toMatchObject({ records: 2, readAll: true, incomplete: [] });
    const gap = readRequirementRecords([file('M98.md', ['M98-FR-01']), file('M99.md', ['M99-FR-01'], FULL.replace('- **Acceptance:** shown.', ''))], 2);
    expect(gap.incomplete).toEqual([{ id: 'M99-FR-01', file: 'M99.md', missing: ['acceptance'] }]);
    expect(gap.detail).toBe('1 of 2 records are missing a field: M99-FR-01 (acceptance criteria)');
    const short = readRequirementRecords([file('M98.md', ['M98-FR-01']), file('notes.md', ['M97-FR-01'])], 2);
    expect(short).toMatchObject({ records: 1, readAll: false });
    expect(missingFields('- **Actors/scope:** Owner. **Alt/error:** **Rules:** one.\n- **Permissions:** owner.\n- **Acceptance:** shown.')).toEqual(['errors']);
  });

  it('becomes a findings report: one HIGH observation per incomplete record, incomplete when not read in full', () => {
    const gap = readRequirementRecords([file('M98.md', ['M98-FR-01'], FULL.replace('- **Rules:** one.\n', ''))], 1);
    const r = requirementRecordsReport(gap, { runId: 'gh-1-1', scannedAt: '2026-11-04T08:00:00.000Z', commit: 'a'.repeat(40) });
    expect(r).toMatchObject({ tool: REQUIREMENT_RECORDS_TOOL, source: 'repository', complete: true, commit: 'a'.repeat(40) });
    expect(r.observations).toEqual([expect.objectContaining({ severity: 'high', title: 'QG-01: M98-FR-01 is missing business rules', location: 'docs/requirements/M98.md M98-FR-01', ruleId: 'missing:rules' })]);
    const short = requirementRecordsReport(readRequirementRecords([], 144), { runId: 'gh-2-1', scannedAt: '2026-11-04T09:00:00.000Z' });
    expect(short.complete).toBe(false);
    expect(short.incompleteBecause?.[0]).toMatch(/read 0 requirement records/);
  });

  it('holds QG-01 as NOT KNOWN with no reading or an incomplete latest one; a finding of it blocks QG-01 only', () => {
    expect(qg01RequirementRecordsBlockers([]).map((b) => [b.gate, b.ref])).toEqual([['QG-01', 'requirement-records:no-reading']]);
    const scans = [{ tool: REQUIREMENT_RECORDS_TOOL, scannedAt: '2026-11-04T08:00:00.000Z', complete: true, runId: 'a' }, { tool: REQUIREMENT_RECORDS_TOOL, scannedAt: '2026-11-04T09:00:00.000Z', complete: false, runId: 'b' }];
    expect(qg01RequirementRecordsBlockers(scans).map((b) => b.ref)).toEqual(['requirement-records:not-known:b']);
    expect(qg01RequirementRecordsBlockers([...scans, { tool: REQUIREMENT_RECORDS_TOOL, scannedAt: '2026-11-04T10:00:00.000Z', complete: true, runId: 'c' }])).toEqual([]);
    expect(qg01RequirementRecordsBlockers([{ tool: 'github-branch-protection', scannedAt: '2026-11-04T10:00:00.000Z', complete: true, runId: 'x' }])).toHaveLength(1);
    const finding = { findingId: 'f1', source: 'repository', tool: REQUIREMENT_RECORDS_TOOL, ruleId: 'missing:rules', title: 'QG-01: M98-FR-01 is missing business rules', severity: 'high', toolSeverity: 'MISSING', location: 'docs/requirements/M98.md M98-FR-01', status: 'open' } as unknown as SecurityFinding;
    expect(findingBlocks([finding]).map((b) => b.gate)).toEqual(['QG-01']);
    expect(findingBlocks([{ ...finding, tool: 'github-branch-protection' }]).map((b) => b.gate)).toEqual(['QG-03']);
  });

  it('the page\'s words: NOT KNOWN, failing by name, or clean — and clean is never "passed"', () => {
    const none = qg01ReadingOf([], []);
    expect(none.standing).toBe('not_known');
    const v0 = qg01ReadingView('en', { result: 'ok', value: none });
    expect([v0.icon, v0.state, v0.headline]).toEqual(['⚠', 'not_known', 'NOT KNOWN — no reading of the requirement records is on file.']);
    const scans = [{ tool: REQUIREMENT_RECORDS_TOOL, scannedAt: '2026-11-04T19:05:00.000Z', complete: true, runId: 'gh-9-1', commit: 'b'.repeat(40) }];
    const failing = qg01ReadingOf(scans, [{ findingId: 'f1', tool: REQUIREMENT_RECORDS_TOOL, status: 'open', title: 'QG-01: M98-FR-01 is missing business rules', location: 'docs/requirements/M98.md M98-FR-01' }]);
    const v1 = qg01ReadingView('en', { result: 'ok', value: failing });
    expect(v1.headline).toBe('Requirement records missing a field: 1');
    // The reading's time on the SHOP's clock (19:05 UTC is 00:35 the next day in the shop), never the UTC date.
    expect(v1.lines[0]).toBe(`Latest reading: 2026-11-05 00:35 · run: gh-9-1 · commit: ${'b'.repeat(12)}`);
    expect(v1.lines).toContain('QG-01: M98-FR-01 is missing business rules — docs/requirements/M98.md M98-FR-01');
    const clean = qg01ReadingView('en', { result: 'ok', value: qg01ReadingOf(scans, [{ findingId: 'f1', tool: REQUIREMENT_RECORDS_TOOL, status: 'fixed', title: 't', location: 'l' }]) });
    expect([clean.icon, clean.state]).toEqual(['✓', 'check_clean']);
    expect(clean.lines.join(' ')).toContain('not the decision — the gate is not passed until he records it');
    expect(`${clean.headline} ${clean.lines.join(' ')}`).not.toMatch(/\bpassed\b(?! until)/);
    expect(qg01ReadingView('en', { result: 'lost_link' }).headline).toMatch(/^The requirement-records reading could not be read — this is not the same as "none"\./);
    expect(qg01ReadingView('ta', { result: 'ok', value: none }).headline).toBe(gatesWords('ta', 'qg01None'));
    for (const k of ['qg01H', 'qg01Lead', 'qg01None', 'qg01NotComplete', 'qg01Failing', 'qg01Clean', 'qg01NotPassed', 'qg01Holds', 'qg01Unread']) expect(gatesWords('ta', k), k).not.toBe(gatesWords('en', k));
  });

  it('the session reads the reading only for whoever may read the register', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => { urls.push(String(url)); return new Response('{"standing":"not_known","latest":null,"failing":[]}', { status: 200 }); }) as unknown as typeof globalThis.fetch;
    expect(await createGatesSession({ viewer: { userId: 'u-c', permissions: [] } as never, fetch }).readQg01()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createGatesSession({ viewer: undefined, fetch }).readQg01()).toEqual({ result: 'invalid', why: 'nobody' });
    const out = await createGatesSession({ viewer: { userId: 'u-o', permissions: ['compliance.gate.read'] } as never, fetch }).readQg01();
    expect(out.result).toBe('ok');
    expect(urls).toEqual(['/v1/compliance/gate-register/qg01-reading']);
  });

  it('the CI runs the reading and sends it with the findings, and the guardrail runs the same check', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const step = ci.indexOf('node --experimental-strip-types scripts/requirement-records-reading.mts --out scan-reports/requirement-records.findings.json');
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(ci.indexOf('node scripts/push-findings.mjs scan-reports'));
    expect(readFileSync('tests/guardrails/every-requirement-record-has-actors-rules-errors-permissions-and-acceptance.test.ts', 'utf8')).toContain("from '../../packages/compliance/src/requirement-records'");
  });
});
