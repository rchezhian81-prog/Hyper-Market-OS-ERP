// The department-slice load — OB-241 (D3 option B): ONE pilot department's products, barcodes, tax classes and prices,
// from the four published CSV templates, with per-row exceptions (MG-05 · §34.1) and a named acceptance before anything
// is applied. Run on the STORE COMPUTER's own real-data stack (OB-240), never the hosted demo.
//
//   pnpm run migration:slice -- --templates <folder>                           write the four header-only templates
//   pnpm run migration:slice -- --dir <folder> --stage   [--api URL] [--out F]  stage: read, judge every row, record the load
//   pnpm run migration:slice -- --dir <folder> --accept --as <login> --statement "…"   a named person accepts the list
//   pnpm run migration:slice -- --dir <folder> --apply   [--api URL] [--out F]  load the STAGED rows, once accepted
//   [--settings infra/compose/.env] [--demo-tenant <uuid>[,<uuid>]]
//
// The folder holds slice.json (the load id, tenant, department, the operator's login, the seal of every file) and the
// CSV files. Each file is read from disk — up to MAX_FILE_BYTES each, far above the 1 MB a screen paste could carry —
// and judged row by row in `packages/migration/src/slice-command.ts`, where every refusal lives and is tested. This shell
// reads, mints the signed-in person's short-lived token from the box's `.env`, speaks HTTP, prints and exits:
// 0 done · 1 refused / not everything landed · 2 could not read what it was given.
//
// Never against a production box (MIGRATION_TARGET_KIND is read and obeyed, hard rule #7), never into the demo tenant (G4).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { CommandClient } from '../packages/migration/src/load-command';
import { runSliceCommand, type SliceMode } from '../packages/migration/src/slice-command';
import { SLICE_FILES, sliceTemplateCsv, type SliceFile } from '../packages/migration/src/slice-import';
import { parseEnvText, parseFlags, tokenPolicyFromEnv, buildOperatorToken, demoTenantIds } from './lib/operator-env';

/** The most one slice file may hold. A department's master data is a few megabytes at most; this leaves room for 10×. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };

function usage(): never {
  out('Usage: pnpm run migration:slice -- --templates <folder>');
  out('       pnpm run migration:slice -- --dir <folder> (--stage | --accept --as <login> --statement "…" | --apply) [--api URL] [--out FILE] [--settings PATH] [--demo-tenant ID[,ID]]');
  process.exit(2);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags['help'] !== undefined) usage();

  if (typeof flags['templates'] === 'string') {
    const dir = resolve(flags['templates']);
    mkdirSync(dir, { recursive: true });
    for (const f of SLICE_FILES) {
      const path = join(dir, f);
      if (existsSync(path)) { out(`kept ${path} (already there — never overwritten)`); continue; }
      writeFileSync(path, sliceTemplateCsv(f), 'utf8');
      out(`wrote ${path}`);
    }
    process.exit(0);
  }

  const dir = typeof flags['dir'] === 'string' ? resolve(flags['dir']) : undefined;
  const mode: SliceMode | undefined = flags['stage'] === true ? 'stage' : flags['accept'] === true ? 'accept' : flags['apply'] === true ? 'apply' : undefined;
  if (dir === undefined || mode === undefined) usage();

  const envFile = typeof flags['settings'] === 'string' ? resolve(flags['settings']) : join(process.cwd(), 'infra', 'compose', '.env');
  let env: Readonly<Record<string, string>> = {};
  if (existsSync(envFile)) env = parseEnvText(readFileSync(envFile, 'utf8'));
  else out(`Note: no env file at ${envFile} — MIGRATION_TARGET_KIND treated as unset (rehearsal), no identity-provider settings.`);

  const manifestPath = join(dir, 'slice.json');
  if (!existsSync(manifestPath)) { out(`Could not read ${manifestPath}: the folder has no slice.json (see docs/runbooks/real-data-load.md, "One department first").`); process.exit(2); }
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { out(`Could not read slice.json: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }

  const files: Partial<Record<SliceFile, string>> = {};
  for (const f of SLICE_FILES) {
    const path = join(dir, f);
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    if (size > MAX_FILE_BYTES) { out(`REFUSED — ${f} is ${size} bytes, over the ${MAX_FILE_BYTES}-byte limit for one slice file. A department's master data is far smaller: check it is the right export.`); process.exit(1); }
    files[f] = readFileSync(path, 'utf8');
  }

  let client: CommandClient | undefined;
  const apiFlag = typeof flags['api'] === 'string' ? flags['api'] : undefined;
  const api = apiFlag ?? (mode === 'stage' && flags['offline'] === true ? undefined : `http://127.0.0.1:${env['API_PORT'] ?? '8081'}`);
  if (api !== undefined) {
    const idp = tokenPolicyFromEnv(env);
    if (idp.policy === undefined) { out(`Cannot talk to the API without the identity-provider settings in the env file: ${idp.missing.join(', ')} missing.`); process.exit(2); }
    const policy = idp.policy;
    const base = api.replace(/\/$/, '');
    client = {
      request: async ({ method, path, userId, tenantId, body, idempotencyKey, query }) => {
        // Minted per call, short-lived, for THIS person in THIS tenant; it never leaves this process.
        const token = buildOperatorToken({ sub: userId, tenantId, ttlSeconds: 600 }, policy, Date.now());
        const qs = query === undefined || Object.keys(query).length === 0 ? '' : `?${new URLSearchParams(query).toString()}`;
        let res: Response;
        try {
          res = await fetch(`${base}${path}${qs}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch (e) { out(`Could not reach ${base}: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
        const text = await res.text();
        let parsed: unknown = text;
        try { parsed = text === '' ? undefined : JSON.parse(text); } catch { /* keep the text */ }
        return { status: res.status, body: parsed };
      },
    };
  }

  const outcome = await runSliceCommand({
    mode, manifest, files, targetKind: env['MIGRATION_TARGET_KIND'], demoTenantIds: demoTenantIds(env, flags['demo-tenant']),
    ...(typeof flags['as'] === 'string' ? { acceptAs: flags['as'] } : {}),
    ...(typeof flags['statement'] === 'string' ? { statement: flags['statement'] } : {}),
    ...(client === undefined ? {} : { client }),
    hasher: (material: string) => createHash('sha256').update(material, 'utf8').digest('hex'),
  });
  for (const line of outcome.lines) out(line);
  if (outcome.exceptionsCsv !== undefined) {
    const listPath = join(dir, 'slice-exceptions.csv');
    writeFileSync(listPath, outcome.exceptionsCsv, 'utf8');
    out(`Exception list written to ${listPath} — the file the acceptor reads.`);
  }
  if (typeof flags['out'] === 'string') {
    writeFileSync(resolve(flags['out']), `${JSON.stringify({ at: new Date().toISOString(), mode, exitCode: outcome.exitCode, stage: outcome.stage, lines: outcome.lines, report: outcome.report }, null, 2)}\n`, 'utf8');
    out(`Outcome written to ${resolve(flags['out'])}`);
  }
  process.exit(outcome.exitCode);
}

await main();
