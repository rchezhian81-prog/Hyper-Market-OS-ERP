// API-11 Platform — the MACHINE-READABLE CONTRACTS: an OpenAPI 3.1 document of every endpoint and an AsyncAPI 3.0 document
// of the §30.2 domain events and the events published to partners (M32-FR-01 · roadmap §30.1 "OpenAPI/AsyncAPI or
// equivalent machine-readable contract" · M36-FR-04 · D14-FR-06 · P-06 — OB-288 P5).
//
// Both are GENERATED, never written by hand: the OpenAPI document from the same running route table `docs/api/surface.md`
// is built from (so it cannot list a route the kernel does not serve, or miss one it does), and the AsyncAPI document from
// the contracts package's event list and the partner-publication map the outbound webhooks read. A guardrail keeps the
// committed `docs/api/openapi.json` and `docs/api/asyncapi.json` equal to what this module produces.
//
// What they state, per endpoint: the method and versioned path, its path parameters, bearer authentication, the
// permission demanded (`x-permission`), the optional feature it belongs to (`x-entitlement`), any step-up sign-in
// (`x-reauth`), the REQUIRED `Idempotency-Key` header on every idempotent write, and the one error shape every refusal
// carries ({ error: { code, whatHappened, wasItSaved, nextSafeAction, traceId } }) on the statuses the kernel itself
// returns (401 / 403 / 404 / 409 / 429). Shared value shapes (Money and Quantity in minor units, the event envelope,
// the currency and unit lists) come from `packages/contracts`.
//
// Request and reply BODY schemas (M32-FR-01 · D14-FR-06): every route declares both, and every event its payload. They are
// DERIVED from the code (`api-body-derive.ts`: the handler's own reads, checks and refusals, and the types its code returns
// and publishes) and handed in here as `bodies` — never written by hand, so they cannot drift from the handlers. The nine
// money routes keep the fuller schemas written for them in `api-body-schemas.ts` (`x-body-schema: "declared"`, checked
// against the real handlers by tests/integration/money-route-schemas-match-the-handlers.test.ts, and held to the derived
// required fields by the guardrail); every other body says `x-body-schema: "derived"` and names the file it is read from.
// A write that never reads its body says so (`x-request-body: "none"`); a retired route that only ever refuses says
// `x-never-succeeds`. Deterministic: no timestamp, no line numbers, stable ordering, so the files change only when the
// surface does.

import type { Route, Method } from '../../kernel/src/index';
import { API_DOMAINS, MAJOR_VERSION } from './api-manifest';
import { CURRENCY_PRECISION } from '../../../packages/contracts/src/money';
import { UOM_PRECISION } from '../../../packages/contracts/src/quantity';
import { TENDER_KINDS } from '../../../packages/contracts/src/enums';
import { DECLARED_BODIES } from './api-body-schemas';
import type { Derived, Json as DerivedJson } from './api-body-derive';

const WRITES: readonly Method[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
export const CONTRACT_DOCUMENT_VERSION = '1.0.0';

type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const errorReply = (description: string): Json => ({ description, content: { 'application/json': { schema: ref('ApiErrorReply') } } });
const respRef = (name: string): Json => ({ $ref: `#/components/responses/${name}` });

/** The shared schemas, from `packages/contracts` (value objects in minor units, the envelope, the error). */
function sharedSchemas(): Record<string, Json> {
  return {
    Money: {
      type: 'object', required: ['minor', 'currency'], additionalProperties: false,
      description: 'An amount in whole minor units (e.g. 1050 = ₹10.50) — never a float (packages/contracts/src/money.ts).',
      properties: { minor: { type: 'integer' }, currency: { type: 'string', enum: Object.keys(CURRENCY_PRECISION).sort() } },
    },
    Quantity: {
      type: 'object', required: ['minor', 'uom'], additionalProperties: false,
      description: 'A quantity in the unit\'s smallest step (e.g. 1234 = 1.234 kg) (packages/contracts/src/quantity.ts).',
      properties: { minor: { type: 'integer' }, uom: { type: 'string', enum: Object.keys(UOM_PRECISION).sort() } },
    },
    TenderKind: { type: 'string', enum: [...TENDER_KINDS] },
    ApiError: {
      type: 'object', required: ['code', 'whatHappened', 'wasItSaved', 'nextSafeAction'],
      properties: {
        code: { type: 'string', description: 'A stable machine code, e.g. permission_denied, idempotency_key_reused.' },
        whatHappened: { type: 'string' },
        wasItSaved: { type: 'string', enum: ['saved', 'not_saved', 'unknown'], description: '"unknown" is honest: a timeout or a lost reply.' },
        nextSafeAction: { type: 'string' },
        traceId: { type: 'string', description: 'Correlates the reply with the audit trail; never business data.' },
      },
    },
    ApiErrorReply: { type: 'object', required: ['error'], properties: { error: ref('ApiError') } },
    DomainEvent: {
      type: 'object', required: ['id', 'type', 'occurredAt', 'idempotencyKey', 'source', 'version', 'payload'],
      description: 'The §30.2 event envelope (packages/contracts/src/event.ts). Consumers dedupe on idempotencyKey (§31.1).',
      properties: {
        id: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 },
        occurredAt: { type: 'string', format: 'date-time', description: 'ISO-8601 UTC ("Z").' },
        idempotencyKey: { type: 'string', minLength: 1 }, source: { type: 'string', minLength: 1 },
        version: { type: 'integer', minimum: 1, description: 'The payload schema version.' },
        payload: { description: 'The event\'s own payload; each event message names its schema.' },
      },
    },
  };
}

const paramNames = (path: string): string[] => [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
const skeleton = (path: string): string => path.replace(/:[A-Za-z0-9_]+/g, ':');
const operationId = (method: Method, path: string): string =>
  `${method.toLowerCase()}${path.replace(/^\/v1/, '').split('/').filter(Boolean).map((seg) => seg.startsWith(':') ? `By${seg[1]!.toUpperCase()}${seg.slice(2)}` : seg.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ?? '').toUpperCase()).replace(/^./, (c) => c.toUpperCase())).join('')}`;

const pascal = (id: string): string => id.replace(/^./, (c) => c.toUpperCase());
const hasRequired = (j: Json): boolean => j !== null && typeof j === 'object' && !Array.isArray(j) && Array.isArray((j as Record<string, Json>)['required']) && ((j as Record<string, Json>)['required'] as Json[]).length > 0;

/** Every `#/components/schemas/<name>` an object refers to. */
const schemaRefs = (j: Json, out: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(j)) for (const x of j) schemaRefs(x, out);
  else if (j !== null && typeof j === 'object') for (const [k, v] of Object.entries(j)) {
    if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) out.add(v.slice('#/components/schemas/'.length));
    else schemaRefs(v, out);
  }
  return out;
};

/**
 * The derived named schemas, placed beside the shared ones: a derived name the document already uses (Money, ApiError…)
 * is carried as `<name>.code`, and only the names something refers to are kept.
 */
function placeDerived(bodies: Derived, reserved: ReadonlySet<string>): { readonly rewrite: (j: DerivedJson) => Json; readonly closure: (roots: readonly Json[]) => Record<string, Json> } {
  const nameOf = (n: string): string => (reserved.has(n) ? `${n}.code` : n);
  const rewrite = (j: DerivedJson): Json => {
    if (Array.isArray(j)) return j.map(rewrite);
    if (j !== null && typeof j === 'object') {
      const o = j as Record<string, DerivedJson>;
      const r = o['$ref'];
      if (typeof r === 'string' && r.startsWith('#/components/schemas/')) return { $ref: `#/components/schemas/${nameOf(r.slice('#/components/schemas/'.length))}` };
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, rewrite(v)]));
    }
    return j;
  };
  const placed = new Map(Object.entries(bodies.components).map(([n, j]) => [nameOf(n), rewrite(j)]));
  const closure = (roots: readonly Json[]): Record<string, Json> => {
    const keep = new Set<string>();
    const queue = [...schemaRefs(roots as Json)];
    while (queue.length > 0) {
      const n = queue.pop()!;
      if (keep.has(n) || !placed.has(n)) continue;
      keep.add(n);
      queue.push(...schemaRefs(placed.get(n)!));
    }
    return Object.fromEntries([...keep].sort().map((n) => [n, placed.get(n)!]));
  };
  return { rewrite, closure };
}

/**
 * The OpenAPI 3.1 document for a route table, with every request and reply body (`bodies`, derived from the code). Paths
 * that differ only in a parameter's NAME share one OpenAPI path (the specification forbids two templates of the same
 * shape); the first path in order names the parameters.
 */
export function buildOpenApi(routes: readonly Route[], bodies: Derived): Record<string, Json> {
  const sorted = [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const templateOf = new Map<string, string>();
  for (const r of sorted) if (!templateOf.has(skeleton(r.path))) templateOf.set(skeleton(r.path), r.path);
  const paths: Record<string, Record<string, Json>> = {};
  const usedIds = new Set<string>();
  const bodySchemas: Record<string, Json> = {};
  const reserved = new Set([...Object.keys(sharedSchemas()), ...Object.values(DECLARED_BODIES).flatMap((d) => [`${d.name}Request`, `${d.name}Reply`])]);
  const placed = placeDerived(bodies, reserved);
  const content = (name: string): Json => ({ 'application/json': { schema: ref(name) } });
  for (const r of sorted) {
    const template = templateOf.get(skeleton(r.path))!;
    const key = template.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const write = WRITES.includes(r.method);
    let id = operationId(r.method, r.path);
    for (let n = 2; usedIds.has(id); n += 1) id = `${operationId(r.method, r.path)}${n}`;
    usedIds.add(id);
    const parameters: Json[] = paramNames(template).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
    if (write && r.idempotent === true) {
      parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1 }, description: 'A replay with the same key and body returns the first answer; the same key with a different body is refused (409).' });
    }
    const responses: Record<string, Json> = {
      '401': respRef('Unauthorised'),
      '403': errorReply(`Not "${r.permission}"${r.entitlement === undefined ? '' : `, or the plan lacks "${r.entitlement}"`}${r.reauth === undefined ? '' : ', or a recent re-authentication is needed'}.`),
      '429': respRef('TooManyRequests'),
    };
    if (paramNames(template).length > 0) responses['404'] = respRef('NotFound');
    if (write && r.idempotent === true) responses['409'] = respRef('Conflict');
    if (write) responses['400'] = respRef('Unreadable');
    const routeKey = `${r.method} ${r.path}`;
    const declared = DECLARED_BODIES[routeKey];
    const derived = bodies.routes[routeKey];
    const stem = pascal(id);
    let requestBody: Json = { required: false, content: { 'application/json': { schema: { 'x-body-schema': 'not derived' } } } };
    let bodySchema = 'not derived';
    let neverSucceeds = false;
    if (declared !== undefined) {
      // The money routes' declared bodies (api-body-schemas.ts): the request it reads and the reply it gives on success.
      bodySchema = 'declared';
      const reply = `${declared.name}Reply`;
      bodySchemas[reply] = { ...(declared.reply.schema as Record<string, Json>), 'x-body-schema': 'declared' };
      const c: Json = { description: declared.reply.description, content: content(reply) };
      responses[declared.reply.status] = c;
      if (declared.reply.alsoStatus !== undefined) responses[declared.reply.alsoStatus] = c;
      if (declared.request !== undefined) {
        const request = `${declared.name}Request`;
        bodySchemas[request] = { ...(declared.request as Record<string, Json>), 'x-body-schema': 'declared' };
        requestBody = { required: true, content: content(request) };
      } else {
        requestBody = { required: false, description: 'This route reads no body.', content: { 'application/json': { schema: { type: 'object' } } } };
      }
    } else if (derived !== undefined) {
      bodySchema = 'derived';
      const from = { 'x-body-schema': 'derived', 'x-derived-from': derived.at };
      if (derived.request === null) {
        requestBody = { required: false, description: 'This route reads no body; anything sent is ignored.', content: { 'application/json': { schema: { type: 'object' } } } };
      } else {
        const request = `${stem}Request`;
        bodySchemas[request] = { ...(placed.rewrite(derived.request) as Record<string, Json>), ...from };
        requestBody = { required: hasRequired(bodySchemas[request]!), content: content(request) };
      }
      const statuses = Object.keys(derived.replies).sort();
      neverSucceeds = statuses.length === 0;
      for (const st of statuses) {
        const reply = statuses.length === 1 ? `${stem}Reply` : `${stem}Reply${st}`;
        bodySchemas[reply] = { ...(placed.rewrite(derived.replies[st]!) as Record<string, Json>), ...from };
        responses[st] = { description: 'The reply, as the handler builds it.', content: content(reply) };
      }
    }
    const op: Record<string, Json> = {
      operationId: id,
      tags: [`${r.api} ${API_DOMAINS[r.api].name}`],
      security: [{ bearer: [] }],
      'x-permission': r.permission,
      'x-entitlement': r.entitlement ?? null,
      ...(r.reauth === undefined ? {} : { 'x-reauth': { withinSeconds: r.reauth.withinSeconds, ...(r.reauth.amr === undefined ? {} : { amr: [...r.reauth.amr] }) } }),
      ...(write ? { 'x-idempotent': r.idempotent === true } : {}),
      ...(r.shownOnce === undefined ? {} : { 'x-shown-once': [...r.shownOnce] }),
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(write ? { requestBody } : {}),
      ...(write && (declared === undefined ? derived?.request === null : declared.request === undefined) ? { 'x-request-body': 'none' } : {}),
      'x-body-schema': bodySchema,
      ...(neverSucceeds ? { 'x-never-succeeds': true, description: 'Retired or refusal-only: every call is refused, by name, with one of the error replies below.' } : {}),
      responses: Object.fromEntries(Object.keys(responses).sort().map((k) => [k, responses[k]!])),
    };
    (paths[key] ??= {})[r.method.toLowerCase()] = op;
  }
  const orderedPaths: Record<string, Json> = {};
  for (const k of Object.keys(paths).sort()) {
    const methods = paths[k]!;
    orderedPaths[k] = Object.fromEntries(Object.keys(methods).sort().map((m) => [m, methods[m]!]));
  }
  const named = placed.closure(Object.values(bodySchemas));
  return {
    openapi: '3.1.0',
    info: {
      title: 'SRE Retail OS API', version: `${MAJOR_VERSION}-${CONTRACT_DOCUMENT_VERSION}`,
      description: 'Generated from the running route table (services/platform/src/api-contracts.ts), with every request and reply body derived from the handlers\' own code (services/platform/src/api-body-derive.ts); kept equal to both by tests/guardrails/the-openapi-and-asyncapi-documents-equal-the-router.test.ts. Every call is scoped to the caller\'s tenant (§35). Changes within a major are additive only (P-06). In a request schema, `x-unchecked` marks a property the handler reads and passes on without checking its type; `x-untyped` inside a reply marks a value the code does not fix the shape of.',
    },
    servers: [{ url: '/', description: 'The head-office API, or a store computer\'s local API for the routes it serves.' }],
    tags: Object.entries(API_DOMAINS).map(([api, d]) => ({ name: `${api} ${d.name}`, description: `Modules ${d.modules}` })),
    paths: orderedPaths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A signed token from Identity (API-01). The permission listed on each operation is checked on the server, then the optional feature; default-deny.' } },
      responses: {
        Unauthorised: errorReply('No valid sign-in.'),
        TooManyRequests: errorReply('Too many requests; wait for Retry-After.'),
        NotFound: errorReply('The record named in the path is not here.'),
        Conflict: errorReply('The Idempotency-Key was used for a different request, or the change conflicts with one recorded a moment ago.'),
        Unreadable: errorReply('The body could not be read as this request; nothing was saved.'),
      },
      schemas: { ...sharedSchemas(), ...Object.fromEntries(Object.keys(bodySchemas).sort().map((k) => [k, bodySchemas[k]!])), ...named },
    },
  };
}

export interface AsyncApiInput {
  /** The §30.2 domain events (`KNOWN_EVENT_TYPES`). */
  readonly domainEvents: readonly string[];
  /** The events published to partners, with the ledger stream each is read from (`PUBLISHED_TO_PARTNERS`). */
  readonly publishedToPartners: Readonly<Record<string, string>>;
  /** The outbound webhook body version (`OUTBOUND_API_VERSION`). */
  readonly outboundApiVersion: string;
  /** Each event's payload schema, derived from the code that builds it. */
  readonly bodies: Derived;
}

/** The AsyncAPI 3.0 document: the domain events on the store↔cloud sync, and the signed webhooks partners receive. */
export function buildAsyncApi(input: AsyncApiInput): Record<string, Json> {
  const domain = [...new Set(input.domainEvents)].sort();
  const partner = Object.keys(input.publishedToPartners).sort();
  const channels: Record<string, Json> = {};
  const operations: Record<string, Json> = {};
  const messages: Record<string, Json> = {};
  const payloads: Record<string, Json> = {};
  const placed = placeDerived(input.bodies, new Set(['DomainEvent', 'Money', 'Quantity']));
  /** The payload schema of an event, or — for one no code builds yet — a statement saying so (P-08, never a blank). */
  const payloadOf = (type: string): Json => {
    const name = `${type}Payload`;
    if (payloads[name] === undefined) {
      const d = input.bodies.events[type];
      payloads[name] = d === undefined
        ? { 'x-payload-schema': 'not published', description: `No code builds a ${type} event yet: it is a §30.2 event the contract reserves. When code first builds one, its payload schema is derived from that code.` }
        : { ...(placed.rewrite(d.payload) as Record<string, Json>), 'x-payload-schema': 'derived', 'x-derived-from': [...d.at] };
    }
    return ref(name);
  };
  for (const type of domain) {
    messages[`event.${type}`] = {
      name: type, title: type, contentType: 'application/json',
      summary: `The ${type} domain event, in the §30.2 envelope.`,
      payload: { allOf: [ref('DomainEvent'), { type: 'object', properties: { type: { const: type }, payload: payloadOf(type) } }] },
    };
    channels[`events.${type}`] = {
      'address': `events/${type}`,
      description: `${type} — appended to the tenant's ledger and carried store→cloud by the sync outbox; replay collapses to one effect on idempotencyKey (§31.1).${input.publishedToPartners[type] === undefined ? '' : ` Also published to partners (webhooks.${type}).`}`,
      messages: { [type]: { $ref: `#/components/messages/event.${type}` } },
    };
    operations[`publish.${type}`] = { action: 'send', channel: { $ref: `#/channels/events.${type}` }, messages: [{ $ref: `#/channels/events.${type}/messages/${type}` }] };
  }
  for (const type of partner) {
    messages[`webhook.${type}`] = {
      name: `webhook.${type}`, title: `${type} webhook`, contentType: 'application/json',
      summary: `The signed webhook a subscribed partner receives for each ${type}.`,
      headers: {
        type: 'object', required: ['x-sre-webhook-id', 'x-sre-webhook-timestamp', 'x-sre-webhook-signature', 'x-sre-api-version'],
        properties: {
          'x-sre-webhook-id': { type: 'string', description: '<subscriptionId>.<eventId> — the partner dedupes on it.' },
          'x-sre-webhook-timestamp': { type: 'string', format: 'date-time' },
          'x-sre-webhook-signature': { type: 'string', pattern: '^v1=[0-9a-f]{64}$', description: 'v1= HMAC-SHA256 (hex) of "<timestamp>.<body>" with the subscription\'s signing secret. Reject a stale timestamp.' },
          'x-sre-api-version': { type: 'string', const: input.outboundApiVersion },
        },
      },
      payload: {
        type: 'object', required: ['id', 'apiVersion', 'type', 'occurredAt', 'tenantId', 'subscriptionId', 'data'],
        properties: {
          id: { type: 'string' }, apiVersion: { type: 'string', const: input.outboundApiVersion }, type: { type: 'string', const: type },
          occurredAt: { type: 'string', format: 'date-time' }, tenantId: { type: 'string' }, subscriptionId: { type: 'string' },
          data: { allOf: [payloadOf(type)], description: `The ${type} event payload as recorded.` },
        },
      },
    };
    channels[`webhooks.${type}`] = {
      'address': '{partnerUrl}',
      parameters: { partnerUrl: { description: 'The HTTPS address approved on the subscription (POST /v1/integration/outbound-webhooks/{subscriptionId}); judged again before every attempt.' } },
      description: `${type}, read from the ${input.publishedToPartners[type]} ledger and POSTed to each active subscription. A 408, 429 or 5xx is retried with back-off; anything else, or the last retry, is dead-lettered and kept.`,
      messages: { [type]: { $ref: `#/components/messages/webhook.${type}` } },
    };
    operations[`deliver.${type}`] = { action: 'send', channel: { $ref: `#/channels/webhooks.${type}` }, messages: [{ $ref: `#/channels/webhooks.${type}/messages/${type}` }] };
  }
  const shared = sharedSchemas();
  return {
    asyncapi: '3.0.0',
    info: {
      title: 'SRE Retail OS events', version: `${MAJOR_VERSION}-${CONTRACT_DOCUMENT_VERSION}`,
      description: 'Generated from packages/contracts KNOWN_EVENT_TYPES and the partner-publication map, with every payload derived from the code that builds the event (services/platform/src/api-contracts.ts, api-body-derive.ts); kept equal to them by tests/guardrails/the-openapi-and-asyncapi-documents-equal-the-router.test.ts.',
    },
    defaultContentType: 'application/json',
    channels, operations,
    components: {
      messages,
      schemas: {
        DomainEvent: shared['DomainEvent']!, Money: shared['Money']!, Quantity: shared['Quantity']!,
        ...Object.fromEntries(Object.keys(payloads).sort().map((k) => [k, payloads[k]!])),
        ...placed.closure(Object.values(payloads)),
      },
    },
  };
}

/**
 * Every body an OpenAPI document leaves UNDECLARED, said by operation (the guardrail refuses any): a route whose bodies
 * were not derived, a write with no request schema (and not marked as reading none), an operation with no success reply
 * schema (and not marked as never succeeding), or a request/reply schema that is itself untyped.
 */
export function undeclaredBodies(doc: Record<string, Json>): string[] {
  const out: string[] = [];
  const schemas = ((doc['components'] as Record<string, Json> | undefined)?.['schemas'] ?? {}) as Record<string, Record<string, Json>>;
  const refName = (c: Json | undefined): string | undefined => {
    const schema = ((c as Record<string, Json> | undefined)?.['application/json'] as Record<string, Json> | undefined)?.['schema'] as Record<string, Json> | undefined;
    const r = schema?.['$ref'];
    return typeof r === 'string' && r.startsWith('#/components/schemas/') ? r.slice('#/components/schemas/'.length) : undefined;
  };
  const untypedAtTop = (s: Record<string, Json> | undefined): boolean =>
    s === undefined || s['x-untyped'] !== undefined || (Array.isArray(s['anyOf']) && (s['anyOf'] as Record<string, Json>[]).some((a) => a['x-untyped'] !== undefined));
  for (const [path, methods] of Object.entries((doc['paths'] ?? {}) as Record<string, Record<string, Record<string, Json>>>)) {
    for (const [method, op] of Object.entries(methods)) {
      const at = `${method.toUpperCase()} ${path}`;
      if (op['x-body-schema'] !== 'declared' && op['x-body-schema'] !== 'derived') { out.push(`${at}: its bodies are not derived`); continue; }
      if (WRITES.includes(method.toUpperCase() as Method) && op['x-request-body'] !== 'none') {
        const name = refName((op['requestBody'] as Record<string, Json> | undefined)?.['content']);
        if (name === undefined) out.push(`${at}: no request body schema`);
        else if (untypedAtTop(schemas[name])) out.push(`${at}: the request body schema ${name} is untyped`);
      }
      const replies = Object.entries((op['responses'] ?? {}) as Record<string, Record<string, Json>>).filter(([st]) => /^2(\d\d|XX)$/.test(st));
      if (replies.length === 0 && op['x-never-succeeds'] !== true) out.push(`${at}: no success reply schema`);
      for (const [st, r] of replies) {
        const name = refName(r['content']);
        if (name === undefined) out.push(`${at}: the ${st} reply has no schema`);
        else if (untypedAtTop(schemas[name])) out.push(`${at}: the ${st} reply schema ${name} is untyped`);
      }
    }
  }
  return out;
}

/** Pretty JSON with a trailing newline — the committed form. */
export const renderContract = (doc: Record<string, Json>): string => `${JSON.stringify(doc, null, 2)}\n`;
