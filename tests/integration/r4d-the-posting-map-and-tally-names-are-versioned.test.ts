import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP, POSTING_KINDS_TO_MAP } from '../../packages/finance/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **Round 4d (M23-FR-01 · Screen D): the accounts set-up behind its page.** The accountant saves the posting map and the Tally
 * ledger names; every version stays on the record (who, when, why, which kinds or accounts changed); a save edited from an
 * older version than the one in force is refused by name — never a silent overwrite (hard rule 10); a person without
 * `finance.posting.configure` is refused; and the kinds no suggestion covers are listed with no account filled in.
 * In memory and, with DATABASE_URL, on real PostgreSQL.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const MGR = 'u-mgr';

describe.each(backings)('Round 4d — the posting map and the Tally names are versioned, append-only and conflict-safe — on $name', ({ harness }) => {
  const A = randomUUID();
  let h: ApiHarness;
  const send = (method: 'GET' | 'PUT' | 'POST', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: A, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const codeOf = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;

  beforeAll(async () => {
    h = harness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, ACCT, 'accountant');
    await h.provisionRole(A, MGR, 'store_manager');
  });

  it('nothing is defined yet: the suggestion and the kinds nobody suggests an account for are offered, no history', async () => {
    const r = await send('GET', '/v1/finance/posting-map', ACCT);
    expect(r.status).toBe(200);
    const b = r.body as { map: unknown; toMap: { kind: string; components: string[] }[]; history: unknown[] };
    expect(b.map).toBeNull();
    expect(b.toMap).toEqual(POSTING_KINDS_TO_MAP);
    expect(b.toMap.map((k) => k.kind)).toContain('promotion_funding');
    expect(b.history).toEqual([]);
  });

  it('two versions are saved; both stay on the record with what each changed and why', async () => {
    const v1 = await send('PUT', '/v1/finance/posting-map', ACCT, { rules: DEFAULT_RETAIL_POSTING_MAP.rules, basedOn: 0, note: 'start from the suggestion' });
    expect(v1.status).toBe(200);
    expect((v1.body as { version: number }).version).toBe(1);
    const rules = [...DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => r.kind !== 'tender:cash'), { kind: 'promotion_funding', legs: [{ account: 'bank_clearing', side: 'debit', component: 'amount' }, { account: 'offer_funding_income', side: 'credit', component: 'amount' }] }];
    const v2 = await send('PUT', '/v1/finance/posting-map', ACCT, { rules, basedOn: 1, note: 'offer funding mapped' });
    expect((v2.body as { version: number }).version).toBe(2);
    const read = (await send('GET', '/v1/finance/posting-map', MGR)).body as { map: { version: number; note: string; definedBy: string }; history: { version: number; added: string[]; dropped: string[]; note?: string; definedBy: string }[] };
    expect(read.map.version).toBe(2);
    expect(read.map.note).toBe('offer funding mapped');
    expect(read.history.map((x) => x.version)).toEqual([2, 1]);
    expect(read.history[0]).toMatchObject({ added: ['promotion_funding'], dropped: ['tender:cash'], note: 'offer funding mapped', definedBy: ACCT });
  });

  it('a save edited from an older version is refused by name, and the map in force is unchanged', async () => {
    const stale = await send('PUT', '/v1/finance/posting-map', ACCT, { rules: DEFAULT_RETAIL_POSTING_MAP.rules, basedOn: 1 });
    expect(stale.status).toBe(409);
    expect(codeOf(stale)).toBe('posting_map_changed_since');
    expect(((await send('GET', '/v1/finance/posting-map', ACCT)).body as { map: { version: number } }).map.version).toBe(2);
  });

  it('a store manager may read but not change it', async () => {
    const r = await send('PUT', '/v1/finance/posting-map', MGR, { rules: DEFAULT_RETAIL_POSTING_MAP.rules, basedOn: 2 });
    expect(r.status).toBe(403);
    const n = await send('POST', '/v1/finance/tally/ledger-names', MGR, { companyName: 'SRE', names: { a: 'A' }, basedOn: 0 });
    expect(n.status).toBe(403);
  });

  it('the Tally names: two versions, each listed with what it named and renamed; a stale save refused', async () => {
    const first = await send('POST', '/v1/finance/tally/ledger-names', ACCT, { companyName: 'SRE Hyper Market', names: { sales_revenue: 'Sales', cash_in_hand: 'Cash' }, basedOn: 0 });
    expect(first.status).toBe(201);
    const second = await send('POST', '/v1/finance/tally/ledger-names', ACCT, { companyName: 'SRE Hyper Market', names: { sales_revenue: 'Sales Accounts', bank_clearing: 'Bank' }, voucherTypes: { sales: 'Sales' }, basedOn: 1, note: 'CA renamed sales' });
    expect(second.status).toBe(201);
    const stale = await send('POST', '/v1/finance/tally/ledger-names', ACCT, { companyName: 'SRE', names: { a: 'A' }, basedOn: 1 });
    expect(stale.status).toBe(409);
    expect(codeOf(stale)).toBe('tally_names_changed_since');
    const read = (await send('GET', '/v1/finance/tally/ledger-names', ACCT)).body as { ledgerNames: { version: number; note: string; voucherTypes: Record<string, string> }; families: { family: string }[]; history: { version: number; added: string[]; renamed: string[]; dropped: string[] }[] };
    expect(read.ledgerNames).toMatchObject({ version: 2, note: 'CA renamed sales', voucherTypes: { sales: 'Sales' } });
    expect(read.families.map((f) => f.family)).toContain('supplier_income');
    expect(read.history.map((x) => [x.version, x.added, x.renamed, x.dropped])).toEqual([[2, ['bank_clearing'], ['sales_revenue'], ['cash_in_hand']], [1, ['cash_in_hand', 'sales_revenue'], [], []]]);
  });
});
