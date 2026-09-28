// Operator entry point: build the DEMO store pack for the demo store box (ADR-0016) from what the cloud has
// published, and write it where the demo edge reads it at boot. A PERSON runs it (it delivers the published
// prices to the demo lanes); bundled and run by scripts/demo-store-pack.mjs. Read-only against the API —
// it changes nothing in the cloud. Refuses anything but the synthetic demo tenant, a production-marked
// environment, or an anonymous operator. Never prints a secret.
//
//   pnpm run demo:store-pack -- --operator "<your name>"      (then restart the demo store box)

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import type { CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import { hostedSeedClient, hostedSeedRefusals } from './hosted';
import { buildDemoStorePack } from './store-pack';
import { PILOT_DEMO_TENANT, PILOT_FOUNDATION } from './dataset';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

/** Where the demo edge reads its store pack (mounted read-only into the edge by the pilot overlay). */
export const DEMO_STORE_PACK_FILE = '/etc/sre-pilot/store-pack/store-pack.json';

async function main(): Promise<number> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(arg('env-file') ?? 'infra/compose/.env.pilot', 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || !t.includes('=')) continue;
    env[t.slice(0, t.indexOf('='))] = t.slice(t.indexOf('=') + 1);
  }
  const operator = arg('operator') ?? '';
  const refusals = hostedSeedRefusals({
    tenantId: env['EDGE_TENANT_ID'] ?? '', operator,
    ...(env['MIGRATION_TARGET_KIND'] === undefined ? {} : { migrationTargetKind: env['MIGRATION_TARGET_KIND'] }),
  });
  if (refusals.length > 0) {
    for (const r of refusals) console.error(`REFUSED — ${r}`);
    console.error('Usage: pnpm run demo:store-pack -- --operator "<your name>"');
    return 2;
  }
  const client = hostedSeedClient({
    baseUrl: arg('api') ?? `http://127.0.0.1:${env['API_PORT'] ?? '8081'}`,
    idp: { secret: env['IDP_SIGNING_KEY']!, issuer: env['IDP_ISSUER']!, audience: env['IDP_AUDIENCE']! },
    store: new InMemoryEventStore(), // reads only; no identity hook is used
    operator, tenantId: PILOT_DEMO_TENANT,
  });
  const reader = PILOT_FOUNDATION.genesisOwner.userId;
  const get = (path: string) => client.request({ method: 'GET', path, userId: reader, tenantId: PILOT_DEMO_TENANT });

  const pack = await get('/v1/catalogue/pack');
  if (pack.status !== 200) {
    console.log(`RED — no published price list to build from (HTTP ${pack.status}). Run \`pnpm run demo:publish-pack\` first.`);
    return 1;
  }
  const master = await get('/v1/catalogue/products');
  const stock = await get('/v1/inventory/availability');
  if (master.status !== 200 || stock.status !== 200) {
    console.log(`RED — could not read the product master (HTTP ${master.status}) or stock (HTTP ${stock.status}). Nothing was written.`);
    return 1;
  }

  const storePack = buildDemoStorePack({
    snapshot: (pack.body as { snapshot: CatalogueSnapshot }).snapshot,
    master: (master.body as { products: [] }).products,
    availability: (stock.body as { rows: [] }).rows,
    builtBy: operator,
    builtAt: new Date().toISOString(),
  });
  if (storePack.products.length === 0) {
    console.log('RED — the published price list has no products, so the tills would have nothing to sell. Nothing was written.');
    return 1;
  }

  // Atomic replace in a directory the edge mounts read-only. The pack holds demo prices, no secret.
  mkdirSync(dirname(DEMO_STORE_PACK_FILE), { recursive: true, mode: 0o755 });
  const tmp = `${DEMO_STORE_PACK_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(storePack, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, DEMO_STORE_PACK_FILE);
  console.log(`GREEN — demo store pack v${storePack.version} written with ${storePack.products.length} products (from the published price list).`);
  for (const p of storePack.products) console.log(`   ${String(p['productId'])}  ${String(p['name'])}  ₹${(Number(p['unitPriceMinor']) / 100).toFixed(2)}  on hand ${String(p['availableMinor'])}`);
  console.log('Next: the demo store box reads its pack at start-up — ask Claude to restart it (or: docker restart sre-pilot-edge-1).');
  return 0;
}

process.exitCode = await main();
