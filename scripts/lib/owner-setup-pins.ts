// The PIN check the owner setup commands make (OB-257): is this the person's own till PIN, on THIS store computer?
//
// The same check the till makes at sign-in (edge/store-edge/src/till-operators.ts → packages/identity/src/till-pin.ts):
// the box's till-credentials file, the LATEST entry per person (a reissue replaces, a revocation ends), and the verifier
// keyed by the box's pack signing key — so a PIN made with `till-pin` is the one that opens these commands, and a PIN is
// never kept, logged or compared anywhere else. Offline: nothing here touches the network.

import { join } from 'node:path';
import { readTillCredentials } from '../../edge/store-edge/src/till-operators';
import { tillPinKey, tillPinMatches } from '../../packages/identity/src/till-pin';
import type { PinVerdict } from '../../packages/migration/src/owner-steps-command';

export interface PinFiles {
  /** The till's own settings (till.env), when the till is installed. */
  readonly tillEnv: Readonly<Record<string, string>> | undefined;
  /** This copy's settings (.env.real) — its pack signing key is the till's (the installer copies it). */
  readonly settings: Readonly<Record<string, string>>;
  readonly readFile: (path: string) => string | undefined;
}

/** Where the till keeps its PIN verifiers, by the till's own settings. Undefined when the till is not installed. */
export function credentialsFileOf(tillEnv: Readonly<Record<string, string>> | undefined): string | undefined {
  if (tillEnv === undefined) return undefined;
  const explicit = (tillEnv['EDGE_TILL_CREDENTIALS_FILE'] ?? '').trim();
  if (explicit !== '') return explicit;
  const dataDir = (tillEnv['EDGE_DATA_DIR'] ?? '').trim();
  return dataDir === '' ? undefined : join(dataDir, 'till-credentials.json');
}

/** The check, ready to ask: (person, PIN) → ok / wrong / no PIN issued to them / this PC cannot check. */
export function pinVerifier(files: PinFiles): (userId: string, pin: string) => PinVerdict {
  return (userId, pin) => {
    const file = credentialsFileOf(files.tillEnv);
    const key = (files.tillEnv?.['PACK_SIGNING_KEY'] ?? files.settings['PACK_SIGNING_KEY'] ?? '').trim();
    if (file === undefined || key.length < 32) return 'cannot_check';
    const text = files.readFile(file);
    if (text === undefined) return 'no_pin_issued';
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return 'cannot_check'; }
    const credential = readTillCredentials(raw).get(userId);
    if (credential === undefined || credential.revoked === true) return 'no_pin_issued';
    return tillPinMatches(pin, credential, tillPinKey(key)) ? 'ok' : 'wrong';
  };
}
