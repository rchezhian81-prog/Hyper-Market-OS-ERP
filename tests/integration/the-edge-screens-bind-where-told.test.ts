import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { SCREEN_HOST } from '../../edge/store-edge/src/screen-server';
import { STORE_EDGE_CONFIG } from '../../services/kernel/src/index';

/**
 * **The edge's screens bind to loopback unless a deployment names another address — and then it says so
 * (ADR-0018 · Stage F slice 2 · P-04 · P-08).**
 *
 * On a shop PC the screens socket carries the day's takings, so it binds to 127.0.0.1 and nothing else. The
 * one public origin (the compose `proxy`) needs to reach the customer screen inside the private container
 * network, so `EDGE_SCREEN_HOST` may name a wider address explicitly. The default must stay loopback, the
 * widening must be deliberate, and the boot line must say in words what it means. The REAL edge starts here.
 */

const KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const started: { stop: () => Promise<void> }[] = [];
const envFor = (dataDir: string, extra: Record<string, string> = {}) => ({
  EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
  EDGE_SCREEN_PORT: '0', ...extra,
});
const boot = async (extra: Record<string, string> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-edge-screens-')); dirs.push(dir);
  const said: string[] = [];
  const edge = (await startEdge(envFor(dir, extra), (l) => said.push(l)))!;
  started.push(edge);
  return { edge, said: () => said.join('\n') };
};
afterEach(async () => {
  for (const e of started.splice(0)) await e.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('the edge screens bind where told, loopback unless told (ADR-0018)', () => {
  it('by default the screens bind to loopback and the boot line says so; the customer app is served from them', async () => {
    const { edge, said } = await boot();
    expect(edge.screens).not.toBeNull();
    expect(edge.screens!.host).toBe(SCREEN_HOST);
    expect(said()).toContain('loopback only');
    expect(said()).not.toContain('NOT loopback');
    const page = await fetch(`http://127.0.0.1:${edge.screens!.port}/customer/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('customer-app.bundle.js');
  });

  it('EDGE_SCREEN_HOST widens the bind on purpose, and the boot line says out loud what that means', async () => {
    const { edge, said } = await boot({ EDGE_SCREEN_HOST: '0.0.0.0' });
    expect(edge.screens!.host).toBe('0.0.0.0');
    expect(said()).toContain('NOT loopback: anything that can reach this address can read the day\'s takings');
    expect(said()).toContain('ADR-0018');
    const page = await fetch(`http://127.0.0.1:${edge.screens!.port}/customer/`);
    expect(page.status).toBe(200);
  });

  it('an explicit loopback address raises no alarm, and the setting is declared optional in the edge configuration', async () => {
    const { edge, said } = await boot({ EDGE_SCREEN_HOST: '127.0.0.1' });
    expect(edge.screens!.host).toBe('127.0.0.1');
    expect(said()).toContain('loopback only');
    expect(said()).not.toContain('NOT loopback');
    const spec = STORE_EDGE_CONFIG.find((s) => s.key === 'EDGE_SCREEN_HOST');
    expect(spec?.optional).toBe(true);
  });
});
