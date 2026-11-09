#!/usr/bin/env node
// CR-01 step 2b (OI-02) — drive the first-run screens on a clean Windows machine, through the same door the browser uses.
// Run by the `store-pc-first-run` job in .github/workflows/ci.yml from the built release folder:
//
//   <release>\runtime\node\node.exe tests\windows\first-run-screens.drive.mjs <release folder> <data drive, e.g. D:>
//
// It starts the screens' server (no browser), reads the one-time key it prints, checks a wrong answer is refused, sends
// the right answers (synthetic people and a made-up GSTIN with a correct check character), follows the progress to the
// end, and passes only on SETUP DONE with the shop prepared by the owner and approved by the accountant (OB-659).
// The synthetic PINs are this test's own; nothing here is a real shop's.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [release, drive] = process.argv.slice(2);
const node = process.execPath;
const port = 8099;
const say = (l) => { process.stdout.write(`${l}\n`); };

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gstinFor = (first14) => {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) { const p = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  return first14 + GSTIN_CHARS[(36 - (sum % 36)) % 36];
};

const server = spawn(node, [join(release, 'scripts', 'dist', 'setup-server.js'), '--port', String(port), '--no-browser'], { cwd: release, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (c) => { process.stderr.write(c); });
const key = await new Promise((resolve, reject) => {
  let seen = '';
  server.stdout.on('data', (c) => { seen += c.toString(); const m = /#key=([A-Za-z0-9_-]+)/.exec(seen); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error(`the screens' server did not start: ${seen}`)), 60_000);
});
say('The screens\' server is up on this PC only.');
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
say('PASS — the first-run screens set this PC up: settings, till, services, the two people, their own PINs, and the shop, prepared by the owner and approved by the accountant.');
server.kill();
process.exit(0);
