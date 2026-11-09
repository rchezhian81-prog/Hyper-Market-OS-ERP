import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';

/**
 * **CR-01 step 2d · OI-03 — the till's own screen server answers /about/ with this shop's tenant id**, on this PC only, with
 * no sign-in (names only: the tenant id is a name, not a secret). Started exactly as the till service starts it.
 */
describe('the About screen is served by the till (OI-03)', () => {
  it('GET /about/ → 200 with the tenant id, the till and the store; no key in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-about-'));
    const key = ['about', 'test', 'pack', 'key'].join('-').padEnd(48, 'k');
    const edge = (await startEdge({
      EDGE_TENANT_ID: '8538cb43-36d6-4346-b093-a72ebe25e400', EDGE_LANE_ID: 'lane-1', EDGE_STORE_ID: 'SRE-MAIN', PACK_SIGNING_KEY: key,
      EDGE_DATA_DIR: join(dir, 'edge-data'), EDGE_WITNESS_DIR: join(dir, 'witness'), EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    try {
      const r = await fetch(`http://127.0.0.1:${edge.screens!.port}/about/`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('<code>8538cb43-36d6-4346-b093-a72ebe25e400</code>');
      expect(html).toContain('<code>lane-1</code>');
      expect(html).toContain('<code>SRE-MAIN</code>');
      expect(html).not.toContain(key);
      expect((await fetch(`http://127.0.0.1:${edge.screens!.port}/about`)).status).toBe(200);
    } finally {
      await edge.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
