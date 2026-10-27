// The doctor's row on the handheld door's lock (OB-422 · ADR-0030) — read-only.
//
// When this computer's till opens the handheld door (EDGE_DEVICE_PORT in till.env), its lock — the store computer's own
// signing authority and the door's certificate — must be there, outside the till's data folder (a backup must never carry
// the private key off the computer), private to this computer's user, and the door's certificate must not be near its
// end (the till renews it by itself while it runs, so a certificate near its end means the till has not been running).
// It reads the PUBLIC certificates only; it never opens, prints or copies a private key.

import { X509Certificate } from 'node:crypto';
import path from 'node:path';

const DAY = 86_400_000;
/** The same names as edge/store-edge/src/device-tls.ts (DEVICE_TLS_FILES). */
export const LOCK_FILES = Object.freeze({ authorityKey: 'authority-key.pem', authorityCert: 'authority.crt', socketKey: 'device-socket-key.pem', socketCert: 'device-socket.crt' });

const firstCertificate = (pem) => `${String(pem).split('-----END CERTIFICATE-----')[0]}-----END CERTIFICATE-----\n`;

/**
 * One doctor row, or undefined when this computer's till opens no handheld door. `till` is `tillFolders(deps, L)`.
 * OK, FIX (with what to do) or NEEDS-YOU.
 */
export function deviceDoorRow(deps, till) {
  const env = till.env;
  if (env === undefined || String(env.EDGE_DEVICE_PORT ?? '').trim() === '') return undefined;
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const dir = till.deviceTls;
  const name = 'Handheld door';
  const fix = (detail, what) => ({ name, status: 'FIX', detail, fix: what });
  const rel = p.relative(till.edgeData, dir);
  if (rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))) {
    return fix(`its lock (${dir}) is inside the till's data folder, so a backup would carry its private key off this computer`, 'Stop here and send me a photo of this screen (never of the files). The lock must sit BESIDE the data folder (OB-422).');
  }
  const has = (f) => deps.fs.existsSync(p.join(dir, f));
  if (!has(LOCK_FILES.authorityCert) || !has(LOCK_FILES.authorityKey) || !has(LOCK_FILES.socketCert) || !has(LOCK_FILES.socketKey)) {
    return fix(`the lock is not made yet (or is incomplete) in ${dir}`, 'Start the till once (double-click till\\start-till.cmd): it makes the lock and says its fingerprint. If its window says the lock is incomplete, send me a photo of that window — never delete or copy the folder.');
  }
  if (deps.platform !== 'win32') {
    for (const f of [LOCK_FILES.authorityKey, LOCK_FILES.socketKey]) {
      const mode = deps.fs.statSync(p.join(dir, f)).mode & 0o077;
      if (mode !== 0) return fix(`${f} can be read by other users on this computer`, `Make it private: chmod 600 ${p.join(dir, f)} — then run this again.`);
    }
  }
  let authority;
  let door;
  try {
    authority = new X509Certificate(deps.fs.readFileSync(p.join(dir, LOCK_FILES.authorityCert), 'utf8'));
    door = new X509Certificate(firstCertificate(deps.fs.readFileSync(p.join(dir, LOCK_FILES.socketCert), 'utf8')));
  } catch {
    return fix(`the lock's certificates in ${dir} cannot be read`, 'Send me a photo of this screen (never of the files). Do not delete the folder: every handheld trusts what is in it.');
  }
  const now = deps.now().getTime();
  const doorEnds = new Date(door.validTo);
  const authorityEnds = new Date(authority.validTo);
  if (!door.verify(authority.publicKey)) return fix('the door\'s certificate was not signed by this computer\'s authority', 'Start the till once: it makes a new certificate under its own authority. If it says the authority is broken, send me a photo of its window.');
  if (doorEnds.getTime() - now < 7 * DAY) {
    return fix(`the door's certificate ends ${doorEnds.toISOString()} — the till renews it while it runs, so it has not been running`, 'Start the till (double-click till\\start-till.cmd) and leave it running: it renews the certificate by itself. Then run this again.');
  }
  if (authorityEnds.getTime() - now < 365 * DAY) {
    return { name, status: 'NEEDS-YOU', detail: `this computer's signing authority ends ${authorityEnds.toISOString()}`, fix: 'Before then a new one must be made and every handheld enrolled again — send me a photo of this screen and we plan it (runbook, "The handheld door\'s lock").' };
  }
  return { name, status: 'OK', detail: `locked (https only): authority ${authority.fingerprint256.slice(0, 23)}…, the door's certificate runs to ${doorEnds.toISOString()} and is renewed by the till` };
}
