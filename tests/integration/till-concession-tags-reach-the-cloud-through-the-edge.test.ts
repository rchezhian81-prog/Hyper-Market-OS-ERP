import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **A concession docket line recorded at the till with the cable out reaches the cloud, through the real edge
 * (M27-FR-03 · Item 3 · §31).**
 *
 * The till's partner-counter line is the FIFTH write seam beside the sale, the refund, the completion and the
 * day close: the real `startEdge` opens its own durable log, `commitConcessionTag` writes there first and
 * queues a `ConcessionTagCaptured` event on its own outbox, its own agent drains it through the real transport
 * to `POST /v1/concession/tags/synced`, which resolves the partner's contract in force ON THE CLOUD, snapshots
 * the scheme there, and records the RELAYED cashier as the author — never the box's identity. Only the socket
 * is replaced. Then: the tag is on the contract's stream and counts toward settlement; a restart does not
 * re-send it; a partner with no contract in force dead-letters by name (kept for a person, hard rule #6).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa27';
const KEY = ['edge', 'tags', 'seam', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';

const CONTRACT = {
  branchId: 'br-1', concessionaireId: 'jeweller-1', name: 'Gold counter', startsOn: '2026-01-01', endsOn: '2026-12-31',
  basis: 'revenue_share', revenueShareBps: 1_500, commissionOn: 'gross', depositMinor: 500_000,
  insuranceUntil: '2027-06-30', licenceUntil: '2027-06-30', approvedBy: OWNER,
};

/** A docket line as the till's page hands it to the box's lane socket. */
const lineRecord = (tagId: string, saleId: string, concessionaireId = 'jeweller-1') => JSON.stringify({
  tagId, kind: 'sale', saleId, lineId: 'line-1', productId: 'ring-22k', concessionaireId, counterId: 'counter-gold',
  tillId: 'till-1', shiftId: 'shift-2026-09-29', qty: 1, grossMinor: 100_000, discountMinor: 0, taxMinor: 3_000,
  capturedBy: 'cashier-anita', byRole: 'cashier', source: 'docket-8842', at: '2026-09-29T10:30:00.000Z',
});

interface TagsBody { tags: { tagId: string; capturedBy: string; commissionMinor: number; history: { by: string; byRole: string }[] }[]; totals: { commissionMinor: number } }
const tagsOn = async (h: ApiHarness, contractId: string): Promise<TagsBody> =>
  (await h.request({ method: 'GET', path: `/v1/concession/contracts/${contractId}/tags`, userId: OWNER, tenantId: A, query: { from: '2026-09-01', to: '2026-09-30' } })).body as TagsBody;

describe('till concession tags reach the cloud through the real edge (M27-FR-03, §31)', () => {
  let h: ApiHarness;
  let dir: string;
  let online = true;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, 'u-sync', 'cashier'); // the store's sync identity: concession.tag.sync
    await h.enableFeature(A, 'dept.concession');
    const defined = await h.request({ method: 'POST', path: '/v1/concession/contracts/ct-gold', userId: OWNER, tenantId: A, idempotencyKey: 'ct-gold', body: CONTRACT });
    expect([200, 201]).toContain(defined.status);

    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'],
        path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''),
        idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;

    dir = await mkdtemp(join(tmpdir(), 'sre-edge-tags-'));
  });

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    CLOUD_API_URL: 'https://cloud.example.test',
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-sync', tenantId: A }),
  });

  it('writes the line durably to ITS OWN log and queues it the moment it is recorded, touching no other queue', async () => {
    online = false; // the cable is out when the cashier records it
    const edge = (await startEdge(env(), () => {}))!;
    const outcome = await edge.node.commitConcessionTag('till-1:S-77:line-1', lineRecord('till-1:S-77:line-1', 'S-77'));
    expect(outcome.committed).toBe(true);
    expect((await readLog(edge.concessionTagsLog.path)).length).toBe(1);
    expect(edge.concessionTagsAgent?.health().unsentCount).toBe(1);
    expect(edge.agent?.health().unsentCount).toBe(0);
    expect(edge.returnsAgent?.health().unsentCount).toBe(0);
    // Nothing reached the cloud yet — the line is only on the store computer.
    expect((await tagsOn(h, 'ct-gold')).tags).toHaveLength(0);
    online = true;
    await edge.stop(); // drains before it goes
  });

  it('and that queued line is on the contract at the cloud — the cashier as author, the commission computed from the contract there', async () => {
    const body = await tagsOn(h, 'ct-gold');
    expect(body.tags.map((t) => t.tagId)).toEqual(['till-1:S-77:line-1']);
    expect(body.tags[0]).toMatchObject({ capturedBy: 'cashier-anita', commissionMinor: 15_000 });
    expect(body.tags[0]!.history[0]).toMatchObject({ by: 'cashier-anita', byRole: 'cashier' }); // the box (u-sync) is the courier, not the author
    expect(body.totals.commissionMinor).toBe(15_000);
  });

  it('does not re-send it on the next start — the concession-tags cursor remembers', async () => {
    const said: string[] = [];
    const edge = (await startEdge(env(), (l) => said.push(l)))!;
    expect(edge.concessionTagsAgent?.health().unsentCount).toBe(0);
    expect(said.join('\n')).not.toContain('partner-counter line(s) from before are still to send');
    await edge.stop();
    expect((await tagsOn(h, 'ct-gold')).tags).toHaveLength(1);
  });

  it('a line for a partner with no contract in force is refused by name at the cloud and KEPT as a dead letter on the box — never dropped, never guessed', async () => {
    const edge = (await startEdge(env(), () => {}))!;
    await edge.node.commitConcessionTag('till-1:S-90:line-1', lineRecord('till-1:S-90:line-1', 'S-90', 'nobody-9'));
    const pass = await edge.syncOnce!();
    expect(pass.dead).toBe(1);
    expect(edge.concessionTagsAgent?.health().deadLetterCount).toBe(1);
    expect((await tagsOn(h, 'ct-gold')).tags).toHaveLength(1); // the good line stands alone
    await edge.stop();
  });
});
