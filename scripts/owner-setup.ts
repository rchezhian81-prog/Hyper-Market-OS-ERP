// The owner setup commands on the store PC (OB-257) — the shell. Run through `pnpm run store-computer -- <command>`,
// never by hand: store-computer refuses production and the demo first, builds this, and hands it this copy's settings
// file and the till's.
//
//   shop               the company, its legal name and GSTIN, and the store, active
//   store-settings     the store's settings (the day's end, the tolerances), a new version each time
//   bill-prefix        a till's bill-number prefix
//   grant              a role for a person (or the store-edge sign-in) at the store: one person asks, a second approves
//   publish-catalogue  the signed price list for the store
//
// Every rule and refusal is in packages/migration/src/owner-steps-command.ts (tested). This shell only asks the
// questions at the keyboard (a YES, then each person's own PIN — hidden), checks each PIN on this PC
// (scripts/lib/owner-setup-pins.ts), mints that person's short-lived token AFTER their PIN matched, and speaks HTTP to this
// copy's own API on loopback. Nothing it prints is a secret: never a PIN, never a token, never a key.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runOwnerSetup, type SetupClient } from '../packages/migration/src/owner-steps-command';
import { buildPersonToken, demoTenantIds, parseEnvText, parseFlags, tokenPolicyFromEnv } from './lib/operator-env';
import { pinVerifier } from './lib/owner-setup-pins';

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };

/** One answer at the keyboard. `hidden`: nothing typed is shown (a PIN). Undefined with no keyboard, or on Ctrl+C. */
function ask(prompt: string, hidden: boolean): Promise<string | undefined> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.resolve(undefined);
  return new Promise((done) => {
    process.stdout.write(prompt);
    let typed = '';
    const finish = (value: string | undefined): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      done(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') { finish(typed); return; }
        if (ch === '\u0003') { finish(undefined); return; }
        if (ch === '\u0008' || ch === '\u007f') { if (typed.length > 0) { typed = typed.slice(0, -1); if (!hidden) process.stdout.write('\b \b'); } continue; }
        if (ch >= ' ') { typed += ch; if (!hidden) process.stdout.write(ch); }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    input.on('data', onData);
  });
}

const readIfThere = (file: string | undefined): string | undefined => {
  if (file === undefined || !existsSync(file)) return undefined;
  try { return readFileSync(file, 'utf8'); } catch { return undefined; }
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const step = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : '';
  const flags = parseFlags(argv.slice(step === '' ? 0 : 1));
  const settingsFile = typeof flags['settings'] === 'string' ? resolve(flags['settings']) : undefined;
  const settingsText = readIfThere(settingsFile);
  if (settingsText === undefined) { out('REFUSED — this copy\'s settings file could not be read. Run this through: pnpm run store-computer -- <command>'); process.exit(2); }
  const settings = parseEnvText(settingsText);
  const tillEnvText = readIfThere(typeof flags['till-settings'] === 'string' ? resolve(flags['till-settings']) : undefined);
  const tillEnv = tillEnvText === undefined ? undefined : parseEnvText(tillEnvText);

  if (!process.stdin.isTTY) { out('REFUSED — this command asks questions (a YES, and each person\'s own PIN). Type it yourself in a PowerShell window.'); process.exit(2); }

  const idp = tokenPolicyFromEnv(settings);
  const base = `http://127.0.0.1:${settings['API_PORT'] || '8081'}`;
  const client: SetupClient | undefined = idp.policy === undefined ? undefined : {
    request: async ({ method, path, userId, tenantId, body, idempotencyKey, signedInAt }) => {
      // Minted per call, for THIS person, only after their own PIN matched; five minutes; it never leaves this process.
      const token = buildPersonToken({ sub: userId, tenantId, ttlSeconds: 300, authTimeSec: Math.floor(Date.parse(signedInAt) / 1000) }, idp.policy!, Date.now());
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
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        return { status: 503, body: { error: { code: 'not_reachable', whatHappened: 'this copy of the system did not answer on this computer. Run: pnpm run store-computer -- up' } } };
      }
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = text === '' ? undefined : JSON.parse(text); } catch { /* keep the text */ }
      return { status: res.status, body: parsed };
    },
  };

  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(flags)) if (typeof v === 'string' && k !== 'settings' && k !== 'till-settings') values[k] = v;
  const outcome = await runOwnerSetup({
    step, tenantId: settings['EDGE_TENANT_ID'] ?? '', targetKind: settings['MIGRATION_TARGET_KIND'], demoTenantIds: demoTenantIds(settings, flags['demo-tenant']),
    values, today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    now: () => new Date().toISOString(),
  }, {
    ...(client === undefined ? {} : { client }),
    confirm: async () => (await ask('Type YES and press Enter to do this (anything else stops it): ', false))?.trim().toUpperCase() === 'YES',
    askPin: (userId) => ask(`  ${userId}'s till PIN: `, true),
    verifyPin: pinVerifier({ tillEnv, settings, readFile: readIfThere }),
    say: out,
  });
  process.exit(outcome.exitCode);
}

await main();
