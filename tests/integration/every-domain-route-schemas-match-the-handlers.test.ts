import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { schemaProblems } from '../support/json-schema-check';
import { servedRoutes } from '../support/derived-contract';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { OPTIONAL_FEATURES } from '../../packages/tenant/src/tenant';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { DECLARED_BODIES } from '../../services/platform/src/api-body-schemas';

// M32-FR-01 · D14-FR-06 (FU-4): the request and reply bodies in docs/api/openapi.json are DERIVED from the handlers' own
// code (services/platform/src/api-body-derive.ts). This proves, against the running handlers, that the published
// contract is what the routes actually accept and return — for a sample of routes in EVERY domain (API-01 … API-13):
//   • a valid body fits the declared request schema, the route accepts it, and its reply fits the declared reply schema;
//   • each property the schema declares REQUIRED, at any depth, when left out: the schema refuses the body AND the route
//     refuses it (400 / 422) — "refused as declared";
//   • a required property of the wrong JSON type: the schema refuses it AND the route refuses it.
// And, for EVERY write route in the table, that none accepts an empty body its declared schema refuses. Synthetic data.

type Schema = Record<string, unknown>;
const DOC = JSON.parse(readFileSync(new URL('../../docs/api/openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, Schema>>; components: { schemas: Record<string, Schema> } };
const TODAY = '2026-10-20';
const STAFF = ['owner', 'store_manager', 'internal_committee', 'cashier', 'platform_admin', 'accountant', 'chartered_accountant'];

const skeleton = (p: string): string => p.replace(/\{[A-Za-z0-9_]+\}|:[A-Za-z0-9_]+/g, '{}');
const opFor = (method: string, path: string): Schema => {
  const key = Object.keys(DOC.paths).find((k) => skeleton(k) === skeleton(path) && DOC.paths[k]![method.toLowerCase()] !== undefined);
  const op = key === undefined ? undefined : DOC.paths[key]![method.toLowerCase()];
  if (op === undefined) throw new Error(`${method} ${path} is not in docs/api/openapi.json`);
  return op;
};
const deref = (s: Schema): Schema => {
  const r = s['$ref'];
  return typeof r === 'string' ? deref(r.replace(/^#\//, '').split('/').reduce<unknown>((at, seg) => (at as Record<string, unknown>)[seg], DOC) as Schema) : s;
};
const contentSchema = (c: unknown): Schema => deref(((c as Record<string, Record<string, Schema>>)['application/json']!)['schema']!);
const requestSchemaOf = (method: string, path: string): Schema => contentSchema((opFor(method, path)['requestBody'] as Schema)['content']);
const replySchemaOf = (method: string, path: string, status: number): Schema | undefined => {
  const responses = opFor(method, path)['responses'] as Record<string, Schema>;
  const r = responses[String(status)] ?? responses['2XX'];
  return r?.['content'] === undefined ? undefined : contentSchema(r['content']);
};

/** The alternative of a schema a value is read against (an anyOf picks the first it fits). */
const shapeFor = (value: unknown, schema: Schema): Schema => {
  const s = deref(schema);
  if (Array.isArray(s['anyOf'])) return deref((s['anyOf'] as Schema[]).find((a) => schemaProblems(value, a, DOC).length === 0) ?? (s['anyOf'] as Schema[])[0]!);
  return s;
};

/** Every property the schema declares required that the body carries, at any depth (a list's first item stands for all). */
function requiredPaths(value: unknown, schema: Schema, at: (string | number)[] = []): (string | number)[][] {
  const s = shapeFor(value, schema);
  const out: (string | number)[][] = [];
  if (Array.isArray(value) && s['items'] !== undefined && value.length > 0) out.push(...requiredPaths(value[0], s['items'] as Schema, [...at, 0]));
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = (s['properties'] ?? {}) as Record<string, Schema>;
    for (const k of (s['required'] as string[] | undefined) ?? []) if (k in (value as object)) out.push([...at, k]);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (props[k] !== undefined) out.push(...requiredPaths(v, props[k]!, [...at, k]));
  }
  return out;
}
const without = (body: unknown, path: (string | number)[]): unknown => {
  const copy = structuredClone(body) as Record<string | number, unknown>;
  let at: Record<string | number, unknown> = copy;
  for (const seg of path.slice(0, -1)) at = at[seg] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (Array.isArray(at)) at.splice(Number(last), 1); else delete at[last];
  return copy;
};
const WRONG: Record<string, unknown> = { string: 12_345, number: 'not a number', integer: 'not a number', boolean: 'yes', array: 'not a list', object: 'not an object' };

/** `path` is the route as the table names it; `at` the address sent to, when the path has parameters. */
interface Sample { readonly api: string; readonly method: 'POST' | 'PUT'; readonly path: string; readonly at?: string; readonly body: Record<string, unknown> }
const SAMPLES: readonly Sample[] = [
  { api: 'API-01', method: 'POST', path: '/v1/access/delegations/effective-authority', body: { userId: 'u-meena', subjectType: 'refund' } },
  { api: 'API-01', method: 'POST', path: '/v1/identity/token-revocations', body: { userId: 'u-meena', reason: 'security' } },
  { api: 'API-02', method: 'POST', path: '/v1/catalogue/products/duplicates', body: { products: [{ productId: 'p-rice-1', name: 'Ponni rice 1 kg' }, { productId: 'p-rice-2', name: 'Ponni Rice 1kg' }] } },
  { api: 'API-02', method: 'POST', path: '/v1/catalogue/category-policy/resolve', body: { onDate: TODAY, history: [] } },
  { api: 'API-03', method: 'POST', path: '/v1/purchase/match-policy', body: { quantityToleranceBps: 200, priceToleranceBps: 100, immaterialMinor: 500 } },
  { api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId', at: '/v1/purchase/suppliers/sup-fu4', body: { name: 'Synthetic Traders' } },
  { api: 'API-04', method: 'POST', path: '/v1/inventory/receipt-policy', body: { excessToleranceBp: 100, shortageToleranceBp: 100, nearExpiryDays: 30 } },
  { api: 'API-04', method: 'POST', path: '/v1/inventory/stockout-impact', body: { products: [{ productId: 'p-oil', daysOutOfStock: 2, periodDays: 30, averageDailyUnits: 5, marginPerUnit: { minor: 1_200, currency: 'INR' } }] } },
  { api: 'API-05', method: 'POST', path: '/v1/pos/return-window', body: { returnWindowDays: 7 } },
  { api: 'API-05', method: 'POST', path: '/v1/pos/refund-threshold', body: { thresholdMinor: 50_000 } },
  { api: 'API-06', method: 'POST', path: '/v1/customers/child-data/check', body: { activity: 'marketing', ageYears: 30 } },
  { api: 'API-06', method: 'POST', path: '/v1/privacy/breach/assess', body: { breachId: 'br-fu4', discoveredAt: `${TODAY}T04:00:00.000Z`, affectedDataCategories: ['contact'], affectedPrincipalCount: 3 } },
  { api: 'API-07', method: 'POST', path: '/v1/orders/channel-reconcile', body: { channel: 'customer_app', channelOrders: [{ orderId: 'o-1', valueMinor: 45_000, state: 'delivered' }], ledgerOrders: [{ orderId: 'o-1', valueMinor: 45_000, state: 'delivered' }] } },
  { api: 'API-08', method: 'POST', path: '/v1/fulfilment/cod/reconcile', body: { expectations: [{ orderId: 'o-1', expectedMinor: 45_000 }], collections: [{ orderId: 'o-1', collectedMinor: 45_000, method: 'cash' }] } },
  { api: 'API-09', method: 'PUT', path: '/v1/finance/budgets/:period', at: '/v1/finance/budgets/2026-10', body: { lines: [{ account: 'shop_expenses', amountMinor: 1_000_000 }], reason: 'October budget (synthetic)' } },
  { api: 'API-09', method: 'PUT', path: '/v1/finance/posting-map', body: { rules: DEFAULT_RETAIL_POSTING_MAP.rules as unknown as Record<string, unknown>[] } },
  { api: 'API-10', method: 'POST', path: '/v1/platform/devices/evaluate', body: { policy: { currentVersion: '1.2.0', minimumSupportedVersion: '1.0.0' } } },
  { api: 'API-10', method: 'POST', path: '/v1/reporting/brief-schedule', body: { dueAt: [8, 30] } },
  { api: 'API-11', method: 'POST', path: '/v1/integration/secrets/usage-signals', body: { current: [{ identityId: 'svc-tally', api: 'API-09', calls: 40, errors: 0, onDate: TODAY }], baseline: [{ identityId: 'svc-tally', api: 'API-09', calls: 35, errors: 1, onDate: '2026-10-13' }] } },
  { api: 'API-11', method: 'PUT', path: '/v1/ai/kill-switch', body: { on: false } },
  { api: 'API-12', method: 'POST', path: '/v1/migration/discovery', body: { sources: [{ sourceId: 'src-erp', name: 'Old ERP database', kind: 'erp_database', volumeBasis: 'counted', extractable: true }] } },
  { api: 'API-13', method: 'POST', path: '/v1/ai/incidents', body: { summary: 'The assistant suggested a price change it may not make (synthetic).' } },
];

describe('the declared body schemas are what the routes accept and return — a sample in every domain (M32-FR-01 · D14-FR-06)', () => {
  let h: ApiHarness;
  let T: string;
  const send = async (s: Sample, body: unknown) => h.request({ method: s.method, path: s.at ?? s.path, userId: 'u-all', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
  beforeAll(async () => {
    h = apiHarness();
    T = randomUUID();
    for (const r of ROLE_CATALOGUE) if (STAFF.includes(r.id)) await h.provisionRole(T, 'u-all', r.id);
    for (const f of OPTIONAL_FEATURES) await h.enableFeature(T, f);
  });

  it('the sample covers every domain, and only routes whose bodies are derived from their handlers', () => {
    const tagOf = (s: Sample): string => String((opFor(s.method, s.path)['tags'] as string[])[0]).split(' ')[0]!;
    expect(new Set(SAMPLES.map(tagOf))).toEqual(new Set(['API-01', 'API-02', 'API-03', 'API-04', 'API-05', 'API-06', 'API-07', 'API-08', 'API-09', 'API-10', 'API-11', 'API-12', 'API-13']));
    for (const s of SAMPLES) expect(opFor(s.method, s.path)['x-body-schema'], `${s.method} ${s.path}`).toBe('derived');
  });

  for (const s of SAMPLES) {
    it(`${s.api} ${s.method} ${s.path}: accepts a valid body, refuses each required part left out or mistyped, as declared`, async () => {
      const request = requestSchemaOf(s.method, s.path);
      expect(schemaProblems(s.body, request, DOC), 'the valid body fits the declared request').toEqual([]);
      const ok = await send(s, s.body);
      expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
      const reply = replySchemaOf(s.method, s.path, ok.status);
      expect(reply, `a declared reply for ${ok.status}`).toBeDefined();
      expect(schemaProblems(ok.body, reply!, DOC), `the reply fits the declared reply: ${JSON.stringify(ok.body).slice(0, 400)}`).toEqual([]);

      const paths = requiredPaths(s.body, request);
      expect(paths.length, 'the schema declares something required').toBeGreaterThan(0);
      for (const p of paths) {
        const missing = without(s.body, p);
        expect(schemaProblems(missing, request, DOC).length, `the schema refuses a body without ${p.join('.')}`).toBeGreaterThan(0);
        const res = await send(s, missing);
        expect([400, 422], `the route refuses a body without ${p.join('.')}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`).toContain(res.status);
      }
      const top = (shapeFor(s.body, request)['required'] as string[] | undefined) ?? [];
      for (const k of top) {
        const t = deref(shapeFor(s.body[k], ((shapeFor(s.body, request)['properties'] ?? {}) as Record<string, Schema>)[k] ?? {}))['type'];
        if (typeof t !== 'string' || WRONG[t] === undefined) continue;
        const mistyped = { ...s.body, [k]: WRONG[t] };
        expect(schemaProblems(mistyped, request, DOC).length, `the schema refuses ${k} as a ${typeof WRONG[t]}`).toBeGreaterThan(0);
        const res = await send(s, mistyped);
        expect([400, 422], `the route refuses ${k} as a ${typeof WRONG[t]}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`).toContain(res.status);
      }
    }, 60_000);
  }

  it('no write route in the table accepts an empty body its declared schema refuses', async () => {
    const accepted: string[] = [];
    let checked = 0;
    for (const r of servedRoutes()) {
      if (r.method === 'GET' || DECLARED_BODIES[`${r.method} ${r.path}`] !== undefined) continue;
      const op = opFor(r.method, r.path);
      if (op['x-request-body'] === 'none') continue;
      const request = requestSchemaOf(r.method, r.path);
      if (schemaProblems({}, request, DOC).length === 0) continue;
      checked += 1;
      const res = await h.request({ method: r.method, path: r.path.replace(/:[A-Za-z0-9_]+/g, 'fu4-x'), userId: 'u-all', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: {} });
      if (res.status < 300) accepted.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(checked).toBeGreaterThan(600);
    expect(accepted, 'a route accepted a body its declared schema says is missing a required field').toEqual([]);
  }, 300_000);
});
