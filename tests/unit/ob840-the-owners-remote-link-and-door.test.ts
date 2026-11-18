import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type Deps, type SpawnResult } from '../../scripts/lib/store-computer.mjs';
import {
  REMOTE_LINK_STATUS_KIND, cleanHost, linkWords, nextBackoff, readLinkSettings, remoteLinkPaths, runRemoteLink, sshArgs, sshProblem,
  tillEnvWithRemote, forwardTaken, type LinkSettings,
} from '../../scripts/lib/store-computer-remote.mjs';
import { REMOTE_LINK_SERVICE, serviceSid, SERVICE_ORDER } from '../../scripts/lib/store-computer-services.mjs';
import { linkCode, pairingCode, sameCode, publicKeyCore } from '../../scripts/lib/remote-link-code.mjs';
import { ask, pendingIn, MAX_PENDING } from '../../infra/remote-access/link-desk.mjs';
import { readyPc, type PretendWin } from '../support/store-pc-windows';
import {
  REMOTE_ACCESS_KIND, REMOTE_API, REMOTE_SCREENS, allowedRemotely, readRemoteAccess, remoteLinkView, remotePathOf,
} from '../../edge/store-edge/src/remote-door';
import { OFFICE_CALL_PREFIX, OfficeCallNonces, checkOfficeCall, officeCallKey, sealOfficeCall, type OfficeCallRequest } from '../../packages/identity/src/office-call-seal';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { withOfficeCalls } from '../../services/identity/src/office-call-authenticator';
import { presentRequestStatus, type ApprovalRequestView } from '../../apps/web-erp/src/approvals-session';

/**
 * **OB-840 · ADR-0035 — the owner's remote link (store PC), the relay's pairing desk, and the remote door's own rules.**
 * The pieces each side decides by itself, proven without a network: the codes both sides print; the ssh line's exact
 * arguments; the store PC's setup (pins only what gives the owner's link code; makes its own key and sends only the PUBLIC
 * half; installs the link OFF-by-default service under its own account); the link's words for Today; the door's paths.
 * The store PC is a PRETEND Windows here (tests/support/store-pc-windows.ts); nothing ran on real Windows.
 */

const sshKeyLine = (comment = ''): string => {
  const type = Buffer.from('ssh-ed25519');
  const len = (b: Buffer): Buffer => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return l; };
  const key = randomBytes(32);
  return `ssh-ed25519 ${Buffer.concat([len(type), type, len(key), key]).toString('base64')}${comment === '' ? '' : ` ${comment}`}`;
};
const realm = generateKeyPairSync('rsa', { modulusLength: 2048 });
/** The first line of a private key file, built from parts so no key-shaped text sits in the source (secret scan). */
const PRIVATE_HEAD = ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----'].join(' ');
const JWKS = { keys: [{ ...(realm.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', use: 'sig', alg: 'RS256' }] };

describe('the two codes a person compares by eye', () => {
  it('the link code covers the server\'s ssh key AND the sign-in key: either changed, a different code', () => {
    const host = sshKeyLine('sre-relay');
    const code = linkCode([host], JWKS)!;
    expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    expect(linkCode([host.replace(' sre-relay', ' another comment')], JWKS)).toBe(code); // the comment is not the key
    expect(linkCode([sshKeyLine()], JWKS)).not.toBe(code);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(linkCode([host], { keys: [{ ...(other.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1' }] })).not.toBe(code);
    expect(linkCode([], JWKS)).toBeUndefined();
    expect(linkCode([host], { keys: [] })).toBeUndefined();
    expect(sameCode(code.toLowerCase().replace(/-/g, ' '), code)).toBe(true);
    expect(sameCode('', '')).toBe(false);
  });

  it('the pairing code is the public key\'s; a line that is not a public key has none', () => {
    const k = sshKeyLine('sre-store-pc');
    expect(pairingCode(k)).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(pairingCode(k)).toBe(pairingCode(publicKeyCore(k)));
    expect(pairingCode(PRIVATE_HEAD)).toBeUndefined();
  });
});

describe('the relay\'s pairing desk takes a PUBLIC ed25519 key only, and keeps at most five waiting', () => {
  it('writes the request with its code; refuses anything else; caps the queue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-link-desk-'));
    const write = (code: string, rec: unknown): void => { writeFileSync(join(dir, `${code}.json`), JSON.stringify(rec)); };
    const now = Date.parse('2026-11-18T06:00:00Z');
    const key = sshKeyLine('sre-store-pc');
    const one = ask(JSON.stringify({ publicKey: key }), '203.0.113.9', now, pendingIn(dir, now), write);
    expect(one.status).toBe(202);
    expect(one.body['pairingCode']).toBe(pairingCode(key));
    expect(pendingIn(dir, now)).toEqual([expect.objectContaining({ code: pairingCode(key), publicKey: publicKeyCore(key) })]);
    expect(ask(JSON.stringify({ publicKey: 'ssh-rsa AAAAB3NzaC1yc2E=' }), 'x', now, [], write).status).toBe(400);
    expect(ask(JSON.stringify({ publicKey: PRIVATE_HEAD }), 'x', now, [], write).status).toBe(400);
    expect(ask('not json', 'x', now, [], write).status).toBe(400);
    for (let i = 0; i < MAX_PENDING; i += 1) ask(JSON.stringify({ publicKey: sshKeyLine() }), 'x', now, pendingIn(dir, now), write);
    expect(pendingIn(dir, now).length).toBe(MAX_PENDING);
    expect(ask(JSON.stringify({ publicKey: sshKeyLine() }), 'x', now, pendingIn(dir, now), write).status).toBe(429);
    // Half an hour later every request has gone; nothing was ever trusted by being asked.
    expect(pendingIn(dir, now + 31 * 60_000)).toEqual([]);
  });
});

describe('the ssh line: exactly one reverse forward, to this PC\'s loopback door, with the pinned key and nothing else', () => {
  const cfg = { host: 'office.example.in', sshPort: 2222, user: 'sre-link', listenPort: 18095, doorPort: 8095 };
  const paths = { key: 'C:\\SRE-data\\remote-link\\key\\id_ed25519', knownHosts: 'C:\\SRE-data\\remote-link\\known_hosts' };

  it('pins the arguments that keep it narrow', () => {
    const a = sshArgs(cfg, paths);
    const opt = (o: string): boolean => a.some((x, i) => x === o && a[i - 1] === '-o');
    for (const o of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'ForwardAgent=no', 'ForwardX11=no', 'ExitOnForwardFailure=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', `UserKnownHostsFile=${paths.knownHosts}`, 'UpdateHostKeys=no']) {
      expect(opt(o), o).toBe(true);
    }
    expect(a.slice(0, 2)).toEqual(['-F', 'none']);
    expect(a).toContain('-N');
    expect(a.filter((x) => x === '-R')).toHaveLength(1);
    expect(a[a.indexOf('-R') + 1]).toBe('127.0.0.1:18095:127.0.0.1:8095');
    expect(a).not.toContain('-L');
    expect(a).not.toContain('-D');
    expect(a).not.toContain('-A');
    expect(a.at(-1)).toBe('office.example.in');
  });

  it('says what went wrong in the owner\'s words, and dials again after a wait that grows to a minute', () => {
    expect(sshProblem('Host key verification failed.')).toMatch(/not the one pinned/);
    expect(sshProblem('sre-link@x: Permission denied (publickey).')).toMatch(/sre-relay approve-link/);
    expect(sshProblem('ssh: Could not resolve hostname office.example.in')).toMatch(/internet/);
    expect(sshProblem('debug1: Reading configuration data')).toBeUndefined();
    expect(forwardTaken('debug1: remote forward success for: listen 127.0.0.1:18095, connect 127.0.0.1:8095')).toBe(true);
    expect([nextBackoff(5_000, 0), nextBackoff(40_000, 0), nextBackoff(60_000, 0), nextBackoff(60_000, 120_000)]).toEqual([10_000, 60_000, 60_000, 5_000]);
  });

  it('the service keeps its status true: connecting → connected (when the server took the forward) → down, with the reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-link-run-'));
    const status = join(dir, 'status.json');
    const link: LinkSettings = { kind: 'sre-remote-link-v1', ...cfg, key: paths.key, knownHosts: paths.knownHosts, status, ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' };
    expect(readLinkSettings(JSON.stringify(link))).toEqual(link);
    expect(readLinkSettings(JSON.stringify({ ...link, host: 'https://x' }))).toBeUndefined();
    let clock = Date.parse('2026-11-18T06:00:00Z');
    let runs = 0;
    const seen: string[] = [];
    const ran: string[][] = [];
    await runRemoteLink({
      fs: { writeFileSync: (f: string, t: string) => { writeFileSync(f, t); seen.push((JSON.parse(t) as { state: string }).state); } },
      now: () => new Date(clock),
      sleep: async (ms: number) => { clock += ms; },
      stopped: () => runs >= 2,
      every: () => ({ cancel: () => undefined }),
      say: () => undefined,
      runSsh: async (program: string, args: readonly string[], onLine: (l: string) => void) => {
        runs += 1;
        ran.push([program, ...args]);
        if (runs === 1) { onLine('debug1: remote forward success for: listen 127.0.0.1:18095, connect 127.0.0.1:8095'); clock += 90_000; onLine('Timeout, server office.example.in not responding.'); return 255; }
        onLine('sre-link@office.example.in: Permission denied (publickey).');
        return 255;
      },
    }, link);
    expect(seen.slice(0, 4)).toEqual(['connecting', 'connected', 'down', 'connecting']);
    expect(ran[0]![0]).toBe(link.ssh);
    expect(ran[0]!.slice(1)).toEqual(sshArgs(cfg, paths));
    const last = JSON.parse(readFileSync(status, 'utf8')) as { kind: string; state: string };
    expect(last.kind).toBe(REMOTE_LINK_STATUS_KIND);
    expect(last.state).toBe('down'); // stopped by Windows: "not connected since", never "turned off"
  });

  it('the link\'s words: connected; not connected since; turned off; an old "connected" is not believed', () => {
    const now = Date.parse('2026-11-18T06:00:00Z');
    const st = (o: Record<string, unknown>): string => JSON.stringify({ kind: REMOTE_LINK_STATUS_KIND, ...o });
    expect(linkWords(st({ state: 'connected', since: 'X', updatedAt: '2026-11-18T05:59:00Z' }), now)).toMatch(/^connected/);
    expect(linkWords(st({ state: 'connected', since: 'X', updatedAt: '2026-11-18T05:00:00Z' }), now)).toMatch(/^not connected/);
    expect(linkWords(st({ state: 'down', since: '2026-11-18T05:00:00Z', updatedAt: '2026-11-18T05:59:00Z', problem: 'no internet' }), now)).toBe('not connected since 2026-11-18T05:00:00Z — no internet');
    expect(linkWords(st({ state: 'off' }), now)).toBe('turned off');
    expect(linkWords(undefined, now)).toMatch(/has not reported/);
    const shop = (iso: string): string => iso.slice(0, 16).replace('T', ' ');
    expect(remoteLinkView({ doorOn: false, statusText: undefined, nowMs: now, shopTime: shop }).state).toBe('off');
    expect(remoteLinkView({ doorOn: true, statusText: st({ state: 'connected', since: 'x', updatedAt: '2026-11-18T05:59:30Z' }), nowMs: now, shopTime: shop }).en).toBe('Remote access: connected.');
    expect(remoteLinkView({ doorOn: true, statusText: st({ state: 'down', since: '2026-11-18T05:00:00Z', updatedAt: '2026-11-18T05:59:30Z' }), nowMs: now, shopTime: shop }).en).toBe('Remote access: not connected since 2026-11-18 05:00.');
    expect(remoteLinkView({ doorOn: true, statusText: '{"garbage":true}', nowMs: now, shopTime: shop }).state).toBe('not_connected');
  });
});

describe('the remote door\'s own rules (pure)', () => {
  it('reads the pins only for this shop, with a key, from an https identity server', () => {
    const good = { kind: REMOTE_ACCESS_KIND, host: 'office.example.in', issuer: 'https://office.example.in/auth/realms/sre-store', audience: 'sre-retail-os-api', tenantId: 't-1', keys: JWKS };
    expect(readRemoteAccess(JSON.stringify(good), 't-1')).toMatchObject({ ok: true, access: { allowed: 'role:owner', keyCount: 1 } });
    expect(readRemoteAccess(undefined, 't-1')).toMatchObject({ ok: false, problem: /not set up/ });
    expect(readRemoteAccess(JSON.stringify(good), 't-2')).toMatchObject({ ok: false, problem: /another shop/ });
    expect(readRemoteAccess(JSON.stringify({ ...good, issuer: 'http://office.example.in/auth/realms/sre-store' }), 't-1').ok).toBe(false);
    expect(readRemoteAccess(JSON.stringify({ ...good, keys: { keys: [] } }), 't-1').ok).toBe(false);
    expect(readRemoteAccess('{', 't-1').ok).toBe(false);
  });

  it('"4A": the owner only by default; a named person or role only when the setting says so; never somebody with no role here', () => {
    const roles = (u: string): readonly string[] | null => ({ 'u-owner': ['owner'], 'u-mgr': ['store_manager'], 'u-acc': ['accountant'] } as Record<string, readonly string[]>)[u] ?? null;
    expect(allowedRemotely('u-owner', '', roles)).toBe(true);
    expect(allowedRemotely('u-owner', 'role:owner', roles)).toBe(true);
    expect(allowedRemotely('u-mgr', 'role:owner', roles)).toBe(false);
    expect(allowedRemotely('u-mgr', 'role:owner,u-mgr', roles)).toBe(true);
    expect(allowedRemotely('u-x', 'u-x', roles)).toBe(false);
  });

  it('"5A": only Today, the reports and the approvals, their own files, and their calls', () => {
    const shell = (s: string): string => (s === 'manager' ? 'index.html' : `${s}.html`);
    expect(REMOTE_SCREENS).toEqual(['manager', 'reporting', 'approvals']);
    const k = (m: string, u: string): string => remotePathOf(m, u, shell as never).kind;
    expect(k('GET', '/manager/')).toBe('screen');
    expect(k('GET', '/approvals/approvals.html')).toBe('screen');
    expect(k('GET', '/approvals/sre-chrome.js')).toBe('asset');
    expect(k('GET', '/manager/fonts/plus-jakarta-sans-latin.woff2')).toBe('asset');
    expect(k('GET', '/manager/fonts/x.html')).toBe('refused');
    expect(k('GET', '/manager/other/x.woff2')).toBe('refused');
    expect(k('GET', '/approvals')).toBe('redirect');
    expect(k('GET', '/')).toBe('redirect');
    expect(k('GET', '/v1/approvals/requests')).toBe('api');
    expect(remotePathOf('POST', '/v1/approvals/requests/areq-1/decide', shell as never)).toEqual({ kind: 'api', decide: 'areq-1' });
    for (const [m, u] of [['GET', '/pos/'], ['GET', '/update/'], ['POST', '/update/request'], ['GET', '/admin/'], ['GET', '/catalogue/'], ['GET', '/approvals/admin.html'],
      ['GET', '/manager/..%2fpos/index.html'], ['GET', '/manager/../pos/'], ['POST', '/manager/'], ['POST', '/v1/approvals/requests'], ['GET', '/v1/identity/people'],
      ['POST', '/office/sign-in'], ['POST', '/office/privilege/grants'], ['GET', '/v1/approvals/requests/x/decide'], ['GET', '//evil/manager/']] as const) {
      expect(k(m, u), `${m} ${u}`).toBe('refused');
    }
    // Every head-office call through the door is a read, but the one decision.
    expect(REMOTE_API.filter((a) => a.method !== 'GET').map((a) => String(a.path))).toEqual([String(/^\/v1\/approvals\/requests\/[A-Za-z0-9._:-]{1,128}\/decide$/)]);
  });

  it('the Approvals page says a decision was made from outside the shop, beside the name (English and Tamil)', () => {
    const r = { requestId: 'a', kind: 'catalogue_change', status: 'rejected', decidedBy: 'u-owner', decidedVia: 'remote', decisionReason: 'not now' } as unknown as ApprovalRequestView;
    expect(presentRequestStatus('en', r).label).toBe('Rejected by u-owner (from outside the shop): not now');
    expect(presentRequestStatus('ta', r).label).toContain('கடைக்கு வெளியிலிருந்து');
    expect(presentRequestStatus('en', { ...r, decidedVia: undefined } as unknown as ApprovalRequestView).label).toBe('Rejected by u-owner: not now');
  });

  it('a seal from the remote door carries the mark and the relay sign-in\'s methods; the API believes exactly that', async () => {
    const raw = randomBytes(32).toString('base64url');
    const key = officeCallKey(privilegeSealKey(raw));
    const now = Date.parse('2026-11-18T06:00:00Z');
    const req: OfficeCallRequest & { readonly method: 'POST' } = { method: 'POST', path: '/v1/approvals/requests/a/decide', query: {}, body: { decision: 'approved', reason: 'x' }, idempotencyKey: 'k' };
    const seal = sealOfficeCall(key, { tenantId: 't', userId: 'u-owner', branchId: 'S1', request: req, signedInAt: now / 1000 - 60, nowMs: now, remote: { amr: ['pwd', 'otp', 'mfa'] } });
    const auth = withOfficeCalls({ privilegeKey: privilegeSealKey(raw), fallback: () => undefined, now: () => now });
    expect(await auth(seal, req)).toEqual({ tenantId: 't', userId: 'u-owner', branchId: 'S1', authTime: now / 1000 - 60, amr: ['pwd', 'otp', 'mfa'], via: 'remote' });
    // The mark cannot be added to (or taken off) a store seal: the signature covers it.
    const inStore = sealOfficeCall(key, { tenantId: 't', userId: 'u-owner', branchId: 'S1', request: req, signedInAt: now / 1000 - 60, nowMs: now });
    const [payload, sig] = inStore.slice(OFFICE_CALL_PREFIX.length).split('.');
    const marked = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), via: 'remote', amr: ['pwd', 'otp', 'mfa'] })).toString('base64url');
    expect(checkOfficeCall(key, `${OFFICE_CALL_PREFIX}${marked}.${sig}`, req, now, new OfficeCallNonces())).toMatchObject({ ok: false, refusedBecause: 'seal_does_not_match' });
    expect(await auth(inStore, req)).toEqual({ tenantId: 't', userId: 'u-owner', branchId: 'S1', authTime: now / 1000 - 60, amr: ['pin'] });
  });
});

// ── The store PC: `remote-access setup` on a pretend Windows ─────────────────────────────────────────────────────────

const HOST = 'office.example.in';
async function pc(opts: { tenant?: string; codeFor?: 'right' | 'wrong'; openShifts?: string[] } = {}): Promise<{ d: Deps; win: PretendWin; said: string[]; posted: unknown[]; code: string; hostKey: string; run: (...a: string[]) => Promise<number> }> {
  const { w, d, win } = await readyPc();
  const tenant = opts.tenant ?? (d.fs.readFileSync('C:\\SRE-data\\till\\till.env', 'utf8').match(/EDGE_TENANT_ID=(.*)/)![1]!);
  const hostKey = sshKeyLine('sre-relay');
  const code = linkCode([hostKey], JWKS)!;
  for (const exe of ['ssh.exe', 'ssh-keygen.exe']) { d.fs.mkdirSync('C:\\Windows\\System32\\OpenSSH', { recursive: true }); d.fs.writeFileSync(`C:\\Windows\\System32\\OpenSSH\\${exe}`, 'pretend'); }
  d.fs.mkdirSync('C:\\SRE\\runtime\\winsw', { recursive: true });
  d.fs.writeFileSync('C:\\SRE\\runtime\\winsw\\WinSW-x64.exe', 'pretend service host');
  win.services.set('SRE-Till', { state: 'running', auto: true, account: 'NT SERVICE\\SRE-Till' });
  const posted: unknown[] = [];
  const base = d.spawn;
  const spawn = (cmd: string, args: readonly string[], o: Parameters<Deps['spawn']>[2] = {}): SpawnResult => {
    const exe = cmd.split('\\').at(-1)!.toLowerCase();
    if (exe === 'ssh-keygen.exe') {
      win.calls.push({ cmd, args: [...args] });
      const f = args[args.indexOf('-f') + 1]!;
      d.fs.writeFileSync(f, `${PRIVATE_HEAD}\nPRETEND-PRIVATE-PART\n`);
      d.fs.writeFileSync(`${f}.pub`, `${sshKeyLine('sre-store-pc')}\n`);
      return { status: 0 };
    }
    if (exe === 'sre-remotelink.exe') { win.calls.push({ cmd, args: [...args] }); win.hostInstalls.push('SRE-RemoteLink'); win.services.set('SRE-RemoteLink', { state: 'stopped', auto: true, account: 'LocalSystem' }); return { status: 0 }; }
    return base(cmd, args, o);
  };
  const pins = { kind: 'sre-remote-link-pins-v1', tenantId: tenant, issuer: `https://${HOST}/auth/realms/sre-store`, audience: 'sre-retail-os-api', sshPort: 2222, user: 'sre-link', listenPort: 18095, hostKeys: [hostKey] };
  const dd: Deps = {
    ...d,
    spawn,
    fetch: async (url: string) => {
      if (url === `https://${HOST}/remote-link/pins`) return { ok: true, json: async () => pins };
      if (url === `https://${HOST}/auth/realms/sre-store/protocol/openid-connect/certs`) return { ok: true, json: async () => JWKS };
      if (url.endsWith('/update/open-shifts')) return { ok: true, json: async () => ({ kind: 'sre-open-shifts-v1', open: (opts.openShifts ?? []).map((tillId) => ({ tillId })) }) };
      throw new Error(`unexpected fetch ${url}`);
    },
    postJson: async (url: string, body: unknown) => { posted.push({ url, body }); return { status: 202 }; },
  };
  const typed = opts.codeFor === 'wrong' ? 'AAAA-BBBB-CCCC' : code;
  return { d: dd, win, said: w.said, posted, code, hostKey, run: (...a: string[]) => main(['remote-access', ...a, ...(a[0] === 'setup' ? ['--host', HOST, '--code', typed] : [])], dd) };
}

describe('remote-access setup — the store PC pins its relay, makes its own key, and turns the link on (OFF until then)', () => {
  it('with the server\'s own link code: pins, its own key (only the PUBLIC half leaves), the door\'s settings, the service under its own account', async () => {
    const { d, win, said, posted, run, hostKey } = await pc();
    const tillBefore = d.fs.readFileSync('C:\\SRE-data\\till\\till.env', 'utf8');
    expect(await run('setup')).toBe(0);
    const out = said.join('\n');
    expect(out).toMatch(/The link code matches/);
    const p = remoteLinkPaths('win32', 'C:\\SRE-data', 'C:\\SRE-data\\till');
    // The server's ssh key, pinned for its port; the sign-in key and "owner only" for the door.
    expect(d.fs.readFileSync(p.knownHosts, 'utf8')).toBe(`[${HOST}]:2222 ${publicKeyCore(hostKey)}\n`);
    const access = JSON.parse(d.fs.readFileSync(p.access, 'utf8')) as Record<string, unknown>;
    expect(access).toMatchObject({ kind: REMOTE_ACCESS_KIND, host: HOST, issuer: `https://${HOST}/auth/realms/sre-store`, allowed: 'role:owner', keys: JWKS });
    // The till gets the door's three settings, once; every line it had is kept.
    const till = d.fs.readFileSync('C:\\SRE-data\\till\\till.env', 'utf8');
    expect(till.startsWith(tillBefore)).toBe(true);
    expect(till).toMatch(/^EDGE_REMOTE_DOOR_PORT=8095$/m);
    expect(tillEnvWithRemote(till, p)).toBe(till);
    // The pairing request carries the PUBLIC key only; the private part is never said, sent or written elsewhere.
    const pub = d.fs.readFileSync(p.pub, 'utf8').trim();
    expect(posted).toEqual([{ url: `https://${HOST}/remote-link/ask`, body: { publicKey: publicKeyCore(pub) } }]);
    expect(out).toContain(`PAIRING CODE: ${pairingCode(pub)}`);
    expect(JSON.stringify(posted)).not.toContain('PRIVATE');
    expect(out).not.toContain('PRIVATE');
    expect(d.fs.readFileSync(p.settings, 'utf8')).not.toContain('PRIVATE');
    // The service: its own virtual account, starts with Windows, restarts on failure; the key folder inherits nothing.
    expect(win.services.get(REMOTE_LINK_SERVICE)).toMatchObject({ state: 'running', auto: true, account: `NT SERVICE\\${REMOTE_LINK_SERVICE}` });
    const xml = d.fs.readFileSync(`C:\\SRE-data\\run\\services\\${REMOTE_LINK_SERVICE}.xml`, 'utf8');
    expect(xml).toContain('store-computer-service.mjs&quot; remote-link --settings &quot;C:\\SRE-data\\remote-link\\remote-link.json&quot;');
    expect(xml).not.toContain('PRIVATE');
    const keyGrant = win.grants.find((g) => g[0] === p.keyDir)!;
    expect(keyGrant).toEqual([p.keyDir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${serviceSid(REMOTE_LINK_SERVICE)}:(OI)(CI)R`]);
    expect(win.grants.flat().some((a) => /Users|Everyone|S-1-1-0|S-1-5-32-545/.test(a))).toBe(false);
    // No till was open, so the till service was restarted to open the door.
    expect(out).toMatch(/the remote door is open on this PC's loopback \(127\.0\.0\.1:8095\) only/);
  });

  it('a till open → the till is NOT restarted; it says when the door opens', async () => {
    const { win, said, run } = await pc({ openShifts: ['lane-1'] });
    expect(await run('setup')).toBe(0);
    expect(said.join('\n')).toMatch(/a till is open now \(lane-1\), so it was NOT restarted/);
    expect(win.calls.some((c) => c.cmd === 'sc.exe' && c.args[0] === 'stop' && c.args[1] === 'SRE-Till')).toBe(false);
  });

  it('refuses — nothing written — when the link code does not match, the server is another shop\'s, or the host is not a domain', async () => {
    const wrong = await pc({ codeFor: 'wrong' });
    expect(await wrong.run('setup')).toBe(2);
    expect(wrong.said.join('\n')).toMatch(/the link code does not match/);
    expect(existsSync('C:\\SRE-data\\remote-link\\known_hosts')).toBe(false);
    expect(wrong.d.fs.existsSync('C:\\SRE-data\\remote-link\\known_hosts')).toBe(false);
    expect(wrong.d.fs.readFileSync('C:\\SRE-data\\till\\till.env', 'utf8')).not.toContain('EDGE_REMOTE');
    expect(wrong.posted).toEqual([]);

    const other = await pc({ tenant: 'another-shop' });
    expect(await other.run('setup')).toBe(2);
    expect(other.said.join('\n')).toMatch(/set up for another shop/);

    const bad = await pc();
    for (const h of ['https://1.2.3.4', '1.2.3.4', 'office', 'office.example.in:443']) {
      expect(await main(['remote-access', 'setup', '--host', h, '--code', bad.code], bad.d)).toBe(2);
    }
    expect(cleanHost('HTTPS://Office.Example.IN/')).toBe('office.example.in');
  });

  it('off: the service stops and does not start with Windows; status says "turned off"', async () => {
    const { win, said, run } = await pc();
    expect(await run('setup')).toBe(0);
    said.length = 0;
    expect(await run('off')).toBe(0);
    expect(win.services.get(REMOTE_LINK_SERVICE)).toMatchObject({ state: 'stopped', auto: false });
    expect(said.join('\n')).toMatch(/^OFF — the remote link is stopped and will not start with Windows/m);
    said.length = 0;
    expect(await run('status')).toBe(1);
    expect(said.join('\n')).toMatch(/Remote access: turned off/);
  });

  it('uninstalling the program removes the link service too; its keys and pins are kept', async () => {
    const { d, win, said, run } = await pc();
    expect(await run('setup')).toBe(0);
    said.length = 0;
    expect(await main(['remove-services'], d)).toBe(0);
    expect(win.services.has(REMOTE_LINK_SERVICE)).toBe(false);
    expect(said.join('\n')).toMatch(/^REMOVED — the owner's remote link \(SRE-RemoteLink\)\.$/m);
    expect(d.fs.existsSync('C:\\SRE-data\\remote-link\\remote-link.json')).toBe(true);
  });

  it('OFF by default: the store PC\'s own setup never installs the link or opens the door', () => {
    expect(SERVICE_ORDER).not.toContain(REMOTE_LINK_SERVICE);
  });
});
