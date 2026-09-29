// Guardrail (M36-FR-04, P-06): the committed API surface document equals the surface the kernel actually
// serves. A partner reads `docs/api/surface.md` (or the live manifest) and builds against it; if a route is
// added, renamed, re-permissioned or feature-gated without the document following, this fails and says how
// to regenerate. The document carries no timestamp, so it changes only when the surface does.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSurface } from '../../services/api/src/main';
import { buildApiManifest, renderApiSurface } from '../../services/platform/src/api-manifest';

const PACK_KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const SURFACE_DOC = fileURLToPath(new URL('../../docs/api/surface.md', import.meta.url));
const REGENERATE = 'UPDATE_API_SURFACE=1 pnpm exec vitest run tests/guardrails/the-api-surface-is-documented.test.ts';

describe('the API surface is documented, from the running route table', () => {
  const routes = buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal' });
  const manifest = buildApiManifest(routes, '2000-01-01T00:00:00.000Z');

  it('serves no endpoint that breaks a convention: every path versioned, every write idempotent, every domain known', () => {
    expect(manifest.violations).toEqual([]);
    expect(manifest.counts.routes).toBeGreaterThan(300);
    expect(manifest.apis.some((s) => s.routes.some((r) => r.path === '/v1/platform/api-manifest'))).toBe(true); // it lists itself
  });

  it('docs/api/surface.md equals what the kernel serves (regenerate when a route changes)', () => {
    const expected = renderApiSurface(manifest).trimEnd() + '\n';
    if (process.env['UPDATE_API_SURFACE'] === '1') writeFileSync(SURFACE_DOC, expected);
    let actual = '';
    try { actual = readFileSync(SURFACE_DOC, 'utf8'); } catch { actual = ''; }
    expect(actual, `docs/api/surface.md is behind the running surface — run: ${REGENERATE}`).toBe(expected);
  });
});
