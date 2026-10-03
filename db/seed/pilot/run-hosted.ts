// Operator entry point for seeding the HOSTED demo box (runbook §8). Bundled and run by
// `scripts/seed-pilot-hosted.mjs`; a PERSON runs it (the role grants it provisions are a privilege
// change — hard rule #5 keeps that a human act), and names themselves with --operator.
//
// Reads the pilot settings file on the box, refuses anything but the synthetic demo tenant or a
// production-marked environment, then drives the four appliers against the live API. Prints a
// step-by-step report; exits non-zero if any step did not land (P-08 — no silent partial seed).
// Never prints a secret.

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { SqlEventStore } from '../../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../../packages/persistence/src/pg-client';
import { hostedSeedClient, hostedSeedRefusals } from './hosted';
import {
  applyPilotFoundation, applyPilotCatalogue, applyPilotTradingPartners, applyPilotTransactions, type SeedReport,
} from './apply';
import {
  PILOT_FOUNDATION, PILOT_CATALOGUE, PILOT_TRADING_PARTNERS, PILOT_TRANSACTIONS, PILOT_DEMO_TENANT,
} from './dataset';

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq !== -1) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<number> {
  const envFile = arg('env-file') ?? 'infra/compose/.env.pilot';
  const operator = arg('operator') ?? '';
  const env = parseEnv(readFileSync(envFile, 'utf8'));

  const refusals = hostedSeedRefusals({
    tenantId: env['EDGE_TENANT_ID'] ?? '',
    operator,
    ...(env['MIGRATION_TARGET_KIND'] === undefined ? {} : { migrationTargetKind: env['MIGRATION_TARGET_KIND'] }),
  });
  if (refusals.length > 0) {
    for (const r of refusals) console.error(`REFUSED — ${r}`);
    console.error('Usage: pnpm run seed:pilot -- --operator "<your name>"');
    return 2;
  }

  // The compose DATABASE_URL names the in-network host `db`; from the box we reach the same database
  // on its localhost-published port. Built from parts so the password never appears in output.
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: Number(env['POSTGRES_PORT'] ?? '5432'),
    user: env['POSTGRES_USER'],
    password: env['POSTGRES_PASSWORD'],
    database: env['POSTGRES_DB'],
    max: 2,
  });
  const baseUrl = arg('api') ?? `http://127.0.0.1:${env['API_PORT'] ?? '8081'}`;

  try {
    const client = hostedSeedClient({
      baseUrl,
      idp: { secret: env['IDP_SIGNING_KEY']!, issuer: env['IDP_ISSUER']!, audience: env['IDP_AUDIENCE']! },
      store: new SqlEventStore(pgPoolClient(pool)),
      operator,
      tenantId: PILOT_DEMO_TENANT,
    });
    const owner = PILOT_FOUNDATION.genesisOwner.userId;
    console.log(`Seeding synthetic demo tenant "${PILOT_DEMO_TENANT}" via ${baseUrl} — operator: ${operator}`);

    const reports: Array<[string, SeedReport]> = [];
    reports.push(['Foundation (owner, role logins, features, org)', await applyPilotFoundation(client, PILOT_FOUNDATION)]);
    reports.push(['Catalogue (tax rates, products, barcodes, prices)', await applyPilotCatalogue(client, PILOT_CATALOGUE, owner)]);
    reports.push(['Trading partners (suppliers, customers)', await applyPilotTradingPartners(client, PILOT_TRADING_PARTNERS, owner)]);
    reports.push(['Transactions (POs, receipts, orders)', await applyPilotTransactions(client, PILOT_TRANSACTIONS, owner)]);

    let allOk = true;
    for (const [label, report] of reports) {
      const bad = report.steps.filter((s) => !s.ok);
      allOk &&= bad.length === 0;
      console.log(`${bad.length === 0 ? '✓' : '✗'} ${label}: ${report.steps.length - bad.length}/${report.steps.length} steps landed`);
      for (const s of bad) console.log(`    ✗ ${s.what} — ${s.detail ?? `status ${s.status ?? '?'}`}`);
    }
    console.log(allOk ? 'GREEN — the demo dataset is in place.' : 'RED — some steps did not land (listed above). Re-running is safe.');
    return allOk ? 0 : 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
