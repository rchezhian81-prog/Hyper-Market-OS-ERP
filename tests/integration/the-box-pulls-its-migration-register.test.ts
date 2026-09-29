import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';

/**
 * **The box pulls its migration register (Stage C3b) — MG-04 · MG-06 · MG-10 · §31 · P-01 · P-08.**
 *
 * C3a carried the migration screen's DECISIONS up to the cloud. Nothing carried the cloud's REGISTER down: the
 * box read its migration sections from a pack file once at boot, so the screen on the night showed whatever
 * someone had typed into a file, with none of the decisions the desk had since taken. This wires the inbound
 * pull (`pullMigrationFeed`) into the same loop as the catalogue pull: the REAL edge process fetches
 * `GET /v1/migration/screen` from a stand-in cloud, lays it over its store pack, SERVES the migration screen
 * with the register in it, persists it, and — the property that matters — keeps showing it, with its age, when
 * the cloud is gone and the box has rebooted.
 *
 * Driven through `edge.refreshMigrationFeed()`, the same code the timer calls, and read back through the
 * screen the box actually serves (`/migration`), not through an accessor built for the test.
 */

const KEY = ['box', 'pulls', 'register', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const TOKEN = ['edge', 'cloud', 'token'].join('-').padEnd(40, 'w');
// A cloud clock safely in the past, so the age the screen shows (measured from it, not from this boot) is > 0.
const GENERATED = '2026-09-01T20:00:00.000Z';

const FEED = {
  tenantId: TENANT, generatedAt: GENERATED,
  policy: { cutoverId: 'cut-1', requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01', dailyReconcilerUserId: 'u-recon' },
  loadOperator: 'u-loader',
  exceptions: [{ exceptionId: 'EX-1', tenantId: TENANT, kind: 'duplicate_product', severity: 'low', confidence: 'probable', legacyIds: ['L-1', 'L-2'], evidence: 'same name and pack',
    resolution: { action: 'merge', decidedBy: 'u-mgr', decidedAt: GENERATED, reason: 'keep the newer', survivingLegacyId: 'L-2' } }],
  refusedDecisions: [{ decisionId: 'd1', kind: 'total_signature', subjectId: 'CT-1', attemptedBy: 'u-cash', refusedBecause: 'decider_lacks_authority', detail: 'x', relayedBy: 'u-sync', relayedAt: GENERATED }],
  parallelDays: [], parallelDifferences: [], rollbacks: [],
  verification: { covered: ['products'], missing: ['stock'], ownerKnown: true, extractionOperatorKnown: true, signaturesOverThisPage: 0, detail: '1 of 12 domains have a finding; still missing: stock' },
};

// A tiny stand-in cloud: GET /v1/migration/screen from a mutable response; the catalogue has nothing published.
let served: { status: number; body: string } = { status: 200, body: JSON.stringify(FEED) };
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/migration/screen') {
      res.writeHead(served.status, { 'content-type': 'application/json' });
      res.end(served.body);
      return;
    }
    res.writeHead(404); res.end(); // no catalogue pack published; the outboxes are empty here
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = typeof addr === 'object' && addr !== null ? `http://127.0.0.1:${addr.port}` : '';
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-box-register-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const envFor = (dataDir: string, cloudUrl = baseUrl, extra: Record<string, string> = {}) => ({
  EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
  EDGE_CAPACITY_BYTES: '10485760', CLOUD_API_URL: cloudUrl, CLOUD_API_TOKEN: TOKEN,
  EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...extra,
});

/** Read the migration screen as the box serves it, and pull the payload it injected — or null when it injected none. */
async function servedMigrationScreen(port: number): Promise<Record<string, unknown> | null> {
  const res = await fetch(`http://127.0.0.1:${port}/migration`);
  expect(res.status).toBe(200);
  const html = await res.text();
  const m = html.match(/<script>window\.migrationData = (.*?);<\/script>/);
  return m === null ? null : JSON.parse(m[1]!) as Record<string, unknown>;
}

describe('the box pulls its migration register (C3b)', () => {
  it('fetches the register, serves it on the migration screen with the desk\'s decisions folded in and its age from the cloud clock, persists it — and keeps it across a reboot with the cloud gone', async () => {
    served = { status: 200, body: JSON.stringify(FEED) };
    const dir = await tempDir();
    const said: string[] = [];
    const edge = (await startEdge(envFor(dir), (l) => said.push(l)))!;

    // Before the first pull the box has been told nothing about a cutover, and the screen says so (no payload).
    expect(await servedMigrationScreen(edge.screens!.port)).toBeNull();

    const outcome = await edge.refreshMigrationFeed!();
    expect(outcome.status).toBe('updated');
    expect(outcome.generatedAt).toBe(GENERATED);
    expect(said.join('\n')).toContain('Migration register updated from the cloud');

    const screen = (await servedMigrationScreen(edge.screens!.port))!;
    expect(screen['cutoverId']).toBe('cut-1');
    expect(screen['requiredCleanDays']).toBe(3);
    expect(screen['loadOperator']).toBe('u-loader');
    expect(screen['exceptions']).toEqual(FEED.exceptions);          // resolved on the desk — and the box shows it resolved
    expect(screen['parallelDays']).toEqual([]);
    expect(screen['refusedDecisions']).toEqual(FEED.refusedDecisions);
    expect(screen['verification']).toEqual(FEED.verification);
    expect(screen).not.toHaveProperty('totals');                    // never recorded on the cloud → not invented here
    expect(screen).not.toHaveProperty('userId');                    // nobody named on this box's screen → nothing may be signed
    expect(screen['edgeUnsyncedItems']).toBe(0);                    // this box's OWN queue, never the cloud's word for it
    const register = screen['cloudRegister'] as { generatedAt: string; ageHours: number };
    expect(register.generatedAt).toBe(GENERATED);
    expect(register.ageHours).toBeGreaterThan(0);                   // measured from the cloud's clock, not this boot

    // A second pass with the same register is quiet — taken, not announced.
    const before = said.length;
    expect((await edge.refreshMigrationFeed!()).status).toBe('unchanged');
    expect(said.length).toBe(before);
    await edge.stop();

    // Reboot on the SAME disk with the cloud unreachable: the register is restored and still served (P-01),
    // and the pull says offline while the screen says how old what it shows is (P-08).
    const said2: string[] = [];
    const rebooted = (await startEdge(envFor(dir, 'http://127.0.0.1:1'), (l) => said2.push(l)))!;
    expect(said2.join('\n')).toContain(`migration register as of ${GENERATED} restored from disk`);
    const again = (await servedMigrationScreen(rebooted.screens!.port))!;
    expect(again['exceptions']).toEqual(FEED.exceptions);
    expect((again['cloudRegister'] as { generatedAt: string }).generatedAt).toBe(GENERATED);
    const offline = await rebooted.refreshMigrationFeed!();
    expect(offline.status).toBe('offline');
    expect(offline.generatedAt).toBe(GENERATED);
    expect(said2.join('\n')).toContain('Cloud not reachable');
    await rebooted.stop();
  });

  it('the cloud\'s terms replace the pack file\'s, while who is on this box\'s screen survives — and a section the cloud did not send stays as the file had it', async () => {
    served = { status: 200, body: JSON.stringify({ ...FEED, exceptions: undefined }) };
    const dir = await tempDir();
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 3,
      migrationPolicy: { cutoverId: 'cut-from-file', requiredCleanDays: 9, userId: 'u-owner' },
      migrationTotals: [{ totalId: 'CT-FILE', tenantId: TENANT, kind: 'stock', name: 'Stock', unit: 'quantity', legacyValue: 1, loadedValue: 1, legacyDerivation: 'a', loadedDerivation: 'b' }],
    }));
    const edge = (await startEdge(envFor(dir, baseUrl, { EDGE_PACK_FILE: packFile }), () => {}))!;
    const before = (await servedMigrationScreen(edge.screens!.port))!;
    expect(before['cutoverId']).toBe('cut-from-file');
    expect(before).not.toHaveProperty('cloudRegister');            // the box has never heard from the cloud — and does not pretend to

    expect((await edge.refreshMigrationFeed!()).status).toBe('updated');
    const after = (await servedMigrationScreen(edge.screens!.port))!;
    expect(after['cutoverId']).toBe('cut-1');                       // the owner's written terms win over the file
    expect(after['requiredCleanDays']).toBe(3);
    expect(after['userId']).toBe('u-owner');                        // the box's own fact survives
    expect(after['loadOperator']).toBe('u-loader');
    expect((after['totals'] as { totalId: string }[])[0]?.totalId).toBe('CT-FILE'); // untouched: the cloud sent no totals
    expect(after).not.toHaveProperty('exceptions');                 // the cloud sent none, the file had none — still not known
    await edge.stop();
  });

  it('keeps out another shop\'s register, a garbled answer and a refusal — the screen keeps what the box holds', async () => {
    const dir = await tempDir();
    const edge = (await startEdge(envFor(dir), () => {}))!;
    served = { status: 200, body: JSON.stringify({ ...FEED, tenantId: 't-other' }) };
    expect((await edge.refreshMigrationFeed!()).status).toBe('kept');
    served = { status: 200, body: '{"not":"a register"}' };
    expect((await edge.refreshMigrationFeed!()).status).toBe('offline');
    served = { status: 403, body: JSON.stringify({ error: { code: 'forbidden' } }) };
    const refused = await edge.refreshMigrationFeed!();
    expect(refused.status).toBe('offline');
    expect(refused.reason).toContain('403');
    expect(refused.reason).not.toContain(TOKEN);
    expect(await servedMigrationScreen(edge.screens!.port)).toBeNull(); // nothing was ever taken
    await edge.stop();
  });

  it('the register rides the sync loop: the timer\'s pass pulls it right after the catalogue, and a failure there cannot stop the loop', async () => {
    // The loop's first pass is fifteen seconds out (BASE_INTERVAL_MS) — too long for a test to wait on, and the
    // exposed pull IS the code the pass calls. So this pins the wiring itself: inside `pass`, after the
    // catalogue refresh, the migration register refresh runs in its own try/catch, and the pass still re-arms.
    const src = (await import('node:fs/promises')).readFile('edge/store-edge/src/main.ts', 'utf8');
    const pass = (await src).slice((await src).indexOf('const pass = async ()'), (await src).indexOf('timer = setTimeout(() => { void pass(); }, BASE_INTERVAL_MS);'));
    expect(pass.indexOf('await refreshPack();')).toBeGreaterThan(pass.indexOf('await drainAndSettle()'));
    expect(pass.indexOf('await refreshMigrationFeed();')).toBeGreaterThan(pass.indexOf('await refreshPack();'));
    expect(pass).toMatch(/try \{\s*await refreshMigrationFeed\(\);\s*\} catch/);
    expect(pass.indexOf('if (!stopping) timer = setTimeout')).toBeGreaterThan(pass.indexOf('await refreshMigrationFeed();'));
  });
});
