import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **PF-13 (audit, HIGH · M27-FR-01, M27-FR-04): a concession decision blocks a counter BEFORE money — with the cable out
 * too — and a line that happened anyway is kept and raised, never dropped.**
 *
 * Head office publishes every partner agreement's TERMS (dates, a second person's approval, active); the real store
 * computer pulls them, keeps them on its disk, and decides each new partner-counter sale line by its own calendar:
 * a counter whose agreement has ended, whose insurance has lapsed, or that has no agreement here is refused before the
 * disk, in the cashier's words; an approved, in-date counter trades; a return is always kept. A line taken on a day the
 * counter could not trade (on a box that had not yet pulled the terms) is recorded at head office AND kept as a breach.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0f13';
const KEY = ['pf13', 'counter', 'blocked', 'signing', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const today = new Date().toISOString().slice(0, 10);
const year = Number(today.slice(0, 4));
const BASE = { branchId: 'br-1', basis: 'revenue_share', revenueShareBps: 1_500, depositMinor: 100_000, startsOn: `${year - 1}-01-01` };
const CONTRACTS = {
  'ct-gold': { ...BASE, concessionaireId: 'jeweller-1', name: 'Gold counter', endsOn: `${year + 1}-12-31`, insuranceUntil: `${year + 1}-06-30` },
  'ct-silver': { ...BASE, concessionaireId: 'silver-1', name: 'Silver counter', endsOn: `${year + 1}-12-31`, insuranceUntil: `${year - 1}-12-31` },
  'ct-saree': { ...BASE, concessionaireId: 'saree-1', name: 'Saree counter', endsOn: `${year - 1}-12-31`, insuranceUntil: `${year + 1}-06-30` },
};

const line = (concessionaireId: string, saleId: string, kind = 'sale') => ({
  tagId: `till-1:${saleId}:line-1`, kind, saleId, lineId: 'line-1', productId: 'item-1', concessionaireId, counterId: `counter-${concessionaireId}`,
  tillId: 'till-1', shiftId: `shift-${today}`, qty: 1, grossMinor: 50_000, discountMinor: 0, taxMinor: 1_500,
  capturedBy: 'cashier-anita', byRole: 'cashier', source: 'docket-1', at: new Date().toISOString(),
});

describe('PF-13: a lapsed partner counter is stopped before money, offline too; a line that happened anyway is kept and raised', () => {
  let h: ApiHarness;
  let dir: string;
  let online = true;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, 'u-sync', 'cashier');
    await h.provisionRole(A, 'u-acct', 'accountant');
    await h.enableFeature(A, 'dept.concession');
    for (const [id, c] of Object.entries(CONTRACTS)) {
      const body = await approvedBody(h, A, OWNER, 'u-acct', 'concession_contract', id, c, { contractId: id });
      expect((await h.request({ method: 'POST', path: `/v1/concession/contracts/${id}`, userId: OWNER, tenantId: A, idempotencyKey: id, body })).status).toBeLessThan(300);
    }
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-pf13-'));
  });
  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const start = async (): Promise<EdgeProcess> => (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
    CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-sync', tenantId: A }),
  }, () => {}))!;
  const post = async (edge: EdgeProcess, body: unknown): Promise<{ committed: boolean; refusedBecause?: string; blockedBy?: string[]; laneMessage?: string }> =>
    (await savedFetch(`http://127.0.0.1:${edge.lane!.port}/lane/concession-tags`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as never;
  const breaches = async () => (await h.request({ method: 'GET', path: '/v1/concession/trading-breaches', userId: OWNER, tenantId: A })).body as { count: number; breaches: { tagId: string; contractId: string; blockedBy: string[] }[] };

  it('a box that has not received the terms keeps the line; head office records it and raises the breach', async () => {
    const edge = await start();
    // The silver counter's insurance has lapsed; this box has never pulled the terms, so it cannot know.
    expect(await post(edge, line('silver-1', 'S-early'))).toMatchObject({ committed: true });
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0 });
    const b = await breaches();
    expect(b.breaches).toEqual([expect.objectContaining({ tagId: 'till-1:S-early:line-1', contractId: 'ct-silver', blockedBy: ['insurance_lapsed'] })]);
    await edge.stop();
  });

  it('once the box holds the terms: lapsed, expired and unknown counters are refused before the disk — offline and across a restart; an in-date counter trades; a return is kept', async () => {
    let edge = await start();
    expect(await edge.refreshConcessionTrading!()).toMatchObject({ status: 'updated' });
    const before = (await readLog(edge.concessionTagsLog.path)).length;

    online = false; // the cable is cut — the box decides from what it holds
    await edge.stop();
    edge = await start(); // and across a restart

    const silver = await post(edge, line('silver-1', 'S-2'));
    expect(silver).toMatchObject({ committed: false, refusedBecause: 'counter_may_not_trade', blockedBy: ['insurance_lapsed'] });
    expect(silver.laneMessage).toMatch(/insurance is not in date.*Do not take money/);
    expect(await post(edge, line('saree-1', 'S-3'))).toMatchObject({ committed: false, blockedBy: ['contract_expired'] });
    expect(await post(edge, line('nobody-9', 'S-4'))).toMatchObject({ committed: false, blockedBy: ['no_agreement'] });
    expect((await readLog(edge.concessionTagsLog.path)).length).toBe(before); // nothing refused reached the disk

    expect(await post(edge, line('jeweller-1', 'S-5'))).toMatchObject({ committed: true });
    // A return already happened, and is always kept.
    expect(await post(edge, { ...line('silver-1', 'S-early', 'return'), tagId: 'till-1:S-early:return-1', lineId: 'return-1' })).toMatchObject({ committed: true });
    expect((await readLog(edge.concessionTagsLog.path)).length).toBe(before + 2);

    online = true;
    const pass = await edge.syncOnce!();
    expect(pass.dead, JSON.stringify(edge.concessionTagsOutbox.deadLetters())).toBe(0);
    expect((await breaches()).count).toBe(1); // the in-date sale raised none
    await edge.stop();
  });
});
