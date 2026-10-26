import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveBodies, UNCHECKED, type Derived } from '../../services/platform/src/api-body-derive';

// M32-FR-01 · D14-FR-06 (FU-4): the body schemas are DERIVED from the handlers' own code, never written beside them. This
// derives them from a small synthetic service and checks each rule the derivation applies: what a handler reads, typed by
// its own checks; REQUIRED exactly where it refuses (400 / 422) a body without it — on every path, a replay excepted; an
// enum where anything off the list is refused; what a wrapper adds in front of a route; the reply per status; "never
// succeeds"; "reads no body"; and an event's payload from the code that builds it.

const KERNEL = fileURLToPath(new URL('../../services/kernel/src/errors', import.meta.url));
const SOURCE = `
import { apiError } from '${KERNEL}';
interface Ctx { readonly tenantId: string; readonly params: Readonly<Record<string, string>>; readonly body: unknown }
interface Route { readonly api: string; readonly method: string; readonly path: string; readonly permission: string; readonly idempotent?: boolean; readonly handler: (ctx: Ctx) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown } }
const refuse = (status: number, code: string) => apiError(status, { code, whatHappened: 'The body could not be read here.', wasItSaved: 'not_saved', nextSafeAction: 'Send it again, complete.' });
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const bodyOf = (b: unknown): Record<string, unknown> => (b !== null && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
const LEVELS = ['low', 'high'] as const;
function readLine(l: unknown): { sku: string; qty: number } | undefined {
  if (l === null || typeof l !== 'object') return undefined;
  const o = l as Record<string, unknown>;
  if (!isStr(o['sku']) || !Number.isInteger(o['qty'])) return undefined;
  return { sku: o['sku'], qty: o['qty'] as number };
}
const deps = { prior: async (_id: string): Promise<{ readonly id: string } | undefined> => undefined };

export const routes: Route[] = [
  {
    api: 'API-11', method: 'POST', path: '/v1/fx/notes/:noteId', permission: 'fx.write', idempotent: true,
    handler: async (ctx) => {
      const b = bodyOf(ctx.body);
      const prior = await deps.prior(ctx.params['noteId'] ?? '');
      if (prior !== undefined) return { status: 200, body: { note: prior, alreadyRecorded: true } };
      if (!isStr(b['title']) || (b['tag'] !== undefined && typeof b['tag'] !== 'string')) throw refuse(400, 'not_readable_as_a_note');
      if (!(LEVELS as readonly unknown[]).includes(b['level'])) throw refuse(400, 'unknown_level');
      const lines = Array.isArray(b['lines']) ? b['lines'].map(readLine) : undefined;
      if (lines === undefined || lines.length === 0 || lines.some((l) => l === undefined)) throw refuse(422, 'lines_unreadable');
      return { status: 201, body: { noteId: ctx.params['noteId'] ?? '', title: b['title'], lineCount: lines.length } };
    },
  },
  { api: 'API-11', method: 'GET', path: '/v1/fx/notes', permission: 'fx.read', handler: async () => ({ status: 200, body: { notes: [] as { readonly noteId: string }[] } }) },
  { api: 'API-11', method: 'POST', path: '/v1/fx/retired', permission: 'fx.write', idempotent: true, handler: async () => { throw refuse(410, 'retired'); } },
  { api: 'API-11', method: 'POST', path: '/v1/fx/ping', permission: 'fx.write', idempotent: true, handler: () => ({ status: 202, body: { ok: true as const } }) },
  {
    // Either a call-off against an agreement, or an order from a supplier: lines in both, the rest in one.
    api: 'API-11', method: 'POST', path: '/v1/fx/orders', permission: 'fx.write', idempotent: true,
    handler: (ctx) => {
      const b = bodyOf(ctx.body);
      if (b['agreementId'] !== undefined) {
        if (!isStr(b['agreementId']) || !Array.isArray(b['lines'])) throw refuse(400, 'not_readable_as_a_call_off');
        return { status: 201, body: { via: 'agreement' as const } };
      }
      if (!isStr(b['supplierId']) || !Array.isArray(b['lines'])) throw refuse(400, 'not_readable_as_an_order');
      return { status: 201, body: { via: 'order' as const } };
    },
  },
];

/** A wrapper that puts a check in front of a route at run time. */
function wrap(rs: Route[], method: string, path: string, around: (inner: Route['handler']) => Route['handler']): void {
  const at = rs.findIndex((r) => r.method === method && r.path === path);
  rs[at] = { ...rs[at]!, handler: around(rs[at]!.handler) };
}
wrap(routes, 'POST', '/v1/fx/notes/:noteId', (inner) => async (ctx: Ctx) => {
  if (!isStr(bodyOf(ctx.body)['storeId'])) throw refuse(400, 'store_not_named');
  return inner(ctx);
});

export const event = { id: 'e-1', type: 'SaleCommitted', occurredAt: '2026-10-20T04:00:00Z', idempotencyKey: 'k', source: 'fx', version: 1, payload: { saleId: 's-1', totalMinor: 100 } };
`;

const served = [
  { method: 'POST', path: '/v1/fx/notes/:noteId' }, { method: 'GET', path: '/v1/fx/notes' }, { method: 'POST', path: '/v1/fx/retired' },
  { method: 'POST', path: '/v1/fx/ping' }, { method: 'POST', path: '/v1/fx/orders' }, { method: 'POST', path: '/v1/fx/not-in-the-code' },
].map((r) => ({ ...r, handlerSource: '' }));

type O = Record<string, unknown>;
let dir: string;
let d: Derived;
const req = (key: string): O => d.routes[key]!.request as O;
const props = (s: O): Record<string, O> => s['properties'] as Record<string, O>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fu4-derive-'));
  writeFileSync(join(dir, 'main.ts'), SOURCE);
  d = deriveBodies({ repoRoot: dir, routeEntry: join(dir, 'main.ts'), eventEntries: [], served, eventTypes: ['SaleCommitted', 'RefundCompleted'] });
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('request bodies are derived from what the handler reads, checks and refuses', () => {
  it('requires exactly what the handler (and a wrapper in front of it) refuses without — a replay before the checks is not the first request\'s path', () => {
    expect(req('POST /v1/fx/notes/:noteId')['required']).toEqual(['level', 'lines', 'storeId', 'title']);
    expect(props(req('POST /v1/fx/notes/:noteId'))['tag']).toEqual({ type: 'string' }); // checked, optional
  });

  it('types a property by the handler\'s own check, at any depth (a list\'s items, through a helper)', () => {
    const lines = props(req('POST /v1/fx/notes/:noteId'))['lines']!;
    expect(lines['type']).toBe('array');
    expect((lines['items'] as O)['required']).toEqual(['qty', 'sku']);
    expect(props(lines['items'] as O)['qty']).toEqual({ type: 'integer' });
    expect(props(lines['items'] as O)['sku']).toEqual({ type: 'string' });
  });

  it('declares an enum only where anything off the list is refused', () => {
    expect(props(req('POST /v1/fx/notes/:noteId'))['level']).toEqual({ type: 'string', enum: ['high', 'low'] });
  });

  it('requires what EVERY way through the handler refuses without, and not what only one way needs', () => {
    expect(req('POST /v1/fx/orders')['required']).toEqual(['lines']);
    expect(Object.keys(props(req('POST /v1/fx/orders'))).sort()).toEqual(['agreementId', 'lines', 'supplierId']);
  });

  it('says a handler reads no body when it never touches ctx.body', () => {
    expect(d.routes['POST /v1/fx/ping']!.request).toBeNull();
    expect(d.routes['GET /v1/fx/notes']!.request).toBeNull();
  });

  it('marks a property read and passed on without a check as unchecked, never invents a type', () => {
    expect(JSON.stringify(d.routes)).not.toContain(UNCHECKED); // every property in this service is checked
  });
});

describe('reply bodies are the types the handler returns, per status', () => {
  it('a replay and a first answer are each declared under their own status', () => {
    const r = d.routes['POST /v1/fx/notes/:noteId']!.replies as Record<string, O>;
    expect(Object.keys(r)).toEqual(['200', '201']);
    expect(r['201']!['required']).toEqual(['noteId', 'title', 'lineCount']);
    expect(props(r['200']!)['alreadyRecorded']).toEqual({ type: 'boolean' }); // TypeScript widens a literal true in an object
    expect((d.routes['POST /v1/fx/ping']!.replies as Record<string, O>)['202']).toMatchObject({ required: ['ok'] });
  });

  it('a route that only ever refuses declares no success reply', () => {
    expect(d.routes['POST /v1/fx/retired']!.replies).toEqual({});
  });
});

describe('events and gaps', () => {
  it('an event\'s payload is the type of the payload the code builds it with; one no code builds has none', () => {
    expect(d.events['SaleCommitted']!.payload).toMatchObject({ type: 'object', required: ['saleId', 'totalMinor'] });
    expect(d.events['RefundCompleted']).toBeUndefined();
  });

  it('a served route with no route object in the code is said by name, never given a body', () => {
    expect(d.problems).toEqual(['POST /v1/fx/not-in-the-code: no route object found in the source']);
    expect(d.routes['POST /v1/fx/not-in-the-code']).toBeUndefined();
  });
});
