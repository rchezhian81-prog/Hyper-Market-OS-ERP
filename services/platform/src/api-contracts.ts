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
// What they do NOT yet state, and say so in the document rather than hiding it (P-08): a per-endpoint request or reply
// body schema. No route declares one today — bodies are validated in each handler — so each body is described as an
// open JSON object with `x-body-schema: "not declared"`. Declaring them is per-domain work, named in the report.
// Deterministic: no timestamp, stable ordering, so the files change only when the surface does.

import type { Route, Method } from '../../kernel/src/index';
import { API_DOMAINS, MAJOR_VERSION } from './api-manifest';
import { CURRENCY_PRECISION } from '../../../packages/contracts/src/money';
import { UOM_PRECISION } from '../../../packages/contracts/src/quantity';
import { TENDER_KINDS } from '../../../packages/contracts/src/enums';

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
    OpenBody: {
      type: 'object', additionalProperties: true,
      description: 'A JSON object. This endpoint does not yet declare its body schema; the handler validates it and refuses an unreadable body with 400 and a reason.',
      'x-body-schema': 'not declared',
    },
    DomainEvent: {
      type: 'object', required: ['id', 'type', 'occurredAt', 'idempotencyKey', 'source', 'version', 'payload'],
      description: 'The §30.2 event envelope (packages/contracts/src/event.ts). Consumers dedupe on idempotencyKey (§31.1).',
      properties: {
        id: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 },
        occurredAt: { type: 'string', format: 'date-time', description: 'ISO-8601 UTC ("Z").' },
        idempotencyKey: { type: 'string', minLength: 1 }, source: { type: 'string', minLength: 1 },
        version: { type: 'integer', minimum: 1, description: 'The payload schema version.' },
        payload: { type: 'object', additionalProperties: true, 'x-body-schema': 'not declared' },
      },
    },
  };
}

const paramNames = (path: string): string[] => [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
const skeleton = (path: string): string => path.replace(/:[A-Za-z0-9_]+/g, ':');
const operationId = (method: Method, path: string): string =>
  `${method.toLowerCase()}${path.replace(/^\/v1/, '').split('/').filter(Boolean).map((seg) => seg.startsWith(':') ? `By${seg[1]!.toUpperCase()}${seg.slice(2)}` : seg.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ?? '').toUpperCase()).replace(/^./, (c) => c.toUpperCase())).join('')}`;

/**
 * The OpenAPI 3.1 document for a route table. Paths that differ only in a parameter's NAME share one OpenAPI path (the
 * specification forbids two templates of the same shape); the first path in order names the parameters.
 */
export function buildOpenApi(routes: readonly Route[]): Record<string, Json> {
  const sorted = [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const templateOf = new Map<string, string>();
  for (const r of sorted) if (!templateOf.has(skeleton(r.path))) templateOf.set(skeleton(r.path), r.path);
  const paths: Record<string, Record<string, Json>> = {};
  const usedIds = new Set<string>();
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
      default: respRef('Reply'),
      '401': respRef('Unauthorised'),
      '403': errorReply(`Not "${r.permission}"${r.entitlement === undefined ? '' : `, or the plan lacks "${r.entitlement}"`}${r.reauth === undefined ? '' : ', or a recent re-authentication is needed'}.`),
      '429': respRef('TooManyRequests'),
    };
    if (paramNames(template).length > 0) responses['404'] = respRef('NotFound');
    if (write && r.idempotent === true) responses['409'] = respRef('Conflict');
    if (write) responses['400'] = respRef('Unreadable');
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
      ...(write ? { requestBody: { $ref: '#/components/requestBodies/Body' } } : {}),
      responses,
    };
    (paths[key] ??= {})[r.method.toLowerCase()] = op;
  }
  const orderedPaths: Record<string, Json> = {};
  for (const k of Object.keys(paths).sort()) {
    const methods = paths[k]!;
    orderedPaths[k] = Object.fromEntries(Object.keys(methods).sort().map((m) => [m, methods[m]!]));
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'SRE Retail OS API', version: `${MAJOR_VERSION}-${CONTRACT_DOCUMENT_VERSION}`,
      description: 'Generated from the running route table (services/platform/src/api-contracts.ts); kept equal to it by tests/guardrails/the-openapi-and-asyncapi-documents-equal-the-router.test.ts. Every call is scoped to the caller\'s tenant (§35). Changes within a major are additive only (P-06).',
    },
    servers: [{ url: '/', description: 'The head-office API, or a store computer\'s local API for the routes it serves.' }],
    tags: Object.entries(API_DOMAINS).map(([api, d]) => ({ name: `${api} ${d.name}`, description: `Modules ${d.modules}` })),
    paths: orderedPaths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A signed token from Identity (API-01). The permission listed on each operation is checked on the server, then the optional feature; default-deny.' } },
      requestBodies: { Body: { required: false, content: { 'application/json': { schema: ref('OpenBody') } } } },
      responses: {
        Reply: { description: 'The reply. Its body schema is not yet declared for this endpoint.', content: { 'application/json': { schema: ref('OpenBody') } } },
        Unauthorised: errorReply('No valid sign-in.'),
        TooManyRequests: errorReply('Too many requests; wait for Retry-After.'),
        NotFound: errorReply('The record named in the path is not here.'),
        Conflict: errorReply('The Idempotency-Key was used for a different request, or the change conflicts with one recorded a moment ago.'),
        Unreadable: errorReply('The body could not be read as this request; nothing was saved.'),
      },
      schemas: sharedSchemas(),
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
}

/** The AsyncAPI 3.0 document: the domain events on the store↔cloud sync, and the signed webhooks partners receive. */
export function buildAsyncApi(input: AsyncApiInput): Record<string, Json> {
  const domain = [...new Set(input.domainEvents)].sort();
  const partner = Object.keys(input.publishedToPartners).sort();
  const channels: Record<string, Json> = {};
  const operations: Record<string, Json> = {};
  const messages: Record<string, Json> = {};
  for (const type of domain) {
    messages[`event.${type}`] = {
      name: type, title: type, contentType: 'application/json',
      summary: `The ${type} domain event, in the §30.2 envelope.`,
      payload: { allOf: [ref('DomainEvent'), { type: 'object', properties: { type: { const: type } } }] },
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
          data: { type: 'object', additionalProperties: true, 'x-body-schema': 'not declared', description: `The ${type} event payload as recorded.` },
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
  return {
    asyncapi: '3.0.0',
    info: {
      title: 'SRE Retail OS events', version: `${MAJOR_VERSION}-${CONTRACT_DOCUMENT_VERSION}`,
      description: 'Generated from packages/contracts KNOWN_EVENT_TYPES and the partner-publication map (services/platform/src/api-contracts.ts); kept equal to them by tests/guardrails/the-openapi-and-asyncapi-documents-equal-the-router.test.ts.',
    },
    defaultContentType: 'application/json',
    channels, operations,
    components: { messages, schemas: { DomainEvent: sharedSchemas()['DomainEvent']!, Money: sharedSchemas()['Money']!, Quantity: sharedSchemas()['Quantity']! } },
  };
}

/** Pretty JSON with a trailing newline — the committed form. */
export const renderContract = (doc: Record<string, Json>): string => `${JSON.stringify(doc, null, 2)}\n`;
