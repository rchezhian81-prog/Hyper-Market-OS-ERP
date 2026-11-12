// The store PC's "Import from the old system" page (OB-704): started by `pnpm run store-computer -- import`, which hands it
// this copy's settings and the till's. It listens on this PC only (127.0.0.1), opens the page in the browser, and runs until
// its window is closed. The rules are in scripts/lib/import-app.ts and the tested packages it calls.

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { heldFetch } from './lib/held-fetch.mjs';
import { buildPersonToken, demoTenantIds, parseEnvText, parseFlags, tokenPolicyFromEnv } from './lib/operator-env';
import { pinVerifier } from './lib/owner-setup-pins';
import { createImportApp } from './lib/import-app';
import type { SetupClient } from '../packages/migration/src/owner-steps-command';

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };
const readIfThere = (file: string | undefined): string | undefined => {
  if (file === undefined || !existsSync(file)) return undefined;
  try { return readFileSync(file, 'utf8'); } catch { return undefined; }
};

const flags = parseFlags(process.argv.slice(2).filter((a) => a !== '--'));
const settingsText = readIfThere(typeof flags['settings'] === 'string' ? resolve(flags['settings']) : undefined);
if (settingsText === undefined) { out('REFUSED — this copy\'s settings file could not be read. Start it with: pnpm run store-computer -- import'); process.exit(2); }
const settings = parseEnvText(settingsText);
const tillEnvText = readIfThere(typeof flags['till-settings'] === 'string' ? resolve(flags['till-settings']) : undefined);
const tillEnv = tillEnvText === undefined ? undefined : parseEnvText(tillEnvText);
const dataRoot = typeof flags['data'] === 'string' ? resolve(flags['data']) : undefined;
if (dataRoot === undefined) { out('REFUSED — the shop\'s data folder is not known. Start it with: pnpm run store-computer -- import'); process.exit(2); }
const storeId = (tillEnv?.['EDGE_STORE_ID'] ?? '').trim();
if (storeId === '') { out('REFUSED — the till is not connected to a store yet (owner guide Part 20). Do that first.'); process.exit(2); }
const tenantId = (settings['EDGE_TENANT_ID'] ?? '').trim();
const idp = tokenPolicyFromEnv(settings);
if (idp.policy === undefined || tenantId === '') { out(`REFUSED — this copy's settings are missing ${[...idp.missing, ...(tenantId === '' ? ['EDGE_TENANT_ID'] : [])].join(', ')}.`); process.exit(2); }
const policy = idp.policy;
const base = `http://127.0.0.1:${settings['API_PORT'] || '8081'}`;

const client: SetupClient = {
  request: async ({ method, path, userId, tenantId: t, body, idempotencyKey, signedInAt }) => {
    // Minted per call, for THIS person, only after their own PIN matched; five minutes; it never leaves this process.
    const token = buildPersonToken({ sub: userId, tenantId: t, ttlSeconds: 300, authTimeSec: Math.floor(Date.parse(signedInAt) / 1000) }, policy, Date.now());
    try {
      const res = await heldFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, 120_000);
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = text === '' ? undefined : JSON.parse(text); } catch { /* keep the text */ }
      return { status: res.status, body: parsed };
    } catch {
      return { status: 503, body: { error: { whatHappened: 'This copy of head office did not answer on this computer.', nextSafeAction: 'Run: pnpm run store-computer -- up, then try again.' } } };
    }
  },
};

const port = Number(flags['port'] ?? 8095);
const app = createImportApp({
  client, verifyPin: pinVerifier({ tillEnv, settings, readFile: readIfThere }), tenantId, storeId,
  targetKind: settings['MIGRATION_TARGET_KIND'], demoTenantIds: demoTenantIds(settings, flags['demo-tenant']),
  dataDir: join(dataRoot, 'imports'), pageHtml: readFileSync(resolve('scripts', 'import-page', 'index.html'), 'utf8'), now: () => new Date(),
});
const server = createServer((req, res) => { void app(req, res); });
server.on('error', (e) => { out(`NOT STARTED — ${e.message}. Is the import page already open in another window? Close it, then try again.`); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  out(`IMPORT PAGE OPEN — ${url} (this computer only). Keep this window open while you work; close it when you are done.`);
  if (flags['no-browser'] !== true && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
