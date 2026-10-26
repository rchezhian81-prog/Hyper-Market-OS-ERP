import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * **OB-391 (owner, 26 Oct 2026): the old erasure page is retired, and stays retired — erasure stays on the real privacy
 * routes.**
 *
 * The page was a development workflow: a typed staff id against a stand-in server (OB-49 kept erasure synthetic-only),
 * never served by the store computer and with no menu item. The owner retired it. This fails when:
 *   • a file of that name comes back anywhere in the product or its tests (apps, edge, packages, services, scripts, infra,
 *     tests) — this guardrail is the one file allowed to name it;
 *   • anything in the product or its tests refers to it again (an address, a script, a cache entry, a test);
 *   • the REAL privacy routes that do erasure — plan, approval, execution — are no longer in head office's API surface,
 *     or no longer each checked on its own permission.
 */

const RETIRED = ['erasure', 'console'].join('-');
const ROOTS = ['apps', 'edge', 'packages', 'services', 'scripts', 'infra', 'tests'];
const SELF = 'tests/guardrails/the-retired-erasure-page-stays-gone.test.ts';
const TEXT = /\.(ts|js|mjs|cjs|html|json|css|md|ya?ml|conf|sh|ps1|webmanifest)$/;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else out.push(relative('.', full));
  }
  return out;
}
const files = ROOTS.flatMap((r) => walk(r, []));

describe('OB-391: the retired erasure page stays gone; erasure stays on the real privacy routes', () => {
  it('no file of that name exists in the product or its tests', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files.filter((f) => f.split('/').pop()!.startsWith(RETIRED))).toEqual([]);
  });

  it('nothing in the product or its tests refers to it (this guardrail alone names it)', () => {
    const hits = files.filter((f) => f !== SELF && TEXT.test(f) && readFileSync(f, 'utf8').toLowerCase().includes(RETIRED));
    expect(hits).toEqual([]);
  });

  it('the store computer does not serve it, and the menu does not offer it', () => {
    const nav = readFileSync('apps/web-erp/src/navigation.ts', 'utf8');
    const pages = readFileSync('edge/store-edge/src/head-office-pages.ts', 'utf8');
    expect(nav.includes(RETIRED)).toBe(false);
    expect(pages.includes(RETIRED)).toBe(false);
  });

  it('the real privacy routes — erasure plan, approval and execution — are still head office\'s, each on its own permission', () => {
    const surface = readFileSync('docs/api/surface.md', 'utf8');
    expect(surface).toContain('| POST | `/v1/privacy/data-requests/:requestId/erasure-plan` | `privacy.request.manage` |');
    expect(surface).toContain('| POST | `/v1/privacy/data-requests/:requestId/erasure-approval` | `privacy.erasure.approve` |');
    expect(surface).toContain('| POST | `/v1/privacy/data-requests/:requestId/erasure-execution` | `privacy.erasure.execute` |');
  });
});
