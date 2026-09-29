// API-11 Platform — the versioned API surface, as a manifest (M36-FR-04, P-06).
//
// A partner builds against versioned APIs (M36-FR-04) and the product promises to be open and portable
// (P-06: versioned APIs, exports, documented data models). Until now the surface was documented by hand in
// `docs/api/catalogue.md` — a description that can drift from the routes the kernel actually serves. This
// manifest is generated FROM the running route table: every endpoint the pipeline registers, grouped by
// API domain, with the major version it carries in its path, the permission it demands, the optional
// feature it belongs to (M36-FR-01) and whether a write is idempotent (a partner must send the key). It can
// therefore not disagree with reality, and a guardrail keeps `docs/api/surface.md` equal to it.
//
// It is a READ of the surface, never a promise about payload shapes — those are the versioned schemas in
// `packages/contracts/` and the per-domain catalogue.

import type { Route, ApiId, Method } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export const API_DOMAINS: Readonly<Record<ApiId, { readonly name: string; readonly modules: string }>> = {
  'API-01': { name: 'Identity / Admin', modules: 'M01–M02' },
  'API-02': { name: 'Catalogue', modules: 'M03–M05' },
  'API-03': { name: 'Purchase', modules: 'M06–M07, M30' },
  'API-04': { name: 'Inventory', modules: 'M08–M11' },
  'API-05': { name: 'POS', modules: 'M12–M15' },
  'API-06': { name: 'Customer / Loyalty', modules: 'M16–M17, M21' },
  'API-07': { name: 'OMS', modules: 'M18' },
  'API-08': { name: 'Fulfilment / Delivery', modules: 'M19' },
  'API-09': { name: 'Finance', modules: 'M23' },
  'API-10': { name: 'Reporting', modules: 'M29' },
  'API-11': { name: 'Platform', modules: 'M32–M35' },
  'API-12': { name: 'Migration', modules: 'MG-01–MG-12' },
  'API-13': { name: 'AI', modules: 'A01–A10' },
};
const API_IDS = Object.keys(API_DOMAINS) as readonly ApiId[];
const WRITES: readonly Method[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
export const MAJOR_VERSION = 'v1';

export interface ManifestRoute {
  readonly method: Method;
  readonly path: string;
  readonly permission: string;
  /** The optional feature the endpoint belongs to (M36-FR-01), or null for a core endpoint. */
  readonly entitlement: string | null;
  readonly write: boolean;
  /** Writes only: the caller must send `Idempotency-Key`; a replay returns the first answer. */
  readonly idempotent: boolean;
}
export interface ApiManifestSection {
  readonly api: ApiId;
  readonly name: string;
  readonly modules: string;
  readonly routes: readonly ManifestRoute[];
}
export interface ApiManifest {
  readonly majorVersion: typeof MAJOR_VERSION;
  readonly generatedAt: string;
  readonly conventions: Readonly<Record<string, string>>;
  readonly documentation: Readonly<Record<string, string>>;
  readonly apis: readonly ApiManifestSection[];
  readonly counts: {
    readonly apis: number;
    readonly routes: number;
    readonly writes: number;
    readonly idempotentWrites: number;
    readonly entitled: number;
    readonly permissions: number;
  };
  /** Endpoints that break a convention — the router refuses these at boot, so this is expected empty; it is here so nothing is hidden. */
  readonly violations: readonly string[];
}

const byPathThenMethod = (a: ManifestRoute, b: ManifestRoute): number =>
  a.path.localeCompare(b.path) || a.method.localeCompare(b.method);

/** Fold the live route table into the manifest. Pure and deterministic for a given table. */
export function buildApiManifest(routes: readonly Route[], generatedAt: string): ApiManifest {
  const violations: string[] = [];
  const sections: ApiManifestSection[] = [];
  for (const api of API_IDS) {
    const mine = routes
      .filter((r) => r.api === api)
      .map((r): ManifestRoute => ({
        method: r.method, path: r.path, permission: r.permission, entitlement: r.entitlement ?? null,
        write: WRITES.includes(r.method), idempotent: WRITES.includes(r.method) && r.idempotent === true,
      }))
      .sort(byPathThenMethod);
    for (const r of mine) {
      if (!r.path.startsWith(`/${MAJOR_VERSION}/`)) violations.push(`${r.method} ${r.path} carries no major version (P-06)`);
      if (r.write && !r.idempotent) violations.push(`${r.method} ${r.path} is a write that does not declare idempotency`);
    }
    sections.push({ api, name: API_DOMAINS[api].name, modules: API_DOMAINS[api].modules, routes: mine });
  }
  for (const r of routes) {
    if (!API_IDS.includes(r.api)) violations.push(`${r.method} ${r.path} names an unknown API domain ${String(r.api)}`);
  }
  const all = sections.flatMap((s) => s.routes);
  return {
    majorVersion: MAJOR_VERSION,
    generatedAt,
    conventions: {
      versioning: `the major version is in the path (/${MAJOR_VERSION}/…); changes within a major are additive only (P-06)`,
      authentication: 'every call carries a bearer token; the permission listed is checked on the server, then the optional feature (M36-FR-01), default-deny',
      idempotency: 'a write marked idempotent needs an Idempotency-Key header; a replay with the same key and body returns the first answer',
      errors: 'every refusal is { error: { code, whatHappened, wasItSaved, nextSafeAction, traceId } }',
      tenancy: 'every call is scoped to the caller\'s tenant; no endpoint reads across tenants (§35)',
    },
    documentation: {
      catalogue: 'docs/api/catalogue.md',
      surface: 'docs/api/surface.md',
      contracts: 'packages/contracts/',
      dataDictionary: 'db/data-dictionary/',
      partnerAccess: 'POST /v1/platform/partners/access-check decides whether a partner credential may make a given call',
    },
    apis: sections,
    counts: {
      apis: sections.filter((s) => s.routes.length > 0).length,
      routes: all.length,
      writes: all.filter((r) => r.write).length,
      idempotentWrites: all.filter((r) => r.idempotent).length,
      entitled: all.filter((r) => r.entitlement !== null).length,
      permissions: new Set(all.map((r) => r.permission)).size,
    },
    violations,
  };
}

/** The manifest as the committed `docs/api/surface.md` — deterministic (no timestamp), so the file changes only when the surface does. */
export function renderApiSurface(manifest: ApiManifest): string {
  const lines: string[] = [
    '# The API surface (generated — do not edit by hand)',
    '',
    `Every endpoint the kernel serves, grouped by API domain, at major version \`${manifest.majorVersion}\` (P-06). Generated from the`,
    'running route table and kept equal to it by `tests/guardrails/the-api-surface-is-documented.test.ts`; to regenerate after',
    'adding or changing a route run `UPDATE_API_SURFACE=1 pnpm exec vitest run tests/guardrails/the-api-surface-is-documented.test.ts`.',
    'Payload shapes are the versioned schemas in `packages/contracts/` and the per-domain notes in `catalogue.md`; a partner reads',
    'this live from `GET /v1/platform/api-manifest` (M36-FR-04).',
    '',
    '## Conventions',
    '',
    ...Object.entries(manifest.conventions).map(([k, v]) => `- **${k}** — ${v}`),
    '',
    '## Counts',
    '',
    '| APIs served | Endpoints | Writes | Idempotent writes | Feature-gated | Distinct permissions |',
    '|---|---|---|---|---|---|',
    `| ${manifest.counts.apis} | ${manifest.counts.routes} | ${manifest.counts.writes} | ${manifest.counts.idempotentWrites} | ${manifest.counts.entitled} | ${manifest.counts.permissions} |`,
    '',
  ];
  if (manifest.violations.length > 0) {
    lines.push('## Convention violations', '', ...manifest.violations.map((v) => `- ${v}`), '');
  }
  for (const s of manifest.apis) {
    lines.push(`## ${s.api} — ${s.name} (${s.modules})`, '');
    if (s.routes.length === 0) { lines.push('_No endpoints served yet._', ''); continue; }
    lines.push('| Method | Path | Permission | Feature | Idempotent |', '|---|---|---|---|---|');
    for (const r of s.routes) {
      lines.push(`| ${r.method} | \`${r.path}\` | \`${r.permission}\` | ${r.entitlement === null ? 'core' : `\`${r.entitlement}\``} | ${r.write ? (r.idempotent ? 'yes' : 'NO') : '—'} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface ApiManifestDeps {
  /** The live route table — read at request time so the manifest includes everything registered, itself included. */
  readonly routes: () => readonly Route[];
  readonly now: () => string;
}

export function apiManifestRoutes(deps: ApiManifestDeps): readonly Route[] {
  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/platform/api-manifest',
      permission: 'platform.partner.read',
      handler: (ctx) => {
        const only = ctx.query['api'];
        if (only !== undefined && !API_IDS.includes(only as ApiId)) {
          throw apiError(400, {
            code: 'unknown_api_domain',
            whatHappened: `'${only}' is not an API domain. The domains are ${API_IDS.join(', ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask for one of the listed domains, or omit ?api= for the whole surface.',
          });
        }
        const manifest = buildApiManifest(deps.routes(), deps.now());
        return {
          status: 200,
          body: only === undefined ? manifest : { ...manifest, apis: manifest.apis.filter((s) => s.api === only) },
        };
      },
    },
  ];
}
