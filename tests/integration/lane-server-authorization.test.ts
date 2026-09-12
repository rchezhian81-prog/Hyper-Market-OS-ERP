import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { isJsonContentType, laneCallRefusal, isLoopbackOrigin } from '../../edge/store-edge/src/lane-server';

/**
 * **RR-F01 — an untrusted request must not mutate the lane's durable log.**
 *
 * The review's probe: a cross-origin `POST /lane/returns` carrying `text/plain` returned HTTP 200 and
 * wrote a record. CORS headers and the loopback bind are not caller authorization — a `text/plain`
 * cross-origin request is a CORS *simple request*, delivered with no preflight, so the write happened
 * before the browser's missing-header check could matter. Authorization is now decided server-side,
 * before anything is read or written. These drive the real edge with nothing stubbed.
 */

const KEY = ['lane', 'auth', 'signing', 'key'].join('-').padEnd(48, '0');

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const startLane = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-lane-auth-'));
  dirs.push(dir);
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
    EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};

const saleBody = () => JSON.stringify({ id: 'S-evil', total: 1 });
const returnBody = () => JSON.stringify({ id: 'RET-evil', returnId: 'RET-evil', originalSaleId: 'S-1' });

describe('RR-F01 — the lane socket authorizes before it writes', () => {
  it('the exact probe: foreign Origin + text/plain on /lane/returns is refused and writes NOTHING', async () => {
    const edge = await startLane();
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/returns`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://untrusted.invalid' },
      body: returnBody(),
    });
    expect(res.status).not.toBe(200);           // refused (was 200 before the fix)
    const body = await res.json() as { committed?: boolean };
    expect(body.committed).toBe(false);
    // The point of the finding: no durable mutation happened.
    expect(await readLog(edge.returnsLog.path)).toHaveLength(0);
  });

  it('the same probe on /lane/sales writes nothing either', async () => {
    const edge = await startLane();
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://untrusted.invalid' },
      body: saleBody(),
    });
    expect(res.status).not.toBe(200);
    expect(await readLog(edge.log.path)).toHaveLength(0);
  });

  it('a foreign Origin is refused even with the right content type (403, before any write)', async () => {
    const edge = await startLane();
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/returns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' },
      body: returnBody(),
    });
    expect(res.status).toBe(403);
    expect(await readLog(edge.returnsLog.path)).toHaveLength(0);
  });

  it('text/plain is refused even with no Origin (the content-type control, 415)', async () => {
    const edge = await startLane();
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: saleBody(),
    });
    expect(res.status).toBe(415);
    expect(await readLog(edge.log.path)).toHaveLength(0);
  });

  it('AUTHORIZED offline operation is preserved: application/json, no foreign origin, commits', async () => {
    const edge = await startLane();
    // No Origin (a non-browser/same-origin call) — the authorized lane path.
    const res1 = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'S-ok', total: 1 }),
    });
    expect(res1.status).toBe(200);
    expect((await res1.json() as { committed: boolean }).committed).toBe(true);
    // A loopback Origin (the till's own screen on another port) — also authorized.
    const res2 = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', origin: `http://127.0.0.1:${edge.lane!.port}` },
      body: JSON.stringify({ id: 'S-ok-2', total: 1 }),
    });
    expect(res2.status).toBe(200);
    expect(await readLog(edge.log.path)).toHaveLength(2);
  });
});

describe('RR-F01 — the authorization decision, unit-tested directly', () => {
  it('accepts application/json (with or without a charset), rejects everything else', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('APPLICATION/JSON')).toBe(true);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });

  it('refuses a foreign origin and a non-JSON content type, allows the authorized shapes', () => {
    // foreign origin -> 403, whatever the content type
    expect(laneCallRefusal('https://untrusted.invalid', 'application/json')?.status).toBe(403);
    expect(laneCallRefusal('https://untrusted.invalid', 'text/plain')?.status).toBe(403);
    // no/loopback origin but wrong content type -> 415
    expect(laneCallRefusal(undefined, 'text/plain')?.status).toBe(415);
    expect(laneCallRefusal('http://localhost:9999', 'text/plain')?.status).toBe(415);
    // authorized: loopback or absent origin + json -> allowed
    expect(laneCallRefusal(undefined, 'application/json')).toBeUndefined();
    expect(laneCallRefusal('http://127.0.0.1:8090', 'application/json')).toBeUndefined();
    expect(laneCallRefusal('http://[::1]:8090', 'application/json; charset=utf-8')).toBeUndefined();
  });

  it('still recognises the loopback origins', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:8090')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:1234')).toBe(true);
    expect(isLoopbackOrigin('https://untrusted.invalid')).toBe(false);
  });
});
