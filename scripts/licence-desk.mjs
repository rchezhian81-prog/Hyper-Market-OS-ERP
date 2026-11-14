#!/usr/bin/env node
// The owner's LICENCE DESK — CR-01 step 5 (OI-10 · OB-710). Run on the OWNER'S OWN computer only. See
// scripts/lib/licence-desk.mjs for what each command does, and docs/runbooks/licensing.md for the steps in plain words.
//
//   node scripts/licence-desk.mjs make-key --folder E:\SRE-licence-key
//   node scripts/licence-desk.mjs issue --key E:\SRE-licence-key\sre-licence-seller-key.pem --request <request file> --expires 2027-11-30
//   node scripts/licence-desk.mjs issue --key … --owner --tenant <id> --shop "SRE Hyper Market" --gstin <GSTIN> --tills 6 --stores 1 --modules all
//   node scripts/licence-desk.mjs show <licence file> --public-key E:\SRE-licence-key\licence-signing.pub
//   node scripts/licence-desk.mjs restore-key --from <typed paper lines> --folder <folder>

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { issueCommand, makeKeyCommand, restoreKeyCommand, showCommand } from './lib/licence-desk.mjs';

const USAGE = [
  'Usage: node scripts/licence-desk.mjs <command>',
  '  make-key --folder <folder on your USB drive>          once: the master key (asks a passphrase, hidden)',
  '  issue --key <key file> [--request <file>] [--owner] [--tenant <id>] [--shop "<name>"] [--gstin <GSTIN>]',
  '        [--tills N] [--stores N] [--modules all|M01,M02] [--expires YYYY-MM-DD] [--out <folder>]',
  '                                                        a licence for one shop (what is not given is asked)',
  '  show <licence file> [--public-key <licence-signing.pub>]   what a licence says, and whether it checks',
  '  restore-key --from <typed paper lines> --folder <folder>   the key again, from the paper backup',
];

/** One answer at the keyboard; `hidden`: nothing typed is shown (a passphrase). One reader for the whole run. */
let reader;
let lines;
let muted = false;
async function ask(question, hidden) {
  if (reader === undefined) {
    const tty = process.stdin.isTTY === true;
    reader = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
    if (tty) { const write = reader._writeToOutput.bind(reader); reader._writeToOutput = (s) => { if (!muted) write(s); }; }
    lines = reader[Symbol.asyncIterator]();
  }
  process.stdout.write(question);
  muted = hidden === true;
  const next = await lines.next();
  muted = false;
  if (hidden === true) process.stdout.write('\n');
  return next.done ? '' : String(next.value);
}

export async function main(argv) {
  const [command, ...rest] = argv.filter((a) => a !== '--');
  const o = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--owner') o.owner = true;
    else if (a.startsWith('--')) { o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[i + 1]; i += 1; }
    else positional.push(a);
  }
  const d = { fs, path, env: process.env, platform: process.platform, say: (l) => process.stdout.write(`${l}\n`), ask, now: () => new Date() };
  try {
    return await run(command, o, positional, d);
  } finally { reader?.close(); }
}

function run(command, o, positional, d) {
  switch (command) {
    case 'make-key': return makeKeyCommand(d, { folder: o.folder });
    case 'issue': return issueCommand(d, o);
    case 'show': return showCommand(d, { file: positional[0] ?? o.file, publicKey: o.publicKey });
    case 'restore-key': return restoreKeyCommand(d, { from: o.from, folder: o.folder });
    default: for (const l of USAGE) d.say(l); return 2;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
