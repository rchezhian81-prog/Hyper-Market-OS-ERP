import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommandLine, prepare } from '../../scripts/lib/store-computer.mjs';
import {
  KEY_CHANGES_LOG, backup, replaceBackupPassphrase, replacePassphraseRefusals, restoreCheck,
} from '../../scripts/lib/store-computer-recovery.mjs';
import { PASSPHRASE, world, type World } from '../support/store-computer-world';

/**
 * OB-730 (owner, 14 Nov 2026: the backup passphrase is lost — "3"). The passphrase is kept nowhere, so it cannot be
 * recovered; the honest step is a NEW key under a NEW passphrase. Nothing is deleted (hard rule #6): the old key file is
 * renamed and kept, every old backup still has its own key copy on the drive, and the change is appended to a log that
 * never holds a passphrase. Only a person at the keyboard, who names themselves and types REPLACE, can do it.
 */

const NEW = 'a brand new backup passphrase 2';
const drive = (): string => mkdtempSync(join(tmpdir(), 'sre-owner-drive-'));
const keyIdOf = (w: World): string => (JSON.parse(readFileSync(join(w.data, 'backup', 'backup-key.json'), 'utf8')) as { keyId: string }).keyId;
const manifestIn = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.manifest.json')).sort().map((f) => join(dir, f));

async function backedUp(): Promise<{ w: World; dir: string; oldKey: string; oldManifest: string }> {
  const w = world();
  expect(await prepare(w.deps)).toBe(0);
  const dir = drive();
  expect(await backup(w.deps, { to: dir })).toBe(0); // the first backup sets the (now lost) passphrase
  w.said.length = 0;
  return { w, dir, oldKey: keyIdOf(w), oldManifest: manifestIn(dir)[0]! };
}

describe('OB-730 — a new backup passphrase when the old one is lost', () => {
  it('refuses without a name, and on a computer that has no backup key yet', () => {
    expect(replacePassphraseRefusals({ by: undefined, current: { present: true, key: {} } }).join(' ')).toMatch(/--by/);
    expect(replacePassphraseRefusals({ by: 'Owner', current: { present: false } }).join(' ')).toMatch(/no backup key yet/);
    expect(replacePassphraseRefusals({ by: 'Owner', current: { present: true, problem: 'bad' } }).join(' ')).toMatch(/cannot be read/);
    expect(replacePassphraseRefusals({ by: 'Owner', current: { present: true, key: {} } })).toEqual([]);
    expect(parseCommandLine(['new-backup-passphrase', '--by', 'Owner'])).toMatchObject({ command: 'new-backup-passphrase', by: 'Owner', problems: [] });
  });

  it('makes a new key, KEEPS the old one under a retired name, and records who and when — never a passphrase', async () => {
    const { w, oldKey } = await backedUp();
    w.typed = ['REPLACE', NEW, NEW];
    expect(await replaceBackupPassphrase(w.deps, { by: 'Owner (demo)' })).toBe(0);
    const newKey = keyIdOf(w);
    expect(newKey).not.toBe(oldKey);
    const kept = readdirSync(join(w.data, 'backup')).filter((f) => f.startsWith(`backup-key-retired-${oldKey}-`));
    expect(kept).toHaveLength(1);
    expect((JSON.parse(readFileSync(join(w.data, 'backup', kept[0]!), 'utf8')) as { keyId: string }).keyId).toBe(oldKey);
    const log = readFileSync(join(w.data, 'backup', KEY_CHANGES_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ by: 'Owner (demo)', oldKeyId: oldKey, newKeyId: newKey, oldKeyKeptAs: kept[0] });
    const everything = [...w.said, readFileSync(join(w.data, 'backup', KEY_CHANGES_LOG), 'utf8')].join('\n');
    expect(everything).not.toContain(NEW);
    expect(everything).not.toContain(PASSPHRASE);
    expect(w.said.join('\n')).toMatch(/write the new passphrase on paper/);
  });

  it('the next backup is locked with the NEW passphrase; the OLD backup still opens with the old one (its key is on the drive)', async () => {
    const { w, dir, oldManifest } = await backedUp();
    w.typed = ['REPLACE', NEW, NEW];
    expect(await replaceBackupPassphrase(w.deps, { by: 'Owner' })).toBe(0);
    expect(await backup(w.deps, { to: dir })).toBe(0);
    const newManifest = manifestIn(dir).find((m) => m !== oldManifest)!;
    w.typed = [NEW];
    expect(await restoreCheck(w.deps, { from: newManifest })).toBe(0);
    w.typed = [PASSPHRASE];
    expect(await restoreCheck(w.deps, { from: newManifest })).toBe(1); // the old passphrase does not open a new backup
    w.typed = [PASSPHRASE];
    expect(await restoreCheck(w.deps, { from: oldManifest })).toBe(0); // …but still opens the old one, if the paper is found
  });

  it('changes nothing unless REPLACE is typed, and nothing with no keyboard', async () => {
    const { w, oldKey } = await backedUp();
    w.typed = ['replace it'];
    expect(await replaceBackupPassphrase(w.deps, { by: 'Owner' })).toBe(1);
    expect(keyIdOf(w)).toBe(oldKey);
    expect(existsSync(join(w.data, 'backup', KEY_CHANGES_LOG))).toBe(false);
    w.deps = { ...w.deps, askSecret: async () => undefined };
    expect(await replaceBackupPassphrase(w.deps, { by: 'Owner' })).toBe(1);
    expect(keyIdOf(w)).toBe(oldKey);
  });

  it('when the new passphrase is not accepted, the old key is put back exactly as it was', async () => {
    const { w, oldKey } = await backedUp();
    const before = readFileSync(join(w.data, 'backup', 'backup-key.json'), 'utf8');
    w.typed = ['REPLACE', NEW, 'a different one 1', NEW, 'a different one 2', NEW, 'a different one 3'];
    expect(await replaceBackupPassphrase(w.deps, { by: 'Owner' })).toBe(1);
    expect(readFileSync(join(w.data, 'backup', 'backup-key.json'), 'utf8')).toBe(before);
    expect(keyIdOf(w)).toBe(oldKey);
    expect(readdirSync(join(w.data, 'backup')).filter((f) => f.startsWith('backup-key-retired-'))).toEqual([]);
    expect(existsSync(join(w.data, 'backup', KEY_CHANGES_LOG))).toBe(false);
  });

  it('refuses before asking anything on a computer with no backup key yet', async () => {
    const w = world();
    expect(await prepare(w.deps)).toBe(0);
    expect(await replaceBackupPassphrase(w.deps, { by: 'Owner' })).toBe(2);
    expect(w.asked).toEqual([]);
  });
});
