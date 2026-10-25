// Guardrail (M36-FR-03 "upgrades are backward-compatible … no breaking a live tenant" · M36-FR-04 "an unversioned/breaking
// change is rejected (deprecation window required)" · P-06 · R8-2 — OB-288 P4): every endpoint and partner webhook event
// in `docs/api/released-contract.json` is still served by this build — or was deprecated, by date, in that file and its
// 180-day window has actually run. Adding is always fine. CI runs this on every change, and a release deploys only a
// commit that passed CI. When a release is cut (or after adding endpoints), record the new surface with:
//   UPDATE_RELEASED_CONTRACT=1 pnpm exec vitest run tests/guardrails/an-upgrade-never-breaks-a-live-shop.test.ts
// The update only ever ADDS: a released item leaves the file only once its dated deprecation has run.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSurface } from '../../services/api/src/main';
import { PUBLISHED_TO_PARTNERS } from '../../services/api/src/adapters';
import { assessUpgrade, releaseContract, currentSurfaceOf, type ReleasedContract } from '../../services/platform/src/upgrade-compatibility';

const PACK_KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const CONTRACT = fileURLToPath(new URL('../../docs/api/released-contract.json', import.meta.url));
const today = new Date().toISOString().slice(0, 10);

const routes = buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal' });
const current = currentSurfaceOf(routes, Object.keys(PUBLISHED_TO_PARTNERS));
const readReleased = (): ReleasedContract | undefined => { try { return JSON.parse(readFileSync(CONTRACT, 'utf8')) as ReleasedContract; } catch { return undefined; } };

describe('an upgrade never takes away what was released (M36-FR-03)', () => {
  it('every released endpoint and partner event is still served, or its dated deprecation has run', () => {
    if (process.env['UPDATE_RELEASED_CONTRACT'] === '1') {
      writeFileSync(CONTRACT, `${JSON.stringify(releaseContract({ released: readReleased(), current, apiVersion: 'v1', today }), null, 2)}\n`);
    }
    const released = readReleased();
    expect(released, 'docs/api/released-contract.json is missing — record it with UPDATE_RELEASED_CONTRACT=1').toBeDefined();
    const verdict = assessUpgrade({ released: released!, current, today });
    expect(verdict.removed.filter((r) => !r.safeToDeploy).map((r) => `${r.contract}: ${r.detail}`), verdict.detail).toEqual([]);
  });

  it('the released contract is well formed: v1, sorted, no duplicates, every deprecation dated', () => {
    const r = readReleased()!;
    expect([r.format, r.apiVersion]).toEqual(['sre-released-contract/1', 'v1']);
    expect([...r.operations]).toEqual([...new Set(r.operations)].sort());
    expect(r.operations.every((o) => /^(GET|POST|PUT|PATCH|DELETE) \/v1\//.test(o))).toBe(true);
    for (const d of r.deprecations) expect(d.deprecatedOn, d.surface).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The two partner webhook events are part of the released surface.
    expect(r.partnerEvents).toEqual(expect.arrayContaining(Object.keys(PUBLISHED_TO_PARTNERS)));
  });
});
