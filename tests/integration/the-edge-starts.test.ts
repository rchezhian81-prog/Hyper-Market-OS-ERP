import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, nextInterval } from '../../edge/store-edge/src/main';
import { commitLocally } from '../../edge/store-edge/src/durability';
import { readLog } from '../../edge/store-edge/src/file-log';
import { loadConfig, STORE_EDGE_CONFIG } from '../../services/kernel/src/index';

/**
 * **The edge starts, and trades, with no cloud configuration at all.**
 *
 * That sentence is P-01 and hard rule #1 turned into something a test can check. Every piece of the
 * edge existed and none of it had ever been *started*: there was no process, no durable log
 * implementation, and no transport. A shop could not have run this.
 *
 * The property worth guarding above all others is the absence of a requirement. If the edge needed
 * the cloud to boot, offline-first would be a paragraph in a document rather than a property of the
 * software — and the first power cut with a dead router would prove it, in front of customers.
 */

const KEY = ['edge', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const TOKEN = ['edge', 'cloud', 'token'].join('-').padEnd(40, 'w');

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-edge-main-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const envFor = (dataDir: string, extra: Record<string, string> = {}) => ({
  EDGE_DATA_DIR: dataDir,
  EDGE_TENANT_ID: 't-sre',
  PACK_SIGNING_KEY: KEY,
  EDGE_CAPACITY_BYTES: '10485760',
  ...extra,
});

describe('the edge starts with no cloud, and says so', () => {
  it('starts, opens its disk, and reports itself ready to sell', async () => {
    const said: string[] = [];
    const edge = await startEdge(envFor(await tempDir()), (l) => said.push(l));

    expect(edge).toBeDefined();
    expect(said.join('\n')).toContain('store edge ready');
    await edge!.stop();
  });

  it('runs no sync agent at all, rather than one pointed at nothing', async () => {
    const edge = await startEdge(envFor(await tempDir()), () => {});
    // Null, not an agent with an empty URL that fails a request every fifteen seconds forever.
    expect(edge?.agent).toBeNull();
    await edge!.stop();
  });

  it('says plainly that nothing will be synced — it does not pretend', async () => {
    const said: string[] = [];
    const edge = await startEdge(envFor(await tempDir()), (l) => said.push(l));
    const output = said.join('\n');
    expect(output).toContain('no cloud is configured, so nothing will be synced');
    expect(output).toContain('The shop can still trade');
    await edge!.stop();
  });

  it('sells while it is like that, and the sale is on the disk', async () => {
    // The whole claim, end to end: no cloud anywhere in this test, and a sale that survives.
    const edge = await startEdge(envFor(await tempDir()), () => {});
    const outcome = await commitLocally({
      saleId: 'S-1', record: JSON.stringify({ saleId: 'S-1', totalMinor: 64_000 }), log: edge!.log,
    });
    expect(outcome.committed).toBe(true);
    expect(outcome.durable).toBe(true);
    await edge!.stop();

    const records = await readLog(edge!.log.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok === true && JSON.parse(records[0].record).totalMinor).toBe(64_000);
  });

  it('lists no cloud setting as required — the absence IS the control', () => {
    // Stated twice on purpose: the config list says it, and the process above honours it. Either
    // one alone can drift from the other.
    const required = STORE_EDGE_CONFIG.filter((s) => s.optional !== true).map((s) => s.key);
    expect(required).not.toContain('CLOUD_API_URL');
    expect(required).not.toContain('CLOUD_API_TOKEN');
    expect(loadConfig(STORE_EDGE_CONFIG, envFor('/tmp/anywhere')).ok).toBe(true);
  });
});

describe('the edge starts a sync agent when there IS a cloud', () => {
  it('builds one, and does not sync anything on the sale path', async () => {
    const edge = await startEdge(
      envFor(await tempDir(), { CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TOKEN }),
      () => {},
    );
    expect(edge?.agent).not.toBeNull();
    // Nothing has been drained yet — the first pass is on a timer, well after start-up, and the
    // sale path never waits for it (hard rule #1).
    expect(edge?.agent?.health().unsentCount).toBe(0);
    await edge!.stop();
  });
});

describe('what a power cut left behind is reported, not repaired', () => {
  it('names the records it could not read whole, and keeps them (hard rule #6)', async () => {
    const dir = await tempDir();
    const first = await startEdge(envFor(dir), () => {});
    await first!.log.append(JSON.stringify({ saleId: 'S-1' }));
    await first!.stop();

    // The power cut: a frame promising more bytes than arrived.
    await appendFile(first!.log.path, '40 {"saleId":"S-2","tot\n');

    const said: string[] = [];
    const second = await startEdge(envFor(dir), (l) => said.push(l));
    const output = said.join('\n');

    expect(output).toContain('1 record(s) could not be read whole');
    expect(output).toContain('a repaired half-sale is a made-up sale');
    await second!.stop();

    // Still there afterwards. Reported, never quietly tidied away.
    expect((await readLog(first!.log.path)).some((r) => !r.ok)).toBe(true);
  });
});

describe('the sync loop backs off, and never runs two passes at once', () => {
  it('widens the gap while nothing is getting through, and caps it at five minutes', () => {
    // A shop with a dead router must not make a request a second all night; and it must not wait
    // hours once the router comes back, either.
    expect(nextInterval(0)).toBe(15_000);
    expect(nextInterval(1)).toBe(30_000);
    expect(nextInterval(4)).toBe(240_000);
    expect(nextInterval(5)).toBe(300_000);
    expect(nextInterval(50)).toBe(300_000);
  });

  it('never returns zero or a negative interval, however the counter is fed', () => {
    for (const n of [0, 1, 10, 100, 1_000]) expect(nextInterval(n)).toBeGreaterThanOrEqual(15_000);
  });
});

describe('it refuses to start on a bad configuration, rather than half-starting', () => {
  it('exits with EX_CONFIG and starts nothing', async () => {
    const previous = process.exitCode;
    const edge = await startEdge({}, () => {});
    expect(edge).toBeUndefined();
    expect(process.exitCode).toBe(78);
    process.exitCode = previous;
  });
});
