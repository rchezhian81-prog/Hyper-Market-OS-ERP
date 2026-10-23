// Guardrail (M32-FR-01 · §30.1 "OpenAPI/AsyncAPI or equivalent machine-readable contract" · M36-FR-04 · P-06 — OB-288 P5):
// the committed `docs/api/openapi.json` and `docs/api/asyncapi.json` are exactly what the running route table and the
// event contracts produce. A route added, renamed, re-permissioned, feature-gated or made idempotent — or an event added
// to §30.2 or published to partners — without the documents following fails here and says how to regenerate.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSurface } from '../../services/api/src/main';
import { PUBLISHED_TO_PARTNERS } from '../../services/api/src/adapters';
import { KNOWN_EVENT_TYPES } from '../../packages/contracts/src/event';
import { OUTBOUND_API_VERSION } from '../../services/platform/src/outbound-webhooks';
import { buildOpenApi, buildAsyncApi, renderContract } from '../../services/platform/src/api-contracts';

const PACK_KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const OPENAPI = fileURLToPath(new URL('../../docs/api/openapi.json', import.meta.url));
const ASYNCAPI = fileURLToPath(new URL('../../docs/api/asyncapi.json', import.meta.url));
const REGENERATE = 'UPDATE_API_CONTRACTS=1 pnpm exec vitest run tests/guardrails/the-openapi-and-asyncapi-documents-equal-the-router.test.ts';

const routes = buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal' });
const openapi = buildOpenApi(routes) as { paths: Record<string, Record<string, { operationId: string; parameters?: { name: string; in: string; required: boolean }[]; 'x-permission': string; 'x-idempotent'?: boolean }>> };
const asyncapi = buildAsyncApi({ domainEvents: KNOWN_EVENT_TYPES, publishedToPartners: PUBLISHED_TO_PARTNERS, outboundApiVersion: OUTBOUND_API_VERSION }) as { channels: Record<string, unknown> };

const readOr = (path: string): string => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const refsOf = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => refsOf(x, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string') out.push(x);
      else refsOf(x, out);
    }
  }
  return out;
};
const resolve = (doc: unknown, pointer: string): unknown => pointer.replace(/^#\//, '').split('/').reduce<unknown>((at, seg) => (at as Record<string, unknown> | undefined)?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')], doc);

describe('the OpenAPI document is the router (M32-FR-01)', () => {
  const ops = Object.entries(openapi.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })));

  it('carries one operation for every route served — none missing, none invented — each with its permission', () => {
    expect(ops.length).toBe(routes.length);
    expect(new Set(ops.map((o) => o.op.operationId)).size).toBe(ops.length);
    const served = new Set(routes.map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:[A-Za-z0-9_]+/g, '{}')}|${r.permission}`));
    for (const o of ops) expect(served.has(`${o.method} ${o.path.replace(/\{[A-Za-z0-9_]+\}/g, '{}')}|${o.op['x-permission']}`), `${o.method} ${o.path}`).toBe(true);
  });

  it('declares every path parameter, and the Idempotency-Key header on every idempotent write', () => {
    for (const o of ops) {
      const inPath = [...o.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
      expect((o.op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name), `${o.method} ${o.path}`).toEqual(inPath);
      const key = (o.op.parameters ?? []).find((p) => p.in === 'header' && p.name === 'Idempotency-Key');
      expect(key?.required === true, `${o.method} ${o.path} idempotency header`).toBe(o.op['x-idempotent'] === true);
    }
    expect(ops.some((o) => o.op['x-idempotent'] === true)).toBe(true);
  });

  it('every $ref resolves inside the document', () => {
    for (const r of new Set(refsOf(openapi))) expect(resolve(openapi, r), r).toBeDefined();
  });

  it('docs/api/openapi.json equals what the router produces (regenerate when a route changes)', () => {
    const expected = renderContract(buildOpenApi(routes));
    if (process.env['UPDATE_API_CONTRACTS'] === '1') writeFileSync(OPENAPI, expected);
    expect(readOr(OPENAPI) === expected, `docs/api/openapi.json is behind the running surface — run: ${REGENERATE}`).toBe(true);
  });
});

describe('the AsyncAPI document is the event contract (M32-FR-01 · §30.2)', () => {
  it('has a channel for every §30.2 event and a signed-webhook channel for every event published to partners', () => {
    for (const t of KNOWN_EVENT_TYPES) expect(asyncapi.channels[`events.${t}`], t).toBeDefined();
    for (const t of Object.keys(PUBLISHED_TO_PARTNERS)) expect(asyncapi.channels[`webhooks.${t}`], t).toBeDefined();
    expect(Object.keys(asyncapi.channels).length).toBe(KNOWN_EVENT_TYPES.length + Object.keys(PUBLISHED_TO_PARTNERS).length);
    for (const r of new Set(refsOf(asyncapi))) expect(resolve(asyncapi, r), r).toBeDefined();
  });

  it('docs/api/asyncapi.json equals what the contracts produce (regenerate when an event changes)', () => {
    const expected = renderContract(buildAsyncApi({ domainEvents: KNOWN_EVENT_TYPES, publishedToPartners: PUBLISHED_TO_PARTNERS, outboundApiVersion: OUTBOUND_API_VERSION }));
    if (process.env['UPDATE_API_CONTRACTS'] === '1') writeFileSync(ASYNCAPI, expected);
    expect(readOr(ASYNCAPI) === expected, `docs/api/asyncapi.json is behind the event contracts — run: ${REGENERATE}`).toBe(true);
  });
});
