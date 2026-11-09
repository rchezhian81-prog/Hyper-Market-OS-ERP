// The SIGNED UPDATE RECORD of a store PC release (CR-01 step 3a · OI-05 · OB-717 "A" · P-04 · hard rule #4).
//
// On every merge to main, CI publishes a GitHub Release holding two files: SRE-Setup.exe (the exact program the
// `store-pc-setup` job ran on a clean Windows machine) and update.json, this record:
//
//     { "kind": "sre-store-pc-update-v1", "version": "1.0.<n>", "commit": "<40 hex>", "sha256": "<64 hex>",
//       "asset": "SRE-Setup.exe", "signature": "<base64 Ed25519>" | null }
//
// What is signed is four lines rebuilt from the record — never the record's own text:
//
//     sre-store-pc-update-v1
//     version=1.0.<n>
//     commit=<40 hex>
//     sha256=<64 hex of SRE-Setup.exe>
//
// The signature is made with the SAME release signing key as the demo-box releases (scripts/release-signing.mjs,
// RELEASE_SIGNING_KEY, held by the IT custodian — OB-342). The store PC checks it against the PUBLIC key that came with
// the release it already runs (release-signing.pub in the install folder), and checks the downloaded file's SHA-256
// against the signed one. Any doubt is a refusal: no signature, a signature that does not verify, a file that is not
// the signed one, a version that is not newer. A missing key never produces a made-up signature (signature: null).

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const UPDATE_KIND = 'sre-store-pc-update-v1';
export const UPDATE_ASSET = 'SRE-Setup.exe';
export const UPDATE_RECORD = 'update.json';

const VERSION = /^1\.0\.([1-9]\d{0,8})$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/** The release version for a CI run on main: 1.0.<run number>. Run numbers only grow, so versions only grow. */
export function releaseVersion(runNumber) {
  const n = String(runNumber).trim();
  if (!/^[1-9]\d{0,8}$/.test(n)) throw new Error(`not a CI run number: ${runNumber}`);
  return `1.0.${n}`;
}

/** The release tag on GitHub for a version. */
export const releaseTag = (version) => `store-pc-v${version}`;

/** Is this a published release version (1.0.<n>)? A test build's "0.0.0-ci.<n>" is not. */
export const isReleaseVersion = (v) => typeof v === 'string' && VERSION.test(v);

/** -1, 0 or 1. Both must be release versions. */
export function compareVersions(a, b) {
  if (!isReleaseVersion(a) || !isReleaseVersion(b)) throw new Error(`not release versions: ${a} · ${b}`);
  const x = Number(VERSION.exec(a)[1]);
  const y = Number(VERSION.exec(b)[1]);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** The SHA-256 of a file's bytes, as 64 lowercase hex. */
export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

function checkFields({ version, commit, sha256 }) {
  if (!isReleaseVersion(version)) throw new Error(`not a release version: ${version}`);
  if (!COMMIT.test(commit ?? '')) throw new Error(`not a 40-hex commit id: ${commit}`);
  if (!SHA256.test(sha256 ?? '')) throw new Error(`not a 64-hex SHA-256: ${sha256}`);
}

/** The four signed lines. */
export function updateManifest(fields) {
  checkFields(fields);
  return `${UPDATE_KIND}\nversion=${fields.version}\ncommit=${fields.commit}\nsha256=${fields.sha256}\n`;
}

/** Sign with the release signing key (an Ed25519 private key PEM). Throws on any other key; never invents one. */
export function signUpdate(fields, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the release signing key must be Ed25519 (it is ${key.asymmetricKeyType})`);
  return sign(null, Buffer.from(updateManifest(fields)), key).toString('base64');
}

/** Does the signature verify against this public key? False for anything malformed — never throws. */
export function verifyUpdate(fields, publicKeyPem, signature) {
  try {
    if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return false;
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(updateManifest(fields)), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** The record published beside SRE-Setup.exe. signature is null when no signing key is configured. */
export function updateRecord({ version, commit, sha256, signature }) {
  checkFields({ version, commit, sha256 });
  if (signature !== null && !SIGNATURE.test(signature ?? '')) throw new Error('the signature is not a base64 Ed25519 signature');
  return { kind: UPDATE_KIND, version, commit, sha256, asset: UPDATE_ASSET, signature };
}

/**
 * The store PC's check of a downloaded release, before anything is touched:
 *   record     — the parsed update.json
 *   setupBytes — the downloaded SRE-Setup.exe
 *   publicKeyPem — release-signing.pub from the install folder (undefined when the running release has none)
 *   runningVersion — the version in the running release.json (a test build's version counts as "older than any")
 * Returns { ok: true, version } or { ok: false, reason } with the reason in plain words.
 */
export function checkUpdate({ record, setupBytes, publicKeyPem, runningVersion }) {
  if (record === null || typeof record !== 'object' || record.kind !== UPDATE_KIND) return { ok: false, reason: 'the update record is not one this PC understands' };
  const { version, commit, sha256, signature } = record;
  try { checkFields({ version, commit, sha256 }); } catch (e) { return { ok: false, reason: `the update record is malformed: ${e.message}` }; }
  if (isReleaseVersion(runningVersion) && compareVersions(version, runningVersion) <= 0) {
    return { ok: false, reason: `version ${version} is not newer than the running ${runningVersion}` };
  }
  if (signature === null || signature === undefined) return { ok: false, reason: `version ${version} is NOT SIGNED (no release signing key was configured when it was built)` };
  if (publicKeyPem === undefined || publicKeyPem.trim() === '') return { ok: false, reason: 'this PC has no release public key to check the signature with' };
  if (!verifyUpdate({ version, commit, sha256 }, publicKeyPem, signature)) return { ok: false, reason: `the signature on version ${version} does not verify with this PC's release public key` };
  if (sha256Of(setupBytes) !== sha256) return { ok: false, reason: `the downloaded ${UPDATE_ASSET} is not the file that was signed (its fingerprint differs)` };
  return { ok: true, version };
}
