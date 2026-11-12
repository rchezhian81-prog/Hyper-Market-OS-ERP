#!/usr/bin/env node
// Make and check the SIGNED UPDATE RECORD of a store PC release (CR-01 step 3a · OI-05 · OB-717). See
// scripts/lib/store-pc-update.mjs for what is signed and why.
//
//   node scripts/store-pc-release.mjs version <run number>
//        prints the release version (1.0.<n>) — used by CI to stamp SRE-Setup.exe
//   node scripts/store-pc-release.mjs record --setup <SRE-Setup.exe> --version <1.0.n> --commit <sha> --out <update.json>
//        writes update.json; signs it when RELEASE_SIGNING_KEY is set (an Ed25519 PEM, never shown), else
//        signature null and a plain NOT SIGNED notice — never a made-up key
//   node scripts/store-pc-release.mjs check --setup <SRE-Setup.exe> --record <update.json> --public-key <pem> [--running <1.0.n>]
//        the store PC's own check: signed, verifies, the file is the signed one, newer than the running release
//
// Exit codes: 0 ok · 1 refused · 2 written NOT SIGNED (no key configured) · 64 usage.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUpdate, releaseVersion, sha256Of, signUpdate, updateRecord } from './lib/store-pc-update.mjs';

function arg(argv, name) { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; }

const USAGE = 'usage: store-pc-release.mjs version <run> · record --setup <exe> --version <v> --commit <sha> --out <json> · check --setup <exe> --record <json> --public-key <pem> [--running <v>]\n';

/** @param {string[]} argv @param {{ env: Record<string, string | undefined>, out: (s: string) => void, err: (s: string) => void }} io */
export function main(argv, io = { env: process.env, out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'version' && rest.length === 1) { io.out(`${releaseVersion(rest[0])}\n`); return 0; }

    if (cmd === 'record') {
      const setup = arg(rest, '--setup'); const version = arg(rest, '--version'); const commit = arg(rest, '--commit'); const out = arg(rest, '--out');
      if ([setup, version, commit, out].includes(undefined)) { io.err(USAGE); return 64; }
      const fields = { version, commit, sha256: sha256Of(readFileSync(setup)) };
      const pem = io.env.RELEASE_SIGNING_KEY ?? '';
      let signature = null;
      if (pem.trim() !== '') {
        try { signature = signUpdate(fields, pem); } catch (e) {
          io.err(`NOT SIGNED — RELEASE_SIGNING_KEY could not sign (its value is not shown): ${e.message.replace(/-----BEGIN[\s\S]*/, '')}\n`);
          return 1;
        }
      }
      writeFileSync(out, `${JSON.stringify(updateRecord({ ...fields, signature }), null, 2)}\n`);
      if (signature === null) {
        io.out(`NOT SIGNED — no RELEASE_SIGNING_KEY is configured. Version ${version} (SHA-256 ${fields.sha256}) is published with no signature; a store PC refuses to update to it.\n`);
        return 2;
      }
      io.out(`SIGNED — version ${version}, commit ${commit.slice(0, 8)}, SHA-256 ${fields.sha256}.\n`);
      return 0;
    }

    if (cmd === 'check') {
      const setup = arg(rest, '--setup'); const recordPath = arg(rest, '--record'); const pub = arg(rest, '--public-key');
      if ([setup, recordPath, pub].includes(undefined)) { io.err(USAGE); return 64; }
      const verdict = checkUpdate({ record: JSON.parse(readFileSync(recordPath, 'utf8')), setupBytes: readFileSync(setup), publicKeyPem: readFileSync(pub, 'utf8'), runningVersion: arg(rest, '--running') });
      io.out(verdict.ok ? `ACCEPTED — version ${verdict.version} is signed, verifies, and the file is the signed one.\n` : `REFUSED — ${verdict.reason}.\n`);
      return verdict.ok ? 0 : 1;
    }
  } catch (e) {
    io.err(`${e.message}\n`);
    return 1;
  }
  io.err(USAGE);
  return 64;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
