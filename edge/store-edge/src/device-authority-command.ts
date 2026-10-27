// `node edge/store-edge/dist/start.js device-authority` — make (at install) or check the handheld door's lock, on the store
// computer itself (OB-422 · ADR-0030). The till installer runs it once the edge is built; an administrator may run it at
// any time (the till's start script passes it through: `till/start-till.sh device-authority`).
//
// It reads the till's own settings (EDGE_DATA_DIR, EDGE_DEVICE_TLS_DIR, EDGE_DEVICE_HOST), makes the store computer's
// signing authority if there is none, (re)issues the door's certificate when due, and says — in words — the fingerprint a
// person compares when a handheld trusts the authority, and where the PUBLIC authority file is. It never prints, returns
// or logs a private key; the key stays in its folder on this computer.

import { join } from 'node:path';
import { DEVICE_HOST } from './device-server';
import { DEVICE_TLS_FILES, ensureDeviceTls, sayDeviceTlsEvent, socketAddressesFor } from './device-tls';

export interface DeviceAuthorityCommandResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/** Where the lock lives, from the till's settings: `EDGE_DEVICE_TLS_DIR`, else beside the data folder. */
export function deviceTlsDirOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const named = env['EDGE_DEVICE_TLS_DIR']?.trim();
  if (named !== undefined && named !== '') return named;
  const data = env['EDGE_DATA_DIR']?.trim();
  return data === undefined || data === '' ? undefined : `${data.replace(/[\\/]+$/, '')}-device-tls`;
}

export function runDeviceAuthorityCommand(env: Readonly<Record<string, string | undefined>>, now: Date = new Date()): DeviceAuthorityCommandResult {
  const dir = deviceTlsDirOf(env);
  if (dir === undefined) return { ok: false, lines: ['NOT DONE — the till\'s settings name no EDGE_DATA_DIR (or EDGE_DEVICE_TLS_DIR). Run this through the till\'s start script.'] };
  const where = socketAddressesFor(env['EDGE_DEVICE_HOST']?.trim() || DEVICE_HOST);
  if (!where.ok) return { ok: false, lines: [`NOT DONE — ${where.problem}.`] };
  const out = ensureDeviceTls({ dir, addresses: where.addresses, now });
  if (!out.ok) return { ok: false, lines: [`NOT DONE — ${out.problem}.`] };
  const lines = out.events.map(sayDeviceTlsEvent);
  if (out.events.length === 0) lines.push('handheld door: the lock is in place; nothing needed renewing.');
  lines.push(
    `  The authority each handheld trusts (public — safe to copy): ${join(dir, DEVICE_TLS_FILES.authorityCert)}`,
    `  Its fingerprint (check it on the handheld when you install it): ${out.tls.authorityFingerprint}`,
    `  The door's certificate covers ${out.tls.addresses.join(', ')} and runs to ${out.tls.socketNotAfter}; this store computer renews it by itself.`,
    `  The private keys stay in ${dir} on this computer only — never copy that folder, never back it up with the till's data.`,
  );
  return { ok: true, lines };
}
