import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepare } from '../../scripts/lib/store-computer.mjs';
import { ALERT_RULES, collectStatus, status } from '../../scripts/lib/store-computer-status.mjs';
import { recordBackupOutcome } from '../../scripts/lib/store-computer-recovery.mjs';
import { judgeStoreComputerStatus, STALE_AFTER_MINUTES, watchStoreComputerStatus } from '../../edge/store-edge/src/store-computer-status-file';
import { world, type World } from '../support/store-computer-world';

/**
 * Audit row 6 (lane B M1 · lane C C-19 · P-08 · P-03) — an alert the owner SEES on the store PC with no internet and no
 * message provider. `store-computer status` checks four things and prints a RED banner when any is wrong: the last
 * backup older than 2 hours (OB-249); till items unsent for more than 15 minutes (§32 cloud RPO; packages/ops
 * DEFAULT_THRESHOLDS) or any dead letter (MONITORING-AND-ALERTS: "any dead letter"); the disk 85% full (the same doc); a
 * container down. It writes a status file the till's box reads and hands to the office screens with its sync status.
 * Every alert in English and Tamil. A missing, unreadable or stale status file is red too — never an all-clear.
 */

const MIN = 60_000;
const at = (w: World): number => w.deps.now().getTime();

/** A store computer with a till installed in the data folder, a till that answers, and the containers up. */
async function healthy(): Promise<World & { lane: { body: Record<string, unknown> | undefined } }> {
  const w = world();
  expect(await prepare(w.deps)).toBe(0);
  const till = join(w.data, 'till');
  mkdirSync(join(till, 'edge-data'), { recursive: true });
  // As till:install writes it on the real copy (OB-248 · OB-252): the mirror pilot with guest sales only.
  writeFileSync(join(till, 'till.env'), `EDGE_DATA_DIR=${join(till, 'edge-data')}\nEDGE_LANE_PORT=8090\nEDGE_GUEST_SALES_ONLY=1\nEDGE_MIRROR_PILOT=1\n`);
  w.docker.ownRunning = ['db', 'api'];
  const lane: { body: Record<string, unknown> | undefined } = { body: { cloud: 'online', unsent: 0, deadLettered: 0, lastSentAt: new Date(at(w) - MIN).toISOString() } };
  const readyz = w.deps.fetch;
  w.deps = {
    ...w.deps,
    fetch: async (url: string) => (url.endsWith('/lane/sync-status')
      ? (lane.body === undefined ? Promise.reject(new Error('ECONNREFUSED')) : { ok: true, json: async () => lane.body })
      : readyz(url)),
  };
  // A good backup half an hour ago.
  recordBackupOutcome({ ...w.deps, now: () => new Date(at(w) - 30 * MIN) }, (await import('../../scripts/lib/store-computer.mjs')).resolveLayout(w.deps), {
    kind: 'automatic', to: '/drive', ok: true, manifestPath: '/drive/m.json',
    manifest: { backupId: 'sre-real-backup-x', timeTakenMs: 1000, parts: { database: { sizeBytes: 1 }, files: { sizeBytes: 1 }, settings: { sizeBytes: 1 } } },
  });
  w.said.length = 0;
  return Object.assign(w, { lane });
}
const codes = async (w: World): Promise<string[]> => (await collectStatus(w.deps)).alerts.map((a) => a.code);

describe('store-computer status — the four checks', () => {
  it('all well: ALL OK, exit 0, a status file the box can read, and nothing red', async () => {
    const w = await healthy();
    expect(await status(w.deps)).toBe(0);
    const out = w.said.join('\n');
    expect(out).toMatch(/OK {3}Backup {5}last good backup 30 min ago/);
    expect(out).toMatch(/OK {3}Till {7}everything the till saved has been sent; no dead letters/);
    expect(out).toMatch(/OK {3}Disk {7}200\.0 GB free of 476\.0 GB \(58% full\)/);
    expect(out).toMatch(/OK {3}Containers the database and the API are running/);
    expect(out).toMatch(/^ALL OK — nothing needs you\.$/m);
    const file = JSON.parse(readFileSync(join(w.data, 'status', 'store-computer-status.json'), 'utf8')) as Record<string, unknown>;
    expect(file).toMatchObject({ kind: 'sre-store-computer-status', version: 1, overall: 'ok', alerts: [] });
    expect(existsSync(join(w.data, 'status', 'store-computer-status.json.tmp'))).toBe(false);
  });

  it(`the backup: red when the last good one is older than ${ALERT_RULES.backupMaxAgeMinutes / 60} hours, or there has never been one`, async () => {
    const w = await healthy();
    expect(await codes(w)).toEqual([]);
    const base = at(w);
    const later = { ...w.deps, now: () => new Date(base + 91 * MIN) }; // 30 + 91 = 121 minutes
    w.deps = later;
    const s = await collectStatus(w.deps);
    expect(s.alerts.map((a) => a.code)).toEqual(['backup_old']);
    expect(s.alerts[0]!.en).toMatch(/The last backup was 2 h 1 min ago — more than 2 hours\. Automatic backup is not set up\./);
    expect(s.alerts[0]!.ta).toMatch(/கடைசி காப்புப் பிரதி 2 மணி 1 நிமிடம் முன்பு/);
    const fresh = world();
    expect(await prepare(fresh.deps)).toBe(0);
    expect((await collectStatus(fresh.deps)).alerts.map((a) => a.code)).toContain('backup_never');
  });

  it(`the till: red for any dead letter, and for unsent items with nothing sent for over ${ALERT_RULES.unsentStuckMinutes} minutes; not for items on their way`, async () => {
    const w = await healthy();
    w.lane.body = { cloud: 'online', unsent: 3, deadLettered: 0, lastSentAt: new Date(at(w) - 5 * MIN).toISOString() };
    expect(await codes(w)).toEqual([]);
    w.lane.body = { cloud: 'offline', unsent: 3, deadLettered: 0, lastSentAt: new Date(at(w) - 16 * MIN).toISOString() };
    const stuck = await collectStatus(w.deps);
    expect(stuck.alerts.map((a) => a.code)).toEqual(['unsent_stuck']);
    expect(stuck.alerts[0]!.en).toBe('3 sale item(s) are saved on the till but not sent for 16 min (the till cannot reach the books). They are safe; the books are behind.');
    expect(stuck.alerts[0]!.ta).toMatch(/16 நிமிடம் அனுப்பப்படவில்லை/);
    w.lane.body = { cloud: 'not_configured', unsent: 2, deadLettered: 1, lastSentAt: null };
    const both = await collectStatus(w.deps);
    expect(both.alerts.map((a) => a.code)).toEqual(['dead_letters', 'unsent_stuck']);
    expect(both.alerts[1]!.en).toMatch(/nothing has ever been sent \(the till has no link to the books set up\)/);
    w.lane.body = undefined;
    expect(await codes(w)).toEqual(['till_not_running']);
  });

  it('the disk: red at 85% full; the containers: red when the database or the API is not running, or Docker is stopped', async () => {
    const w = await healthy();
    w.deps = { ...w.deps, diskSpace: () => ({ free: 15 * 1024 ** 3, total: 100 * 1024 ** 3 }) };
    const disk = await collectStatus(w.deps);
    expect(disk.alerts.map((a) => a.code)).toEqual(['disk_full']);
    expect(disk.alerts[0]!.en).toMatch(/85% full \(15\.0 GB free\)/);
    w.deps = { ...w.deps, diskSpace: () => { throw new Error('EIO'); } };
    expect(await codes(w)).toEqual(['disk_not_known']);
    const v = await healthy();
    v.docker.ownRunning = ['db'];
    const down = await collectStatus(v.deps);
    expect(down.alerts.map((a) => a.code)).toEqual(['container_down']);
    expect(down.alerts[0]!.en).toMatch(/Not running: the API \(the books\)\. Run: pnpm run store-computer -- up/);
    v.docker.running = false;
    expect(await codes(v)).toEqual(['docker_not_running']);
  });

  it('red prints the banner, every alert in words, exit 1 — and the same alerts reach the status file in English and Tamil', async () => {
    const w = await healthy();
    w.docker.ownRunning = [];
    w.lane.body = { cloud: 'online', unsent: 0, deadLettered: 4, lastSentAt: null };
    expect(await status(w.deps)).toBe(1);
    const out = w.said.join('\n');
    expect(out).toMatch(/^████ RED — SOMETHING NEEDS YOU ████$/m);
    expect(out).toMatch(/• 4 item\(s\) the books refused are waiting for a person to look at them\./);
    expect(out).toMatch(/The office screen shows the same red banner\./);
    const file = JSON.parse(readFileSync(join(w.data, 'status', 'store-computer-status.json'), 'utf8')) as { overall: string; alerts: { code: string; en: string; ta: string }[] };
    expect(file.overall).toBe('red');
    expect(file.alerts.map((a) => a.code)).toEqual(['dead_letters', 'container_down']);
    for (const a of file.alerts) expect(a.ta).toMatch(/[஀-௿]/);
    // --quiet (what the 15-minute task runs) says nothing, but still writes the file and the exit code.
    w.said.length = 0;
    expect(await status(w.deps, { quiet: true })).toBe(1);
    expect(w.said).toEqual([]);
  });
});

describe('store-computer status — the till\'s mirror settings (OB-248 · OB-252 · OB-256)', () => {
  it('both on: OK, said by name; one off or missing: RED, in both languages; no till yet: "not known", never red', async () => {
    const w = await healthy();
    const mirror = async () => (await collectStatus(w.deps)).checks.find((c) => c.name === 'Mirror');
    expect(await mirror()).toEqual({ name: 'Mirror', ok: true, detail: 'the till runs the mirror pilot with guest sales only (EDGE_MIRROR_PILOT=1, EDGE_GUEST_SALES_ONLY=1)' });
    expect(await status(w.deps)).toBe(0);
    expect(w.said.join('\n')).toMatch(/OK {3}Mirror {5}the till runs the mirror pilot with guest sales only \(EDGE_MIRROR_PILOT=1, EDGE_GUEST_SALES_ONLY=1\)/);
    const env = join(w.data, 'till', 'till.env');
    for (const text of [`EDGE_DATA_DIR=${join(w.data, 'till', 'edge-data')}\nEDGE_LANE_PORT=8090\nEDGE_GUEST_SALES_ONLY=1\n`, `EDGE_DATA_DIR=${join(w.data, 'till', 'edge-data')}\nEDGE_LANE_PORT=8090\nEDGE_GUEST_SALES_ONLY=0\nEDGE_MIRROR_PILOT=1\n`]) {
      writeFileSync(env, text);
      const s = await collectStatus(w.deps);
      expect(s.checks.find((c) => c.name === 'Mirror')?.ok).toBe(false);
      const alert = s.alerts.find((a) => a.code === 'mirror_settings_off')!;
      expect(alert.en).toBe("The till's settings do not say the mirror pilot with guest sales only. Ring nothing more on the new till, and install the till again (owner guide Part 13).");
      expect(alert.ta).toMatch(/[஀-௿]/);
      expect(judgeStoreComputerStatus(JSON.stringify(s), at(w)).alerts).toContainEqual(alert);
    }
    expect((await mirror())?.detail).toMatch(/EDGE_MIRROR_PILOT=1, EDGE_GUEST_SALES_ONLY=0/);
    const fresh = world();
    expect(await prepare(fresh.deps)).toBe(0);
    expect((await collectStatus(fresh.deps)).checks.find((c) => c.name === 'Mirror')).toEqual({ name: 'Mirror', ok: null, detail: 'not known — no till is installed on this computer yet' });
  });
});

describe("the till's box hands the check to the office screens (edge/store-edge/src/store-computer-status-file.ts)", () => {
  const NOW = Date.parse('2026-10-20T10:00:00Z');
  const file = (over: Record<string, unknown> = {}): string => JSON.stringify({ kind: 'sre-store-computer-status', version: 1, checkedAt: '2026-10-20T09:50:00.000Z', overall: 'ok', alerts: [], ...over });

  it('a fresh file with no alerts is ok; with alerts it is red and carries them, word for word, in both languages', () => {
    expect(judgeStoreComputerStatus(file(), NOW)).toEqual({ known: true, checkedAt: '2026-10-20T09:50:00.000Z', stale: false, overall: 'ok', alerts: [] });
    const red = judgeStoreComputerStatus(file({ alerts: [{ code: 'disk_full', en: 'Disk 90% full.', ta: 'வட்டு 90% நிரம்பியுள்ளது.' }] }), NOW);
    expect(red).toMatchObject({ overall: 'red', alerts: [{ code: 'disk_full', en: 'Disk 90% full.', ta: 'வட்டு 90% நிரம்பியுள்ளது.' }] });
  });

  it(`no file, an unreadable one, or one older than ${STALE_AFTER_MINUTES} minutes is RED — a check that stopped is never an all-clear`, () => {
    expect(judgeStoreComputerStatus(undefined, NOW)).toMatchObject({ known: false, overall: 'red', alerts: [{ code: 'check_never_ran' }] });
    expect(judgeStoreComputerStatus('{not json', NOW)).toMatchObject({ known: false, overall: 'red', alerts: [{ code: 'check_unreadable' }] });
    expect(judgeStoreComputerStatus(JSON.stringify({ kind: 'other' }), NOW)).toMatchObject({ overall: 'red', alerts: [{ code: 'check_unreadable' }] });
    const stale = judgeStoreComputerStatus(file({ checkedAt: '2026-10-20T09:29:00.000Z' }), NOW);
    expect(stale).toMatchObject({ known: true, stale: true, overall: 'red', alerts: [{ code: 'check_stale' }] });
    expect(stale.alerts[0]!.en).toMatch(/last ran 31 minutes ago/);
    expect(stale.alerts[0]!.ta).toMatch(/31 நிமிடங்களுக்கு முன்/);
    // An alert that is not well formed is shown as "cannot be read", never dropped.
    expect(judgeStoreComputerStatus(file({ alerts: [{ code: 'x', en: '' }] }), NOW).alerts.map((a) => a.code)).toEqual(['check_unreadable']);
  });

  it('the file store-computer status writes is the file the box accepts (one contract, both sides)', async () => {
    const w = await healthy();
    w.docker.ownRunning = ['api'];
    await status(w.deps, { quiet: true });
    const text = readFileSync(join(w.data, 'status', 'store-computer-status.json'), 'utf8');
    const seen = judgeStoreComputerStatus(text, at(w) + MIN);
    expect(seen).toMatchObject({ known: true, stale: false, overall: 'red', alerts: [{ code: 'container_down' }] });
  });

  it('the box re-reads the file off the sale path and answers from memory; a file that disappears turns it red', async () => {
    let text: string | undefined = file();
    const watch = watchStoreComputerStatus({ file: '/x', read: async () => { if (text === undefined) throw new Error('ENOENT'); return text; }, now: () => NOW, everyMs: 60_000 });
    await watch.refresh();
    expect(watch.current().overall).toBe('ok');
    text = undefined;
    expect(watch.current().overall).toBe('ok'); // nothing re-read yet: the answer comes from memory, never a read per request
    await watch.refresh();
    expect(watch.current()).toMatchObject({ overall: 'red', alerts: [{ code: 'check_never_ran' }] });
    watch.stop();
  });
});
