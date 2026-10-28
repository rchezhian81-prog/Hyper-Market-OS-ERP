// Guardrail (M36-FR-04, P-06): the committed API surface document equals the surface the kernel actually
// serves. A partner reads `docs/api/surface.md` (or the live manifest) and builds against it; if a route is
// added, renamed, re-permissioned or feature-gated without the document following, this fails and says how
// to regenerate. The document carries no timestamp, so it changes only when the surface does.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { servedRoutes, storelessRoutes } from '../support/derived-contract';
import { buildApiManifest, renderApiSurface } from '../../services/platform/src/api-manifest';

const SURFACE_DOC = fileURLToPath(new URL('../../docs/api/surface.md', import.meta.url));
const REGENERATE = 'UPDATE_API_SURFACE=1 pnpm exec vitest run tests/guardrails/the-api-surface-is-documented.test.ts';

describe('the API surface is documented, from the running route table', () => {
  // As production serves it: WITH an event store (round 6 audit — built without one, ~47 served routes were undocumented).
  const routes = servedRoutes();
  const manifest = buildApiManifest(routes, '2000-01-01T00:00:00.000Z');

  it('serves no endpoint that breaks a convention: every path versioned, every write idempotent, every domain known', () => {
    expect(manifest.violations).toEqual([]);
    expect(manifest.counts.routes).toBeGreaterThan(300);
    expect(manifest.apis.some((s) => s.routes.some((r) => r.path === '/v1/platform/api-manifest'))).toBe(true); // it lists itself
  });

  it('documents every route production mounts only with an event store (none left out)', () => {
    const storeless = new Set(storelessRoutes().map((r) => `${r.method} ${r.path}`));
    const storeOnly = routes.filter((r) => !storeless.has(`${r.method} ${r.path}`));
    expect(storeOnly.length).toBeGreaterThan(40);
    let doc = '';
    try { doc = readFileSync(SURFACE_DOC, 'utf8'); } catch { doc = ''; }
    const missing = storeOnly.filter((r) => !doc.includes(`| ${r.method} | \`${r.path}\``)).map((r) => `${r.method} ${r.path}`);
    expect(missing, `docs/api/surface.md leaves out routes production serves — run: ${REGENERATE}`).toEqual([]);
  });

  it('docs/api/surface.md equals what the kernel serves (regenerate when a route changes)', () => {
    const expected = renderApiSurface(manifest).trimEnd() + '\n';
    if (process.env['UPDATE_API_SURFACE'] === '1') writeFileSync(SURFACE_DOC, expected);
    let actual = '';
    try { actual = readFileSync(SURFACE_DOC, 'utf8'); } catch { actual = ''; }
    expect(actual, `docs/api/surface.md is behind the running surface — run: ${REGENERATE}`).toBe(expected);
  });
});
