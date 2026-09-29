import { describe, it, expect, afterEach } from 'vitest';
import { startLaneServer, type LaneServer } from '../../edge/store-edge/src/lane-server';
import type { EdgeNode } from '../../edge/store-edge/src/index';
import { toCloudConcessionTag, concessionTagIdOf } from '../../edge/store-edge/src/cloud-concession-tag';

/**
 * **The lane's concession-tag write route: POST /lane/concession-tags (M27-FR-03 · Item 3 · §31).**
 *
 * The till's partner-counter docket line travels the same loopback socket as a sale and a refund, under the same
 * server-side authorization decided BEFORE the body is read (RR-F01), and reaches the edge's own seam
 * (`commitConcessionTag`) with the record's OWN id (`tagId`). A record with no tag id is refused as unreadable —
 * never written under a guessed id. And the translator the edge queues with reads the disk record defensively.
 */

let committed: { id: string; record: string }[] = [];
const stubNode = (): EdgeNode => ({
  pack: () => undefined,
  commit: async (id) => ({ committed: true, saleId: id, laneMessage: 'saved' } as never),
  commitReturn: async (id) => ({ committed: true, returnId: id, laneMessage: 'saved' } as never),
  commitCompletion: async (_kind, id) => ({ committed: true, completionId: id, laneMessage: 'saved' } as never),
  commitConcessionTag: async (id, record) => { committed.push({ id, record }); return { committed: true, saleId: id, laneMessage: 'saved' } as never; },
  lookupSale: async () => undefined,
  takePack: () => ({ accepted: true, staffMessage: '' }),
});

const LINE = {
  tagId: 'till-1:S-77:line-1', kind: 'sale', saleId: 'S-77', lineId: 'line-1', productId: 'ring-22k', concessionaireId: 'jeweller-1', counterId: 'counter-gold',
  tillId: 'till-1', shiftId: 'shift-2026-09-29', qty: 1, grossMinor: 100_000, discountMinor: 0, taxMinor: 3_000,
  capturedBy: 'cashier-anita', byRole: 'cashier', source: 'docket-8842', at: '2026-09-29T10:30:00.000Z',
};

describe('POST /lane/concession-tags', () => {
  const servers: LaneServer[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); committed = []; });
  const start = async () => {
    const s = await startLaneServer({ node: stubNode(), port: 0 });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };
  const headers = { origin: 'http://127.0.0.1:8080', 'content-type': 'application/json' };

  it('hands a loopback caller\'s docket line to the edge seam under the record\'s own tag id, and answers 200 with the outcome', async () => {
    const base = await start();
    const res = await fetch(`${base}/lane/concession-tags`, { method: 'POST', headers, body: JSON.stringify(LINE) });
    expect(res.status).toBe(200);
    expect((await res.json() as { committed: boolean }).committed).toBe(true);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.id).toBe('till-1:S-77:line-1');
    expect(JSON.parse(committed[0]!.record)).toMatchObject({ saleId: 'S-77', capturedBy: 'cashier-anita' });
  });

  it('refuses a record with no tag id as unreadable — nothing is written under a guessed id', async () => {
    const base = await start();
    const { tagId: _dropped, ...noId } = LINE;
    void _dropped;
    const res = await fetch(`${base}/lane/concession-tags`, { method: 'POST', headers, body: JSON.stringify(noId) });
    expect(res.status).toBe(400);
    expect(committed).toHaveLength(0);
    const garbage = await fetch(`${base}/lane/concession-tags`, { method: 'POST', headers, body: '{not json' });
    expect(garbage.status).toBe(400);
    expect(committed).toHaveLength(0);
  });

  it('refuses a foreign origin and a non-JSON body BEFORE anything is written (RR-F01)', async () => {
    const base = await start();
    const foreign = await fetch(`${base}/lane/concession-tags`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(LINE) });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    const text = await fetch(`${base}/lane/concession-tags`, { method: 'POST', headers: { origin: 'http://127.0.0.1:8080', 'content-type': 'text/plain' }, body: JSON.stringify(LINE) });
    expect(text.status).toBeGreaterThanOrEqual(400);
    expect(committed).toHaveLength(0);
  });
});

describe('toCloudConcessionTag — the disk record, read defensively into the cloud\'s synced contract', () => {
  it('carries every docket field, defaults an unknown kind to sale and an unknown role to the narrowest (cashier), keeps a named contract', () => {
    const cloud = toCloudConcessionTag({ ...LINE, kind: 'weird', byRole: 'owner', contractId: 'ct-gold' });
    expect(cloud).toMatchObject({ tagId: 'till-1:S-77:line-1', kind: 'sale', byRole: 'cashier', contractId: 'ct-gold', grossMinor: 100_000, capturedBy: 'cashier-anita', at: '2026-09-29T10:30:00.000Z' });
    expect(toCloudConcessionTag({ ...LINE, kind: 'return', byRole: 'supervisor' })).toMatchObject({ kind: 'return', byRole: 'supervisor' });
    expect('contractId' in toCloudConcessionTag(LINE)).toBe(false);
  });
  it('invents nothing: garbage reads as empty strings and zeros, and the id tolerates a bare `id`', () => {
    expect(toCloudConcessionTag('not an object')).toMatchObject({ tagId: '', saleId: '', qty: 0, grossMinor: 0, byRole: 'cashier', kind: 'sale' });
    expect(toCloudConcessionTag({ qty: 1.5, grossMinor: '100' }).qty).toBe(0);
    expect(concessionTagIdOf({ id: 'bare' })).toBe('bare');
    expect(concessionTagIdOf({ tagId: 'named', id: 'bare' })).toBe('named');
    expect(concessionTagIdOf({})).toBeUndefined();
  });
});
