#!/usr/bin/env node
// scripts/release-signing.mjs — SIGN a release and VERIFY a signed one (WF-20 · AID-08 "sign releases" · P-04 · hard rule
// #4 — OB-288 P5).
//
// A release of SRE Retail OS is one merged commit (infra/deploy/release.sh deploys a checkout of it). What is signed is
// the release MANIFEST — three lines that pin the exact code:
//
//     sre-release-v1
//     commit=<40-hex commit id>
//     tree=<40-hex tree id>
//
// The tree id is git's digest of every file in the commit, so a signature over the manifest covers every byte that
// deploys. The box rebuilds the same three lines from its own fetch and checks the signature with `openssl` against the
// public key it was given (release.sh) — it never trusts a manifest it was sent.
//
// Ed25519. The PRIVATE key is never in the repository, a config file, an image or a log (hard rule #4): it is read from
// the RELEASE_SIGNING_KEY environment variable (a PEM), held by the release-signing custodian as a CI secret. When it is
// not configured, `sign` says so and exits 2 — it never signs with a made-up key.
//
//   node scripts/release-signing.mjs manifest <sha>                    print the manifest
//   node scripts/release-signing.mjs sign <sha>                        print the base64 signature (needs RELEASE_SIGNING_KEY)
//   node scripts/release-signing.mjs verify <sha> <public-key.pem> <base64-signature>
//   node scripts/release-signing.mjs selftest <sha>                    sign + verify with a THROWAWAY key; a tampered
//                                                                      manifest and another key must both be refused
// Exit codes: 0 ok · 1 signature refused / self-test failed · 2 not signed (no key) · 64 usage.

import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SHA = /^[0-9a-f]{40}$/;
const SIG = /^[A-Za-z0-9+/]{86}==$/;

const usage = () => {
  process.stderr.write('usage: release-signing.mjs manifest|sign|selftest <sha>  ·  verify <sha> <public-key.pem> <base64-signature>\n');
  process.exit(64);
};

/** The manifest for a commit, from git itself. */
export function manifestOf(sha, cwd = process.cwd()) {
  if (!SHA.test(sha)) throw new Error(`not a 40-hex commit id: ${sha}`);
  const tree = execFileSync('git', ['rev-parse', `${sha}^{tree}`], { cwd, encoding: 'utf8' }).trim();
  if (!SHA.test(tree)) throw new Error(`git did not give a tree id for ${sha}`);
  return `sre-release-v1\ncommit=${sha}\ntree=${tree}\n`;
}

export const signManifest = (manifest, privateKeyPem) => sign(null, Buffer.from(manifest), createPrivateKey(privateKeyPem)).toString('base64');
export const verifyManifest = (manifest, publicKeyPem, signature) =>
  SIG.test(signature) && verify(null, Buffer.from(manifest), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));

function main() {
  const [cmd, sha, ...rest] = process.argv.slice(2);
  if (cmd === undefined || sha === undefined || !SHA.test(sha)) usage();
  const manifest = manifestOf(sha);
  if (cmd === 'manifest') { process.stdout.write(manifest); return; }
  if (cmd === 'sign') {
    const pem = process.env.RELEASE_SIGNING_KEY ?? '';
    if (pem.trim() === '') {
      process.stderr.write(`NOT SIGNED — no release signing key is configured (RELEASE_SIGNING_KEY). ${sha} is not signed; a box that checks signatures will refuse it.\n`);
      process.exit(2);
    }
    let key;
    try { key = createPrivateKey(pem); } catch { process.stderr.write('NOT SIGNED — RELEASE_SIGNING_KEY is not a readable private key (its value is not shown).\n'); process.exit(1); }
    if (key.asymmetricKeyType !== 'ed25519') { process.stderr.write(`NOT SIGNED — the release signing key must be Ed25519 (it is ${key.asymmetricKeyType}).\n`); process.exit(1); }
    process.stdout.write(`${sign(null, Buffer.from(manifest), key).toString('base64')}\n`);
    return;
  }
  if (cmd === 'verify') {
    const [pubPath, signature] = rest;
    if (pubPath === undefined || signature === undefined) usage();
    const ok = verifyManifest(manifest, readFileSync(pubPath, 'utf8'), signature);
    process.stdout.write(ok ? `SIGNED — the signature over ${sha} verifies.\n` : `REFUSED — the signature does not verify for ${sha}.\n`);
    process.exit(ok ? 0 : 1);
  }
  if (cmd === 'selftest') {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const pem = a.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const pubA = a.publicKey.export({ type: 'spki', format: 'pem' });
    const pubB = b.publicKey.export({ type: 'spki', format: 'pem' });
    const s = signManifest(manifest, pem);
    const tampered = manifest.replace(/tree=[0-9a-f]/, (m) => `${m.slice(0, -1)}${m.endsWith('0') ? '1' : '0'}`);
    const results = { verifies: verifyManifest(manifest, pubA, s), tamperedRefused: !verifyManifest(tampered, pubA, s), otherKeyRefused: !verifyManifest(manifest, pubB, s), garbageRefused: !verifyManifest(manifest, pubA, 'not-a-signature') };
    const ok = Object.values(results).every(Boolean);
    process.stdout.write(`${ok ? 'GREEN' : 'RED'} — release signing self-test for ${sha}: ${Object.entries(results).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
    process.exit(ok ? 0 : 1);
  }
  usage();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
