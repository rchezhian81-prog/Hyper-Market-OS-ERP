import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * D-13 (R4, OB-219): "Image recognition is built as a switched-off link with a test stand-in, and nothing is sent while
 * switched off: no photo leaves the shop, and the score says 'counted by staff'." Pinned on the source:
 *
 *   • the running system composes ONLY the switched-off link; the test stand-in is imported by tests and nothing else;
 *   • the switched-off link refuses before touching a photo, and makes no network call;
 *   • the service asks the link only when it is not switched off, never on the way a photo comes in, and every score is
 *     the staff count's.
 */
const code = (p: string): string => readFileSync(p, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const PORT = code('packages/merchandising/src/shelf-image-port.ts');
const SERVICE = code('services/inventory/src/shelf-bay-compliance.ts');
const ADAPTERS = code('services/api/src/r4-supply-lp-adapters.ts');

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...sourcesUnder(p));
    else if (p.endsWith('.ts') || p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

describe('no shelf photo leaves the shop (D-13)', () => {
  it('the running system composes only the switched-off link', () => {
    expect(ADAPTERS).toMatch(/recognition: SWITCHED_OFF_SHELF_RECOGNITION,/);
    expect(ADAPTERS).not.toMatch(/testStandInShelfRecognition/);
    for (const f of [...sourcesUnder('services'), ...sourcesUnder('packages'), ...sourcesUnder('apps'), ...sourcesUnder('edge')]) {
      if (f === join('packages', 'merchandising', 'src', 'shelf-image-port.ts')) continue;
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/testStandInShelfRecognition/);
    }
  });

  it('the switched-off link refuses before touching a photo, and no link makes a network call', () => {
    const off = PORT.slice(PORT.indexOf('export const SWITCHED_OFF_SHELF_RECOGNITION'), PORT.indexOf('export function testStandInShelfRecognition'));
    expect(off).toMatch(/recognise: async \(\): Promise<readonly RecognisedFacing\[\]> => \{ throw new RecognitionSwitchedOffError\(\); \}/);
    expect(PORT).not.toMatch(/fetch\(|https?:\/\/|import .* from 'node:(http|https|net)'/);
  });

  it('the service asks the link only when it is on, never when a photo comes in, and the score is the staff count', () => {
    const intake = SERVICE.slice(SERVICE.indexOf("path: '/v1/merchandising/shelf-photos/:photoId'"), SERVICE.indexOf("path: '/v1/merchandising/shelf-photos',"));
    expect(intake).not.toMatch(/recognise|recognition/);
    expect([...SERVICE.matchAll(/deps\.recognition\.recognise\(/g)]).toHaveLength(1);
    expect(SERVICE).toMatch(/if \(!off && latestPhoto !== undefined\) \{\s*suggestion = await deps\.recognition\.recognise\(/);
    expect(SERVICE).toMatch(/measuredBy: 'counted by staff'/);
    expect(SERVICE).toMatch(/changesTheScore: false/);
    expect(SERVICE).not.toMatch(/fetch\(|https?:\/\//);
  });
});
