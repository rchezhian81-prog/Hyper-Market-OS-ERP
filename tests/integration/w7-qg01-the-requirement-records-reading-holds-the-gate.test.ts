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
import { readRequirementRecords, requirementRecordsOf, requirementRecordsReport } from '../../packages/compliance/src/index';

/**
 * **W7 · QG-01 (roadmap §22 "No build without approved ID, rules, actors, errors, permissions and testable acceptance") — the
 * requirement-records reading on head office's gate register, on the real API, in memory and on real PostgreSQL, with a cold
 * restart.** The reading is the CI guardrail's own check (packages/compliance/src/requirement-records.ts) over the repository's
 * real `docs/requirements/M##.md` (and a copy with one field taken out), sent through the findings register:
 *   • no reading on file → QG-01 is held, NOT KNOWN; GO is refused by name;
 *   • a record missing a field → an open high finding holds QG-01 (and not QG-03);
 *   • a complete clean reading closes it; QG-01 is then unblocked but still UNDECIDED — the reading is evidence, never GO;
 *   • GET /v1/compliance/gate-register/qg01-reading says each of these in words, for whoever may read the register only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash';
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const DIR = 'docs/requirements';
const realFiles = () => readdirSync(DIR).filter((n) => /^M\d\d\.md$/.test(n)).sort().map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }));
// The record taken apart and the file left out are found, not named, so this gate test cites no module requirement itself.
const FIRST_FILE = realFiles()[0]!.name;
const LAST_FILE = realFiles().at(-1)!.name;
const FIRST_ID = requirementRecordsOf([realFiles()[0]!])[0]!.id;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: (store?: EventStore) => ApiHarness }[] = [{ name: 'the in-memory event store', harness: (store) => apiHarness(store === undefined ? {} : { store }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('QG-01: the requirement-records reading holds the gate — on $name', ({ harness }) => {
  it('none on file → NOT KNOWN; a missing field → an open finding on QG-01 only; a clean complete reading clears it, and QG-01 is still not decided', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASHIER, 'cashier');
    const call = (hh: ApiHarness, method: 'GET' | 'POST', path: string, user: string, body?: unknown, query?: Record<string, string>) =>
      hh.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });
    type Gate = { gate: string; state: string; blockers: { kind: string; ref: string; reason: string }[] };
    const gate = async (id: string, hh: ApiHarness = h) => ((await call(hh, 'GET', '/v1/compliance/gate-register', MGR, undefined, { release: 'R1' })).body as { gates: Gate[] }).gates.find((g) => g.gate === id)!;
    const reading = async (hh: ApiHarness = h) => (await call(hh, 'GET', '/v1/compliance/gate-register/qg01-reading', MGR)).body as { standing: string; latest: { runId: string; complete: boolean } | null; failing: { title: string; location: string }[]; says: string };
    const send = async (files: ReturnType<typeof realFiles>, runId: string, scannedAt: string) => {
      const r = await call(h, 'POST', '/v1/compliance/finding-scans', MGR, { report: requirementRecordsReport(readRequirementRecords(files), { runId, scannedAt }) });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    };
    const go = () => call(h, 'POST', '/v1/compliance/gate-decisions/QG-01/R1', OWNER, { decision: 'GO', evidence: [{ label: 'reading', ref: 'scan-reports-security/requirement-records.findings.json' }], rationale: 'the records are complete' });

    // ── No reading on file: NOT KNOWN, the gate held, GO refused.
    expect((await gate('QG-01')).blockers.map((b) => b.ref)).toEqual(['requirement-records:no-reading']);
    expect(await reading()).toMatchObject({ standing: 'not_known', latest: null, failing: [] });
    expect(codeOf(await go())).toBe('go_refused_while_blocked');
    expect((await call(h, 'GET', '/v1/compliance/gate-register/qg01-reading', CASHIER)).status).toBe(403);

    // ── A copy with the first record's acceptance criteria taken out: a high finding on QG-01, not on QG-03.
    const broken = realFiles().map((f) => (f.name !== FIRST_FILE ? f : { ...f, text: f.text.replace(new RegExp(`(## ${FIRST_ID}[\\s\\S]*?)\\*\\*Acceptance(?: criteria)?[^*\\n]{0,40}:\\*\\*`, 'i'), '$1') }));
    expect(readRequirementRecords(broken).incomplete).toEqual([{ id: FIRST_ID, file: FIRST_FILE, missing: ['acceptance'] }]);
    await send(broken, 'gh-qg01-1', '2026-11-04T08:00:00.000Z');
    const held = await gate('QG-01');
    expect(held.blockers).toEqual([expect.objectContaining({ kind: 'finding', reason: expect.stringContaining(`QG-01: ${FIRST_ID} is missing acceptance criteria`) })]);
    expect((await gate('QG-03')).blockers.some((b) => b.reason.includes(FIRST_ID))).toBe(false);
    expect(await reading()).toMatchObject({ standing: 'failing', latest: { runId: 'gh-qg01-1', complete: true }, failing: [{ title: `QG-01: ${FIRST_ID} is missing acceptance criteria`, location: `docs/requirements/${FIRST_FILE} ${FIRST_ID}` }] });
    expect(codeOf(await go())).toBe('go_refused_while_blocked');

    // ── A reading that could not read every record closes nothing and is NOT KNOWN.
    await send(realFiles().filter((f) => f.name !== LAST_FILE), 'gh-qg01-2', '2026-11-04T09:00:00.000Z');
    expect((await gate('QG-01')).blockers.map((b) => b.ref)).toEqual(expect.arrayContaining(['requirement-records:not-known:gh-qg01-2']));
    expect((await reading()).standing).toBe('not_known');

    // ── The repository's real records, read complete: nothing blocks QG-01 — and it is still not decided (never GO by itself).
    await send(realFiles(), 'gh-qg01-3', '2026-11-04T10:00:00.000Z');
    const clean = await gate('QG-01');
    expect(clean.blockers).toEqual([]);
    expect(clean.state).toBe('undecided');
    const r = await reading();
    expect(r.standing).toBe('check_clean');
    expect(r.says).toContain('not the decision');

    // ── Cold restart: the same answer from the same store.
    const again = harness(h.store);
    expect((await reading(again)).standing).toBe('check_clean');
    expect((await gate('QG-01', again)).state).toBe('undecided');
  }, 60_000);
});
