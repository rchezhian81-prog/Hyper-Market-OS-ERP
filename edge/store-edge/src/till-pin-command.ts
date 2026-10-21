// The command for TILL PINs, run ON the store computer (ADR-0020 §2 · M02-FR-01 · hard rule #4).
//
//   node edge/store-edge/dist/start.js till-pin --user <staff id> --by "<your name>"      the person sets their own PIN
//   node edge/store-edge/dist/start.js till-pin --user <staff id> --by "<your name>" --revoke
//   node edge/store-edge/dist/start.js till-pin --user <staff id> --by "<your name>" --generate-and-show   (see below)
//
// THE PERSON TYPES THEIR OWN PIN (round 4, the default). Whoever runs the command (the owner) hands the keyboard to the
// person whose PIN it is; they type their new six-digit PIN twice, at the store PC itself, and nothing they type shows —
// a star per key. The owner never sees it; it is never printed, never written to a file or a log, never sent anywhere.
// Only its verifier is kept, appended to the box's till-credentials file (owner-only, replaced atomically). A window that
// cannot hide what is typed (input piped from a file or another program) is refused: a PIN must come from the keyboard.
//
// `--generate-and-show` is the old way, kept only behind its own flag with a warning: the box makes the PIN and SHOWS IT
// on this screen, to whoever is in front of it. Nothing in the owner guide or the sheets uses it.
//
// The PIN rules are the till's own (packages/identity/src/till-pin.ts): six digits, nothing else. Run it in your own
// session on the box, never through a chat or remote-support tool.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TILL_PIN_LENGTH, isTillPin, issueTillCredential, newTillPin, tillPinKey, type TillCredential } from '../../../packages/identity/src/till-pin';

export interface TillPinCommandResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  /** The generated PIN, in `--generate-and-show` only — returned so a test can sign in with it. Never in the default mode. */
  readonly pin?: string;
}

/** Ask for a secret at this computer's keyboard without showing it; undefined when this window cannot hide what is typed. */
export type ReadSecret = (prompt: string) => Promise<string | undefined>;

/** How many tries the person gets to type the same six digits twice before the command stops, changing nothing. */
export const OWN_PIN_TRIES = 3;

const arg = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

/** Run the command. Pure apart from the credentials file it appends to; the clock, the PIN source and the keyboard are injectable. */
export async function runTillPinCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly now?: () => string;
    readonly newPin?: () => string;
    /** The keyboard, hidden (`readHiddenLine` on the store PC). Absent: this window cannot hide what is typed. */
    readonly readSecret?: ReadSecret;
    /** Words for the person at the keyboard while it asks (never a PIN). */
    readonly say?: (line: string) => void;
  } = {},
): Promise<TillPinCommandResult> {
  const userId = (arg(argv, 'user') ?? '').trim();
  const by = (arg(argv, 'by') ?? '').trim();
  const revoke = argv.includes('--revoke');
  const generate = argv.includes('--generate-and-show');
  if (userId === '' || by === '' || (revoke && generate)) {
    return { ok: false, lines: ['Usage: till-pin --user <staff id> --by "<your name>" [--revoke]  (the person then types their own new PIN twice; it never shows)'] };
  }
  const key = env['PACK_SIGNING_KEY'] ?? '';
  const dataDir = env['EDGE_DATA_DIR'] ?? '';
  if (key.length < 32 || dataDir === '') {
    return { ok: false, lines: ['Run this on the store computer, with its settings loaded (EDGE_DATA_DIR and PACK_SIGNING_KEY).'] };
  }
  const file = env['EDGE_TILL_CREDENTIALS_FILE'] ?? join(dataDir, 'till-credentials.json');
  const now = (options.now ?? (() => new Date().toISOString()))();

  let entry: TillCredential | { userId: string; revoked: true; issuedAt: string; issuedBy: string };
  let pin: string | undefined;
  if (revoke) {
    entry = { userId, revoked: true, issuedAt: now, issuedBy: by };
  } else if (generate) {
    pin = (options.newPin ?? newTillPin)();
    entry = issueTillCredential({ userId, pin, key: tillPinKey(key), issuedAt: now, issuedBy: by });
  } else {
    // The person whose PIN it is types it, twice, at this keyboard — hidden. Nothing is written until it matches.
    const chosen = await ownPin(userId, options.readSecret, options.say ?? (() => {}));
    if (!chosen.ok) return { ok: false, lines: chosen.lines };
    entry = issueTillCredential({ userId, pin: chosen.pin, key: tillPinKey(key), issuedAt: now, issuedBy: by });
  }
  // Read the file only now: the person may have taken a minute at the keyboard.
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { version?: number; credentials?: unknown[] }) : { version: 1, credentials: [] };
  const credentials = Array.isArray(existing.credentials) ? existing.credentials : [];
  // Append, never edit (hard rule #2): the latest entry per person wins when the box reads the file.
  const next = { version: 1, credentials: [...credentials, entry] };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* not the owner: leave the mode as it is */ }

  if (revoke) return { ok: true, lines: [`Till PIN for ${userId} revoked by ${by}. They cannot sign in at a till until a new PIN is set.`] };
  if (generate) {
    return {
      ok: true,
      pin,
      lines: [
        'WARNING: --generate-and-show puts the new PIN on this screen, where whoever is in front of it can read it. Use it only if the person cannot type their own PIN here; otherwise run the same line without it.',
        `Till PIN for ${userId}: ${pin}`,
        'Give it to them in person. It is not stored anywhere and will not be shown again.',
        'Issuing again replaces it; --revoke ends it. Five wrong PINs lock their staff ID for fifteen minutes.',
      ],
    };
  }
  return {
    ok: true,
    lines: [
      `Till PIN for ${userId} set: ${userId} typed it themselves (recorded by ${by}). It was not shown and is not stored anywhere — only a fingerprint of it, on this store computer.`,
      'Their old PIN, if they had one, has stopped working. Doing this again replaces it; --revoke ends it. Five wrong PINs lock their staff ID for fifteen minutes.',
    ],
  };
}

/** Ask the person for their new PIN twice, hidden, within `OWN_PIN_TRIES` tries. Never says what was typed. */
async function ownPin(userId: string, readSecret: ReadSecret | undefined, say: (line: string) => void): Promise<{ ok: true; pin: string } | { ok: false; lines: string[] }> {
  const cannotHide = [
    'This window cannot hide what is typed, so it will not take a PIN. Nothing was changed.',
    'Run it in PowerShell at the store computer itself, with the person beside you to type their own PIN.',
  ];
  if (readSecret === undefined) return { ok: false, lines: cannotHide };
  say(`${userId}: please come to the keyboard. Everyone else, look away.`);
  for (let attempt = 1; attempt <= OWN_PIN_TRIES; attempt += 1) {
    const first = await readSecret(`${userId}, type your new ${TILL_PIN_LENGTH}-digit till PIN and press Enter (it shows as stars): `);
    if (first === undefined) return { ok: false, lines: cannotHide };
    if (!isTillPin(first)) { say(`That was not ${TILL_PIN_LENGTH} digits. A till PIN is ${TILL_PIN_LENGTH} digits, 0 to 9, nothing else.`); continue; }
    const second = await readSecret('Type the same PIN again and press Enter: ');
    if (second === undefined) return { ok: false, lines: cannotHide };
    if (second !== first) { say('The two did not match. Start again.'); continue; }
    return { ok: true, pin: first };
  }
  return { ok: false, lines: [`The PIN was not set for ${userId}: the two did not match in ${OWN_PIN_TRIES} tries. Nothing was changed — run the same line again.`] };
}

/** The slice of a terminal's input this needs (process.stdin on the store PC). */
export interface HiddenInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: 'utf8'): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
}

/**
 * Read one line at THIS computer's keyboard without showing it: a star for each key, Backspace takes one back, Enter ends
 * it, Ctrl+C gives up (undefined). Works in the Windows console (PowerShell) and any terminal Node can put in raw mode.
 * Undefined at once when the input is not a keyboard (piped from a file or a program) — a PIN must be typed by a person.
 */
export function readHiddenLine(input: HiddenInput, output: { write(text: string): unknown }, prompt: string): Promise<string | undefined> {
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') return Promise.resolve(undefined);
  const setRaw = input.setRawMode.bind(input);
  output.write(prompt);
  return new Promise((resolve) => {
    let typed = '';
    const finish = (value: string | undefined): void => {
      input.removeListener('data', onData);
      setRaw(false);
      input.pause();
      output.write('\n');
      resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(typed); return; }
        if (ch === '\u0003' || ch === '\u0004') { finish(undefined); return; }
        if (ch === '\b' || ch === '\u007f') {
          if (typed.length > 0) { typed = typed.slice(0, -1); output.write('\b \b'); }
          continue;
        }
        // An arrow or function key arrives as Escape and a few letters together: none of it is part of a PIN.
        if (ch === '\u001b') break;
        if (ch >= ' ') { typed += ch; output.write('*'); }
      }
    };
    setRaw(true);
    input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
  });
}
