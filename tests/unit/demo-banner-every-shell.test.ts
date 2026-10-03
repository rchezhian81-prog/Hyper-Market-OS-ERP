// The DEMO / PILOT — NOT PRODUCTION banner is on EVERY shell of the hosted demo, not just the ERP
// (owner instruction 27 Sep 2026, defect H-04). Proves each shell's entry mounts it from the build flag,
// and that each shell's real browser bundle, built exactly as `scripts/build-app.mjs` builds it, carries
// the banner when PILOT_DEMO_BANNER=1 and bakes the flag OFF when it is unset (production).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const SHELLS = ['pos', 'web-erp', 'owner-app', 'picker-app', 'delivery-app', 'customer-app', 'warehouse-app', 'supplier-app'];

async function bundle(app: string, flag: string): Promise<string> {
  const out = await build({
    entryPoints: [`apps/${app}/src/browser-entry.ts`],
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], write: false, logLevel: 'silent',
    define: { PILOT_DEMO_BANNER: JSON.stringify(flag) },
  });
  return out.outputFiles[0]!.text;
}

/** The top-level mount statement, e.g. `mountDemoBanner(demoBannerDoc, true ? "1" : "");`. */
const mountCall = (js: string): string => /mountDemoBanner\(\s*demoBannerDoc[^;]*;/.exec(js)?.[0] ?? '';

describe('every shell mounts the demo banner', () => {
  for (const app of SHELLS) {
    it(`${app}: the entry mounts it from the build-time flag`, () => {
      const src = readFileSync(`apps/${app}/src/browser-entry.ts`, 'utf8');
      expect(src).toMatch(/from '\.\.\/\.\.\/\.\.\/packages\/ui\/src\/demo-banner'/);
      expect(src).toMatch(/mountDemoBanner\([^;]*PILOT_DEMO_BANNER/);
    });

    it(`${app}: the demo build carries the banner; the production build bakes the flag off`, async () => {
      const demo = await bundle(app, '1');
      // esbuild escapes non-ASCII (the em dash), so match the plain-ASCII parts of the English text.
      expect(demo).toContain('DEMO / PILOT');
      expect(demo).toContain('NOT PRODUCTION');
      expect(mountCall(demo)).toContain('"1"');
      // Production: the constant is baked to '' — the call can only ever pass an empty flag.
      const prod = await bundle(app, '');
      expect(mountCall(prod)).not.toBe('');
      expect(mountCall(prod)).not.toContain('"1"');
    }, 60_000);
  }
});
