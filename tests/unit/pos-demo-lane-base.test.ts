// DEMO ONLY (ADR-0016). The till's lane base is a build-time constant: the hosted-demo build points a
// remote-browser till at the demo store box (`/store-lane`, same origin, behind the demo sign-in); the
// production build must compile to the store's own loopback exactly as before. This proves both, on the
// real bundle built the way scripts/build-app.mjs builds it.

import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { laneBase } from '../../apps/pos/src/browser-entry';

async function posBundle(laneBaseDefine: string): Promise<string> {
  const out = await build({
    entryPoints: ['apps/pos/src/browser-entry.ts'], bundle: true, format: 'esm', platform: 'browser',
    target: ['es2022'], write: false, logLevel: 'silent',
    define: { PILOT_DEMO_BANNER: '""', PILOT_DEMO_LANE_BASE: JSON.stringify(laneBaseDefine) },
  });
  return out.outputFiles[0]!.text;
}

describe('the till lane base', () => {
  it('is the store loopback unless a demo base is given', () => {
    expect(laneBase(8090, '')).toBe('http://127.0.0.1:8090');
    expect(laneBase(8095, '')).toBe('http://127.0.0.1:8095');
    expect(laneBase(8090, '/store-lane')).toBe('/store-lane');
  });

  it('PRODUCTION build: the constant is baked empty — the till still writes to the store loopback', async () => {
    const js = await posBundle('');
    expect(js).toContain('http://127.0.0.1:');
    expect(js).not.toContain('/store-lane');
    // The demo base folds to an empty string, so laneBase() always takes the loopback branch.
    expect(js).toMatch(/DEMO_LANE_BASE = true \? "" : ""/);
  });

  it('DEMO build: the till writes to the demo store box through the same-origin path', async () => {
    const js = await posBundle('/store-lane');
    expect(js).toMatch(/DEMO_LANE_BASE = true \? "\/store-lane" : ""/);
  });

  it('only the till knows about the demo lane base', () => {
    for (const app of ['web-erp', 'owner-app', 'picker-app', 'delivery-app', 'customer-app', 'warehouse-app', 'supplier-app']) {
      expect(readFileSync(`apps/${app}/src/browser-entry.ts`, 'utf8')).not.toContain('PILOT_DEMO_LANE_BASE');
    }
    for (const dir of ['services', 'edge/store-edge/src']) {
      expect(readFileSync(`${dir === 'services' ? 'services/pos/src/index.ts' : 'edge/store-edge/src/lane-server.ts'}`, 'utf8')).not.toContain('PILOT_DEMO_LANE_BASE');
    }
  });
});
