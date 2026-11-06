import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error — a plain .mjs build script, no type declarations
import { developerDocs, OPENAPI_FILE } from '../../scripts/developer-docs.mjs';

/**
 * **W3 · M36-FR-04 "documentation" (P-06): the office Developer guide is GENERATED from the published contract
 * `docs/api/openapi.json` — every operation in it, each with the permission it needs, whether it takes an Idempotency-Key,
 * and its request and reply fields — never written by hand.** `scripts/build-app.mjs web-erp` writes it on every build.
 */

type Op = { method: string; path: string; group: string; permission: string | null; idempotent: boolean; request?: { name: string; required: boolean }[]; reply?: { name: string }[]; shownOnce?: string[] };
const openapi = JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as { paths: Record<string, Record<string, Record<string, unknown>>> };
const docs = developerDocs(openapi) as { operations: Op[]; groups: { name: string }[]; source: string };

describe('the Developer guide is the published contract', () => {
  it('lists every operation in docs/api/openapi.json, once, sorted', () => {
    const inContract = Object.entries(openapi.paths).flatMap(([path, ops]) => Object.keys(ops).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map((m) => `${m.toUpperCase()} ${path}`)).sort();
    expect(docs.operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual(inContract);
    expect(new Set(docs.operations.map((o) => `${o.method} ${o.path}`)).size).toBe(docs.operations.length);
    expect(docs.source).toBe('docs/api/openapi.json');
    expect(docs.groups.length).toBeGreaterThan(5);
  });

  it('carries each call\'s permission, idempotency and fields exactly as the contract says', () => {
    const sandbox = docs.operations.find((o) => o.method === 'POST' && o.path === '/v1/platform/partners/sandboxes/{sandboxId}')!;
    expect(sandbox).toMatchObject({ group: 'API-11 Platform', permission: 'platform.partner.manage', idempotent: true });
    expect(sandbox.request?.filter((f) => f.required).map((f) => f.name).sort()).toEqual(['createdOn', 'expiresOn', 'partnerId']);
    expect(sandbox.reply?.map((f) => f.name)).toContain('syntheticDataOnly');
    // W3: the two new list reads are in the guide too.
    expect(docs.operations.some((o) => o.method === 'GET' && o.path === '/v1/platform/partners')).toBe(true);
    expect(docs.operations.some((o) => o.method === 'GET' && o.path === '/v1/integration/outbound-webhooks')).toBe(true);
    // A reply field shown only once is marked so.
    expect(docs.operations.filter((o) => o.shownOnce !== undefined).length).toBeGreaterThan(0);
    for (const o of docs.operations) if (o.method === 'GET') expect(o.idempotent, `${o.path}`).toBe(false);
  });
});
