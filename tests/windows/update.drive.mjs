#!/usr/bin/env node
// CR-01 step 3f — the store PC's UPDATE and its ROLLBACK DRILL, for real, on a clean Windows machine (GitHub's test
// machine). It drives the SHIPPED code of the installed release; only what a person or GitHub would do is stood in for:
//
//   update.drive.mjs sign <SRE-Setup.exe> <version> <commit> <test key.pem> <out>   update.json, signed with the job's
//                                                           throwaway test key by the published releases' own signing code
//   update.drive.mjs prepare <release> <backup folder>      the backup key (a synthetic test passphrase, as typed once at
//                                                           the keyboard) and the hourly backup's drive (schedule.json)
//   update.drive.mjs serve <port> <releases folder>         a stand-in for GitHub's release API on 127.0.0.1 only: each
//                                                           <tag>\ holds SRE-Setup.exe and update.json, as published
//   update.drive.mjs ask <release> <update.json>            the owner's press of Update on the page (update-request.json)
//   update.drive.mjs wait-update <state> <minutes>          wait for the updater's own word (status\update-progress.json)
//   update.drive.mjs drill <release> <backup folder>        `store-computer drill --run`, the passphrase typed
//   update.drive.mjs wait-drill <minutes>                   wait for `drill-result` to say PASSED or NOT PASSED
//
// Nothing here installs or rolls back anything itself: the updater and the drill do, as on the shop's PC.

import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [command, ...args] = process.argv.slice(2);
const say = (l) => { process.stdout.write(`${l}\n`); };
const fail = (why) => { say(`FAIL — ${why}`); process.exit(1); };
const PASSPHRASE = 'synthetic passphrase for a throw-away test machine only';
const REPO = 'rchezhian81-prog/Hyper-Market-OS-ERP';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function shipped(release) {
  const lib = await import(pathToFileURL(join(release, 'scripts', 'lib', 'store-computer.mjs')).href);
  const rec = await import(pathToFileURL(join(release, 'scripts', 'lib', 'store-computer-recovery.mjs')).href);
  const found = lib.resolveDataFolder(lib.defaultDeps());
  if (found.problem !== undefined) fail(found.problem);
  return { lib, rec, deps: { ...found.deps, askSecret: async () => PASSPHRASE, say } };
}
const dataRoot = () => JSON.parse(readFileSync('C:\\ProgramData\\SRE\\data-folder.json', 'utf8')).dataRoot;

if (command === 'sign') {
  const [setup, version, commit, keyFile, out] = args;
  const u = await import(pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'store-pc-update.mjs')).href);
  const fields = { version, commit, sha256: u.sha256Of(readFileSync(setup)) };
  writeFileSync(out, `${JSON.stringify(u.updateRecord({ ...fields, signature: u.signUpdate(fields, readFileSync(keyFile, 'utf8')) }), null, 2)}\n`);
  say(`SIGNED — ${version} (${fields.sha256.slice(0, 12)}…) with the throwaway test key.`);
} else if (command === 'prepare') {
  const [release, to] = args;
  const { lib, rec, deps } = await shipped(release);
  const L = lib.resolveLayout(deps);
  const key = await rec.ensureBackupKey(deps, L);
  if (key === undefined) fail('no backup key');
  writeFileSync(join(L.backupDir, 'schedule.json'), `${JSON.stringify({ to, everyMinutes: 60, setAt: new Date().toISOString(), setBy: 'ci', keyId: key.keyId }, null, 2)}\n`);
  say(`READY — backup key ${key.keyId}; the backup drive is ${to}.`);
} else if (command === 'serve') {
  const [port, dir] = args;
  const base = `http://127.0.0.1:${port}`;
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    const tag = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/([^/]+)$/.exec(url.pathname)?.[1];
    if (tag !== undefined && url.pathname.startsWith(`/repos/${REPO}/`) && existsSync(join(dir, tag))) {
      const assets = readdirSync(join(dir, tag)).map((name) => ({ name, url: `${base}/assets/${tag}/${name}` }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tag_name: tag, assets }));
      return;
    }
    const asset = /^\/assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (asset !== null && existsSync(join(dir, asset[1], asset[2]))) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(join(dir, asset[1], asset[2])));
      return;
    }
    res.writeHead(404).end();
  }).listen(Number(port), '127.0.0.1', () => say(`The stand-in for GitHub's releases answers on ${base}.`));
} else if (command === 'ask') {
  const [release, recordFile] = args;
  const { lib, rec, deps } = await shipped(release);
  const till = rec.tillFolders(deps, lib.resolveLayout(deps));
  const r = JSON.parse(readFileSync(recordFile, 'utf8'));
  const running = JSON.parse(readFileSync(join(release, 'release.json'), 'utf8')).version;
  const request = { kind: 'sre-store-pc-update-request-v1', requestedAt: new Date().toISOString(), requestedBy: 'owner-01', version: r.version, tag: `store-pc-v${r.version}`, commit: r.commit, sha256: r.sha256, from: running };
  writeFileSync(join(till.edgeData, 'update-request.json'), `${JSON.stringify(request, null, 2)}\n`);
  say(`ASKED — update from ${running} to ${r.version}, as the owner's press of Update leaves it.`);
} else if (command === 'wait-update') {
  const [want, minutes] = args;
  const file = join(dataRoot(), 'status', 'update-progress.json');
  const deadline = Date.now() + Number(minutes) * 60_000;
  let last = '';
  for (;;) {
    const p = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    const line = p === undefined ? '(no word yet)' : `${p.state}: ${p.said}`;
    if (line !== last) { say(`  ${new Date().toISOString()}  ${line}`); last = line; }
    if (p !== undefined && p.state !== 'working') {
      if (p.state !== want) fail(`the updater ended "${p.state}", not "${want}"`);
      say(`AS EXPECTED — ${p.state}.`);
      break;
    }
    if (Date.now() > deadline) fail(`no outcome within ${minutes} minutes`);
    await sleep(10_000);
  }
} else if (command === 'drill') {
  const [release, to] = args;
  const { lib, deps } = await shipped(release);
  const code = await lib.main(['drill', '--by', 'CI test machine', '--to', to, '--run'], deps);
  if (code !== 0) fail(`the drill's first half ended ${code}`);
} else if (command === 'wait-drill') {
  const [minutes] = args;
  const records = join(dataRoot(), 'records');
  const deadline = Date.now() + Number(minutes) * 60_000;
  for (;;) {
    const done = existsSync(join(dataRoot(), 'updates')) && readdirSync(join(dataRoot(), 'updates')).filter((f) => f.startsWith('drill-')).every((f) => existsSync(join(dataRoot(), 'updates', f, 'record-path.txt')));
    const files = existsSync(records) ? readdirSync(records).filter((f) => /^g9-drill-.*\.json$/.test(f)).sort() : [];
    if (done && files.length > 0) {
      const r = JSON.parse(readFileSync(join(records, files[files.length - 1]), 'utf8'));
      for (const s of r.steps) say(`  ${s.ok ? 'done  ' : 'FAILED'} ${s.title} — ${(s.ms / 60_000).toFixed(1)} min${s.detail ? ` — ${s.detail}` : ''}`);
      if (r.overall !== 'G9 PASSED') fail(`the drill says ${r.overall}`);
      say('G9 PASSED on Windows services.');
      break;
    }
    if (Date.now() > deadline) fail(`the drill did not finish within ${minutes} minutes`);
    await sleep(10_000);
  }
} else {
  fail(`not a command: ${command}`);
}
