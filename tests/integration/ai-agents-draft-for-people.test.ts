import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **The agents draft for people and commit nothing (OB-288 lane 4 · P1 · A01/A02/A03/A05 · AI-NFR-04/11 · OB-296/314).**
 *
 * Through the real API — in memory and on real PostgreSQL, with a cold restart:
 *   • A02 drafts a FORECAST stock-out (the D-1 engine over the shop's own sales) and a QUOTATION comparison (the tested
 *     like-for-like engine over the quotes on record) — for a buyer, with no quantity invented, each with a confidence band;
 *   • A03 drafts a predicted stock-out where another store has stock to spare (a transfer), and OVERSTOCK past the 91-day
 *     ageing line — for a manager; a product that has not sold is not judged;
 *   • A01's ACTION LIST names what needs a person today — drafts waiting by agent, an assistant stopped by a switch;
 *   • A05 answers a service agent's ORDER and POLICY questions from the records, cited, and ESCALATES what the records
 *     cannot answer; free-text questions are refused (OB-296);
 *   • the customer-facing suggestions (AI-NFR-11 · OB-314) carry "Suggested by AI" in English and Tamil on every one, and
 *     use what the customer bought ONLY after they opt in on the consent ledger — opting out stops it at once;
 *   • the people without the authority are refused (403).
 */

const OWNER = 'u-owner'; const OWNER2 = 'u-owner-2'; const MGR = 'u-mgr'; const CASH = 'u-cash'; const CUST = 'u-cust';

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

type Make = (store?: EventStore) => ApiHarness;
const backings: { name: string; make: Make }[] = [{ name: 'the in-memory event store', make: (store) => apiHarness(store === undefined ? {} : { store }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', make: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

interface Draft { proposalId: string; agent: string; summary: string; wouldRequire: string; evidence: { source: string; summary: string }[]; confidence: { band: string; basis: string; uncertainty: string }; committed: boolean }
const code = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('the agents draft for people and commit nothing — on $name', ({ make }) => {
  it('A02 forecast and quotes, A03 predictions, A01 action list, A05 answers, the customer\'s AI notice and opt-in — and a cold restart', async () => {
    let h = make();
    const T = randomUUID();
    const today = shopDateIn(new Date().toISOString());
    const dayAgo = (n: number): string => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    await h.seedOwner(T, OWNER);
    await h.provisionOwner(T, OWNER2);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASH, 'cashier');
    await h.provisionRole(T, CUST, 'customer');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });

    for (const [id, body] of [
      ['C1', { kind: 'company', name: 'SRE Retail' }],
      ['S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }],
      ['S2', { kind: 'branch', name: 'Store 2', parentId: 'C1', companyId: 'C1' }],
    ] as const) expect((await req('POST', `/v1/org/nodes/${id}`, OWNER, body, `org-${id}`)).status).toBe(201);
    const receive = async (p: string, loc: string, q: number) =>
      expect((await req('POST', '/v1/inventory/movements', OWNER, { movementId: `rx-${p}-${loc}`, productId: p, locationId: loc, kind: 'received', quantityMinor: q, uom: 'ea', occurredAt: new Date(Date.now() - 7_200_000).toISOString(), enteredBy: OWNER, unitCostMinor: 1_000 }, `rx-${p}-${loc}`)).status).toBe(202);
    const sell = async (saleId: string, day: string, loc: string, p: string, q: number) =>
      expect((await req('POST', '/v1/sales', CASH, {
        saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: loc, cashierId: CASH, tradingDay: day, committedAt: new Date(Date.now() - 60_000).toISOString(),
        totalMinor: q * 2_000, currency: 'INR', packVersion: 1, lines: [{ productId: p, quantityMinor: q, uom: 'ea', unitPriceMinor: 2_000, lineTotalMinor: q * 2_000 }], tenders: [{ kind: 'cash', amountMinor: q * 2_000 }],
      }, saleId)).status).toBe(202);
    // OIL: 150 in at S1, 10 a day sold for 14 days → 10 left and about 2.5 a day forecast — it runs out within the week.
    // Store 2 holds 200 and sells none → room to spare. DAL: 1,000 in at S1, 1 a day → ~3,900 days of cover = overstock.
    // SUGAR: 50 at S2, never sold → not judged (it may simply be new).
    await receive('OIL', 'S1', 150); await receive('OIL', 'S2', 200); await receive('DAL', 'S1', 1_000); await receive('SUGAR', 'S2', 50);
    for (let i = 1; i <= 14; i += 1) {
      await sell(`oil-${i}`, dayAgo(i), 'S1', 'OIL', 10);
      await sell(`dal-${i}`, dayAgo(i), 'S1', 'DAL', 1);
    }
    // Two quotes on a requisition for oil.
    expect((await req('POST', '/v1/purchase/requisitions/RQ-1', OWNER, { currency: 'INR', lines: [{ productId: 'OIL', quantity: 100 }] }, 'rq-1')).status).toBeLessThan(300);
    expect((await req('POST', '/v1/purchase/requisitions/RQ-1/quotes/Q-A', OWNER, { supplierId: 'SUP-MURUGAN', lines: [{ productId: 'OIL', unitCost: { minor: 11_800, currency: 'INR' }, leadTimeDays: 2 }] }, 'q-a')).status).toBeLessThan(300);
    expect((await req('POST', '/v1/purchase/requisitions/RQ-1/quotes/Q-B', OWNER, { supplierId: 'SUP-LAKSHMI', lines: [{ productId: 'OIL', unitCost: { minor: 12_150, currency: 'INR' }, leadTimeDays: 1 }] }, 'q-b')).status).toBeLessThan(300);

    expect((await req('PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'trial' })).status).toBe(200);
    expect((await req('PUT', '/v1/ai/agents/enabled', OWNER, { agents: ['A01', 'A02', 'A03', 'A04', 'A05'] })).status).toBe(200);

    // ── A02: the forecast stock-out and the quotation comparison — for a buyer; no quantity, nothing ordered.
    const a02 = (await req('POST', '/v1/ai/agents/A02/runs', OWNER, {}, 'run-a02')).body as { proposals: Draft[]; committedAnything: boolean };
    expect(a02.committedAnything).toBe(false);
    const forecast = a02.proposals.find((p) => p.proposalId === `a02-forecast-OIL-S1-${today}`)!;
    expect(forecast, JSON.stringify(a02.proposals.map((p) => p.proposalId))).toBeDefined();
    expect(forecast.summary).toMatch(/likely to run out/);
    expect(forecast.summary).toMatch(/buyer's decision/);
    expect(forecast.confidence).toMatchObject({ band: 'medium', basis: 'forecast' });
    expect(forecast.wouldRequire).toMatch(/second person/);
    const quotes = a02.proposals.find((p) => p.proposalId === 'a02-quotes-RQ-1-Q-A+Q-B')!;
    expect(quotes.summary).toMatch(/SUP-MURUGAN is cheapest overall at ₹11,800.00/);
    expect(quotes.summary).toMatch(/SUP-LAKSHMI is fastest \(1 day/);
    expect(quotes.confidence.basis).toBe('recorded_fact');
    expect(a02.proposals.some((p) => p.proposalId.includes('SUGAR'))).toBe(false);

    // ── A03: a predicted stock-out with stock to spare at Store 2 (a transfer), and DAL overstock — for a manager.
    const a03 = (await req('POST', '/v1/ai/agents/A03/runs', MGR, {}, 'run-a03')).status;
    expect(a03).toBe(403); // running an agent is not the manager's
    const a03b = (await req('POST', '/v1/ai/agents/A03/runs', OWNER, {}, 'run-a03b')).body as { proposals: Draft[] };
    const ids = a03b.proposals.map((p) => p.proposalId);
    expect(ids).toContain(`a03-predicted-out-OIL-S2-S1-${today}`);
    expect(ids).toContain(`a03-overstock-DAL-S1-${today}`);
    expect(ids.some((id) => id.includes('SUGAR'))).toBe(false);
    expect(ids.some((id) => id.startsWith('a03-overstock-OIL'))).toBe(false);
    const overstock = a03b.proposals.find((p) => p.proposalId === `a03-overstock-DAL-S1-${today}`)!;
    expect(overstock.summary).toMatch(/past the 91-day ageing line/);
    expect(overstock.summary).toMatch(/the manager decides/);
    expect(overstock.wouldRequire).toMatch(/by a manager/);

    // ── A01's action list: what needs a person today.
    expect((await req('POST', '/v1/ai/kill-switches', OWNER, { scope: 'single_agent', agentId: 'A04', reason: 'checking the shopping assistant' }, 'pull-a04')).status).toBe(201);
    const actions = (await req('GET', '/v1/ai/owner/action-list', OWNER)).body as { agentActive: boolean; items: { actionId: string; says: string; confidence: { band: string } }[]; committedAnything: boolean };
    expect(actions.agentActive).toBe(true);
    expect(actions.committedAnything).toBe(false);
    expect(actions.items.find((i) => i.actionId === 'act-waiting-A02')!.says).toMatch(/wait for a buyer/);
    expect(actions.items.find((i) => i.actionId === 'act-waiting-A03')!.says).toMatch(/wait for a manager/);
    expect(actions.items.some((i) => i.actionId.startsWith('act-stopped-') && /A04 stopped by u-owner/.test(i.says))).toBe(true);
    expect((await req('GET', '/v1/ai/owner/action-list', CASH)).status).toBe(403);

    // ── A05 (staff): order and policy answers from the records, cited; escalation when the records cannot answer.
    expect((await req('POST', '/v1/ai/service/answers', CASH, { topic: 'compensation_policy' })).status).toBe(403);
    expect(code(await req('POST', '/v1/ai/service/answers', MGR, { topic: 'order_status', orderId: 'ORD-1', question: 'when will it come?' }))).toBe('not_readable_as_a_service_question');
    const unknown = (await req('POST', '/v1/ai/service/answers', MGR, { topic: 'order_status', orderId: 'ORD-NONE' })).body as { answered: boolean; escalate: boolean };
    expect(unknown).toMatchObject({ answered: false, escalate: true });
    await req('POST', '/v1/orders/ORD-9/promise', OWNER, { lines: [{ productId: 'OIL', quantityMinor: 2 }], locationId: 'S1' }, 'promise-9');
    const known = (await req('POST', '/v1/ai/service/answers', MGR, { topic: 'order_status', orderId: 'ORD-9' })).body as { answered: boolean; text: string; evidence: { reference: string }[]; confidence: { band: string } };
    expect(known).toMatchObject({ answered: true, confidence: { band: 'high' } });
    expect(known.text).toMatch(/order ORD-9: placed/);
    expect(known.evidence[0]!.reference).toBe('ORD-9');
    const policy = (await req('POST', '/v1/ai/service/answers', MGR, { topic: 'compensation_policy' })).body as { answered: boolean; text: string };
    expect(policy.text).toMatch(/₹500.00/);

    // ── AI-NFR-11 (OB-314): the customer's suggestions — the notice on every one, personalisation only after opt-in.
    expect((await req('POST', '/v1/ai/kill-switches/' + ((await req('GET', '/v1/ai/kill-switches', OWNER)).body as { active: { switchId: string }[] }).active[0]!.switchId + '/lift', OWNER2, { reason: 'checked' }, 'lift-a04')).status).toBe(200);
    await h.store.append(T, streamName(STREAM.orders, 'index'), makeEvent({
      id: 'seed-order-c1', type: 'OrderPlaced', occurredAt: new Date().toISOString(), idempotencyKey: `seed-order-${T}`, source: 'test/seed',
      payload: { orderId: 'ORD-C1', locationId: 'S1', lines: [{ productId: 'OIL', quantityMinor: 1 }, { productId: 'SUGAR', quantityMinor: 1 }], state: 'delivered', placedAt: new Date().toISOString(), customerRef: CUST },
    }));
    expect((await req('GET', '/v1/me/ai-suggestions', CASH, undefined, undefined, { locationId: 'S1' })).status).toBe(403);
    expect(code(await req('GET', '/v1/me/ai-suggestions', CUST))).toBe('location_not_given');
    const before = (await req('GET', '/v1/me/ai-suggestions', CUST, undefined, undefined, { locationId: 'S1' })).body as { aiActive: boolean; notice: { en: string; ta: string }; personalisation: { optedIn: boolean }; boughtBefore: unknown[] };
    expect(before.aiActive).toBe(true);
    expect(before.notice.en).toMatch(/^Suggested by AI\./);
    expect(before.notice.ta).toMatch(/^AI பரிந்துரைத்தது/);
    expect(before.personalisation.optedIn).toBe(false);
    expect(before.boughtBefore).toEqual([]); // nothing of their history is read without the opt-in
    const optIn = await req('POST', '/v1/me/privacy/consent', CUST, { purpose: 'ai_personalisation', channel: 'push', given: true }, 'opt-in');
    expect(optIn.status).toBe(201);
    expect((optIn.body as { tellTheCustomer: string }).tellTheCustomer).toMatch(/AI suggestions may now use what you bought before/);
    const after = (await req('GET', '/v1/me/ai-suggestions', CUST, undefined, undefined, { locationId: 'S1' })).body as { personalisation: { optedIn: boolean }; boughtBefore: { productId: string; suggestedByAi: boolean; notice: { en: string } }[] };
    expect(after.personalisation.optedIn).toBe(true);
    // OIL is in stock at S1 (SUGAR is only at S2): each suggestion carries the notice itself.
    expect(after.boughtBefore.map((b) => b.productId)).toEqual(['OIL']);
    expect(after.boughtBefore[0]).toMatchObject({ suggestedByAi: true, notice: { en: expect.stringMatching(/^Suggested by AI/) } });
    // The customer-facing kill switch stops the suggestions at once.
    expect((await req('POST', '/v1/ai/kill-switches', OWNER, { scope: 'customer_facing', reason: 'review the wording' }, 'pull-cf')).status).toBe(201);
    const stopped = (await req('GET', '/v1/me/ai-suggestions', CUST, undefined, undefined, { locationId: 'S1' })).body as { aiActive: boolean; boughtBefore: unknown[]; notice: { en: string } };
    expect(stopped).toMatchObject({ aiActive: false, boughtBefore: [] });

    // ── COLD RESTART: the drafts, the switch and the customer's opt-in are read back from the store.
    h = make(h.store);
    const register = (await req('GET', '/v1/ai/proposals', OWNER)).body as { proposals: Draft[] };
    expect(register.proposals.map((p) => p.proposalId)).toEqual(expect.arrayContaining([`a02-forecast-OIL-S1-${today}`, 'a02-quotes-RQ-1-Q-A+Q-B', `a03-overstock-DAL-S1-${today}`]));
    const cf = ((await req('GET', '/v1/ai/kill-switches', OWNER)).body as { active: { switchId: string; scope: string }[] }).active.find((s) => s.scope === 'customer_facing')!;
    expect((await req('POST', `/v1/ai/kill-switches/${cf.switchId}/lift`, OWNER2, { reason: 'wording fixed' }, 'lift-cf')).status).toBe(200);
    const back = (await req('GET', '/v1/me/ai-suggestions', CUST, undefined, undefined, { locationId: 'S1' })).body as { personalisation: { optedIn: boolean }; boughtBefore: { productId: string }[] };
    expect(back.personalisation.optedIn).toBe(true);
    expect(back.boughtBefore.map((b) => b.productId)).toEqual(['OIL']);
    // Opting out stops it at once.
    expect((await req('POST', '/v1/me/privacy/consent', CUST, { purpose: 'ai_personalisation', channel: 'push', given: false }, 'opt-out')).status).toBe(201);
    const out = (await req('GET', '/v1/me/ai-suggestions', CUST, undefined, undefined, { locationId: 'S1' })).body as { personalisation: { optedIn: boolean }; boughtBefore: unknown[] };
    expect(out).toMatchObject({ personalisation: { optedIn: false }, boughtBefore: [] });
  }, 180_000);
});
