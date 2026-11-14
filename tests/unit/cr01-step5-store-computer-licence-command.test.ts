import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { gstinOk, signLicence, type LicenceTerms } from '../../scripts/lib/licence.mjs';
import { licenceCommand } from '../../scripts/lib/store-computer-licence.mjs';
import { parseCommandLine, USAGE } from '../../scripts/lib/store-computer.mjs';

/**
 * **CR-01 step 5 · OI-10: `store-computer licence` at the store PC's keyboard.**
 *
 *   The same checks as the Licence screen: a licence the seller signed for THIS shop is loaded; a copy of another shop's is
 *   refused by name; `--request` writes the names-only request to send the seller; with no argument it says the standing
 *   in English and Tamil, and that the till sells whatever the licence says. Synthetic data only, on a pretend PC folder.
 */

const seller = generateKeyPairSync('ed25519');
const PRIV = seller.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUB = seller.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const TENANT = '0b6f1c2e-6a57-4f0a-9d3b-2f4a1e7c9d10';
const GSTIN = ((): string => { for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const g = `33ABCDE1234F1Z${c}`; if (gstinOk(g)) return g; } throw new Error('x'); })();
const terms = (over: Partial<LicenceTerms> = {}): LicenceTerms => ({ licenceId: 'LIC-20261114-00000001', kind: 'shop', tenantId: TENANT, shopName: 'Test Shop Two', gstin: GSTIN, tills: 2, stores: 1, modules: ['all'], issuedOn: '2026-11-14', expiresOn: '2027-11-13', ...over });

function pc(withKey = true) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'sre-release-'));
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'sre-data-'));
  writeFileSync(path.join(repoRoot, 'release.json'), JSON.stringify({ kind: 'sre-store-pc-release', version: '1.0.3000' }));
  if (withKey) writeFileSync(path.join(repoRoot, 'licence-signing.pub'), PUB);
  writeFileSync(path.join(dataRoot, '.env.real'), `EDGE_TENANT_ID=${TENANT}\n`);
  mkdirSync(path.join(dataRoot, 'till'), { recursive: true });
  const edgeData = path.join(dataRoot, 'till', 'edge-data');
  writeFileSync(path.join(dataRoot, 'till', 'till.env'), `EDGE_DATA_DIR=${edgeData}\n`);
  const said: string[] = [];
  const deps = { repoRoot, dataRoot, platform: 'linux', fs, env: {}, say: (l: string) => { said.push(l); }, now: () => new Date('2026-11-14T06:00:00Z') };
  return { deps, said, edgeData, repoRoot };
}

describe('store-computer licence', () => {
  it('is a command, in the usage, with --load and --request', () => {
    expect(USAGE.join('\n')).toMatch(/licence \[--load <licence file>\]/);
    expect(parseCommandLine(['licence', '--load', 'x.json'])).toMatchObject({ command: 'licence', load: 'x.json', problems: [] });
    expect(parseCommandLine(['licence', '--request', '--out', 'E:\\'])).toMatchObject({ command: 'licence', request: true, out: 'E:\\' });
  });

  it('with no licence: the setup period, in English and Tamil, the tenant id named, and the till still sells', async () => {
    const { deps, said } = pc();
    expect(await licenceCommand(deps as never, {})).toBe(0);
    const t = said.join('\n');
    expect(t).toMatch(/Licence: NO LICENCE — No licence is loaded yet/);
    expect(t).toMatch(/[\u0B80-\u0BFF]/);
    expect(t).toContain(TENANT);
    expect(t).toMatch(/till sells whatever the licence says/);
  });

  it('--load: the seller\'s licence for this shop is LOADED; a copy for another shop is REFUSED by name', async () => {
    const { deps, said, edgeData } = pc();
    const dir = mkdtempSync(path.join(tmpdir(), 'usb-'));
    writeFileSync(path.join(dir, 'mine.json'), signLicence(terms(), PRIV));
    writeFileSync(path.join(dir, 'copy.json'), signLicence(terms({ tenantId: '7d1e9a44-2c3b-4e5f-8a90-b1c2d3e4f5a6', shopName: 'Other Shop' }), PRIV));
    expect(await licenceCommand(deps as never, { load: path.join(dir, 'copy.json') })).toBe(2);
    expect(said.join('\n')).toMatch(/REFUSED — This licence is for ANOTHER shop \(a copy\)/);
    expect(await licenceCommand(deps as never, { load: path.join(dir, 'mine.json') })).toBe(0);
    expect(said.join('\n')).toMatch(/LICENCE LOADED — LIC-20261114-00000001/);
    said.length = 0;
    expect(await licenceCommand(deps as never, {})).toBe(0);
    expect(said.join('\n')).toMatch(/Licence: VALID — Licensed to Test Shop Two until 2027-11-13/);
    const history = readFileSync(path.join(edgeData, 'licence', 'licence-history.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(history.map((h) => h['outcome'])).toEqual(['refused:another_shop', 'loaded']);
    expect(history[1]).toMatchObject({ via: 'store_computer_tool', by: 'administrator at the store PC keyboard' });
  });

  it('--request: the names-only request to send the seller', async () => {
    const { deps, said } = pc();
    const out = mkdtempSync(path.join(tmpdir(), 'usb-'));
    expect(await licenceCommand(deps as never, { request: true, out })).toBe(0);
    const f = readdirSync(out)[0]!;
    expect(JSON.parse(readFileSync(path.join(out, f), 'utf8'))).toMatchObject({ kind: 'sre-retail-os-licence-request-v1', tenantId: TENANT, release: '1.0.3000' });
    expect(said.join('\n')).toMatch(/LICENCE REQUEST WRITTEN/);
  });

  it('a release with no seller key: licensing not in force, nothing limited', async () => {
    const { deps, said } = pc(false);
    expect(await licenceCommand(deps as never, {})).toBe(0);
    expect(said.join('\n')).toMatch(/NOT IN FORCE — Licensing is not switched on/);
  });
});
