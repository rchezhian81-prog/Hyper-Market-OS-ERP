import { describe, it, expect } from 'vitest';
import { buildRouter, type Method } from '../../services/kernel/src/index';
import { buildSurface } from '../../services/api/src/main';
import { ROLE_CATALOGUE, STORE_COMPUTER_ROLE_ID } from '../../services/api/src/roles';
import { EVENT_ROUTES } from '../../edge/sync-agent/src/http-transport';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every TypeScript source of the box and the screens/phones it relays for — what can actually PRODUCE an event. */
const sourcesUnder = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'web' ? [] : sourcesUnder(p);
  return p.endsWith('.ts') && !p.endsWith('http-transport.ts') ? [p] : [];
});
const PRODUCERS = [...sourcesUnder('edge'), ...readdirSync('apps').flatMap((a) => { try { return sourcesUnder(join('apps', a, 'src')); } catch { return []; } })]
  .map((p) => readFileSync(p, 'utf8')).join('\n');
/** An event type nothing in the box or its screens ever produces is a route the box never calls (least privilege). */
const produced = (type: string): boolean => PRODUCERS.includes(`'${type}'`);

/**
 * **The store computer has its own role, and it covers exactly what the box sends (OB-36 "A", 10 Oct 2026 · P-04 ·
 * hard rule #4).** The box used to sign in as a CASHIER: a person's role, which carried till permissions the machine
 * never uses and lacked `till.dayclose.sync`, so a relayed day close dead-lettered with 403. Now the box holds the
 * dedicated `store_computer` role. This test reads every head-office route the box calls — every event route the
 * sync agent relays and every feed it pulls — from the real surface, and holds the role to that list in both
 * directions: each route's permission is in the role (nothing dead-letters on a 403), and the role holds nothing the
 * box never calls (least privilege).
 */

/** What the function-valued routes need to name each of their paths (ids are placeholders, never data). */
const SAMPLES: readonly Record<string, unknown>[] = [
  { originalSaleId: 's1' }, { noReceipt: true, originalSaleId: null },
  { id: 'x1', action: 'poll', documentType: 'e_invoice' }, { id: 'x1', action: 'verify', documentType: 'e_way_bill' },
];

/** The feeds the box pulls under its own credential (edge/sync-agent/src/*-feed.ts, pack-source.ts, store-pack-feed.ts). */
const PULLS: readonly [Method, string][] = [
  ['GET', '/v1/catalogue/pack'],
  ['GET', '/v1/floor/indents'],
  ['GET', '/v1/fulfilment/assignments'],
  ['GET', '/v1/loyalty/wallets'],
  ['GET', '/v1/migration/screen'],
  ['GET', '/v1/org/document-templates/published'],
  ['GET', '/v1/store-packs/S1'],
  ['POST', '/v1/store-packs/S1/held'],
  // Round 6: the box reports how far each queue has synced (edge/sync-agent/src/sync-watermark-report.ts).
  ['POST', '/v1/stores/S1/sync-watermarks'],
];

describe('the store computer role (OB-36 "A")', () => {
  const built = buildRouter(buildSurface({ signingKey: 'k'.repeat(48), migrationTargetKind: 'rehearsal' }));
  const router = built.router!;
  const role = ROLE_CATALOGUE.find((r) => r.id === STORE_COMPUTER_ROLE_ID)!;

  const needed = (): Map<string, string> => {
    const out = new Map<string, string>(); // permission → the first route that needs it
    const paths: [Method, string][] = [...PULLS];
    for (const [type, route] of Object.entries(EVENT_ROUTES)) {
      if (!produced(type)) continue;
      const named = typeof route === 'string' ? [route] : SAMPLES.map((p) => route(p)).filter((p): p is string => p !== undefined);
      for (const path of new Set(named)) paths.push(['POST', path.replace(/:[a-zA-Z]+/g, 'x1')]);
    }
    for (const [method, path] of paths) {
      const matched = router.match(method, path);
      expect(matched, `${method} ${path} is a route head office serves`).toBeDefined();
      if (!out.has(matched!.route.permission)) out.set(matched!.route.permission, `${method} ${path}`);
    }
    return out;
  };

  it('exists, separate from every person\'s role', () => {
    expect(role).toBeDefined();
    expect(role.permissions).toContain('till.dayclose.sync'); // the 403 Batch 3 found
  });

  it('holds the permission of every route the box calls — nothing it sends dead-letters on a 403', () => {
    const missing = [...needed()].filter(([p]) => !role.permissions.includes(p)).map(([p, r]) => `${p} (${r})`);
    expect(missing).toEqual([]);
  });

  it('holds nothing the box never calls (least privilege)', () => {
    const used = new Set(needed().keys());
    expect(role.permissions.filter((p) => !used.has(p))).toEqual([]);
  });
});
