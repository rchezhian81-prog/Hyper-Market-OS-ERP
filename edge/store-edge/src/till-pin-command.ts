// The administrator's command for TILL PINs, run ON the store computer (ADR-0020 §2 · M02-FR-01 · hard rule #4).
//
//   node edge/store-edge/dist/start.js till-pin --user <staff id> --by "<your name>"      issue (or reissue) a PIN
//   node edge/store-edge/dist/start.js till-pin --user <staff id> --by "<your name>" --revoke
//
// The PIN is generated HERE and printed ONCE to the administrator's own terminal, to be handed to the person directly.
// Only its verifier is kept, appended to the box's till-credentials file (owner-only, replaced atomically). Run it in
// your own session on the box, never through a chat tool, so the PIN is never copied anywhere else.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { issueTillCredential, newTillPin, tillPinKey, type TillCredential } from '../../../packages/identity/src/till-pin';

export interface TillPinCommandResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  /** The issued PIN — returned only so a test can sign in with it; the command prints it once and keeps nothing. */
  readonly pin?: string;
}

const arg = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

/** Run the command. Pure apart from the credentials file it appends to; the clock and the random source are injectable. */
export function runTillPinCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly now?: () => string; readonly newPin?: () => string } = {},
): TillPinCommandResult {
  const userId = (arg(argv, 'user') ?? '').trim();
  const by = (arg(argv, 'by') ?? '').trim();
  const revoke = argv.includes('--revoke');
  if (userId === '' || by === '') {
    return { ok: false, lines: ['Usage: till-pin --user <staff id> --by "<your name>" [--revoke]'] };
  }
  const key = env['PACK_SIGNING_KEY'] ?? '';
  const dataDir = env['EDGE_DATA_DIR'] ?? '';
  if (key.length < 32 || dataDir === '') {
    return { ok: false, lines: ['Run this on the store computer, with its settings loaded (EDGE_DATA_DIR and PACK_SIGNING_KEY).'] };
  }
  const file = env['EDGE_TILL_CREDENTIALS_FILE'] ?? join(dataDir, 'till-credentials.json');
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { version?: number; credentials?: unknown[] }) : { version: 1, credentials: [] };
  const credentials = Array.isArray(existing.credentials) ? existing.credentials : [];
  const now = (options.now ?? (() => new Date().toISOString()))();

  let entry: TillCredential | { userId: string; revoked: true; issuedAt: string; issuedBy: string };
  let pin: string | undefined;
  if (revoke) {
    entry = { userId, revoked: true, issuedAt: now, issuedBy: by };
  } else {
    pin = (options.newPin ?? newTillPin)();
    entry = issueTillCredential({ userId, pin, key: tillPinKey(key), issuedAt: now, issuedBy: by });
  }
  // Append, never edit (hard rule #2): the latest entry per person wins when the box reads the file.
  const next = { version: 1, credentials: [...credentials, entry] };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* not the owner: leave the mode as it is */ }

  return revoke
    ? { ok: true, lines: [`Till PIN for ${userId} revoked by ${by}. They cannot sign in at a till until a new PIN is issued.`] }
    : {
      ok: true,
      pin,
      lines: [
        `Till PIN for ${userId}: ${pin}`,
        'Give it to them in person. It is not stored anywhere and will not be shown again.',
        'Issuing again replaces it; --revoke ends it. Five wrong PINs lock their staff ID for fifteen minutes.',
      ],
    };
}
