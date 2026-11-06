import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { localDateOf } from '../../services/api/src/r3-gst-adapters';

/**
 * **W5 · OB-683 (owner, 3 Nov 2026) · M23-FR-02 · API-09 — an approved GSTR-1, uploaded on the GST portal BY HAND, is
 * recorded filed with the portal's ARN, in memory AND on real PostgreSQL, with a cold restart.**
 *
 * Live filing is off, so a return could never become Filed. Now the store manager prepares May, the owner approves it, and
 * the owner — who uploaded it on the portal himself — records the ARN. Refused in words: an empty ARN, a malformed one, a
 * return not yet approved. The person is the session's (a body naming someone else, or another time, is ignored), the time
 * head office's own; once per period (a replay of the same request is the same answer, a second record is refused, even
 * after a restart). The return then reads "filed" with the ARN and the person's name; the filing calendar shows it filed on
 * the shop's date; GSTR-3B can now lock to it; and the old "filed outside this system" route still refuses it.
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

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const P = '052026';
const ARN = 'AA330626012345X';
interface Agg { state: string; arn?: string; filedByHand?: { by: string; name: string; at: string }; detail: string }

describe.each(backings)('OB-683: an approved GSTR-1 recorded filed by hand on the portal — on $name', ({ harness, restart }) => {
  it('refuses an empty or malformed ARN and an unapproved return; records once, by the session, at head office\'s time', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-ca', 'chartered_accountant');
    // The owner's name in the staff register (synthetic), so the return shows a name, not an id.
    await h.store.append(T, STREAM.identity, makeEvent({
      id: `person-${T}-owner`, type: 'PersonSignInRequested', occurredAt: '2026-05-01T04:00:00.000Z', idempotencyKey: `person-${T}-u-owner`, source: 'test/provision',
      payload: { userId: 'u-owner', username: 'murugan', displayName: 'Murugan S', secondFactor: true, requestedBy: 'test', at: '2026-05-01T04:00:00.000Z' },
    }));
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', key = `k-${randomUUID()}`): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: key } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const handFile = (body: unknown, userId = 'u-owner', key?: string) => req('POST', `/v1/finance/gstr1/submission/${P}/filed-by-hand`, body, userId, key);

    await ok(req('POST', '/v1/sales', {
      saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-owner', tradingDay: '2026-05-10', committedAt: '2026-05-10T05:30:00Z', totalMinor: 10_500, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-paneer', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_500, lineTotalMinor: 10_500, hsnCode: '040610', taxRateBps: 500 }],
      tenders: [{ kind: 'cash', amountMinor: 10_500 }],
    }), 'sale');
    const digest = ((await ok(req('GET', `/v1/finance/gstr3b/${P}`), 'gstr3b')).body as { gstr1PreviewDigest: string }).gstr1PreviewDigest;
    await ok(req('POST', `/v1/finance/gstr1/submission/${P}/preview`, { returnDigest: digest }, 'u-mgr'), 'prepare');

    // Not yet approved: refused by name, nothing recorded.
    const early = await handFile({ arn: ARN });
    expect(early.status).toBe(422);
    expect(codeOf(early)).toBe('submission_not_approved');

    await ok(req('POST', `/v1/finance/gstr1/submission/${P}/approve`, {}), 'approve');

    // Empty and malformed ARNs are refused in words.
    const empty = await handFile({ arn: '   ' });
    expect([empty.status, codeOf(empty)]).toEqual([400, 'arn_needed']);
    expect((empty.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/acknowledgement number \(ARN\)/);
    for (const bad of ['AA33062601234', 'BB330626012345X', 'AA331326012345X', 'AA000626012345X', 'SANDBOX-123', 'AA3306260123456X']) {
      const r = await handFile({ arn: bad });
      expect([r.status, codeOf(r)], bad).toEqual([400, 'arn_malformed']);
    }
    // The CA may read the returns page but files nothing (OB-192): refused at the gate.
    expect((await handFile({ arn: ARN }, 'u-ca')).status).toBe(403);
    expect(((await ok(req('GET', `/v1/finance/gstr1/submission/${P}`), 'still approved')).body as Agg).state).toBe('approved');

    // The owner records it — typed in lower case with a space; the body's "by" and "at" are ignored.
    const before = Date.now();
    const key = `hand-${randomUUID()}`;
    const typed = { arn: 'aa33 0626012345x', by: 'u-mgr', byName: 'Someone Else', at: '2020-01-01T00:00:00.000Z' };
    const done = await handFile(typed, 'u-owner', key);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const agg = (done.body as { current: Agg }).current;
    expect(agg).toMatchObject({ state: 'filed', arn: ARN, filedByHand: { by: 'u-owner', name: 'Murugan S' } });
    expect(Date.parse(agg.filedByHand!.at)).toBeGreaterThanOrEqual(before - 1_000);
    expect(agg.detail).toBe(`filed by hand on the portal by Murugan S — portal reference ${ARN}`);

    // A replay of the same request is the same answer; a second record (any person, any ARN) is refused.
    const replay = await handFile(typed, 'u-owner', key);
    expect(replay.status).toBe(201);
    expect((replay.body as { current: Agg }).current.filedByHand).toEqual(agg.filedByHand);
    const twice = await handFile({ arn: 'AA330626099999Z' });
    expect([twice.status, codeOf(twice)]).toEqual([409, 'submission_already_filed']);

    // It fits the register: the old "filed outside this system" route refuses it as already filed, the calendar shows
    // it filed on the shop's date with the ARN, and GSTR-3B now locks to the filed GSTR-1.
    const outside = await req('POST', `/v1/finance/returns/GSTR1/${P}/filed`, { arn: ARN, filedOn: '2026-06-11' });
    expect([outside.status, codeOf(outside)]).toEqual([409, 'return_already_filed']);
    const cal = (await ok(req('GET', '/v1/finance/filing-calendar'), 'calendar')).body as { entries: { type: string; period: string; filedOn?: string; arn?: string }[] };
    expect(cal.entries.find((e) => e.type === 'GSTR1' && e.period === P)).toMatchObject({ arn: ARN, filedOn: localDateOf(agg.filedByHand!.at, 'Asia/Kolkata') });
    await ok(req('POST', `/v1/finance/gstr3b/${P}/lock`, {}, 'u-mgr'), 'GSTR-3B locks to the filed GSTR-1');

    // A cold restart: still filed by hand, and still refused a second time.
    h = restart(h);
    const reread = (await ok(req('GET', `/v1/finance/gstr1/submission/${P}`), 'reread')).body as Agg;
    expect(reread).toMatchObject({ state: 'filed', arn: ARN, filedByHand: { by: 'u-owner', name: 'Murugan S' } });
    expect(codeOf(await handFile({ arn: ARN }))).toBe('submission_already_filed');
    const list = (await ok(req('GET', '/v1/finance/gstr1/submissions'), 'list')).body as { submissions: { period: string; state: string; arn?: string }[] };
    expect(list.submissions).toEqual([expect.objectContaining({ period: P, state: 'filed', arn: ARN })]);
  });
});
