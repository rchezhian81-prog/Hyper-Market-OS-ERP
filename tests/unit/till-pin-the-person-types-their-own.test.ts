import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWN_PIN_TRIES, readHiddenLine, runTillPinCommand, type HiddenInput } from '../../edge/store-edge/src/till-pin-command';
import { loadTillCredentials } from '../../edge/store-edge/src/till-operators';
import { tillPinKey, tillPinMatches } from '../../packages/identity/src/till-pin';
import { testPin } from '../support/till-operator';

/**
 * **Round 4 · `till-pin`: the person whose PIN it is types their own new PIN, twice, hidden, at the store PC — the
 * default (hard rule #4 · ADR-0020 · OB-251/OB-259 "a person's own till PIN").**
 *
 * Before this, the command made the PIN and printed it to the window of whoever ran it — the owner saw every PIN he set.
 * Now, by default, nothing shows: each key the person types is a star, the PIN is asked twice and must match, it must be
 * the till's own shape (six digits — packages/identity/src/till-pin.ts), and it is never in what the command prints, in a
 * prompt, in the result, or in any file. A window that cannot hide what is typed (input piped from a file) is refused and
 * nothing is changed. The old way stays only behind `--generate-and-show`, with a warning (tests/unit/till-pin-command.test.ts).
 */

const BOX_KEY = ['till', 'pin', 'own', 'entry', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const box = async (): Promise<{ EDGE_DATA_DIR: string; PACK_SIGNING_KEY: string }> => {
  const d = await mkdtemp(join(tmpdir(), 'sre-till-pin-own-'));
  dirs.push(d);
  return { EDGE_DATA_DIR: d, PACK_SIGNING_KEY: BOX_KEY };
};
/** The person at the keyboard: answers each hidden prompt in turn, and keeps every prompt and line they were shown. */
const keyboard = (answers: readonly (string | undefined)[]): { readSecret: (p: string) => Promise<string | undefined>; say: (l: string) => void; shown: string[] } => {
  const shown: string[] = [];
  let i = 0;
  return {
    shown,
    say: (line) => { shown.push(line); },
    readSecret: async (prompt) => { shown.push(prompt); const a = answers[i]; i += 1; return a; },
  };
};

describe('till-pin: the person types their own new PIN, twice, hidden (the default)', () => {
  it('sets the PIN the person typed — never shown, never in the result, never on the disk — and the box then matches it', async () => {
    const env = await box();
    const pin = testPin(11);
    const kb = keyboard([pin, pin]);
    const out = await runTillPinCommand(['--user', 'u-meena', '--by', 'Owner'], env, { now: () => '2026-10-21T08:00:00.000Z', ...kb });
    expect(out.ok).toBe(true);
    expect(out.pin).toBeUndefined();
    expect(out.lines[0]).toBe('Till PIN for u-meena set: u-meena typed it themselves (recorded by Owner). It was not shown and is not stored anywhere — only a fingerprint of it, on this store computer.');
    // The person was asked by name, twice, and told it shows as stars; the owner was told to look away.
    expect(kb.shown).toEqual([
      'u-meena: please come to the keyboard. Everyone else, look away.',
      'u-meena, type your new 6-digit till PIN and press Enter (it shows as stars): ',
      'Type the same PIN again and press Enter: ',
    ]);
    for (const text of [...out.lines, ...kb.shown]) expect(text).not.toContain(pin);
    const file = join(env.EDGE_DATA_DIR, 'till-credentials.json');
    expect(await readFile(file, 'utf8')).not.toContain(pin);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const credential = (await loadTillCredentials(file)).get('u-meena')!;
    expect(credential).toMatchObject({ userId: 'u-meena', issuedBy: 'Owner', issuedAt: '2026-10-21T08:00:00.000Z' });
    expect(tillPinMatches(pin, credential, tillPinKey(BOX_KEY))).toBe(true);
  });

  it('the two must match and be six digits; after three tries nothing is changed — the old PIN still works', async () => {
    const env = await box();
    const old = testPin(12);
    expect((await runTillPinCommand(['--user', 'u-meena', '--by', 'Owner'], env, keyboard([old, old]))).ok).toBe(true);
    const file = join(env.EDGE_DATA_DIR, 'till-credentials.json');
    const before = await readFile(file, 'utf8');

    const kb = keyboard(['12345', '1234567', testPin(13), testPin(14)]);
    const out = await runTillPinCommand(['--user', 'u-meena', '--by', 'Owner'], env, kb);
    expect(OWN_PIN_TRIES).toBe(3);
    expect(out).toMatchObject({ ok: false, lines: ['The PIN was not set for u-meena: the two did not match in 3 tries. Nothing was changed — run the same line again.'] });
    expect(kb.shown).toContain('That was not 6 digits. A till PIN is 6 digits, 0 to 9, nothing else.');
    expect(kb.shown).toContain('The two did not match. Start again.');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(tillPinMatches(old, (await loadTillCredentials(file)).get('u-meena')!, tillPinKey(BOX_KEY))).toBe(true);

    // A slip, then right: set on the second try.
    const next = testPin(15);
    expect((await runTillPinCommand(['--user', 'u-meena', '--by', 'Owner'], env, keyboard(['abcdef', next, next]))).ok).toBe(true);
    expect(tillPinMatches(next, (await loadTillCredentials(file)).get('u-meena')!, tillPinKey(BOX_KEY))).toBe(true);
  });

  it('a window that cannot hide what is typed is refused, and nothing is written', async () => {
    const env = await box();
    for (const options of [{}, keyboard([undefined])]) {
      const out = await runTillPinCommand(['--user', 'u-meena', '--by', 'Owner'], env, options);
      expect(out).toMatchObject({ ok: false, lines: ['This window cannot hide what is typed, so it will not take a PIN. Nothing was changed.', expect.stringMatching(/PowerShell at the store computer itself/)] });
    }
    expect(existsSync(join(env.EDGE_DATA_DIR, 'till-credentials.json'))).toBe(false);
  });
});

/** A terminal's input, as the store PC's PowerShell gives it to Node. */
class FakeTerminal extends EventEmitter implements HiddenInput {
  readonly isTTY: boolean;
  raw = false;
  paused = true;
  constructor(isTTY = true) { super(); this.isTTY = isTTY; }
  setRawMode(mode: boolean): this { this.raw = mode; return this; }
  setEncoding(): this { return this; }
  resume(): this { this.paused = false; return this; }
  pause(): this { this.paused = true; return this; }
  type(keys: string): void { this.emit('data', keys); }
}

describe('readHiddenLine: what the keyboard types never shows', () => {
  it('a star per key, Backspace takes one back, Enter ends it — the window never shows a digit, and the terminal is put back', async () => {
    const term = new FakeTerminal();
    const shown: string[] = [];
    const line = readHiddenLine(term, { write: (t) => { shown.push(t); } }, 'PIN: ');
    expect(term.raw).toBe(true);
    term.type('48');
    term.type('2\b');
    term.type('7\u001b[A'); // an arrow key: ignored
    term.type('9\r');
    expect(await line).toBe('4879');
    expect(shown.join('')).toBe('PIN: ***\b \b**\n');
    expect(shown.join('')).not.toMatch(/\d/);
    expect(term.raw).toBe(false);
    expect(term.paused).toBe(true);
    expect(term.listenerCount('data')).toBe(0);
  });

  it('Ctrl+C gives up; input that is not a keyboard is refused before asking', async () => {
    const term = new FakeTerminal();
    const line = readHiddenLine(term, { write: () => {} }, 'PIN: ');
    term.type('12\u0003');
    expect(await line).toBeUndefined();
    const piped = new FakeTerminal(false);
    const shown: string[] = [];
    expect(await readHiddenLine(piped, { write: (t) => { shown.push(t); } }, 'PIN: ')).toBeUndefined();
    expect(shown).toEqual([]);
  });
});

describe('the sheets and the guides say the person types their own PIN, and nobody else sees it', () => {
  it('SOP-04 (English and Tamil), the owner guide and the install runbook: the keyboard goes to the person; no PIN is read off the screen', async () => {
    const en = await readFile('docs/sop/sop-04-forgotten-pin.en.md', 'utf8');
    const ta = await readFile('docs/sop/sop-04-forgotten-pin.ta.md', 'utf8');
    const guide = await readFile('docs/runbooks/store-computer-owner-guide-windows.md', 'utf8');
    const install = await readFile('docs/runbooks/in-store-install.md', 'utf8');
    expect(en).toContain('**Give the keyboard to the\n   cashier and look away.**');
    expect(ta).toContain('விசைப்பலகையைக்\n   காசாளரிடம் கொடுத்து');
    expect(guide).toContain('**Give the keyboard to the person and look\n     away.**');
    expect(install).toMatch(/asks \*\*the person\*\* for their new six-digit PIN, twice/);
    for (const [name, text] of [['sop-04.en', en], ['guide', guide], ['install', install]] as const) {
      expect(text, name).not.toMatch(/Turn the screen to the (cashier|person)/);
      expect(text, name).not.toMatch(/(new|six-digit) PIN (appears|\*\*once\*\*)|prints the six-digit PIN/);
    }
    expect(ta).not.toContain('திரையைக் காசாளர் பக்கம் திருப்பி');
  });
});
