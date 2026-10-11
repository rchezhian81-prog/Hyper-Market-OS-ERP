import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The database's '*' platform scope reads every shop's rows. It is for operator tools a named person runs
// (scripts/, the tenant bootstrap), never for the running API, the store box or an app: head office never looks across
// shops (OB-21). Found in round-4 integration: two background workers discovered shops through it; they now serve only
// the shops the operator names (WORKER_TENANT_IDS).
const ROOTS = ['services', 'apps', 'edge'];
const ALL_SHOPS = /scopedTo\([^)]*['"]\*['"]\s*\)/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe('the running system never reads across shops (OB-21)', () => {
  it('no service, app or store-box source opens the all-shops platform scope', () => {
    const offenders = ROOTS.flatMap(sources).filter((f) => ALL_SHOPS.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
