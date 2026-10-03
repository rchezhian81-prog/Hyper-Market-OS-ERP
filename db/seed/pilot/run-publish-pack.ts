// Operator entry point: publish the demo branch's signed price list to the demo store box's tills
// (ADR-0016). A PERSON runs it and names themselves (hard rule #5 — it releases prices to the lanes);
// bundled and run by scripts/demo-publish-pack.mjs. Refuses anything but the synthetic demo tenant or a
// production-marked environment, and an anonymous operator. Never prints a secret.

import { readFileSync } from 'node:fs';
import { InMemoryEventStore } from '../../../packages/persistence/src/event-store';
import { hostedSeedClient, hostedSeedRefusals, publishPilotPack } from './hosted';
import { PILOT_DEMO_BRANCH, PILOT_DEMO_TENANT, PILOT_FOUNDATION } from './dataset';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

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
    console.error('Usage: pnpm run demo:publish-pack -- --operator "<your name>"');
    return 2;
  }
  const client = hostedSeedClient({
    baseUrl: arg('api') ?? `http://127.0.0.1:${env['API_PORT'] ?? '8081'}`,
    idp: { secret: env['IDP_SIGNING_KEY']!, issuer: env['IDP_ISSUER']!, audience: env['IDP_AUDIENCE']! },
    // Published through the API only; no identity hook is used, so no database handle is needed.
    store: new InMemoryEventStore(),
    operator, tenantId: PILOT_DEMO_TENANT,
  });
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  console.log(`Publishing the demo price list for ${PILOT_DEMO_BRANCH} (synthetic tenant pilot-demo) — operator: ${operator}`);
  const res = await publishPilotPack(client, PILOT_FOUNDATION.genesisOwner.userId, PILOT_DEMO_BRANCH, day);
  const body = res.body as { error?: { code?: string; whatHappened?: string } } | undefined;
  if (res.status === 200 || res.status === 201) {
    console.log(`GREEN — price list published (HTTP ${res.status}). The demo store box picks it up within a minute or two.`);
    return 0;
  }
  console.log(`RED — not published (HTTP ${res.status}): ${body?.error?.code ?? ''} ${body?.error?.whatHappened ?? ''}`);
  return 1;
}

process.exitCode = await main();
