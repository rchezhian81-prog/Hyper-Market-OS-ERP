import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
// @ts-expect-error — plain .mjs script module, imported for its pure flag parser (no types file needed).
import { parseArgs as parseTillInstallArgs } from '../../scripts/install-till.mjs';
import { parseCommandLine } from '../../scripts/lib/store-computer.mjs';

/**
 * The owner's Windows guide (Parts 12–25: the till, the locked PC, the UPS, memory, the daily routine — OB-244, OB-247,
 * OB-248, OB-250, OB-251, OB-252, OB-254, OB-255) and the cashier sheets in docs/sop hold together:
 *
 *   • the guide and every sheet name no address and hold no secret — no IP, no URL, nothing shaped like a key;
 *   • every `pnpm run X` the guide or a sheet tells the owner to type exists in package.json, and every flag on it is one
 *     the command really reads (read from that command's own source) — the guide never invents a flag;
 *   • every store-computer command is one the tool has today, or one of the named commands lane 2 is adding — and those
 *     are marked LANE-2 CHECK where the guide uses them, until the tool really has them;
 *   • every sheet exists in English AND Tamil, with the same sheet id and the same numbered steps, and the guide lists
 *     both files of every sheet.
 */

const GUIDE_PATH = 'docs/runbooks/store-computer-owner-guide-windows.md';
const SOP_DIR = 'docs/sop';
const guide = readFileSync(GUIDE_PATH, 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

/** The sheets the owner asked for (OB-255, OB-248 with OB-252, OB-254, and the forgotten PIN). */
const SHEETS = ['sop-01-pc-down', 'sop-02-mirror-keying', 'sop-03-owner-evening-check', 'sop-04-forgotten-pin'] as const;
const sheetText = (id: string, lang: 'en' | 'ta'): string => readFileSync(`${SOP_DIR}/${id}.${lang}.md`, 'utf8');

/** The store-computer commands lane 2 is adding, exactly as named in the brief. */
const LANE_2_COMMANDS = ['schedule-backup', 'unschedule-backup', 'backup-status', 'autostart', 'migrate-data-folder', 'update', 'status'];

/** The commands store-computer has today, read from its own dispatcher — so this follows the tool, not a copy of it. */
const storeComputerSource = readFileSync('scripts/lib/store-computer.mjs', 'utf8');
const EXISTING_COMMANDS = [...storeComputerSource.matchAll(/^\s*case '([a-z-]+)':\s*return /gm)].map((m) => m[1]!);

/** Nothing shaped like an address or a secret. */
export function addressOrSecretFindings(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) found.push(`IP address ${m[0]}`);
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi)) found.push(`URL ${m[0]}`);
  for (const m of text.matchAll(/\blocalhost\b(?::\d+)?/gi)) found.push(`address ${m[0]}`);
  for (const m of text.matchAll(/[A-Za-z0-9_-]{40,}/g)) found.push(`key-shaped ${m[0].slice(0, 8)}…`);
  for (const m of text.matchAll(/\b[0-9a-f]{32,}\b/gi)) found.push(`hex-shaped ${m[0].slice(0, 8)}…`);
  // A setting written out with a value, e.g. CLOUD_API_TOKEN=<something>: the guide never shows one.
  for (const m of text.matchAll(/\b(POSTGRES_PASSWORD|DATABASE_URL|PACK_SIGNING_KEY|BOX_HISTORY_SEAL_KEY|IDP_SIGNING_KEY|CLOUD_API_TOKEN|CLOUD_API_URL)=(\S+)/g)) found.push(`setting with a value ${m[1]}`);
  return found;
}

/** Split a command line the way PowerShell would hand it on: spaces, with "double quotes" kept together. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

/** Every command the reader is told to type: each line of a fenced block, and each inline `code` span. */
function commandsIn(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) { out.push(line.trim()); continue; }
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]!.trim());
  }
  return out.filter((c) => c.startsWith('pnpm run ') || /start-till\.cmd till-pin/.test(c));
}

/** The flags a command reads, taken from its own source. */
function flagsReadBy(file: string, pattern: RegExp, extra: readonly string[] = []): Set<string> {
  const src = readFileSync(file, 'utf8');
  return new Set([...[...src.matchAll(pattern)].map((m) => `--${m[1]!}`), ...extra]);
}
const TOKEN_FLAGS = flagsReadBy('scripts/issue-store-token.mjs', /args\['([a-z-]+)'\]/g, ['--no-store']);
const BOOTSTRAP_FLAGS = flagsReadBy('scripts/bootstrap-tenant.ts', /flags\['([a-z-]+)'\]/g);
const SLICE_FLAGS = flagsReadBy('scripts/migration-slice.ts', /flags\['([a-z-]+)'\]/g);
const TILL_PIN_FLAGS = flagsReadBy('edge/store-edge/src/till-pin-command.ts', /arg\(argv, '([a-z-]+)'\)/g, ['--revoke']);

/** Why a command the reader is told to type would not be understood — empty when it would be. */
export function commandProblems(command: string, scripts: Readonly<Record<string, string>>): string[] {
  const w = words(command);
  if (w[0] === 'pnpm' && w[1] === 'run') {
    const script = w[2] ?? '';
    if (scripts[script] === undefined) return [`pnpm run ${script}: no such script in package.json`];
    const rest = w.slice(3);
    const flags = rest.filter((a) => a.startsWith('--') && a !== '--');
    const unknown = (known: Set<string>) => flags.filter((f) => !known.has(f)).map((f) => `${script}: ${f} is not a flag it reads`);
    switch (script) {
      case 'till:install': {
        const parsed = parseTillInstallArgs(rest) as { unknown: string[] };
        return parsed.unknown.map((u) => `till:install: ${u === '--' ? 'a "--" is refused by the installer (gap W-1)' : `${u} is not a flag it reads`}`);
      }
      case 'store-computer': {
        const parsed = parseCommandLine(rest);
        const cmd = parsed.command ?? '';
        if (!EXISTING_COMMANDS.includes(cmd)) {
          return LANE_2_COMMANDS.includes(cmd) ? [] : [`store-computer: "${cmd}" is neither a command today nor one lane 2 is adding`];
        }
        return parsed.problems.map((p) => `store-computer ${cmd}: ${p}`);
      }
      case 'token:store': return unknown(TOKEN_FLAGS);
      case 'tenant:bootstrap': return unknown(BOOTSTRAP_FLAGS);
      case 'migration:slice': return unknown(SLICE_FLAGS);
      default: return flags.length === 0 ? [] : [`${script}: this guardrail does not know where its flags are read — add it here`];
    }
  }
  const at = w.indexOf('till-pin');
  if (at !== -1) return w.slice(at + 1).filter((a) => a.startsWith('--') && !TILL_PIN_FLAGS.has(a)).map((f) => `till-pin: ${f} is not a flag it reads`);
  return [];
}

/** Lines that use a lane-2 command the tool does not have yet, with no LANE-2 CHECK mark close above them. */
export function unmarkedLane2Lines(text: string, existing: readonly string[]): string[] {
  const lines = text.split('\n');
  const bad: string[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/store-computer -- ([a-z-]+)/g)) {
      const cmd = m[1]!;
      if (!LANE_2_COMMANDS.includes(cmd) || existing.includes(cmd)) continue;
      let marked = false;
      for (let j = i; j >= Math.max(0, i - 15); j -= 1) {
        if (lines[j]!.includes('LANE-2 CHECK')) { marked = true; break; }
        if (j < i && /^#{2,3} /.test(lines[j]!)) break; // a new section starts: the mark must be in this one
      }
      if (!marked) bad.push(`line ${i + 1}: ${cmd}`);
    }
  });
  return bad;
}

const numberedSteps = (text: string): string[] => [...text.matchAll(/^(\d+)\. /gm)].map((m) => m[1]!);
const tamilShare = (text: string): number => {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  return letters.filter((ch) => /[\u0B80-\u0BFF]/.test(ch)).length / Math.max(1, letters.length);
};

describe('the owner guide and the cashier sheets hold together (OB-244 · OB-248 · OB-251 · OB-255)', () => {
  it('the guide and every sheet name no address and hold no secret', () => {
    expect(addressOrSecretFindings(guide)).toEqual([]);
    for (const id of SHEETS) for (const lang of ['en', 'ta'] as const) expect(addressOrSecretFindings(sheetText(id, lang)), `${id}.${lang}`).toEqual([]);
  });

  it('the address-and-secret check really looks — it finds an IP, a URL, loopback and a token', () => {
    const planted = ['h', 't', 't', 'p', ':', '/', '/'].join('') + 'example.invalid/x';
    expect(addressOrSecretFindings(`open ${['10', '0', '0', '7'].join('.')} or ${planted} or localhost:8091`)).toHaveLength(3);
    expect(addressOrSecretFindings(`CLOUD_API_TOKEN=${'Ab9_'.repeat(12)}`).length).toBeGreaterThanOrEqual(2);
  });

  it('every "pnpm run X" in the guide and the sheets exists in package.json', () => {
    const all = [guide, ...SHEETS.flatMap((id) => [sheetText(id, 'en'), sheetText(id, 'ta')])].join('\n');
    const named = [...new Set([...all.matchAll(/pnpm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]!))];
    expect(named.length).toBeGreaterThan(4);
    for (const s of named) expect(pkg.scripts[s], `pnpm run ${s}`).toBeDefined();
  });

  it('every command the reader types uses only flags that command reads (no invented flag)', () => {
    const commands = [guide, ...SHEETS.flatMap((id) => [sheetText(id, 'en'), sheetText(id, 'ta')])].flatMap(commandsIn);
    expect(commands.length).toBeGreaterThan(20);
    for (const c of commands) expect(commandProblems(c, pkg.scripts), c).toEqual([]);
  });

  it('the flag check really looks — an invented flag, an unknown script and the installer\'s "--" are each caught', () => {
    expect(commandProblems('pnpm run token:store -- --tenant t --colour blue', pkg.scripts)).toEqual(['token:store: --colour is not a flag it reads']);
    expect(commandProblems('pnpm run no-such-thing', pkg.scripts)).toHaveLength(1);
    expect(commandProblems('pnpm run till:install -- --lane lane-1', pkg.scripts)[0]).toMatch(/gap W-1/);
    expect(commandProblems('pnpm run store-computer -- teleport', pkg.scripts)).toHaveLength(1);
    expect(commandProblems('C:\\SRE\\till\\start-till.cmd till-pin --user u1 --by "A B" --forever', pkg.scripts)).toHaveLength(1);
  });

  it('the guide uses exactly the lane-2 command names, and marks each one LANE-2 CHECK until the tool has it', () => {
    expect(EXISTING_COMMANDS).toEqual(expect.arrayContaining(['doctor', 'prepare', 'up', 'check', 'backup', 'restore-check', 'drill']));
    for (const step of ['schedule-backup --to', '--every 60', 'unschedule-backup', 'backup-status', 'autostart', 'migrate-data-folder', 'update --from', '-- status']) {
      expect(guide, step).toContain(step);
    }
    expect(guide).toContain('C:\\SRE-data');
    expect(unmarkedLane2Lines(guide, EXISTING_COMMANDS)).toEqual([]);
    // …and the mark check is not empty: an unmarked use is caught.
    expect(unmarkedLane2Lines('## Part X\n\nType:\n```\npnpm run store-computer -- autostart\n```\n', [])).toEqual(['line 5: autostart']);
  });

  it('every sheet exists in English and Tamil, with the same id and the same numbered steps, each naming the other', () => {
    for (const id of SHEETS) {
      expect(existsSync(`${SOP_DIR}/${id}.en.md`), `${id}.en.md`).toBe(true);
      expect(existsSync(`${SOP_DIR}/${id}.ta.md`), `${id}.ta.md`).toBe(true);
      const en = sheetText(id, 'en');
      const ta = sheetText(id, 'ta');
      const sheetId = /SOP-\d\d/.exec(en)?.[0];
      expect(sheetId, id).toBeDefined();
      expect(ta, id).toContain(sheetId!);
      expect(numberedSteps(ta), id).toEqual(numberedSteps(en));
      expect(numberedSteps(en).length, id).toBeGreaterThanOrEqual(4);
      expect(en, id).toContain(`${id}.ta.md`);
      expect(ta, id).toContain(`${id}.en.md`);
      expect(tamilShare(ta), `${id}.ta.md is written in Tamil`).toBeGreaterThan(0.6);
      expect(tamilShare(en), `${id}.en.md is written in English`).toBe(0);
    }
  });

  it('no sheet is left without its other language, and the guide and the sop index list both files of every sheet', () => {
    const files = readdirSync(SOP_DIR).filter((f) => /^sop-.*\.md$/.test(f));
    for (const f of files) {
      const base = f.replace(/\.(en|ta)\.md$/, '');
      expect(SHEETS as readonly string[], f).toContain(base);
    }
    const index = readFileSync(`${SOP_DIR}/README.md`, 'utf8');
    for (const id of SHEETS) {
      for (const lang of ['en', 'ta']) {
        expect(guide, `guide lists ${id}.${lang}.md`).toContain(`docs\\sop\\${id}.${lang}.md`);
        expect(index, `index lists ${id}.${lang}.md`).toContain(`${id}.${lang}.md`);
      }
    }
  });

  it('the sheets say what the decisions say: old till only, mirror keying with no new bill, guest only, and a marked tender step', () => {
    const down = sheetText('sop-01-pc-down', 'en');
    expect(down).toMatch(/Stop keying into the new till/);
    expect(down).toMatch(/time it stopped/);
    expect(down).toMatch(/OB-255/);
    const mirror = sheetText('sop-02-mirror-keying', 'en');
    const mirrorTa = sheetText('sop-02-mirror-keying', 'ta');
    expect(mirror).toMatch(/That is the customer's only bill/);
    expect(mirror).toMatch(/Never give the customer anything from the new till/);
    expect(mirror).toMatch(/Guest sale only/);
    expect(mirrorTa).toMatch(/மொபைல் எண்/);
    expect(mirror).toMatch(/not in the catalogue/);
    // The tender and cash-up step is lane 1's question: both languages agree on whether it is still the placeholder.
    expect(mirror.includes('PLACEHOLDER — LANE 1')).toBe(mirrorTa.includes('PLACEHOLDER — LANE 1'));
    const evening = sheetText('sop-03-owner-evening-check', 'en');
    for (const label of ['Running both', 'Enter a day', 'Save the day', 'Sign the day', 'Which one was wrong']) expect(evening).toContain(label);
    const eveningTa = sheetText('sop-03-owner-evening-check', 'ta');
    for (const label of ['இரண்டையும் இயக்குதல்', 'ஒரு நாளைப் பதிவு செய்', 'நாளைச் சேமி', 'நாளில் கையெழுத்திடு', 'எது தவறு']) expect(eveningTa).toContain(label);
  });

  it('the evening sheet uses the migration screen\'s own words, in both languages', () => {
    const screen = readFileSync('apps/web-erp/web/migration.html', 'utf8');
    for (const label of ['Running both', 'Enter a day', 'Save the day', 'Sign the day']) expect(screen).toContain(label);
    const strings = readFileSync('apps/web-erp/web/migration.js', 'utf8');
    for (const label of ['இரண்டையும் இயக்குதல்', 'ஒரு நாளைப் பதிவு செய்', 'நாளைச் சேமி', 'நாளில் கையெழுத்திடு', 'எது தவறு']) expect(strings).toContain(label);
  });

  it('the guide carries the locked-PC, UPS and memory steps (OB-251 · OB-250 · OB-247)', () => {
    // OB-251: one admin, a standard cashier account, the folder lock with its check, BitLocker with a printed key.
    expect(guide).toMatch(/net localgroup Administrators/);
    expect(guide).toMatch(/Standard User/);
    expect(guide).toContain('icacls C:\\SRE /inheritance:r /grant:r');
    expect(guide).toContain('icacls C:\\SRE\\infra\\compose\\.env.real');
    expect(guide).toMatch(/BUILTIN\\Users/);
    expect(guide).toMatch(/Print the recovery key/);
    expect(guide).toMatch(/Never photograph the recovery key/);
    expect(guide).toContain('manage-bde -status C:');
    // OB-250: the UPS model and run time, and the power-cut test with a clean shutdown.
    expect(guide).toMatch(/UPS's own plug out of the wall/);
    expect(guide).toMatch(/Quit Docker Desktop/);
    // OB-247: the .wslconfig limit from the lane C audit, and the Task Manager photo in a practice hour.
    for (const v of ['memory=3GB', 'swap=4GB', 'autoMemoryReclaim=dropCache', 'wsl --shutdown']) expect(guide).toContain(v);
    expect(guide).toMatch(/practice hour/);
    // Names are never invented: the steps that need one say STOP AND ASK.
    expect((guide.match(/STOP AND ASK/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
