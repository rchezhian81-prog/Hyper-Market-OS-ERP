// The two short codes a person compares by eye when the owner's remote link is set up (OB-840 · ADR-0035). Shared, word
// for word, by the store computer (scripts/lib/store-computer-remote.mjs) and the relay server's link desk
// (infra/remote-access/link-desk.mjs), so both sides always print the same letters. Node built-ins only. No secret.
//
//   • the LINK CODE — the relay server shows it once its setup is done; the owner types it at the store computer. It is a
//     fingerprint of the relay's ssh host key(s) and the identity server's public signing key(s). The store computer
//     fetches both over the relay's https address and refuses to pin them unless they give the same code — so a wrong
//     address, or anything in between, cannot get its own keys pinned. It is not a secret: it only says "these keys".
//   • the PAIRING CODE — the store computer shows it for its own PUBLIC key; the relay's `sre-relay approve-link` shows the
//     same letters for the key waiting there. The owner approves only when they match. The private key never leaves the PC.

import { createHash } from 'node:crypto';

// Letters and digits that cannot be misread for one another (no 0/O, 1/I/L, U).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `n` characters of a digest, from the unambiguous alphabet, in groups of four. */
function grouped(digest, n) {
  let out = '';
  for (let i = 0; out.length < n; i += 1) out += ALPHABET[digest[i % digest.length] % ALPHABET.length];
  return out.match(/.{1,4}/g).join('-');
}

/** `ssh-ed25519 AAAA… comment` → `ssh-ed25519 AAAA…` (type and key only), or undefined when it is not a public key line. */
export function publicKeyCore(line) {
  const parts = String(line ?? '').trim().split(/\s+/);
  if (parts.length < 2 || !/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa)$/.test(parts[0]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) return undefined;
  return `${parts[0]} ${parts[1]}`;
}

/** The RSA signing keys of a published key set, as `kid:n:e`, sorted. */
export function signingKeyCores(jwks) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  return keys
    .filter((k) => k && k.kty === 'RSA' && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string' && (k.use === undefined || k.use === 'sig'))
    .map((k) => `${k.kid}:${k.n}:${k.e}`)
    .sort();
}

/** The link code for these host keys and this key set: `XXXX-XXXX-XXXX`, or undefined when either is missing. */
export function linkCode(hostKeyLines, jwks) {
  const hosts = (hostKeyLines ?? []).map(publicKeyCore).filter((x) => x !== undefined).sort();
  const sigs = signingKeyCores(jwks);
  if (hosts.length === 0 || sigs.length === 0) return undefined;
  const digest = createHash('sha256').update(`sre-remote-link-v1\n${hosts.join('\n')}\n--\n${sigs.join('\n')}\n`, 'utf8').digest();
  return grouped(digest, 12);
}

/** The pairing code of one public key line: `XXXX-XXXX`, or undefined when it is not a public key line. */
export function pairingCode(publicKeyLine) {
  const core = publicKeyCore(publicKeyLine);
  if (core === undefined) return undefined;
  const blob = Buffer.from(core.split(' ')[1], 'base64');
  return grouped(createHash('sha256').update(blob).digest(), 8);
}

/** Two codes are the same when they match ignoring case, spaces and dashes. */
export const sameCode = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/[\s-]/g, '').toUpperCase() === b.replace(/[\s-]/g, '').toUpperCase() && a.replace(/[\s-]/g, '') !== '';
