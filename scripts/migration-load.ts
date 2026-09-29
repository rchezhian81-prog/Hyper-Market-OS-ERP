// The operator's load — MG-05, the ACTUAL load of the store's checked, sealed, cleaned extract into a
// named, empty, non-demo tenant, through the same routes a person uses on the screens.
//
//   pnpm run migration:load -- --dir <folder> [--api http://127.0.0.1:8081] [--dry-run] [--out report.json]
//                              [--env-file infra/compose/.env] [--demo-tenant <uuid>[,<uuid>]]
//
// The folder holds up to six CSV files (products.csv is required), `manifest.json` (who / where / the seal
// of every file, from the seal route) and `exceptions.json` (the cleaning report with every blocking
// exception decided in writing). Everything that can refuse lives in `packages/migration/src/load-command.ts`
// and is tested there; this file only reads the folder, mints the operator's token from the box's `.env`,
// speaks HTTP, prints, and exits: 0 done, 1 refused / not everything landed, 2 could not read.
//
// Run by a NAMED HUMAN (hard rule #5 — the AI prepares and checks; a person loads). Never against a
// production box (hard rule #7 — MIGRATION_TARGET_KIND is read and obeyed), never into the demo tenant (G4).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoadCommand, EXTRACT_FILES, type ExtractFileName, type CommandClient } from '../packages/migration/src/load-command';
import { parseEnvText, parseFlags, tokenPolicyFromEnv, buildOperatorToken, demoTenantIds } from './lib/operator-env';

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };

function usage(): never {
  out('Usage: pnpm run migration:load -- --dir <folder> [--api URL] [--dry-run] [--out report.json] [--env-file PATH] [--demo-tenant ID[,ID]]');
  out();
  out('  --dir         Folder with products.csv (+ categories/tax-rates/suppliers/customers/opening-stock .csv),');
  out('                manifest.json and exceptions.json.');
  out('  --api         The cloud API, e.g. http://127.0.0.1:8081. Default: http://127.0.0.1:<API_PORT or 8081>.');
  out('  --dry-run     Check everything and print the plan; send nothing.');
  out('  --out         Write the outcome (plan / report / lines) as JSON here — evidence for the sign-off.');
  out('  --env-file    The deployment .env (MIGRATION_TARGET_KIND, IDP_*, API_PORT, DEMO_TENANT_IDS). Default infra/compose/.env.');
  out('  --demo-tenant Extra tenant id(s) that must be refused as demo.');
  process.exit(2);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const dir = typeof flags['dir'] === 'string' ? resolve(flags['dir']) : undefined;
  if (dir === undefined || flags['help'] !== undefined) usage();
  const dryRun = flags['dry-run'] === true;

  const envFile = typeof flags['env-file'] === 'string' ? resolve(flags['env-file']) : join(process.cwd(), 'infra', 'compose', '.env');
  let env: Readonly<Record<string, string>> = {};
  if (existsSync(envFile)) env = parseEnvText(readFileSync(envFile, 'utf8'));
  else out(`Note: no env file at ${envFile} — MIGRATION_TARGET_KIND treated as unset (rehearsal), no identity-provider settings.`);

  const readJson = (name: string): { value?: unknown; missing?: true; error?: string } => {
    const path = join(dir, name);
    if (!existsSync(path)) return { missing: true };
    try { return { value: JSON.parse(readFileSync(path, 'utf8')) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  };
  const manifest = readJson('manifest.json');
  if (manifest.missing) { out(`Could not read ${join(dir, 'manifest.json')}: the folder has no manifest. The person who sealed the files writes it (see docs/runbooks/real-data-load.md).`); process.exit(2); }
  if (manifest.error !== undefined) { out(`Could not read manifest.json: ${manifest.error}`); process.exit(2); }
  const exceptions = readJson('exceptions.json');
  if (exceptions.error !== undefined) { out(`Could not read exceptions.json: ${exceptions.error}`); process.exit(2); }

  const files: Partial<Record<ExtractFileName, string>> = {};
  for (const name of EXTRACT_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) files[name] = readFileSync(path, 'utf8');
  }

  let client: CommandClient | undefined;
  const apiFlag = typeof flags['api'] === 'string' ? flags['api'] : undefined;
  const api = apiFlag ?? (dryRun ? undefined : `http://127.0.0.1:${env['API_PORT'] ?? '8081'}`);
  if (api !== undefined) {
    const idp = tokenPolicyFromEnv(env);
    if (idp.policy === undefined) {
      out(`Cannot talk to the API without the identity-provider settings in the env file: ${idp.missing.join(', ')} missing.`);
      process.exit(2);
    }
    const policy = idp.policy;
    const base = api.replace(/\/$/, '');
    client = {
      request: async ({ method, path, userId, tenantId, body, idempotencyKey }) => {
        // Minted per call, short-lived, for THIS operator in THIS tenant; it never leaves this process.
        const token = buildOperatorToken({ sub: userId, tenantId, ttlSeconds: 600 }, policy, Date.now());
        let res: Response;
        try {
          res = await fetch(`${base}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch (e) {
          out(`Could not reach ${base}: ${e instanceof Error ? e.message : String(e)}`);
          process.exit(2);
        }
        const text = await res.text();
        let parsed: unknown = text;
        try { parsed = text === '' ? undefined : JSON.parse(text); } catch { /* keep the text */ }
        return { status: res.status, body: parsed };
      },
    };
  }

  const outcome = await runLoadCommand({
    manifest: manifest.value, files, exceptions: exceptions.missing ? undefined : exceptions.value,
    targetKind: env['MIGRATION_TARGET_KIND'], demoTenantIds: demoTenantIds(env, flags['demo-tenant']), dryRun,
    ...(client === undefined ? {} : { client }),
  });
  for (const line of outcome.lines) out(line);
  if (typeof flags['out'] === 'string') {
    writeFileSync(resolve(flags['out']), `${JSON.stringify({ at: new Date().toISOString(), dryRun, ...outcome }, null, 2)}\n`, 'utf8');
    out(`Outcome written to ${resolve(flags['out'])}`);
  }
  process.exit(outcome.exitCode);
}

await main();
