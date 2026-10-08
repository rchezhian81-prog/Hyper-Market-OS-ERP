// Make a NEW shop's own realm file, for the administrator to load at the identity server (OB-15-d · OB-19 "A").
//
//   pnpm run realm:for-shop -- --realm sre-<shop> --tenant <uuid> --name "<Shop name>" --origin https://<shop address>
//                              [--out <file>] [--audience sre-retail-os-api]
//
// Head office never creates a realm itself (owner decision OB-19). This writes the file — the repository's realm with
// the shop's own name, id and address written in, no person and no secret — and says the exact steps to load it. It
// changes nothing anywhere: no database, no identity server.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { shopRealmFile } from '../services/identity/src/shop-realm-file';
import { parseFlags } from './lib/operator-env';

const out = (s = ''): void => { process.stdout.write(`${s}\n`); };
const flags = parseFlags(process.argv.slice(2));
const str = (k: string): string => (typeof flags[k] === 'string' ? flags[k] as string : '');

if (str('realm') === '' || str('tenant') === '' || str('name') === '' || str('origin') === '') {
  out('Usage: pnpm run realm:for-shop -- --realm sre-<shop> --tenant <uuid> --name "<Shop name>" --origin https://<shop address> [--out <file>]');
  process.exit(2);
}

const templatePath = resolve(process.cwd(), 'infra/keycloak/realm-sre-store.json');
const template = JSON.parse(readFileSync(templatePath, 'utf8')) as Record<string, unknown>;
const made = shopRealmFile(template, {
  realm: str('realm'), tenantId: str('tenant'), displayName: str('name'), webOrigin: str('origin'),
  audience: str('audience') || 'sre-retail-os-api', allowHttp: flags['allow-http'] === true,
});
if (!made.ok) {
  out('Not made:');
  for (const p of made.problems) out(`  • ${p}`);
  process.exit(1);
}
const file = resolve(process.cwd(), str('out') || `realm-${str('realm')}.json`);
if (existsSync(file)) {
  out(`Not made: ${file} already exists. Move it away or name another --out.`);
  process.exit(1);
}
writeFileSync(file, `${JSON.stringify(made.realm, null, 2)}\n`, { mode: 0o600 });
out(`Written: ${file}`);
out();
out('Load it at the identity server (runbook: identity server → "A new shop"):');
out('  1. /auth/admin → the realm list (top left) → Create realm → Browse → choose this file → Create.');
out(`  2. Realm ${str('realm')} → Clients → sre-provisioner → Credentials: that is the shop's provisioner secret.`);
out(`  3. Head office: add  ${str('realm')}=${str('tenant')}  to IDP_OIDC_SHOP_REALMS and release.`);
out('Nothing else was changed.');
