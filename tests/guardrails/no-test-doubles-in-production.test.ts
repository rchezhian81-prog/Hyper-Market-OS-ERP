import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **A composition root may not wire a test double, and may not leave a port unwired.**
 *
 * Five faults of one shape turned up in a single session, each found by hand and each invisible to
 * every test in the suite:
 *
 *   1. `SyncTransport` — a port with no implementation. The edge queued sales and had nowhere to
 *      send them.
 *   2. `DurableLog` — a port with a test double behind it. Nothing could write a sale to disk.
 *   3. No edge process at all. Nothing started any of it.
 *   4. `MemoryIdempotencyStore` in `main()`. The guard against a different request under a used
 *      key emptied on every restart and was never shared between instances.
 *   5. No `AuditSink` in `main()`. Hard rule #6 says never delete audit evidence, and there was
 *      none to delete.
 *
 * None of them is a crash. Every one is a control quietly not being there, which is the failure
 * mode this repository spends most of its effort making impossible — so finding them one at a time
 * by reading is not good enough. This is the guard that will still be here for the sixth.
 *
 * It works on names, because this codebase names things honestly: a class called
 * `MemoryIdempotencyStore` says exactly what it is, and the moment one appears in a file that
 * production runs, that is the finding.
 */

const COMPOSITION_ROOTS = [
  'services/api/src/main.ts',
  'services/api/src/start.ts',
  'edge/store-edge/src/main.ts',
  'edge/store-edge/src/start.ts',
] as const;

/** Names this codebase gives to things that must never run in a shop. */
const TEST_DOUBLE = /\b(?:InMemory|Memory|Fake|Stub|Mock|Dummy|Test|Noop|NoOp)[A-Z]\w*/g;

describe('production wiring names no test double', () => {
  it('has no in-memory or fake implementation in any composition root', () => {
    const found: string[] = [];
    for (const path of COMPOSITION_ROOTS) {
      const source = readFileSync(path, 'utf8');
      // Comments are where these are *discussed*, which is exactly what the entries below do, so
      // only real code counts.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      for (const match of code.matchAll(TEST_DOUBLE)) found.push(`${path}: ${match[0]}`);
    }
    // Named all at once, because one per run is several rounds of the same discovery.
    expect(found).toEqual([]);
  });

  it('tripwire — the detector fires on a known-bad sample', () => {
    // Otherwise a regex that silently matched nothing would make the test above vacuous. This is
    // the exact line that was in `main.ts` this morning.
    const knownBad = 'idempotency: new MemoryIdempotencyStore(),\nconst x = new InMemoryEventStore();';
    expect([...knownBad.matchAll(TEST_DOUBLE)].map((m) => m[0]))
      .toEqual(['MemoryIdempotencyStore', 'InMemoryEventStore']);
  });
});

describe('every port the cloud API depends on is actually supplied', () => {
  const main = readFileSync('services/api/src/main.ts', 'utf8');

  it('supplies an audit sink — hard rule #6 protects evidence that must exist', () => {
    // The kernel's `audit` is optional in the TYPE, because a test does not want one. It is not
    // optional in a deployment: without it `writeAudit` returns immediately on every request and
    // the trail is simply never kept.
    expect(main).toMatch(/audit:\s*new SqlAuditSink/);
  });

  it('supplies a durable idempotency store, not one held in memory', () => {
    expect(main).toMatch(/idempotency:\s*new SqlIdempotencyStore/);
  });

  it('supplies a real authenticator, not one that lets everybody in', () => {
    expect(main).toMatch(/authenticate:\s*tokenAuthenticator/);
    // The shape it used to have: default-deny, but nobody could use the system.
    expect(main).not.toMatch(/authenticate:\s*\(\)\s*(?::\s*[\w |]+)?=>\s*undefined/);
  });

  it('supplies a real event store, so the API does not answer and forget', () => {
    expect(main).toMatch(/new SqlEventStore/);
  });

  it('wires observability — structured request logging and metrics — not a blind service', () => {
    // Optional in the kernel type (a test does not want it) and NOT optional in a deployment: a
    // service the operator cannot see is a service that fails silently. One structured line per
    // request and /metricz counters, provider-neutral.
    expect(main).toMatch(/observe[,:]/);
    expect(main).toMatch(/metricsSnapshot:/);
    expect(main).toMatch(/new RequestMetrics\(/);
  });

  it('wires REAL per-tenant authorization, not an empty AccessControl that authorises nothing', () => {
    // The shape it used to have: `access: new AccessControl([], [])` — a global, empty table that
    // was never rebuilt from anyone's grants, so every authenticated request returned 403 and the
    // whole least-privilege apparatus was inert on the live surface. It must resolve authority from
    // the tenant's own grants instead. This guard is the fix made un-regressable.
    expect(main).not.toMatch(/access:\s*new AccessControl\s*\(\s*\[\s*\]\s*,\s*\[\s*\]\s*\)/);
    expect(main).toMatch(/access:\s*tenantAccessResolver\(/);
  });
});

describe('every port the store edge depends on is actually supplied', () => {
  const main = readFileSync('edge/store-edge/src/main.ts', 'utf8');

  it('opens a real durable log — the disk the receipt waits for', () => {
    expect(main).toMatch(/openFileLog\(/);
  });

  it('builds a real transport when a cloud is configured', () => {
    expect(main).toMatch(/httpTransport\(/);
  });

  it('runs NO agent when no cloud is configured, rather than one pointed at nothing', () => {
    // The absence is the control (P-01). An agent with an empty base URL would fail a request
    // every fifteen seconds forever and call it syncing.
    expect(main).toMatch(/agent:\s*null/);
  });
});
