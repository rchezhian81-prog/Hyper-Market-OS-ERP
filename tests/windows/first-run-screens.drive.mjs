#!/usr/bin/env node
// CR-01 step 2b (OI-02) — drive the first-run screens on a clean Windows machine, through the same door the browser uses.
// Run by the `store-pc-first-run` job in .github/workflows/ci.yml from the built release folder:
//
//   <release>\runtime\node\node.exe tests\windows\first-run-screens.drive.mjs <release folder> <data drive, e.g. D:> [<test seller key folder>]
//
// CR-01 step 5 (OI-10): with a test seller key folder (tests/windows/licence-test-key.mjs; the release built with its public
// half), the last page's licence step is driven too: no licence yet (the setup period), the request names this shop's
// tenant id and GSTIN, a COPY (another tenant id) and an EDITED licence are refused by name, the right one is loaded, and
// `store-computer licence` then says VALID.
//
// It starts the screens' server as SRE-Setup.exe does (--shortcut, --log: no browser of its own), reads the one-time key
// from the "Finish SRE setup" shortcut it writes (the owner's PC, 2026-11-09: the browser it opened itself never
// appeared), checks the key is never in the setup log, checks a wrong answer is refused, sends
// the right answers (synthetic people and a made-up GSTIN with a correct check character), follows the progress to the
// end, and passes only on SETUP DONE with the shop prepared by the owner and approved by the accountant (OB-659).
// The synthetic PINs are this test's own; nothing here is a real shop's.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { urlInShortcut } from '../../scripts/lib/setup-handoff.mjs';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import { issueCommand, KEY_FILE } from '../../scripts/lib/licence-desk.mjs';

const [release, drive, licenceKeyDir] = process.argv.slice(2);
const node = process.execPath;
const port = 8099;
const say = (l) => { process.stdout.write(`${l}\n`); };

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstinFor = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) { const p = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  return first14 + GSTIN_CHARS[(36 - (sum % 36)) % 36];
};

const shortcut = join(tmpdir(), 'Finish SRE setup.url');
const log = join(tmpdir(), 'sre-screens-test.log');
rmSync(shortcut, { force: true });
rmSync(log, { force: true });
const server = spawn(node, [join(release, 'scripts', 'dist', 'setup-server.js'), '--port', String(port), '--shortcut', shortcut, '--log', log], { cwd: release, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (c) => { process.stdout.write(c); });
server.stderr.on('data', (c) => { process.stderr.write(c); });
const key = await new Promise((resolve, reject) => {
  const t = setInterval(() => {
    const url = existsSync(shortcut) ? urlInShortcut(readFileSync(shortcut, 'utf8')) : undefined;
    const m = url === undefined ? null : /^http:\/\/127\.0\.0\.1:\d+\/setup\/#key=([A-Za-z0-9_-]+)$/.exec(url);
    if (m) { clearInterval(t); resolve(m[1]); }
  }, 250);
  setTimeout(() => { clearInterval(t); reject(new Error('the screens\' server wrote no "Finish SRE setup" shortcut in 60 seconds')); }, 60_000);
});
say('The screens\' server is up on this PC only; its address came from the "Finish SRE setup" shortcut.');
const call = async (method, what, body, k = key) => {
  const r = await fetch(`http://127.0.0.1:${port}/setup/api/${what}`, { method, headers: { 'x-setup-key': k, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
};
const fail = (why) => { say(`FAIL — ${why}`); server.kill(); process.exit(1); };

if ((await call('GET', 'state', undefined, 'wrong-key')).status !== 403) fail('a call without the right key was answered');
const st = await call('GET', 'state');
say(`This PC: set up ${st.body.setUp}; drives: ${st.body.drives.map((d) => `${d.letter}:${d.ok ? ' ok' : ` no (${d.why})`}`).join(', ')}`);
if (st.body.setUp) fail('the PC was expected to be new');
if (st.body.drives.find((d) => d.letter === 'C')?.ok !== false) fail('C: (the disk Windows is on) was offered (OB-716)');

const answers = {
  dataDrive: drive, shopName: 'Test Hyper Market', legalName: 'Test Hyper Market Private Limited', gstin: gstinFor('33ABCDE1234F1Z'), shopCode: 'TST',
  owner: { name: 'Test Owner', pin: '482915', pinAgain: '482915' }, accountant: { name: 'Test Accountant', pin: '730264', pinAgain: '730264' },
};
const wrong = await call('POST', 'install', { ...answers, gstin: `${answers.gstin.slice(0, 14)}${answers.gstin[14] === 'A' ? 'B' : 'A'}` });
if (wrong.status !== 400 || wrong.body.problems?.gstin === undefined) fail('a GSTIN with a wrong check character was not refused');
say(`A wrong GSTIN is refused: ${wrong.body.problems.gstin}`);

if ((await call('POST', 'install', answers)).status !== 202) fail('the install did not start');
let progress;
for (let i = 0; i < 240; i += 1) {
  progress = (await call('GET', 'progress')).body;
  if (progress.done) break;
  await new Promise((r) => setTimeout(r, 2500));
}
for (const l of progress.lines) say(`  | ${l}`);
const all = progress.lines.join('\n');
if (all.includes('482915') || all.includes('730264')) fail('a PIN appeared in what the screens said');
if (!progress.done || !progress.ok) fail('the setup did not finish');
if (!/DONE — the shop is set up .*store TST-MAIN active\. Done as owner-01, approved by accountant-01\./.test(all)) fail('the shop was not made active by the owner with the accountant\'s approval');
if ((await call('POST', 'install', answers)).status !== 409) fail('a second install on the same page was not refused');
// CR-01 step 2d (OI-04): the last screen's shortcuts, all three ticked → on this account's desktop.
const sc = await call('POST', 'shortcuts', { till: true, office: true, import: true });
for (const l of sc.body.lines ?? []) say(`  | ${l}`);
const desktop = join(process.env.USERPROFILE ?? '', 'Desktop');
for (const f of ['SRE Till.url', 'SRE Office.url', 'SRE Import & export.cmd']) if (!existsSync(join(desktop, f))) fail(`the shortcut "${f}" is not on the desktop`);
if (!readFileSync(join(desktop, 'SRE Till.url'), 'utf8').includes('URL=http://127.0.0.1:8091/pos/')) fail('the till shortcut does not open the till');
// OI-03: the About screen says this shop's tenant id.
const tenant = (await call('GET', 'state')).body.tenantId;
const about = await fetch('http://127.0.0.1:8091/about/').then((r) => r.text(), () => '');
if (tenant === undefined || !about.includes(`<code>${tenant}</code>`)) fail('the About screen does not show this shop\'s tenant id');
say(`The desktop has the three shortcuts; the About screen shows tenant id ${tenant}.`);
const logged = existsSync(log) ? readFileSync(log, 'utf8') : '';
if (!logged.includes('[screens] The setup screens are open on this PC only')) fail('the screens\' server kept nothing in the setup log');
if (logged.includes(key)) fail('the one-time key was written into the setup log');
say('The screens\' words are in the setup log, without the key.');

// CR-01 step 5 (OI-10): the licence on the last page — checked offline with the public key this test build carries.
if (licenceKeyDir !== undefined) {
  const lic = (await call('GET', 'licence')).body;
  say(`Licence before: ${lic.state} — ${lic.en}`);
  if (lic.state !== 'no_licence' || lic.keyBuiltIn !== true) fail('a new shop with a seller key in its release did not start in its setup period');
  if (lic.request?.tenantId !== tenant || lic.request?.gstin !== answers.gstin || lic.request?.shopName !== answers.shopName) fail('the licence request does not name this shop (tenant id, name, GSTIN)');
  const out = join(tmpdir(), `sre-licences-${Date.now()}`);
  const issue = async (over) => {
    const dir = join(out, String(Math.random()).slice(2));
    const code = await issueCommand({ fs: nodeFs, path: nodePath, env: process.env, platform: process.platform, now: () => new Date(), say, ask: async () => process.env.LICENCE_TEST_PASSPHRASE ?? '' },
      { key: join(licenceKeyDir, KEY_FILE), tenant, shop: answers.shopName, gstin: answers.gstin, tills: '2', stores: '1', modules: 'all', expires: '2099-12-31', out: dir, ...over });
    if (code !== 0) fail('the owner\'s tool did not issue the test licence');
    return readFileSync(join(dir, nodeFs.readdirSync(dir)[0]), 'utf8');
  };
  const copy = await call('POST', 'licence', { licence: await issue({ tenant: '7d1e9a44-2c3b-4e5f-8a90-b1c2d3e4f5a6' }) });
  if (copy.status !== 422 || copy.body.refusedBecause !== 'another_shop') fail(`a licence for another shop was not refused as a copy (${copy.status} ${copy.body.refusedBecause})`);
  say(`A copied licence is refused: ${copy.body.en}`);
  const right = await issue({});
  const edited = await call('POST', 'licence', { licence: right.replace('"tills": 2', '"tills": 20') });
  if (edited.status !== 422 || edited.body.refusedBecause !== 'not_signed_by_the_seller') fail('an edited licence was not refused');
  say(`An edited licence is refused: ${edited.body.en}`);
  const loaded = await call('POST', 'licence', { licence: right });
  if (loaded.status !== 200 || loaded.body.ok !== true) fail(`the right licence was not loaded (${loaded.body.en})`);
  say(loaded.body.en);
  const after = (await call('GET', 'licence')).body;
  if (after.state !== 'valid') fail(`after loading, the licence is ${after.state}, not valid`);
  const cli = spawnSync(node, [join(release, 'scripts', 'store-computer.mjs'), 'licence'], { cwd: release, env: process.env, encoding: 'utf8' });
  say(String(cli.stdout).trim());
  if (cli.status !== 0 || !/Licence: VALID/.test(String(cli.stdout))) fail('store-computer licence does not say VALID');
  say('The licence step: the setup period first, a copy and an edit refused by name, the right licence loaded and VALID.');
}
say('PASS — the first-run screens set this PC up: settings, till, services, the two people, their own PINs, and the shop, prepared by the owner and approved by the accountant.');
server.kill();
process.exit(0);
