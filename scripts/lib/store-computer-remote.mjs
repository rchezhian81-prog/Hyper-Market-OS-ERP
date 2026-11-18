// The owner's REMOTE LINK — OB-840 · ADR-0035 · the owner's decision of 18 Nov 2026 ("1A, 2A, 3A, 4A, 5A").
//
//   remote-access setup --host <your domain> --code <the link code the server showed>
//                       pin the relay server's keys, make this PC's own key, ask the server to pair, and turn the link on
//   remote-access on    turn the link on again (after `off`)
//   remote-access off   turn the link off: the service stops and does not start with Windows; nobody can reach the office
//                       pages from outside until it is turned on again
//   remote-access status    the link in plain words: connected, not connected since <time>, or turned off
//
// ── What the link is ───────────────────────────────────────────────────────────────────────────────────────────────
// One more Windows service, "SRE-RemoteLink", under its OWN virtual account (NT SERVICE\SRE-RemoteLink, no password). It
// runs Windows' own OpenSSH client (ssh.exe) and DIALS OUT to the owner's small relay server in India, asking it to send
// whatever arrives for the owner back down the same line to ONE place on this PC: the remote door, 127.0.0.1:8095 (this
// PC's loopback only — never the ordinary screen door 8091, never the shop network). Nothing on this PC listens on the
// internet; the shop's router opens no port. The line is encrypted and kept alive; when it drops (no internet, the server
// is off), the service dials again by itself, waiting a little longer each time (5 s up to a minute).
//
//   • The server's key is PINNED at setup (known_hosts, StrictHostKeyChecking=yes): a server with any other key is refused.
//     The pins come over the server's https address and must give the LINK CODE the server showed the owner.
//   • This PC's private key is MADE HERE by Windows' own ssh-keygen and never leaves it; only its public half goes to the
//     server, which uses it only after the owner approves it there with the PAIRING CODE shown on both screens.
//   • The identity server's public signing key is pinned for the remote door (till\remote-access.json), with the default
//     remote-allowed list: the owner only ("4A").
//   • OFF by default: `setup` does not install it; only this command does, when the owner runs it.
//   • Selling never depends on it (P-01, hard rule #1): the till does not know the link exists.
//
// Every program is started with an argument array and no shell; nothing here ever prints or stores a secret (there is
// none: the private key is written by ssh-keygen and read only by ssh.exe).

import { createHash } from 'node:crypto';
import { linkCode, pairingCode, publicKeyCore, sameCode } from './remote-link-code.mjs';
import { loadSettings, parseEnvText, pathFor, guarded, demoTenants } from './store-computer.mjs';
import { refusedOnServer } from './store-computer-windows.mjs';
import { REMOTE_LINK_SERVICE, accountOf, serviceSid, serviceState, servicePaths, SERVICES } from './store-computer-services.mjs';
import { withSettingAppended } from './settings-append.mjs';

export const REMOTE_DOOR_PORT = '8095';
export const REMOTE_ACCESS_KIND = 'sre-remote-access-v1';
export const REMOTE_LINK_STATUS_KIND = 'sre-remote-link-status-v1';
export const PINS_PATH = '/remote-link/pins';
export const ASK_PATH = '/remote-link/ask';
export const PINS_KIND = 'sre-remote-link-pins-v1';
export const LINK_DISPLAY = 'SRE Retail OS - remote link (owner\'s remote access)';
export const LINK_DESCRIPTION = 'Dials OUT to the owner\'s relay server so he can see Today, reports and approvals from outside. Off unless the owner turned it on. Selling never depends on it.';
/** Waits between two tries: 5 s, doubling, at most a minute; back to 5 s once a line has held for a minute. */
export const BACKOFF_MS = Object.freeze({ first: 5_000, max: 60_000, heldFor: 60_000 });
/** The service rewrites its status this often while a line is up, so Today can tell a stopped service from a live line. */
export const HEARTBEAT_MS = 30_000;

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A domain name as the owner typed it, cleaned — or undefined when it is not one (an address, a URL, a port …). */
export function cleanHost(typed) {
  const h = String(typed ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return HOST_RE.test(h) ? h : undefined;
}

/** Where everything of the link lives in the shop's data folder. */
export function remoteLinkPaths(platform, dataRoot, tillDir) {
  const p = pathFor(platform);
  const dir = p.join(dataRoot, 'remote-link');
  return {
    dir,
    keyDir: p.join(dir, 'key'),
    key: p.join(dir, 'key', 'id_ed25519'),
    pub: p.join(dir, 'key', 'id_ed25519.pub'),
    knownHosts: p.join(dir, 'known_hosts'),
    settings: p.join(dir, 'remote-link.json'),
    stateDir: p.join(dir, 'state'),
    status: p.join(dir, 'state', 'status.json'),
    access: p.join(tillDir, 'remote-access.json'),
    logDir: p.join(dataRoot, 'logs', REMOTE_LINK_SERVICE),
  };
}

/** Windows' own OpenSSH programs (Windows 10 1809 and later, and Windows 11, have them). */
export function opensshOf(env, platform) {
  const p = pathFor(platform);
  const root = String(env?.SystemRoot || env?.windir || 'C:\\Windows');
  return { ssh: p.join(root, 'System32', 'OpenSSH', 'ssh.exe'), keygen: p.join(root, 'System32', 'OpenSSH', 'ssh-keygen.exe') };
}

/**
 * The ssh.exe arguments — the whole security of the line is in this list (a guardrail pins it): no config file, this key
 * only, the pinned host key only, no password or keyboard prompt, no agent, no X11, no shell, ONE reverse forward from the
 * server's loopback to THIS PC's loopback remote door, kept alive, and an exit (then a fresh dial) if the forward fails.
 */
export function sshArgs(cfg, paths) {
  return [
    '-F', 'none',
    '-N', '-T', '-v',
    '-i', paths.key,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', `UserKnownHostsFile=${paths.knownHosts}`,
    '-o', 'GlobalKnownHostsFile=none',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=20',
    '-p', String(cfg.sshPort),
    '-l', cfg.user,
    '-R', `127.0.0.1:${cfg.listenPort}:127.0.0.1:${cfg.doorPort}`,
    cfg.host,
  ];
}

/** What a line of ssh's own words means, in the owner's words — or undefined when it says nothing that matters. */
export function sshProblem(line) {
  const l = String(line);
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(l)) return 'the server\'s key is not the one pinned at setup — run remote-access setup again, and only if you changed the server';
  if (/Permission denied/i.test(l)) return 'the server has not approved this store computer yet — on the server run: sudo sre-relay approve-link';
  if (/remote port forwarding failed|Error: remote port forwarding/i.test(l)) return 'the server refused the line to this store computer (is another store computer linked?)';
  if (/Could not resolve hostname|Name or service not known|No such host/i.test(l)) return 'the server\'s name cannot be found — is the internet on?';
  if (/Connection timed out|Network is unreachable|No route to host|Connection refused|Connection reset|Broken pipe|Timeout, server .* not responding/i.test(l)) return 'the server cannot be reached — no internet, or the server is off';
  return undefined;
}

/** ssh, with -v, says this when the server took the reverse forward. */
export const forwardTaken = (line) => /remote forward success|Remote connections from 127\.0\.0\.1:\d+ forwarded to local address/i.test(String(line));

/** The next wait after a line ended: back to the first wait when the line held, else double (to at most a minute). */
export function nextBackoff(previousMs, heldMs) {
  if (heldMs >= BACKOFF_MS.heldFor) return BACKOFF_MS.first;
  return Math.min(BACKOFF_MS.max, Math.max(BACKOFF_MS.first, previousMs * 2));
}

/** The status file's text. `since` is when the CURRENT state began (connected since / not connected since). */
export function statusText(state, since, nowIso, extra = {}) {
  return `${JSON.stringify({ kind: REMOTE_LINK_STATUS_KIND, state, since, updatedAt: nowIso, ...extra }, null, 2)}\n`;
}

/** The link in plain words, from its status file (the same reading as Today's line on the store PC). */
export function linkWords(text, nowMs) {
  let s;
  try { s = JSON.parse(String(text)); } catch { s = undefined; }
  if (s?.kind !== REMOTE_LINK_STATUS_KIND) return 'not connected — the link service has not reported';
  if (s.state === 'off') return 'turned off';
  const fresh = Number.isFinite(Date.parse(s.updatedAt)) && nowMs - Date.parse(s.updatedAt) <= 3 * 60_000;
  if (s.state === 'connected' && fresh) return `connected (since ${s.since})`;
  return `not connected since ${s.since ?? s.updatedAt}${s.problem ? ` — ${s.problem}` : ''}`;
}

// ── The WinSW definition of the service (no secret: only paths) ───────────────────────────────────────────────────

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function remoteLinkXml(P, paths) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Written by the store-computer tool (OB-840 · ADR-0035). No secret is in this file. -->',
    '<service>',
    `  <id>${REMOTE_LINK_SERVICE}</id>`,
    `  <name>${xmlEscape(LINK_DISPLAY)}</name>`,
    `  <description>${xmlEscape(LINK_DESCRIPTION)}</description>`,
    `  <executable>${xmlEscape(P.nodePath)}</executable>`,
    `  <arguments>${xmlEscape(`"${P.launcher}" remote-link --settings "${paths.settings}"`)}</arguments>`,
    `  <workingdirectory>${xmlEscape(P.repoRoot)}</workingdirectory>`,
    '  <startmode>Automatic</startmode>',
    '  <onfailure action="restart" delay="10 sec"/>',
    '  <onfailure action="restart" delay="30 sec"/>',
    '  <onfailure action="restart" delay="60 sec"/>',
    '  <resetfailure>1 hour</resetfailure>',
    '  <stoptimeout>15 sec</stoptimeout>',
    `  <logpath>${xmlEscape(paths.logDir)}</logpath>`,
    '  <log mode="roll-by-size">',
    '    <sizeThreshold>2048</sizeThreshold>',
    '    <keepFiles>4</keepFiles>',
    '  </log>',
    '</service>',
    '',
  ].join('\r\n');
}

/** The rights the link service needs, by SID: its key READ only (the key folder inherits nothing), its state, its log. */
export function remoteLinkGrants(P, paths) {
  const me = `*${serviceSid(REMOTE_LINK_SERVICE)}`;
  return [
    // The key folder: SYSTEM and Administrators, and the link service to READ — nobody else (OpenSSH also insists).
    [paths.keyDir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `${me}:(OI)(CI)R`],
    [paths.settings, '/grant', `${me}:R`],
    [paths.knownHosts, '/grant', `${me}:R`],
    [paths.stateDir, '/grant', `${me}:(OI)(CI)M`],
    // The till reads the link's state for Today's line.
    [paths.stateDir, '/grant', `*${serviceSid(SERVICES.till)}:(OI)(CI)RX`],
    [paths.logDir, '/grant', `${me}:(OI)(CI)M`],
    [P.servicesDir, '/grant', `${me}:(OI)(CI)RX`],
    [P.repoRoot, '/grant', `${me}:(OI)(CI)RX`],
  ];
}

// ── setup / on / off / status ────────────────────────────────────────────────────────────────────────────────────

const ran = (r) => r.error === undefined && r.status === 0;

async function readJson(deps, url) {
  try {
    const r = await deps.fetch(url);
    if (!r.ok) return { problem: `${url} answered ${r.status}` };
    return { value: await r.json() };
  } catch (e) { return { problem: `${url} could not be reached (${e?.cause?.code ?? e?.code ?? e?.message ?? 'error'})` }; }
}

/** The till.env with the remote door's three settings, each added once (every other line kept exactly as it was). */
export function tillEnvWithRemote(text, paths) {
  const have = parseEnvText(text);
  let out = String(text);
  if (have.EDGE_REMOTE_DOOR_PORT === undefined) out = withSettingAppended(out, 'EDGE_REMOTE_DOOR_PORT', REMOTE_DOOR_PORT, 'OB-840 · ADR-0035: the remote door, this PC\'s loopback only (written by remote-access setup)');
  if (have.EDGE_REMOTE_ACCESS_FILE === undefined) out = withSettingAppended(out, 'EDGE_REMOTE_ACCESS_FILE', paths.access);
  if (have.EDGE_REMOTE_LINK_STATUS_FILE === undefined) out = withSettingAppended(out, 'EDGE_REMOTE_LINK_STATUS_FILE', paths.status);
  return out;
}

/** `remote-access setup --host <domain> --code <link code>`. 0 done · 1 not done · 2 refused. */
export async function remoteAccessSetup(deps, opts) {
  const { say, fs } = deps;
  if (deps.platform !== 'win32') { say('REFUSED — remote access is set up on the store computer (Windows 10 or 11).'); return 2; }
  if (refusedOnServer(deps)) return 2;
  const { L, settings } = loadSettings(deps);
  if (settings === undefined || L.mode !== 'data-folder' || !fs.existsSync(L.tillEnv)) { say('REFUSED — this PC is not set up yet. Run the setup first.'); return 2; }
  if (guarded(deps, settings)) return 2;
  const host = cleanHost(opts.host);
  if (host === undefined) { say('REFUSED — name your domain with --host, for example: --host office.example.in (the name only; no https://, no port).'); return 2; }
  if (opts.code === undefined || String(opts.code).trim() === '') { say('REFUSED — type the link code your server showed at the end of its setup, with --code XXXX-XXXX-XXXX.'); return 2; }
  const tenantId = String(settings.EDGE_TENANT_ID ?? '').trim();
  if (tenantId === '' || demoTenants(settings).includes(tenantId)) { say('REFUSED — this PC is not the real shop\'s store computer (its tenant id is missing or a demo one). Remote access is for the real shop only.'); return 2; }
  const ssh = opensshOf(deps.env, deps.platform);
  if (!fs.existsSync(ssh.ssh) || !fs.existsSync(ssh.keygen)) {
    say('NOT DONE — Windows\' own "OpenSSH Client" is not installed on this PC. Open Settings → System → Optional features → Add a feature → "OpenSSH Client", install it, then run this again.');
    return 1;
  }

  // 1 — The server's pins, over its https address (the certificate is checked by Windows' own list, as any browser does).
  say(`Asking ${host} for its keys…`);
  const pins = await readJson(deps, `https://${host}${PINS_PATH}`);
  if (pins.problem !== undefined) { say(`NOT DONE — ${pins.problem}. Check the domain is right, its A record points at the server, and the server's setup finished. Nothing was changed.`); return 1; }
  const v = pins.value ?? {};
  const issuer = `https://${host}/auth/realms/sre-store`;
  const hostKeys = Array.isArray(v.hostKeys) ? v.hostKeys.map(publicKeyCore).filter((x) => x !== undefined) : [];
  if (v.kind !== PINS_KIND || hostKeys.length === 0 || v.issuer !== issuer || !/^\d{2,5}$/.test(String(v.sshPort)) || !/^\d{2,5}$/.test(String(v.listenPort)) || !/^[a-z][a-z0-9-]{0,31}$/.test(String(v.user))) {
    say('NOT DONE — the server\'s answer is not the relay server\'s (is the domain right?). Nothing was changed.');
    return 1;
  }
  if (v.tenantId !== tenantId) {
    say('REFUSED — that server was set up for another shop (its tenant id is not this shop\'s). Run the server\'s setup with this shop\'s tenant id (shown on the About page). Nothing was changed.');
    return 2;
  }
  const jwks = await readJson(deps, `${issuer}/protocol/openid-connect/certs`);
  if (jwks.problem !== undefined) { say(`NOT DONE — ${jwks.problem}. The server's sign-in may still be starting; wait two minutes and run this again. Nothing was changed.`); return 1; }
  const expected = linkCode(hostKeys, jwks.value);
  if (expected === undefined || !sameCode(expected, String(opts.code))) {
    say('REFUSED — the link code does not match what this server shows. Do not continue: check you typed the code from YOUR server\'s screen, and the domain. Nothing was changed.');
    return 2;
  }
  say(`The link code matches (${expected}). The server's keys are pinned.`);

  // 2 — This PC's own key, made here, never sent anywhere but its PUBLIC half.
  const paths = remoteLinkPaths(deps.platform, L.dataRoot, L.tillDir);
  for (const d of [paths.dir, paths.keyDir, paths.stateDir, paths.logDir]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(paths.key)) {
    const made = deps.spawn(ssh.keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'sre-store-pc', '-f', paths.key], {});
    if (!ran(made) || !fs.existsSync(paths.pub)) { say('NOT DONE — Windows could not make this PC\'s key. Send me a photo of this screen.'); return 1; }
    say('This PC\'s own key was made. Its private part stays on this PC.');
  } else {
    say('This PC\'s own key is kept as it is.');
  }
  const publicKey = publicKeyCore(fs.readFileSync(paths.pub, 'utf8'));
  if (publicKey === undefined) { say('NOT DONE — this PC\'s public key cannot be read. Send me a photo of this screen.'); return 1; }

  // 3 — The pins, written.
  fs.writeFileSync(paths.knownHosts, `${hostKeys.map((k) => `[${host}]:${v.sshPort} ${k}`).join('\n')}\n`, 'utf8');
  const cfg = { kind: 'sre-remote-link-v1', host, sshPort: Number(v.sshPort), user: String(v.user), listenPort: Number(v.listenPort), doorPort: Number(REMOTE_DOOR_PORT), key: paths.key, knownHosts: paths.knownHosts, status: paths.status, ssh: ssh.ssh };
  fs.writeFileSync(paths.settings, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  const access = { kind: REMOTE_ACCESS_KIND, host, issuer, audience: String(v.audience || 'sre-retail-os-api'), tenantId, keys: jwks.value, allowed: 'role:owner', setAt: deps.now().toISOString() };
  fs.writeFileSync(paths.access, `${JSON.stringify(access, null, 2)}\n`, 'utf8');
  const tillText = fs.readFileSync(L.tillEnv, 'utf8');
  const tillNext = tillEnvWithRemote(tillText, paths);
  if (tillNext !== tillText) fs.writeFileSync(L.tillEnv, tillNext, 'utf8');
  say('The remote door is set: only the owner, only with his one-time code, only Today, reports and approvals.');

  // 4 — Ask the server to pair. It takes the PUBLIC key only, and uses it only once the owner approves it there.
  try {
    const r = await deps.postJson(`https://${host}${ASK_PATH}`, { publicKey });
    if (r.status !== 200 && r.status !== 202) { say(`NOT DONE — the server did not take this PC's request (it answered ${r.status}). Run this again in a minute.`); return 1; }
  } catch { say('NOT DONE — the server could not be reached to ask for pairing. Run this again in a minute.'); return 1; }
  say(`PAIRING CODE: ${pairingCode(publicKey)}`);
  say('  Now, on the server, run:  sudo sre-relay approve-link   and approve only if it shows this same code.');

  // 5 — The service, turned on.
  return remoteAccessOn(deps);
}

/** Install (once) and start the link service, and open the remote door on the till. */
export async function remoteAccessOn(deps) {
  const { say, fs } = deps;
  if (deps.platform !== 'win32') { say('REFUSED — the remote link runs on the store computer (Windows 10 or 11).'); return 2; }
  const { L, settings } = loadSettings(deps);
  if (settings === undefined || L.mode !== 'data-folder') { say('REFUSED — this PC is not set up yet.'); return 2; }
  const paths = remoteLinkPaths(deps.platform, L.dataRoot, L.tillDir);
  if (!fs.existsSync(paths.settings) || !fs.existsSync(paths.key) || !fs.existsSync(paths.access)) {
    say('REFUSED — remote access is not set up on this PC yet. Run: remote-access setup --host <your domain> --code <the link code>');
    return 2;
  }
  const serviceHost = deps.serviceHost ?? pathFor(deps.platform).join(deps.repoRoot, 'runtime', 'winsw', 'WinSW-x64.exe');
  if (!fs.existsSync(serviceHost)) { say('NOT DONE — this release has no service host program (runtime\\winsw). Install the store PC release, then run this again.'); return 1; }
  const P = servicePaths({ platform: deps.platform, repoRoot: deps.repoRoot, dataRoot: L.dataRoot, nodePath: deps.nodePath, serviceHost });
  fs.mkdirSync(P.servicesDir, { recursive: true });
  const exe = P.hostExeOf(REMOTE_LINK_SERVICE);
  const fresh = serviceState(deps, REMOTE_LINK_SERVICE) === 'missing';
  if (fresh || !fs.existsSync(exe)) fs.copyFileSync(serviceHost, exe);
  fs.writeFileSync(P.hostXmlOf(REMOTE_LINK_SERVICE), remoteLinkXml(P, paths), 'utf8');
  if (fresh) {
    const r = deps.spawn(exe, ['install'], { cwd: P.servicesDir });
    if (!ran(r)) { say('NOT DONE — Windows would not take the remote link as a service. Send me a photo of this screen.'); return 1; }
  }
  for (const args of [
    ['config', REMOTE_LINK_SERVICE, 'obj=', accountOf(REMOTE_LINK_SERVICE), 'start=', 'auto', 'DisplayName=', LINK_DISPLAY],
    ['failure', REMOTE_LINK_SERVICE, 'reset=', '3600', 'actions=', 'restart/10000/restart/30000/restart/60000'],
    ['description', REMOTE_LINK_SERVICE, LINK_DESCRIPTION],
  ]) {
    const r = deps.spawn('sc.exe', args, {});
    if (!ran(r)) { say(`NOT DONE — Windows would not set up the remote link (${args[0]}).`); return 1; }
  }
  for (const args of remoteLinkGrants(P, paths)) {
    const r = deps.spawn('icacls.exe', args, {});
    if (!ran(r)) { say(`NOT DONE — Windows would not give the remote link its rights on ${args[0]}.`); return 1; }
  }
  fs.writeFileSync(paths.status, statusText('connecting', deps.now().toISOString(), deps.now().toISOString()), 'utf8');
  if (serviceState(deps, REMOTE_LINK_SERVICE) !== 'running') deps.spawn('sc.exe', ['start', REMOTE_LINK_SERVICE], {});
  say(`ON — the remote link (${REMOTE_LINK_SERVICE}) dials out to the server, and dials again by itself whenever the line drops.`);
  await openTheDoor(deps, L);
  return 0;
}

/** The till reads EDGE_REMOTE_DOOR_PORT when it starts: restart it now only if no till is open; else say when it opens. */
async function openTheDoor(deps, L) {
  const { say } = deps;
  const till = parseEnvText(deps.fs.readFileSync(L.tillEnv, 'utf8'));
  const port = Number(till.EDGE_SCREEN_PORT || 8091);
  let open;
  try {
    const r = await deps.fetch(`http://127.0.0.1:${port}/update/open-shifts`);
    const o = await r.json();
    open = r.ok && o?.kind === 'sre-open-shifts-v1' && Array.isArray(o.open) ? o.open : undefined;
  } catch { open = undefined; }
  if (open === undefined || open.length > 0) {
    say(open === undefined
      ? 'The remote door opens the next time the till service starts (it did not answer just now). Restart this computer tonight after the day is closed.'
      : `The remote door opens the next time the till service starts — a till is open now (${open.map((s) => s?.tillId ?? s).join(', ')}), so it was NOT restarted. Tonight, after the day is closed, run: remote-access on`);
    return;
  }
  deps.spawn('sc.exe', ['stop', SERVICES.till], {});
  for (let i = 0; i < 30 && serviceState(deps, SERVICES.till) !== 'stopped'; i += 1) await deps.sleep(1_000);
  deps.spawn('sc.exe', ['start', SERVICES.till], {});
  say('No till was open, so the till service was restarted: the remote door is open on this PC\'s loopback (127.0.0.1:8095) only.');
}

/** `remote-access off`: the service stops and does not start with Windows. Its keys and pins are kept for `on`. */
export async function remoteAccessOff(deps) {
  const { say, fs } = deps;
  if (deps.platform !== 'win32') { say('REFUSED — the remote link runs on the store computer (Windows 10 or 11).'); return 2; }
  const { L } = loadSettings(deps);
  if (serviceState(deps, REMOTE_LINK_SERVICE) === 'missing') { say('The remote link is not installed on this PC: remote access is OFF.'); return 0; }
  deps.spawn('sc.exe', ['stop', REMOTE_LINK_SERVICE], {});
  const r = deps.spawn('sc.exe', ['config', REMOTE_LINK_SERVICE, 'start=', 'disabled'], {});
  if (L.dataRoot !== undefined) {
    const paths = remoteLinkPaths(deps.platform, L.dataRoot, L.tillDir);
    try { fs.mkdirSync(paths.stateDir, { recursive: true }); fs.writeFileSync(paths.status, statusText('off', deps.now().toISOString(), deps.now().toISOString()), 'utf8'); } catch { /* the service's state still says it */ }
  }
  if (!ran(r)) { say('NOT DONE — Windows would not switch the remote link off. Send me a photo of this screen.'); return 1; }
  say('OFF — the remote link is stopped and will not start with Windows. Nobody can reach the office pages from outside. (remote-access on turns it back on.)');
  return 0;
}

/** `remote-access status`: the service and the line, in plain words. 0 connected · 1 anything else. */
export async function remoteAccessStatus(deps) {
  const { say, fs } = deps;
  const { L } = loadSettings(deps);
  const state = deps.platform === 'win32' ? serviceState(deps, REMOTE_LINK_SERVICE) : 'missing';
  if (state === 'missing' || L.dataRoot === undefined) { say('Remote access: turned off (the remote link is not installed on this PC).'); return 1; }
  const paths = remoteLinkPaths(deps.platform, L.dataRoot, L.tillDir);
  let text;
  try { text = fs.readFileSync(paths.status, 'utf8'); } catch { text = undefined; }
  const words = linkWords(text, deps.now().getTime());
  say(`Remote access: ${words}. (Windows service ${REMOTE_LINK_SERVICE}: ${state}.)`);
  return words.startsWith('connected') ? 0 : 1;
}

// ── The service itself: dial out, keep the line, say how it is ───────────────────────────────────────────────────

/** Read the link's settings file (written by setup). Undefined when it is not one. */
export function readLinkSettings(text) {
  let c;
  try { c = JSON.parse(String(text)); } catch { return undefined; }
  if (c?.kind !== 'sre-remote-link-v1' || cleanHost(c.host) === undefined) return undefined;
  for (const k of ['sshPort', 'listenPort', 'doorPort']) if (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 65535) return undefined;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(c.user)) || typeof c.key !== 'string' || typeof c.knownHosts !== 'string' || typeof c.status !== 'string' || typeof c.ssh !== 'string') return undefined;
  return c;
}

/**
 * The service's loop: dial, keep the status file true, dial again after a wait. Runs until `deps.stopped()` says so.
 * `deps.runSsh(program, args, onLine)` starts ssh and resolves with its exit code when it ends.
 */
export async function runRemoteLink(deps, cfg) {
  const write = (state, since, extra) => {
    try { deps.fs.writeFileSync(cfg.status, statusText(state, since, deps.now().toISOString(), extra), 'utf8'); } catch { /* said on the service's log */ }
  };
  let wait = BACKOFF_MS.first;
  let downSince = deps.now().toISOString();
  const args = sshArgs(cfg, { key: cfg.key, knownHosts: cfg.knownHosts });
  while (!deps.stopped()) {
    write('connecting', downSince);
    let connectedAt;
    let problem;
    const beat = deps.every(HEARTBEAT_MS, () => { if (connectedAt !== undefined) write('connected', connectedAt); });
    const code = await deps.runSsh(cfg.ssh, args, (line) => {
      if (connectedAt === undefined && forwardTaken(line)) { connectedAt = deps.now().toISOString(); write('connected', connectedAt); deps.say(`connected to ${cfg.host}`); }
      const p = sshProblem(line);
      if (p !== undefined) problem = p;
    });
    beat.cancel();
    const held = connectedAt === undefined ? 0 : deps.now().getTime() - Date.parse(connectedAt);
    downSince = deps.now().toISOString();
    if (deps.stopped()) break;
    write('down', downSince, problem === undefined ? {} : { problem });
    deps.say(`the line ended (code ${code})${problem === undefined ? '' : ` — ${problem}`}; dialling again in ${Math.round(nextBackoff(wait, held) / 1000)} s`);
    wait = nextBackoff(wait, held);
    await deps.sleep(wait);
  }
  // Stopped by Windows (a restart, a shutdown): "not connected since now". Only `remote-access off` says "turned off".
  write('down', deps.now().toISOString());
}

/** A fingerprint for a log line, never the key itself. */
export const keyFingerprint = (publicKeyLine) => createHash('sha256').update(String(publicKeyLine)).digest('hex').slice(0, 12);
