// An INSTALLED store PC for the CR-01 step 3d (updater) and 3e (rollback drill) tests: version 1.0.2005 in C:\SRE, its
// data in C:\SRE-data, its three services running, the updater set up by `setup`, the hourly backup scheduled to
// G:\sre-real, and GitHub offering version 1.0.2012, signed. Robocopy, SRE-Setup.exe, the installed program's own
// `setup` and `services-status`, the till and the database's applied steps are pretended. NOTHING HERE IS REAL WINDOWS.

import { expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { win32 } from 'node:path';
import { main, type Deps, type SpawnResult } from '../../scripts/lib/store-computer.mjs';
import { SERVICES } from '../../scripts/lib/store-computer-services.mjs';
import { KEPT_FOLDER } from '../../scripts/lib/store-pc-updater.mjs';
import { releaseTag, sha256Of, signUpdate, updateRecord } from '../../scripts/lib/store-pc-update.mjs';
import { world, type World } from './store-computer-world';
import { settingsIn, storePc, type PretendWin } from './store-pc-windows';

export const keys = () => {
  const k = generateKeyPairSync('ed25519');
  return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: k.publicKey.export({ type: 'spki', format: 'pem' }) as string };
};
export const SHOP_KEY = keys();
export const OTHER_KEY = keys();
export const NEW = '1.0.2012';
export const OLD = '1.0.2005';
export const COMMIT = 'a'.repeat(40);
export const SETUP_BYTES = Buffer.from('pretend SRE-Setup.exe 1.0.2012');
export const KEPT = `C:\\${KEPT_FOLDER}\\${OLD}`;
export const TAG_URL = `https://api.github.com/repos/rchezhian81-prog/Hyper-Market-OS-ERP/releases/tags/${releaseTag(NEW)}`;
export const RECORD_URL = 'https://api.github.com/assets/record';
export const SETUP_URL = 'https://api.github.com/assets/setup';

export interface Pc {
  w: World; d: Deps; win: PretendWin;
  /** What the pretend PC does — changed per test. */
  how: {
    open: string[] | 'silent';
    setupStatus: number;
    newStatusOk: boolean;
    oldSetupOk: boolean;
    record: Record<string, unknown>;
    served: Buffer;
    downloads: string[];
    ran: string[][];
    /** The database's applied steps (what the PC's own PostgreSQL says), grown by a new version's setup. */
    dbSteps: string[];
    /** The new version's own setup, when run again (the drill's roll forward). */
    newSetupOk: boolean;
  };
}

/**
 * An installed store PC on version 1.0.2005 (C:\SRE, its data in C:\SRE-data), its three services running, the updater
 * set up by `setup`, the hourly backup scheduled to G:\sre-real, and GitHub offering version 1.0.2012, signed.
 */
export async function installedPc(): Promise<Pc> {
  const w = world();
  const fields = { version: NEW, commit: COMMIT, sha256: sha256Of(SETUP_BYTES) };
  const how: Pc['how'] = {
    open: [], setupStatus: 0, newStatusOk: true, oldSetupOk: true,
    record: updateRecord({ ...fields, signature: signUpdate(fields, SHOP_KEY.priv) }) as unknown as Record<string, unknown>,
    served: SETUP_BYTES, downloads: [], ran: [], dbSteps: ['0001_first.sql'], newSetupOk: true,
  };
  /** The PC's own deps, once made below (the pretend GitHub writes its download through them). */
  const self: { d?: Deps } = {};
  const pc = storePc(w, {
    web: async (url: string) => {
      const body = url === TAG_URL ? JSON.stringify({ tag_name: releaseTag(NEW), assets: [{ name: 'SRE-Setup.exe', url: SETUP_URL }, { name: 'update.json', url: RECORD_URL }] })
        : url === RECORD_URL ? JSON.stringify(how.record) : undefined;
      return { status: body === undefined ? 404 : 200, text: async () => body ?? '' };
    },
    download: async (url: string, _h: Record<string, string>, file: string) => {
      how.downloads.push(url);
      if (url !== SETUP_URL) return { status: 404 };
      realFs(self.d!).writeFileSync(file, how.served);
      return { status: 200 };
    },
  } as Partial<Deps>);
  const { win } = pc;
  const base = pc.d;
  const fetchBase = base.fetch;
  const spawnBase = base.spawn;
  const d: Deps = {
    ...base,
    freeDiskBytes: () => 200 * 1024 ** 3,
    fetch: (async (url: string) => {
      if (url.endsWith('/update/open-shifts')) {
        if (how.open === 'silent') throw new Error('ECONNREFUSED');
        return { ok: true, json: async () => ({ kind: 'sre-open-shifts-v1', open: (how.open as string[]).map((tillId) => ({ tillId })) }) };
      }
      if (url.endsWith('/pos/')) return { ok: true, json: async () => ({}) };
      return fetchBase(url);
    }) as Deps['fetch'],
    spawn: ((cmd: string, args: readonly string[], o: Record<string, unknown> = {}): SpawnResult => {
      const exe = win32.basename(cmd).toLowerCase();
      if (exe === 'robocopy.exe') {
        how.ran.push(['robocopy', args[0]!, args[1]!]);
        realFs(d).rmSync(args[1]!, { recursive: true, force: true });
        realFs(d).cpSync(args[0]!, args[1]!, { recursive: true });
        return { status: 1 }; // robocopy: 1 = files copied
      }
      if (exe === 'sre-setup.exe') {
        how.ran.push(['SRE-Setup.exe', ...args]);
        for (const s of SERVICES_IN_ORDER) { const x = win.services.get(s); if (x) x.state = 'stopped'; }
        if (how.setupStatus !== 0) return { status: how.setupStatus };
        // The new version's files replace the program; its `setup` starts the services again.
        d.fs.writeFileSync('C:\\SRE\\release.json', JSON.stringify({ kind: 'sre-store-pc-release', version: NEW }));
        d.fs.writeFileSync('C:\\SRE\\db\\migrations\\0002_new.sql', 'create table if not exists t2 (id int);');
        d.fs.writeFileSync('C:\\SRE\\new-only.txt', 'a file only the new version has');
        if (!how.dbSteps.includes('0002_new.sql')) how.dbSteps.push('0002_new.sql');
        for (const s of SERVICES_IN_ORDER) { const x = win.services.get(s); if (x) x.state = 'running'; }
        return { status: 0 };
      }
      if (exe === 'node.exe' && String(args[0]).endsWith('store-computer.mjs')) {
        const version = JSON.parse(d.fs.readFileSync('C:\\SRE\\release.json', 'utf8')).version as string;
        how.ran.push([`node(${version})`, ...args.slice(1)]);
        if (args[1] === 'services-status') return { status: version === NEW && !how.newStatusOk ? 1 : 0, stdout: version === NEW && !how.newStatusOk ? 'FIX      SRE Retail OS - office API (SRE-API): stopped\r\n' : 'OK\r\n' };
        if (args[1] === 'setup') {
          if (version === NEW ? !how.newSetupOk : !how.oldSetupOk) return { status: 1, stdout: 'NOT STARTED — the shop database did not start.\r\n' };
          for (const s of SERVICES_IN_ORDER) { const x = win.services.get(s); if (x) x.state = 'running'; }
          return { status: 0, stdout: 'SETUP DONE.\r\n' };
        }
        return { status: 0 }; // check-update
      }
      // The database's applied steps, as the PC's own PostgreSQL answers the drill's question.
      if (exe === 'psql.exe' && typeof o['input'] === 'string' && o['input'].includes("'MIG|'") && !o['input'].includes("'ROWS|'") && !o['input'].includes('pg_export_snapshot')) {
        return { status: 0, stdout: `${how.dbSteps.map((m) => `MIG|${m}`).join('\n')}\n` };
      }
      return spawnBase(cmd, args, o);
    }) as Deps['spawn'],
  };
  self.d = d;
  expect(await main(['prepare'], d)).toBe(0);
  const fs = d.fs;
  for (const dir of ['C:\\SRE\\runtime\\pgsql\\bin', 'C:\\SRE\\runtime\\winsw', 'C:\\SRE\\runtime\\node', 'C:\\SRE\\scripts', 'C:\\SRE\\services\\api\\dist', 'C:\\SRE\\edge\\store-edge\\dist', 'C:\\SRE\\db\\migrations', 'C:\\SRE-data\\till', 'G:\\sre-real']) fs.mkdirSync(dir, { recursive: true });
  for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe', 'pg_dump.exe']) fs.writeFileSync(`C:\\SRE\\runtime\\pgsql\\bin\\${exe}`, 'pretend');
  fs.writeFileSync('C:\\SRE\\runtime\\winsw\\WinSW-x64.exe', 'pretend');
  fs.writeFileSync('C:\\SRE\\runtime\\node\\node.exe', 'pretend node');
  fs.writeFileSync('C:\\SRE\\scripts\\store-computer.mjs', '// the tool');
  fs.writeFileSync('C:\\SRE\\scripts\\store-computer-service.mjs', '// launcher');
  fs.writeFileSync('C:\\SRE\\services\\api\\dist\\start.js', '// api');
  fs.writeFileSync('C:\\SRE\\edge\\store-edge\\dist\\start.js', '// edge');
  fs.writeFileSync('C:\\SRE\\db\\migrations\\0001_first.sql', 'create table if not exists t1 (id int);');
  fs.writeFileSync('C:\\SRE\\release.json', JSON.stringify({ kind: 'sre-store-pc-release', version: OLD }));
  fs.writeFileSync('C:\\SRE\\release-signing.pub', SHOP_KEY.pub);
  const s = settingsIn(fs);
  fs.writeFileSync('C:\\SRE-data\\till\\till.env', `EDGE_TENANT_ID=${s['EDGE_TENANT_ID']}\nPACK_SIGNING_KEY=${s['PACK_SIGNING_KEY']}\nEDGE_LANE_ID=lane-1\nEDGE_LANE_PORT=8090\nEDGE_SCREEN_PORT=8091\nEDGE_DATA_DIR=C:\\SRE-data\\till\\edge-data\n`);
  fs.mkdirSync('C:\\SRE-data\\till\\edge-data', { recursive: true });
  expect(await main(['setup'], d)).toBe(0);
  // The shop's own records in the PC's database (a pretend: a few sales), so a backup has rows and money to reconcile.
  win.nativeDbs['sre_real'] = { tables: { event_ledger: 4, products: 12, schema_migrations: 1 }, values: { SaleCommitted: 100_000 }, maxSeq: 4, migrations: ['0001_first.sql'] };
  expect(await main(['schedule-backup', '--to', 'G:\\sre-real'], d)).toBe(0);
  w.said.length = 0;
  how.ran.length = 0;
  return { w, d, win, how };
}
export const SERVICES_IN_ORDER = [SERVICES.database, SERVICES.api, SERVICES.till];
/** The pretend PC's file system is Node's own behind a Windows-path map: every Node call is there. */
export const realFs = (d: Deps): typeof import('node:fs') => d.fs as unknown as typeof import('node:fs');
