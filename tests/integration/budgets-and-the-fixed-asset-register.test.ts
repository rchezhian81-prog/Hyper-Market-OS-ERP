import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-57 "A" (owner, 11 Oct 2026) · D10-FR-05 "budgets, fixed-asset integration and period close" — monthly budgets by
 * account (versioned, never edited) with actual-vs-budget read from the books; a fixed-asset register (add, transfer
 * between stores, dispose) with straight-line depreciation posted monthly through the accountant's posting map, once per
 * asset per month.**
 *
 * On the real head-office API (in memory and, with DATABASE_URL, on real PostgreSQL): a freezer (₹1,200 over 12 months)
 * and a billing PC (₹500, ₹20 salvage, 36 months) go into service in July at store-1. July's run posts both acquisitions
 * and July's depreciation; a re-run posts nothing. The freezer moves to store-2 in August — August's depreciation names
 * store-2. The PC is sold in September for ₹450: September's run takes it off the books with its two months of
 * depreciation and a ₹23.34 loss, and depreciates nothing for it in September. September's budget is set twice (two
 * versions, both kept); actual-vs-budget reads the books. A map with no fixed-asset rules lists the run's journals as
 * unmapped and posts none; only finance writes.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Line { accountCode: string; debitMinor: number; creditMinor: number }
interface FaJournal { entryId: string; period: string; lines: Line[]; fixedAsset: { assetId: string; kind: string; month?: string; storeId: string; amountMinor: number } }

async function shop(harness: () => ApiHarness) {
  const h = harness();
  const t = randomUUID();
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-acct', 'accountant');
  await h.provisionRole(t, 'u-mgr', 'store_manager');
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  // Round 18 (verifier r17 C-2 c): an asset is only ever at a store head office knows.
  await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
  for (const s of ['store-1', 'store-2']) await ok(call('POST', `/v1/org/nodes/${s}`, 'u-owner', { kind: 'branch', name: s, parentId: 'C1', companyId: 'C1' }), `${s} in the org tree`);
  return { h, t, call, ok };
}

const FREEZER = { name: 'Chest freezer 500L', category: 'freezer', storeId: 'store-1', costMinor: 120_000, salvageMinor: 0, usefulLifeMonths: 12, inServiceDate: '2026-07-15' };
const PC = { name: 'Billing PC lane 1', category: 'billing_pc', storeId: 'store-1', costMinor: 50_000, salvageMinor: 2_000, usefulLifeMonths: 36, inServiceDate: '2026-07-01' };

describe.each(backings)('OB-57 — budgets and the fixed-asset register — on $name', ({ harness }) => {
  it('adds, transfers and disposes assets; depreciation posts once per asset per month; the register reads the books', async () => {
    const { h, t, call, ok } = await shop(harness);
    await ok(call('PUT', '/v1/finance/posting-map', 'u-owner', DEFAULT_RETAIL_POSTING_MAP), 'map');
    // Only finance writes the register; a bad asset is refused.
    expect((await call('POST', '/v1/finance/fixed-assets/FRZ-1', 'u-mgr', FREEZER)).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/finance/fixed-assets/FRZ-1', 'u-acct', { ...FREEZER, salvageMinor: 200_000 }))).toBe('not_readable_as_a_fixed_asset');
    expect((await ok(call('POST', '/v1/finance/fixed-assets/FRZ-1', 'u-acct', FREEZER), 'freezer')).status).toBe(201);
    await ok(call('POST', '/v1/finance/fixed-assets/PC-1', 'u-acct', PC), 'pc');
    // The same asset again is the same entry; other figures under the same id are refused (a register is never edited).
    expect((await call('POST', '/v1/finance/fixed-assets/FRZ-1', 'u-acct', FREEZER)).body).toMatchObject({ alreadyAdded: true });
    expect(codeOf(await call('POST', '/v1/finance/fixed-assets/FRZ-1', 'u-acct', { ...FREEZER, costMinor: 1 }))).toBe('asset_exists');

    // ── July: both acquisitions and July's depreciation; a re-run posts nothing.
    const july = (await ok(call('POST', '/v1/finance/fixed-assets/depreciation/2026-07', 'u-acct', {}), 'july')).body as { posted: FaJournal[]; exceptions: unknown[] };
    expect(july.exceptions).toEqual([]);
    expect(july.posted.map((j) => [j.entryId, j.period, j.fixedAsset.amountMinor, j.fixedAsset.storeId])).toEqual([
      ['fa-acq:FRZ-1', '2026-07', 120_000, 'store-1'], ['fa-dep:FRZ-1:2026-07', '2026-07', 10_000, 'store-1'],
      ['fa-acq:PC-1', '2026-07', 50_000, 'store-1'], ['fa-dep:PC-1:2026-07', '2026-07', 1_333, 'store-1'],
    ]);
    expect(july.posted[1]!.lines).toEqual([{ accountCode: 'depreciation_expense', debitMinor: 10_000, creditMinor: 0 }, { accountCode: 'accumulated_depreciation', debitMinor: 0, creditMinor: 10_000 }]);
    expect(((await ok(call('POST', '/v1/finance/fixed-assets/depreciation/2026-07', 'u-acct', {}), 'july again')).body as { posted: unknown[] }).posted).toEqual([]);

    // ── The freezer moves to store-2 on 10 August: August's depreciation names store-2.
    expect(codeOf(await call('POST', '/v1/finance/fixed-assets/FRZ-1/transfer', 'u-acct', { toStoreId: 'store-1', on: '2026-08-10', reason: 'x' }))).toBe('already_there');
    await ok(call('POST', '/v1/finance/fixed-assets/FRZ-1/transfer', 'u-acct', { toStoreId: 'store-2', on: '2026-08-10', reason: 'second freezer bay at store-2' }), 'transfer');
    const aug = (await ok(call('POST', '/v1/finance/fixed-assets/depreciation/2026-08', 'u-acct', {}), 'aug')).body as { posted: FaJournal[] };
    expect(aug.posted.map((j) => [j.entryId, j.fixedAsset.storeId, j.fixedAsset.amountMinor])).toEqual([['fa-dep:FRZ-1:2026-08', 'store-2', 10_000], ['fa-dep:PC-1:2026-08', 'store-1', 1_333]]);

    // ── The PC is sold on 5 September for ₹450: no September depreciation for it; off the books with a ₹23.34 loss.
    expect(codeOf(await call('POST', '/v1/finance/fixed-assets/PC-1/dispose', 'u-acct', { on: '2026-08-20', proceedsMinor: 45_000, reason: 'sold' }))).toBe('depreciation_already_posted');
    await ok(call('POST', '/v1/finance/fixed-assets/PC-1/dispose', 'u-acct', { on: '2026-09-05', proceedsMinor: 45_000, reason: 'sold to staff' }), 'dispose');
    expect((await call('POST', '/v1/finance/fixed-assets/PC-1/dispose', 'u-acct', { on: '2026-09-05', proceedsMinor: 45_000, reason: 'sold to staff' })).body).toMatchObject({ alreadyDisposed: true });
    expect(codeOf(await call('POST', '/v1/finance/fixed-assets/PC-1/dispose', 'u-acct', { on: '2026-09-06', proceedsMinor: 1, reason: 'x' }))).toBe('already_disposed');
    expect(codeOf(await call('POST', '/v1/finance/fixed-assets/PC-1/transfer', 'u-acct', { toStoreId: 'store-2', on: '2026-09-10', reason: 'x' }))).toBe('asset_disposed');
    const sep = (await ok(call('POST', '/v1/finance/fixed-assets/depreciation/2026-09', 'u-acct', {}), 'sep')).body as { posted: FaJournal[] };
    expect(sep.posted.map((j) => j.entryId)).toEqual(['fa-dep:FRZ-1:2026-09', 'fa-disp:PC-1']);
    expect(sep.posted[1]!.lines).toEqual([
      { accountCode: 'accumulated_depreciation', debitMinor: 2_666, creditMinor: 0 },
      { accountCode: 'fixed_asset_disposal_proceeds', debitMinor: 45_000, creditMinor: 0 },
      { accountCode: 'loss_on_asset_disposal', debitMinor: 2_334, creditMinor: 0 },
      { accountCode: 'fixed_assets', debitMinor: 0, creditMinor: 50_000 },
    ]);
    expect(((await ok(call('POST', '/v1/finance/fixed-assets/depreciation/2026-09', 'u-acct', {}), 'sep again')).body as { posted: unknown[] }).posted).toEqual([]);
    // Exactly one depreciation journal per asset per month in the ledger.
    const ids = (await h.store.readStream(t, 'finance', { type: 'JournalPosted' })).map((e) => (e.event.payload as { entryId: string }).entryId).filter((x) => x.startsWith('fa-'));
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids).toHaveLength(8); // 2 acquisitions, freezer Jul–Sep, PC Jul–Aug, 1 disposal

    // ── The register.
    // A store manager reads the register (finance.period.read); only finance writes it.
    const regBody = (await call('GET', '/v1/finance/fixed-assets', 'u-mgr')).body as { assets: { assetId: string; state: string; storeId: string; depreciationPostedMinor: number; bookValueMinor: number; transfers: unknown[] }[] };
    expect(regBody.assets.map((a) => [a.assetId, a.state, a.storeId, a.depreciationPostedMinor, a.bookValueMinor, a.transfers.length])).toEqual([
      ['FRZ-1', 'in_use', 'store-2', 30_000, 90_000, 1], ['PC-1', 'disposed', 'store-1', 2_666, 0, 0],
    ]);

    // ── September's budget, set twice — two versions kept; actual-vs-budget read from the books.
    const suggested = ((await call('GET', '/v1/finance/account-classes', 'u-acct')).body as { suggested: Record<string, string> }).suggested;
    await ok(call('PUT', '/v1/finance/account-classes', 'u-owner', { classes: suggested }), 'classes');
    expect((await call('PUT', '/v1/finance/budgets/2026-09', 'u-mgr', { lines: [{ account: 'depreciation_expense', amountMinor: 1 }] })).status).toBe(403);
    expect(codeOf(await call('PUT', '/v1/finance/budgets/2026-09', 'u-owner', { lines: [{ account: 'x', amountMinor: -1 }] }))).toBe('not_readable_as_a_budget');
    expect(codeOf(await call('PUT', '/v1/finance/budgets/2026-09', 'u-owner', { lines: [{ account: 'x', amountMinor: 1 }, { account: 'x', amountMinor: 2 }] }))).toBe('not_readable_as_a_budget');
    expect((await call('PUT', '/v1/finance/budgets/2026-09', 'u-owner', { lines: [{ account: 'depreciation_expense', amountMinor: 9_000 }, { account: 'sales_revenue', amountMinor: 5_000_000 }], reason: 'first cut' })).status).toBe(201);
    expect((await call('PUT', '/v1/finance/budgets/2026-09', 'u-acct', { lines: [{ account: 'depreciation_expense', amountMinor: 12_000 }], reason: 'freezer only from September' })).status).toBe(201);
    const b = (await call('GET', '/v1/finance/budgets/2026-09', 'u-mgr')).body as {
      budget: { version: number; setBy: string }; versions: { version: number; setBy: string; totalMinor: number }[];
      rows: { account: string; budgetMinor: number; actualMinor: number; varianceMinor: number }[]; unbudgeted: { account: string; actualMinor: number }[];
    };
    expect(b.budget).toMatchObject({ version: 2, setBy: 'u-acct' });
    expect(b.versions.map((v) => [v.version, v.setBy, v.totalMinor])).toEqual([[1, 'u-owner', 5_009_000], [2, 'u-acct', 12_000]]);
    expect(b.rows).toEqual([{ account: 'depreciation_expense', accountClass: 'expense', budgetMinor: 12_000, actualMinor: 10_000, varianceMinor: -2_000 }]);
    expect(b.unbudgeted).toEqual(expect.arrayContaining([{ account: 'loss_on_asset_disposal', accountClass: 'expense', actualMinor: 2_334 }, { account: 'fixed_asset_disposal_proceeds', accountClass: 'asset', actualMinor: 45_000 }]));
    // The month's P&L carries the depreciation and the loss, from the same journals.
    const pl = (await call('GET', '/v1/finance/periods/2026-09/profit-and-loss', 'u-acct')).body as { expenses: { account: string; amountMinor: number }[] };
    expect(pl.expenses).toEqual(expect.arrayContaining([{ account: 'depreciation_expense', amountMinor: 10_000 }, { account: 'loss_on_asset_disposal', amountMinor: 2_334 }]));
  }, 90_000);

  it('a map with no fixed-asset rules lists the run\'s journals as unmapped and posts none', async () => {
    const { call, ok } = await shop(harness);
    await ok(call('PUT', '/v1/finance/posting-map', 'u-owner', { rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => !r.kind.startsWith('fixed_asset:')) }), 'map');
    await ok(call('POST', '/v1/finance/fixed-assets/FRZ-1', 'u-acct', FREEZER), 'freezer');
    const run = (await ok(call('POST', '/v1/finance/fixed-assets/depreciation/2026-07', 'u-acct', {}), 'run')).body as { posted: unknown[]; exceptions: { entryId: string; reason: string }[] };
    expect(run.posted).toEqual([]);
    expect(run.exceptions).toEqual([expect.objectContaining({ entryId: 'fa-acq:FRZ-1', reason: 'unmapped_kind' })]);
    const reg = (await call('GET', '/v1/finance/fixed-assets', 'u-acct')).body as { assets: { acquisitionPosted: boolean; depreciationPostedMinor: number }[] };
    expect(reg.assets[0]).toMatchObject({ acquisitionPosted: false, depreciationPostedMinor: 0 });
  }, 60_000);
});
