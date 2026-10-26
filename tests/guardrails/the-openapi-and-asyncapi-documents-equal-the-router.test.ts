// Guardrail (M32-FR-01 · D14-FR-06 · §30.1 "OpenAPI/AsyncAPI or equivalent machine-readable contract" · M36-FR-04 · P-06 —
// OB-288 P5, FU-4): the committed `docs/api/openapi.json` and `docs/api/asyncapi.json` are exactly what the running route
// table, the event contracts and the CODE produce. Every route declares its request and reply body, and every event its
// payload — derived from the handlers' own reads, checks and refusals and the types their code returns and publishes
// (services/platform/src/api-body-derive.ts), never hand-written beside them. A route added, renamed, re-permissioned,
// feature-gated or made idempotent, a body a handler reads or returns differently, or an event added to §30.2 or built
// with a different payload — without the documents following — fails here and says how to regenerate. A body that cannot
// be derived is refused by name.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PUBLISHED_TO_PARTNERS } from '../../services/api/src/adapters';
import { KNOWN_EVENT_TYPES } from '../../packages/contracts/src/event';
import { OUTBOUND_API_VERSION } from '../../services/platform/src/outbound-webhooks';
import { buildOpenApi, buildAsyncApi, renderContract, undeclaredBodies } from '../../services/platform/src/api-contracts';
import { DECLARED_BODIES } from '../../services/platform/src/api-body-schemas';
import { derivedContract, servedRoutes } from '../support/derived-contract';

const OPENAPI = fileURLToPath(new URL('../../docs/api/openapi.json', import.meta.url));
const ASYNCAPI = fileURLToPath(new URL('../../docs/api/asyncapi.json', import.meta.url));
const REGENERATE = 'UPDATE_API_CONTRACTS=1 pnpm exec vitest run tests/guardrails/the-openapi-and-asyncapi-documents-equal-the-router.test.ts';

/**
 * §30.2 events the contract reserves that NO code builds yet (so there is no payload to derive). Said by name, never
 * hidden (P-08): when code first builds one, its payload is derived and it must leave this list; a new event no code
 * builds must be added here on purpose.
 */
const NOT_PUBLISHED_YET = ['ReconciliationExceptionResolved', 'RefundCompleted', 'RefundFailed', 'TenderAuthorized', 'TenderSettled', 'TenderUncertain'];

const routes = servedRoutes();
const bodies = derivedContract(routes);
type Op = { operationId: string; parameters?: { name: string; in: string; required: boolean }[]; 'x-permission': string; 'x-idempotent'?: boolean; 'x-body-schema'?: string; 'x-request-body'?: string; requestBody?: { content?: Record<string, { schema: { $ref?: string } }> }; responses: Record<string, { content?: Record<string, { schema: { $ref?: string } }> }> };
const openapi = buildOpenApi(routes, bodies) as { paths: Record<string, Record<string, Op>>; components: { schemas: Record<string, Record<string, unknown>> } };
const asyncapi = buildAsyncApi({ domainEvents: KNOWN_EVENT_TYPES, publishedToPartners: PUBLISHED_TO_PARTNERS, outboundApiVersion: OUTBOUND_API_VERSION, bodies }) as { channels: Record<string, unknown>; components: { schemas: Record<string, Record<string, unknown>> } };

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
const opOf = (key: string): Op | undefined => {
  const [method, path] = key.split(' ') as [string, string];
  return openapi.paths[path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')]?.[method.toLowerCase()];
};

describe('the OpenAPI document is the router (M32-FR-01)', () => {
  const ops = Object.entries(openapi.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })));

  it('carries one operation for every route served — none missing, none invented — each with its permission', () => {
    expect(ops.length).toBe(routes.length);
    expect(new Set(ops.map((o) => o.op.operationId)).size).toBe(ops.length);
    const served = new Set(routes.map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:[A-Za-z0-9_]+/g, '{}')}|${r.permission}`));
    for (const o of ops) expect(served.has(`${o.method} ${o.path.replace(/\{[A-Za-z0-9_]+\}/g, '{}')}|${o.op['x-permission']}`), `${o.method} ${o.path}`).toBe(true);
  });

  it('declares every path parameter, and the Idempotency-Key header on every idempotent write (paths stay /v1)', () => {
    for (const o of ops) {
      expect(o.path.startsWith('/v1/'), o.path).toBe(true);
      const inPath = [...o.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
      expect((o.op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name), `${o.method} ${o.path}`).toEqual(inPath);
      const key = (o.op.parameters ?? []).find((p) => p.in === 'header' && p.name === 'Idempotency-Key');
      expect(key?.required === true, `${o.method} ${o.path} idempotency header`).toBe(o.op['x-idempotent'] === true);
    }
    expect(ops.some((o) => o.op['x-idempotent'] === true)).toBe(true);
  });

  it('every route\'s bodies are derived from its own route object in the code — none left unread', () => {
    expect(bodies.problems).toEqual([]);
    for (const r of routes) expect(bodies.routes[`${r.method} ${r.path}`], `${r.method} ${r.path}`).toBeDefined();
  });

  it('REFUSES an undeclared body: every write declares its request (or that it reads none), every route its success reply', () => {
    expect(undeclaredBodies(openapi as unknown as Record<string, never>)).toEqual([]);
    expect(JSON.stringify(openapi)).not.toContain('OpenBody');
    expect(JSON.stringify(openapi)).not.toContain('not declared');
    const derived = ops.filter((o) => o.op['x-body-schema'] === 'derived').length;
    expect(derived).toBe(routes.length - Object.keys(DECLARED_BODIES).length);
  });

  it('the check itself refuses a route whose body is missing, untyped, or has no success reply', () => {
    const one = routes.find((r) => r.method === 'POST' && DECLARED_BODIES[`${r.method} ${r.path}`] === undefined && bodies.routes[`${r.method} ${r.path}`]?.request !== null)!;
    const key = `${one.method} ${one.path}`;
    const without = { ...bodies, routes: Object.fromEntries(Object.entries(bodies.routes).filter(([k]) => k !== key)) };
    expect(undeclaredBodies(buildOpenApi([one], without))).toEqual([expect.stringContaining('its bodies are not derived')]);
    const untyped = { ...bodies, routes: { ...bodies.routes, [key]: { ...bodies.routes[key]!, request: { 'x-untyped': 'unknown' }, replies: { '200': { 'x-untyped': 'unknown' } } } } };
    expect(undeclaredBodies(buildOpenApi([one], untyped))).toEqual([expect.stringContaining('request body schema'), expect.stringContaining('200 reply schema')]);
    const silent = { ...bodies, routes: { ...bodies.routes, [key]: { ...bodies.routes[key]!, replies: {} } } };
    expect(undeclaredBodies(buildOpenApi([one], silent))).toEqual([]); // it says x-never-succeeds instead, by name
    expect(buildOpenApi([one], silent)['paths']).toMatchObject({ [one.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')]: { post: { 'x-never-succeeds': true } } });
  });

  it('the money routes keep their declared bodies, and require every field the code refuses without', () => {
    for (const [key, d] of Object.entries(DECLARED_BODIES)) {
      const op = opOf(key);
      expect(op?.['x-body-schema'], key).toBe('declared');
      expect(op?.responses[d.reply.status]?.content?.['application/json']?.schema.$ref, key).toBe(`#/components/schemas/${d.name}Reply`);
      if (d.request !== undefined) {
        expect(op?.requestBody?.content?.['application/json']?.schema.$ref, key).toBe(`#/components/schemas/${d.name}Request`);
        const declaredRequired = [...((d.request as { required?: string[] }).required ?? [])].sort();
        const derivedRequired = [...((bodies.routes[key]?.request as { required?: string[] } | null)?.required ?? [])].sort();
        // Never less than the handler refuses without. (It may say more: POST /v1/finance/journals fails with a 500 rather
        // than a refusal when a journal arrives without its lines or narrative — reported, not changed here.)
        expect(declaredRequired, `${key}: the hand-declared schema does not require a field the handler refuses without`).toEqual(expect.arrayContaining(derivedRequired));
      }
    }
  });

  it('every $ref resolves inside the document', () => {
    for (const r of new Set(refsOf(openapi))) expect(resolve(openapi, r), r).toBeDefined();
  });

  it('docs/api/openapi.json equals what the router and the code produce (regenerate when a route or a body changes)', () => {
    const expected = renderContract(buildOpenApi(routes, bodies));
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

  it('every event the code builds declares its payload, derived from that code; the rest are named as not published yet', () => {
    const built = KNOWN_EVENT_TYPES.filter((t) => bodies.events[t] !== undefined);
    expect(KNOWN_EVENT_TYPES.filter((t) => !built.includes(t)).sort()).toEqual(NOT_PUBLISHED_YET);
    for (const t of KNOWN_EVENT_TYPES) {
      const payload = asyncapi.components.schemas[`${t}Payload`];
      expect(payload?.['x-payload-schema'], t).toBe(built.includes(t) ? 'derived' : 'not published');
      if (built.includes(t)) expect(payload?.['x-untyped'], t).toBeUndefined();
    }
  });

  it('docs/api/asyncapi.json equals what the contracts and the code produce (regenerate when an event changes)', () => {
    const expected = renderContract(buildAsyncApi({ domainEvents: KNOWN_EVENT_TYPES, publishedToPartners: PUBLISHED_TO_PARTNERS, outboundApiVersion: OUTBOUND_API_VERSION, bodies }));
    if (process.env['UPDATE_API_CONTRACTS'] === '1') writeFileSync(ASYNCAPI, expected);
    expect(readOr(ASYNCAPI) === expected, `docs/api/asyncapi.json is behind the event contracts — run: ${REGENERATE}`).toBe(true);
  });
});
