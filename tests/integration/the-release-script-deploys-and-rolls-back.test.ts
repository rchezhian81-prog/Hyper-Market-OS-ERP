import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

/**
 * **A merged release deploys itself, and a broken one puts the previous release back (Stage F slice 1 · §20 ·
 * AID-08 · hard rule #8 · P-08).**
 *
 * `infra/deploy/release.sh` is the half of the pipeline that runs ON the box. Here it really runs — the same
 * file, byte for byte — against a sandbox that has everything it touches: a bare "origin" with commits on
 * `main` and one that is not, the box's own checkout, and stand-ins on PATH for `pnpm`, `docker` and `curl`
 * that record what they were asked and answer READY or not on command. The properties a shop depends on:
 *
 *   • only a commit on origin/main deploys; a branch commit or garbage is refused and nothing is touched;
 *   • a good release: dependencies, every configured shell (with the demo-banner flag), `compose up`, READY,
 *     the stand-up check — and one append-only log line saying what replaced what, by whom, which run;
 *   • a release that never becomes READY is rolled back to the previous commit, the pipeline goes red (70);
 *   • a forced SSH command carries the arguments; anything but `release …` is refused;
 *   • two deployments cannot run at once; a rollback that itself fails says so (71);
 *   • the secrets file is never printed;
 *   • QG-10 · WF-20 (FG-3): the books are snapshotted before the release and compared after it — a lost event, a new
 *     dead letter or a grown sync backlog rolls the release back (70); books that cannot be read before refuse it (69);
 *     every attempt writes one QG-10 evidence line (health, smoke, reconciliation, monitoring, rollback);
 *   • OB-423: that line is posted to head office's gate register with the key from the custodian's file on the box — the
 *     key only in the Authorization header, never printed; no key, an unreachable or a refusing head office: the release
 *     still runs and says "QG-10 note NOT POSTED". Every release ATTEMPT is its own note: the line names the pipeline run
 *     and attempt (the CI's `attempt=N` word or GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT; by hand, run "manual" and a box-local
 *     attempt time), a second attempt of one release is posted too, and a different note re-using an attempt is refused
 *     and said.
 */

const REAL_SCRIPT = join(process.cwd(), 'infra/deploy/release.sh');
// QG-10 (FG-3): the release's own reconcile tool rides in the sandbox commits, as it does in a real release.
const REAL_RECONCILE = join(process.cwd(), 'scripts/release-reconcile.mjs');
const REAL_RECONCILE_LIB = join(process.cwd(), 'scripts/lib/release-reconcile.mjs');
// The stand-in for the migrate container's snapshot: the before-release books, or (with --upto) the after-release ones.
const SNAPSHOT_STUB = `#!/usr/bin/env bash
echo "snapshot $*" >> "$SRE_TEST_CALLS"
case " $* " in *" --upto "*) cat "$SRE_TEST_SNAPS/after.json" 2>/dev/null ;; *) cat "$SRE_TEST_SNAPS/before.json" 2>/dev/null ;; esac
`;
const books = (count: number, deadLetter = 0, pending = 0) => ({ version: 1, at: '2026-10-26T00:00:00.000Z', ledger: { count, maxSeq: count, digest: `d${count}`, byFamily: { sales: count } }, outbox: { pending, deadLetter, oldestPendingSeconds: null } });
const after = (count: number, upTo: { seq: number; count: number; digest: string; sales: number }, deadLetter = 0, pending = 0) =>
  ({ ...books(count, deadLetter, pending), upTo: { seq: upTo.seq, count: upTo.count, digest: upTo.digest, byFamily: { sales: upTo.sales } } });
// OB-423: a stand-in for head office's gate-register route, run as its own process (release.sh runs synchronously in the
// test). It records what it was sent and answers as head office does: 201 for a box's first note on a release ATTEMPT (box +
// release + run + attempt), 200 "already recorded" for the same note again, 409 for a different note claiming that attempt.
const REGISTER_STUB = `const http = require('node:http'); const fs = require('node:fs');
const [, , portFile, logFile] = process.argv; const seen = new Map();
http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
  fs.appendFileSync(logFile, JSON.stringify({ method: req.method, path: req.url, auth: req.headers.authorization || null, key: req.headers['idempotency-key'] || null, body: b }) + '\\n');
  let note; try { note = JSON.parse(b).note; } catch { note = undefined; }
  const k = ['release', 'box', 'run', 'attempt'].map((f) => String(note && note[f])).join('|');
  const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!seen.has(k)) { seen.set(k, b); send(201, { alreadyRecorded: false }); return; }
  if (seen.get(k) === b) { send(200, { alreadyRecorded: true }); return; }
  send(409, { error: { code: 'qg10_note_already_recorded' } });
}); }).listen(0, '127.0.0.1', function () { fs.writeFileSync(portFile, String(this.address().port)); });
`;
// The release script's machine key, as the custodian's file holds it — a sentinel the output must never show.
const QG10_KEY = ['qg10', 'machine', 'key', 'sentinel', 'fedcba9876543210'].join('-');
// Constructed from parts so the repository's secret scan (which refuses hard-coded credential assignments) does
// not trip on obviously-fake test material. It is a sentinel: the test only asserts it NEVER appears in output.
const KEY_NAME = ['PACK', 'SIGNING', 'KEY'].join('_');
const SENTINEL = ['sentinel', 'never', 'printed', '0123456789abcdef0123456789abcdef'].join('-');

const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@test.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@test.invalid' };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...IDENT } }).trim();

const BUILD_STUB = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SRE_TEST_CALLS, \`build-app \${process.argv.slice(2).join(' ')} banner=\${process.env.PILOT_DEMO_BANNER ?? ''}\\n\`);
`;
const TOOL_STUB = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SRE_TEST_CALLS, \`build-service \${process.argv.slice(2).join(' ')}\\n\`);
`;
const STANDUP_STUB = `import { appendFileSync, readFileSync } from 'node:fs';
if (process.argv.includes('--settings-only')) {
  // Round 32 · OB-116: the release's pre-flight — only whether the settings file has every setting the release needs.
  appendFileSync(process.env.SRE_TEST_CALLS, \`standup-check --settings-only env=\${process.env.STANDUP_ENV_FILE}\\n\`);
  let settings = ''; try { settings = readFileSync(process.env.SRE_TEST_SETTINGS, 'utf8').trim(); } catch { /* none: complete */ }
  console.log(settings === 'missing' ? 'RED — Settings: still unfilled: BOX_HISTORY_SEAL_KEY' : 'GREEN — 1 of 1 checks passed.');
  process.exit(settings === 'missing' ? 1 : 0);
}
appendFileSync(process.env.SRE_TEST_CALLS, \`standup-check env=\${process.env.STANDUP_ENV_FILE}\\n\`);
let ready = ''; try { ready = readFileSync(process.env.SRE_TEST_READY, 'utf8').trim(); } catch { /* not there yet */ }
console.log(ready === 'ok' ? 'GREEN — 5 of 5 checks passed.' : 'RED — 1 of 5 check(s) not ready.');
process.exitCode = ready === 'ok' ? 0 : 1;
`;
const PNPM_STUB = `#!/usr/bin/env bash
echo "pnpm $* ci=\${CI:-}" >> "$SRE_TEST_CALLS"
exit 0
`;
// \`docker compose … up\` takes the next answer from the queue (ok / down) and makes it the API's state.
const DOCKER_STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$SRE_TEST_CALLS"
case " $* " in
  *" --force-recreate "*) ;;   # recreating one service (the relay) never changes the stack's readiness
  *" up "*)
    next=$(head -n1 "$SRE_TEST_UP_RESULTS" 2>/dev/null || true)
    tail -n +2 "$SRE_TEST_UP_RESULTS" > "$SRE_TEST_UP_RESULTS.tmp" 2>/dev/null || true
    mv "$SRE_TEST_UP_RESULTS.tmp" "$SRE_TEST_UP_RESULTS"
    echo "\${next:-ok}" > "$SRE_TEST_READY" ;;
  *" logs "*) echo "api | (stub log line)" ;;
  *" ps -q api "*) [ -n "\${SRE_TEST_PS_FAILS:-}" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    for i in $(seq 1 "\${SRE_TEST_API_CONTAINERS:-1}"); do echo "api-container-$i"; done ;;
esac
exit 0
`;
const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$SRE_TEST_CALLS"
# WF-20 canary bake: /metricz answers the next server-error count from a queue (the last one sticks); "garbage" is unreadable.
case " $* " in *"/metricz"*)
  n=$(head -n1 "$SRE_TEST_METRICS" 2>/dev/null || true); [ -z "$n" ] && n=0
  if [ "$(wc -l < "$SRE_TEST_METRICS" 2>/dev/null || echo 0)" -gt 1 ]; then tail -n +2 "$SRE_TEST_METRICS" > "$SRE_TEST_METRICS.tmp"; mv "$SRE_TEST_METRICS.tmp" "$SRE_TEST_METRICS"; fi
  if [ "$n" = "garbage" ]; then echo 'not json'; else echo "{\\"byStatusClass\\":{\\"2xx\\":10,\\"5xx\\":$n}}"; fi
  exit 0;;
esac
# With -w the caller wants a status code (the web-front settle), otherwise the readiness body.
case " $* " in *" -w "*) if [ "$(cat "$SRE_TEST_READY" 2>/dev/null)" = "ok" ]; then echo 200; else echo 500; fi; exit 0;; esac
if [ "$(cat "$SRE_TEST_READY" 2>/dev/null)" = "ok" ]; then echo '{"ready":true}'; exit 0; fi
exit 22
`;

describe('the release script deploys a merged commit and rolls a broken one back (Stage F slice 1)', () => {
  let sandbox: string; let app: string; let calls: string; let upResults: string; let ready: string; let releaseLog: string; let lock: string;
  let V1: string; let V2: string; let V3: string; let FEATURE: string;
  let baseEnv: Record<string, string>;

  const run = (args: readonly string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync('bash', [join(app, 'infra/deploy/release.sh'), ...args], { encoding: 'utf8', env: { ...baseEnv, ...extraEnv } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const head = () => git(app, 'rev-parse', 'HEAD');
  const callLog = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const lastLogLine = async () => (await readFile(releaseLog, 'utf8')).trim().split('\n').at(-1) ?? '';

  beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'sre-release-'));
    const origin = join(sandbox, 'origin.git');
    git(sandbox, 'init', '-q', '--bare', '-b', 'main', origin);

    // The author's clone: v1, v2, v3 on main; one commit on a branch that never merges.
    const author = join(sandbox, 'author');
    git(sandbox, 'clone', '-q', origin, author);
    git(author, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    await mkdir(join(author, 'infra/deploy'), { recursive: true });
    await mkdir(join(author, 'infra/compose'), { recursive: true });
    await mkdir(join(author, 'scripts'), { recursive: true });
    await copyFile(REAL_SCRIPT, join(author, 'infra/deploy/release.sh'));
    await chmod(join(author, 'infra/deploy/release.sh'), 0o755);
    await writeFile(join(author, 'infra/compose/docker-compose.yml'), 'services: {}\n');
    await writeFile(join(author, 'scripts/build-app.mjs'), BUILD_STUB);
    await writeFile(join(author, 'scripts/build-service.mjs'), TOOL_STUB);
    await writeFile(join(author, 'scripts/standup-check.mjs'), STANDUP_STUB);
    await mkdir(join(author, 'scripts/lib'), { recursive: true });
    await copyFile(REAL_RECONCILE, join(author, 'scripts/release-reconcile.mjs'));
    await copyFile(REAL_RECONCILE_LIB, join(author, 'scripts/lib/release-reconcile.mjs'));
    await writeFile(join(author, 'package.json'), '{ "name": "sandbox", "private": true, "type": "module" }\n');
    const commit = async (version: string): Promise<string> => {
      await writeFile(join(author, 'VERSION'), `${version}\n`);
      git(author, 'add', '-A'); git(author, 'commit', '-q', '-m', version);
      return git(author, 'rev-parse', 'HEAD');
    };
    V1 = await commit('v1'); git(author, 'push', '-q', 'origin', 'main');

    // The box: cloned at v1 and left there — exactly the state after the demo stand-up.
    app = join(sandbox, 'app');
    git(sandbox, 'clone', '-q', origin, app);
    git(app, 'checkout', '-q', '--detach', V1);
    await writeFile(join(app, 'infra/compose/.env.test'), `${KEY_NAME}=${SENTINEL}\nAPI_PORT=8081\n`, { mode: 0o600 });

    V2 = await commit('v2'); V3 = await commit('v3'); git(author, 'push', '-q', 'origin', 'main');
    git(author, 'checkout', '-q', '-b', 'feature'); FEATURE = await commit('feature'); git(author, 'push', '-q', 'origin', 'feature');

    // Stand-ins on PATH.
    const bin = join(sandbox, 'bin'); await mkdir(bin);
    for (const [name, body] of [['pnpm', PNPM_STUB], ['docker', DOCKER_STUB], ['curl', CURL_STUB], ['snapshot-books', SNAPSHOT_STUB]] as const) {
      await writeFile(join(bin, name), body); await chmod(join(bin, name), 0o755);
    }
    calls = join(sandbox, 'calls.log'); upResults = join(sandbox, 'up-results'); ready = join(sandbox, 'ready');
    releaseLog = join(sandbox, 'state', 'releases.log'); lock = join(sandbox, 'state', 'deploy.lock');
    baseEnv = {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: sandbox, ...IDENT,
      SRE_DEPLOY_CONF: join(sandbox, 'no-such.conf'), SRE_APP_DIR: app,
      SRE_COMPOSE_PROJECT: 'sre-test', SRE_COMPOSE_FILES: 'docker-compose.yml', SRE_ENV_FILE: '.env.test',
      SRE_BUILD_SHELLS: 'pos owner-app', SRE_BUILD_ENV: 'PILOT_DEMO_BANNER=1',
      SRE_API_URL: 'http://127.0.0.1:9', SRE_READY_TIMEOUT: '3', SRE_READY_POLL: '1',
      SRE_RELEASE_LOG: releaseLog, SRE_DEPLOY_LOCK: lock,
      SRE_TEST_CALLS: calls, SRE_TEST_UP_RESULTS: upResults, SRE_TEST_READY: ready, SRE_TEST_METRICS: join(sandbox, 'metrics'), SRE_TEST_SETTINGS: join(sandbox, 'settings'),
      // QG-10 (FG-3): the books' snapshot comes from the stand-in; the per-release evidence goes to the sandbox.
      SRE_RECONCILE_CMD: 'snapshot-books', SRE_TEST_SNAPS: join(sandbox, 'snaps'), SRE_QG10_LOG: join(sandbox, 'state', 'qg10.jsonl'),
      // OB-423: the custodian's key file — absent unless a test puts it there; head office (SRE_API_URL) is not listening.
      SRE_QG10_PUSH_TOKEN_FILE: join(sandbox, 'secrets', 'qg10-push.token'),
    };
    await mkdir(join(sandbox, 'snaps'), { recursive: true });
  });
  afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });
  const snaps = async (before: unknown, afterBooks: unknown) => {
    await writeFile(join(sandbox, 'snaps', 'before.json'), `${JSON.stringify(before)}\n`);
    await writeFile(join(sandbox, 'snaps', 'after.json'), `${JSON.stringify(afterBooks)}\n`);
  };
  const lastQg10 = async () => JSON.parse((await readFile(join(sandbox, 'state', 'qg10.jsonl'), 'utf8')).trim().split('\n').at(-1) ?? '{}') as { release: string; run: string; attempt: string; outcome: string; verified: boolean; checks: Record<string, string>; differences: string[]; decision: string; notVerified: string[] };
  beforeEach(async () => {
    await writeFile(calls, ''); await writeFile(upResults, ''); await writeFile(ready, 'down\n'); await writeFile(join(sandbox, 'metrics'), '0\n'); await writeFile(join(sandbox, 'settings'), 'complete\n');
    // The books agree by default: 10 events before; 12 after, the first 10 unchanged.
    await snaps(books(10), after(12, { seq: 10, count: 10, digest: 'd10', sales: 10 }));
  });

  it('refuses garbage (64) and a commit that is not on origin/main (65) — and touches nothing', async () => {
    expect(run(['not-a-sha']).code).toBe(64);
    const r = run([FEATURE, 'octocat', '1']);
    expect(r.code).toBe(65);
    expect(r.out).toContain('not on origin/main');
    expect(head()).toBe(V1);
    expect((await callLog()).some((l) => l.startsWith('docker') || l.startsWith('pnpm'))).toBe(false);
  });

  it('round 32 · OB-116: a settings file missing a setting the release needs (BOX_HISTORY_SEAL_KEY) is REFUSED (78) by name before anything is rebuilt — the box untouched', async () => {
    await writeFile(join(sandbox, 'settings'), 'missing\n');
    await writeFile(upResults, 'ok\n');
    const r = run([V2, 'octocat', '122']);
    expect(r.code, r.out).toBe(78);
    expect(r.out).toContain('BOX_HISTORY_SEAL_KEY');
    expect(r.out).toContain(`REFUSED — the settings file (.env.test) is missing a setting ${V2} needs`);
    expect(r.out).toContain(`Nothing was rebuilt or restarted; the box is still on ${V1}`);
    expect(head()).toBe(V1);
    const log = await callLog();
    expect(log).toContain(`standup-check --settings-only env=${join(app, 'infra/compose/.env.test')}`);
    expect(log.some((l) => l.startsWith('docker') || l.startsWith('pnpm') || l.startsWith('build-'))).toBe(false);
    expect(await lastLogLine()).toContain(`result=settings_missing sha=${V2} previous=${V1} by=octocat run=122`);
    expect(r.out).not.toContain(SENTINEL);
  }, 30_000);

  it('deploys a merged commit: dependencies, every shell with the banner flag, compose up, READY, stand-up check — and one log line', async () => {
    await writeFile(upResults, 'ok\n');
    const r = run([V2, 'octocat', '123']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('DEPLOYED');
    expect(head()).toBe(V2);
    const log = await callLog();
    expect(log).toContain('pnpm install --frozen-lockfile ci=true'); // unattended: pnpm must never wait for a yes
    expect(log).toContain('build-app pos banner=1');
    expect(log).toContain('build-app owner-app banner=1');
    expect(log).toContain('build-service demo-login'); // the demo sign-in bundle the pilot overlay runs, rebuilt per release
    expect(log).toContain('docker compose -p sre-test -f docker-compose.yml --env-file .env.test up -d --build');
    expect(log).toContain('docker compose -p sre-test -f docker-compose.yml --env-file .env.test up -d --force-recreate --no-deps edge-relay'); // the relay must follow the edge it rides in
    expect(log).toContain('docker compose -p sre-test -f docker-compose.yml --env-file .env.test restart demo-login'); // a mounted bundle needs its container restarted
    expect(log).toContain(`standup-check env=${join(app, 'infra/compose/.env.test')}`);
    expect(log).toContain('curl -fsk --max-time 10 https://127.0.0.1/readyz'); // the public front, which the stand-up check cannot see
    expect(log).toContain('curl -sS -L -o /dev/null --max-time 5 -w %{http_code} http://127.0.0.1:8080/pos/'); // the web front is given time to answer again after the tool restarts
    expect(await lastLogLine()).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d:]+Z result=deployed sha=${V2} previous=${V1} by=octocat run=123$`));
    expect(r.out).not.toContain(SENTINEL);
  }, 30_000);

  it('a release that never becomes READY is put back: previous commit live again, red exit 70, the container logs shown', async () => {
    await writeFile(upResults, 'down\nok\n');
    const r = run([V3, 'octocat', '124']);
    expect(r.code, r.out).toBe(70);
    expect(r.out).toContain('ROLLED BACK');
    expect(r.out).toContain('stub log line');
    expect(head()).toBe(V2);
    expect((await callLog()).filter((l) => l.includes(' up -d --build')).length).toBe(2);
    expect(await lastLogLine()).toContain(`result=rolled_back sha=${V3} previous=${V2} by=octocat run=124`);
    expect(r.out).not.toContain(SENTINEL);
  }, 30_000);

  it('as an SSH forced command the arguments arrive in SSH_ORIGINAL_COMMAND; any other verb is refused', async () => {
    expect(run([], { SSH_ORIGINAL_COMMAND: `rm -rf / ${V3}` }).code).toBe(64);
    expect(head()).toBe(V2);
    await writeFile(upResults, 'ok\n');
    const r = run([], { SSH_ORIGINAL_COMMAND: `release ${V3} octocat 456` });
    expect(r.code, r.out).toBe(0);
    expect(head()).toBe(V3);
    expect(await lastLogLine()).toContain(`result=deployed sha=${V3} previous=${V2} by=octocat run=456`);
  }, 30_000);

  it.skipIf(spawnSync('flock', ['--version']).status !== 0)('two deployments cannot run at once (75)', async () => {
    await mkdir(join(sandbox, 'state'), { recursive: true });
    // Another "deployment" holds the lock until we close its stdin — then it exits and the lock is released
    // (killing it would leave a child holding the inherited descriptor, which is exactly the point of the lock).
    // It says "held" once it has the lock — on a busy runner a fixed pause let the release take the lock first.
    const holder = spawn('bash', ['-c', 'exec 9>"$1"; flock 9; echo held; read -r _', '_', lock], { stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('the lock holder never took the lock')), 10_000);
      holder.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('held')) { clearTimeout(timer); res(); } });
    });
    try {
      const r = run([V2, 'octocat', '7']);
      expect(r.code).toBe(75);
      expect(r.out).toContain('another deployment is running');
      expect(head()).toBe(V3);
    } finally {
      const gone = new Promise((res) => holder.on('exit', res));
      holder.stdin!.end('\n');
      await gone;
    }
  }, 30_000);

  it('when the previous release does not come back either, it says so and exits 71 — a person is needed', async () => {
    await writeFile(upResults, 'down\ndown\n');
    const r = run([V2, 'octocat', '125']);
    expect(r.code, r.out).toBe(71);
    expect(r.out).toContain('ROLLBACK FAILED');
    expect(head()).toBe(V3); // the previous release is what is checked out, even though it did not answer
    expect(await lastLogLine()).toContain(`result=rollback_failed sha=${V2} previous=${V3}`);
  }, 30_000);

  it('verifier r21 rolling deploy: a stack running TWO API containers is refused (one API version at a time), and needs a person', async () => {
    await writeFile(upResults, 'ok\nok\n');
    const before = head();
    const r = run([V2, 'octocat', '126'], { SRE_TEST_API_CONTAINERS: '2' });
    expect(r.code, r.out).toBe(71); // the previous release runs two as well — a person scales it back to one
    expect(r.out).toContain('REFUSED — 2 API containers are running in this stack; head office must run exactly ONE API at a time');
    expect((await callLog()).some((l) => l.includes(' ps -q api'))).toBe(true);
    expect(before).not.toBe(V2);
    // One container (the normal stack): the same release deploys.
    await writeFile(upResults, 'ok\n');
    const ok = run([V2, 'octocat', '127']);
    expect(ok.code, ok.out).toBe(0);
    expect(head()).toBe(V2);
  }, 30_000);

  it('verifier r22 (low): two API containers are refused BEFORE the stack is rebuilt; a count compose cannot give is refused, never read as 0', async () => {
    await writeFile(upResults, 'ok\nok\n');
    await writeFile(calls, '');
    const two = run([V3, 'octocat', '128'], { SRE_TEST_API_CONTAINERS: '2' });
    expect(two.code, two.out).toBe(71);
    const log = await callLog();
    const firstPs = log.findIndex((l) => l.includes(' ps -q api'));
    const firstUp = log.findIndex((l) => l.includes(' up -d --build'));
    expect(firstPs).toBeGreaterThanOrEqual(0);
    expect(firstUp === -1 || firstPs < firstUp).toBe(true); // counted before anything was brought up
    expect(log.some((l) => l.includes(' up -d --build'))).toBe(false); // and so never brought up beside the two
    await writeFile(upResults, 'ok\nok\n');
    const blind = run([V3, 'octocat', '129'], { SRE_TEST_PS_FAILS: '1' });
    expect(blind.code, blind.out).not.toBe(0);
    expect(blind.out).toContain('REFUSED — could not count the API containers in this stack (docker compose ps failed)');
    // The normal stack (one API, compose answers): deploys.
    await writeFile(upResults, 'ok\n');
    const ok = run([V3, 'octocat', '130']);
    expect(ok.code, ok.out).toBe(0);
    expect(head()).toBe(V3);
  }, 30_000);

  // ── WF-20 (ADR-0026): the backup before the release, and the canary bake after it ────────────────────────────────
  const BACKUP_OK = 'echo backup-taken >> "$SRE_TEST_CALLS"';
  const BAKE = { SRE_BAKE_SECONDS: '2', SRE_BAKE_POLL: '1', SRE_BAKE_MAX_5XX: '0' };

  it('a pre-release backup that fails refuses the release (69): nothing built, nothing checked out, and the log says so', async () => {
    const before = head();
    const r = run([V2, 'octocat', '201'], { SRE_PREDEPLOY_BACKUP_CMD: 'echo backup-tried >> "$SRE_TEST_CALLS"; exit 3' });
    expect(r.code, r.out).toBe(69);
    expect(r.out).toContain('pre-release backup did not succeed');
    expect(head()).toBe(before);
    const log = await callLog();
    expect(log).toContain('backup-tried');
    expect(log.some((l) => l.startsWith('docker') || l.startsWith('pnpm'))).toBe(false);
    expect(await lastLogLine()).toContain(`result=backup_failed sha=${V2} previous=${before}`);
  }, 30_000);

  it('the canary: backup first, then up, GREEN, and WATCHED for the bake — READY throughout, no new server errors — then deployed', async () => {
    await writeFile(upResults, 'ok\n');
    await writeFile(join(sandbox, 'metrics'), '3\n3\n3\n'); // three old 5xx before the release; none added
    const r = run([V2, 'octocat', '202'], { SRE_PREDEPLOY_BACKUP_CMD: BACKUP_OK, ...BAKE });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/canary bake: watching .* for 2s/);
    expect(r.out).toMatch(/stayed READY for 2s with server errors at 3/);
    const log = await callLog();
    expect(log.indexOf('backup-taken')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('backup-taken')).toBeLessThan(log.findIndex((l) => l.startsWith('pnpm'))); // the backup comes BEFORE anything changes
    expect(log.filter((l) => l.includes('/metricz')).length).toBeGreaterThanOrEqual(2);
    expect(head()).toBe(V2);
    expect(await lastLogLine()).toContain(`result=deployed sha=${V2}`);
  }, 30_000);

  it('a release that comes up GREEN but adds server errors during the bake is rolled back (70), recorded as a canary failure', async () => {
    await writeFile(upResults, 'ok\nok\n');
    await writeFile(join(sandbox, 'metrics'), '0\n4\n');
    const r = run([V3, 'octocat', '203'], BAKE);
    expect(r.code, r.out).toBe(70);
    expect(r.out).toContain('failed its canary bake');
    expect(r.out).toMatch(/server errors went from 0 to 4/);
    expect(head()).toBe(V2);
    expect(await lastLogLine()).toContain(`result=rolled_back_in_canary_bake sha=${V3} previous=${V2} by=octocat run=203`);
  }, 30_000);

  it('an error count the bake cannot read is a failure, never a pass (P-08)', async () => {
    await writeFile(upResults, 'ok\nok\n');
    await writeFile(join(sandbox, 'metrics'), 'garbage\n');
    const r = run([V3, 'octocat', '204'], BAKE);
    expect(r.code, r.out).toBe(70);
    expect(r.out).toContain('cannot be read');
    expect(head()).toBe(V2);
    expect(await lastLogLine()).toContain('result=rolled_back_in_canary_bake');
  }, 30_000);

  // ── WF-20 · AID-08 "sign releases" (OB-288 P5): a box with the release key deploys only a signed release ────────────
  const SIGNER = join(process.cwd(), 'scripts/release-signing.mjs');
  const keyPair = () => {
    const k = generateKeyPairSync('ed25519');
    return { pem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: k.publicKey.export({ type: 'spki', format: 'pem' }) as string };
  };
  // The CI half: the real signing script, run against the origin's objects with a key held only in this process's memory.
  const signed = (sha: string, pem: string): string => {
    const r = spawnSync('node', [SIGNER, 'sign', sha], { cwd: join(sandbox, 'origin.git'), encoding: 'utf8', env: { ...process.env, ['RELEASE_SIGNING' + '_KEY']: pem } });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  it('signing: a box with the release key refuses an unsigned release, another key\'s signature, another commit\'s signature and garbage (77) — before the backup, the box untouched', async () => {
    const release = keyPair(); const stranger = keyPair();
    const pubPath = join(sandbox, 'release-signing.pub'); await writeFile(pubPath, release.pub);
    const env = { SRE_RELEASE_PUBKEY: pubPath, SRE_PREDEPLOY_BACKUP_CMD: BACKUP_OK };
    const before = head();
    const cases: [string, string[], string][] = [
      ['unsigned', [V3, 'octocat', '301'], 'unsigned_refused'],
      ['another key', [V3, 'octocat', '302', signed(V3, stranger.pem)], 'signature_refused'],
      ['another commit', [V3, 'octocat', '303', signed(V1, release.pem)], 'signature_refused'],
      ['garbage', [V3, 'octocat', '304', 'not-a-signature'], 'signature_refused'],
    ];
    for (const [name, args, result] of cases) {
      const r = run(args, env);
      expect(r.code, `${name}: ${r.out}`).toBe(77);
      expect(r.out).toContain('REFUSED');
      expect(await lastLogLine()).toContain(`result=${result} sha=${V3} previous=${before}`);
    }
    expect(head()).toBe(before);
    const log = await callLog();
    expect(log.some((l) => l.startsWith('docker') || l.startsWith('pnpm') || l === 'backup-taken')).toBe(false);
  }, 60_000);

  it('signing: the release key\'s signature over THIS commit deploys — also through the forced SSH command; a box without the key says it did not check', async () => {
    const release = keyPair();
    const pubPath = join(sandbox, 'release-signing.pub'); await writeFile(pubPath, release.pub);
    await writeFile(upResults, 'ok\n');
    // OB-423: the pipeline's word order — the signature, then the attempt (`attempt=N`) — both read.
    const r = run([], { SRE_RELEASE_PUBKEY: pubPath, SSH_ORIGINAL_COMMAND: `release ${V3} octocat 305 ${signed(V3, release.pem)} attempt=2` });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`release signature verified for ${V3}`);
    expect(await lastQg10()).toMatchObject({ release: V3, run: '305', attempt: '2' });
    expect(head()).toBe(V3);
    expect(await lastLogLine()).toMatch(new RegExp(`result=deployed sha=${V3} previous=[0-9a-f]{40} by=octocat run=305$`));
    // The key path set but unreadable: NOT SET UP (78), never "skip the check".
    const missing = run([V2, 'octocat', '306'], { SRE_RELEASE_PUBKEY: join(sandbox, 'no-such.pub') });
    expect(missing.code, missing.out).toBe(78);
    expect(await lastLogLine()).toContain('result=signature_key_missing');
    // No key on the box: deployed, and said out loud that the signature was not checked.
    await writeFile(upResults, 'ok\n');
    const unchecked = run([V2, 'octocat', '307']);
    expect(unchecked.code, unchecked.out).toBe(0);
    expect(unchecked.out).toContain('release signature NOT CHECKED on this box');
    expect(unchecked.out).toContain('the release arrived NOT SIGNED');
    expect(head()).toBe(V2);
    // OB-342: the custodian has set the secret but the box has no public key yet — the signed release deploys (the demo
    // keeps updating), and the box says it did not check and that the release arrived signed.
    await writeFile(upResults, 'ok\n');
    const signedButUnchecked = run([], { SSH_ORIGINAL_COMMAND: `release ${V3} octocat 308 ${signed(V3, release.pem)}` });
    expect(signedButUnchecked.code, signedButUnchecked.out).toBe(0);
    expect(signedButUnchecked.out).toContain('release signature NOT CHECKED on this box (SRE_RELEASE_PUBKEY is not set; the release arrived signed)');
    expect(head()).toBe(V3);
  }, 60_000);

  it('signing: the script never signs without a key, and its self-test refuses tampering and another key', () => {
    const none = spawnSync('node', [SIGNER, 'sign', V2], { cwd: join(sandbox, 'origin.git'), encoding: 'utf8', env: { ...process.env, ['RELEASE_SIGNING' + '_KEY']: '' } });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('NOT SIGNED');
    const selftest = spawnSync('node', [SIGNER, 'selftest', V2], { cwd: join(sandbox, 'origin.git'), encoding: 'utf8' });
    expect(selftest.status, selftest.stdout + selftest.stderr).toBe(0);
    expect(selftest.stdout).toContain('GREEN — release signing self-test');
    expect(selftest.stdout).toContain('tamperedRefused=true otherKeyRefused=true garbageRefused=true');
  });

  // ── QG-10 · WF-20 (FG-3): the books reconciled around every release, and the per-release QG-10 record ──────────────────
  it('QG-10: the books are snapshotted before anything changes and compared after; a release they agree on is deployed, with its QG-10 record', async () => {
    await writeFile(upResults, 'ok\n');
    await writeFile(join(sandbox, 'metrics'), '0\n0\n0\n');
    const r = run([V2, 'octocat', '401'], { SRE_BAKE_SECONDS: '2', SRE_BAKE_POLL: '1' });
    expect(r.code, r.out).toBe(0);
    const log = await callLog();
    const before = log.indexOf('snapshot ');
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThan(log.findIndex((l) => l.startsWith('pnpm'))); // before anything is rebuilt
    expect(log).toContain('snapshot --upto 10'); // after: the ledger re-read up to where it stood
    expect(r.out).toContain('reconcile: RECONCILED');
    const q = await lastQg10();
    expect(q).toMatchObject({ release: V2, outcome: 'deployed', verified: true, checks: { health: 'verified', smoke: 'verified', reconciliation: 'verified', monitoring: 'verified', rollback: 'ready' }, differences: [] });
    expect(q.decision).toMatch(/evidence for the owner's QG-10 decision/);
    expect(r.out).toMatch(/release: QG-10 record: \{"gate":"QG-10"/);
    expect(r.out).not.toContain(SENTINEL);
  }, 30_000);

  it('QG-10: an event lost across the release rolls it back (70) — the differences said in words, the QG-10 record kept', async () => {
    await writeFile(upResults, 'ok\nok\n');
    await snaps(books(10), after(11, { seq: 10, count: 9, digest: 'other', sales: 9 }));
    const before = head();
    const r = run([V3, 'octocat', '402']);
    expect(r.code, r.out).toBe(70);
    expect(r.out).toContain('THE BOOKS DO NOT RECONCILE');
    expect(r.out).toMatch(/DIFFERENCE — the ledger held 10 event\(s\) before the release and holds 9 of them now — some were LOST/);
    expect(r.out).toContain('ROLLED BACK');
    expect(head()).toBe(before);
    expect(await lastLogLine()).toContain(`result=rolled_back_on_reconcile sha=${V3} previous=${before}`);
    const q = await lastQg10();
    expect(q).toMatchObject({ release: V3, outcome: 'rolled_back_on_reconcile', verified: false, checks: { health: 'verified', smoke: 'verified', reconciliation: 'failed', rollback: 'exercised_ok' } });
    expect(q.differences.join(' ')).toMatch(/some were LOST/);
  }, 30_000);

  it('QG-10: a new dead letter or a grown sync backlog is a difference too (70); an allowance set on the box lets the backlog grow that far', async () => {
    await writeFile(upResults, 'ok\nok\n');
    await snaps(books(10, 1, 0), after(12, { seq: 10, count: 10, digest: 'd10', sales: 10 }, 2, 0));
    const dead = run([V3, 'octocat', '403']);
    expect(dead.code, dead.out).toBe(70);
    expect(dead.out).toMatch(/DIFFERENCE — 1 new dead letter\(s\) in the outbox since the release \(from 1 to 2; allowed \+0\)/);
    await writeFile(upResults, 'ok\nok\n');
    await snaps(books(10, 0, 3), after(12, { seq: 10, count: 10, digest: 'd10', sales: 10 }, 0, 5));
    const backlog = run([V3, 'octocat', '404']);
    expect(backlog.code, backlog.out).toBe(70);
    expect(backlog.out).toMatch(/the sync backlog grew by 2 \(from 3 pending to 5; allowed \+0\)/);
    await writeFile(upResults, 'ok\n');
    const allowed = run([V3, 'octocat', '405'], { SRE_RECONCILE_MAX_BACKLOG_GROWTH: '2' });
    expect(allowed.code, allowed.out).toBe(0);
    expect(head()).toBe(V3);
    // A box with no bake: monitoring was not run here, so the record says QG-10 is not fully verified on this box.
    expect(await lastQg10()).toMatchObject({ outcome: 'deployed', verified: false, notVerified: ['monitoring'], checks: { monitoring: 'not_run_on_this_box' } });
  }, 60_000);

  it('QG-10: books that cannot be read BEFORE the release refuse it (69) with nothing rebuilt — by default through the stack\'s own migrate container', async () => {
    const before = head();
    const r = run([V2, 'octocat', '406'], { SRE_RECONCILE_CMD: '' }); // the default: docker compose run … migrate (the stub prints nothing)
    expect(r.code, r.out).toBe(69);
    expect(r.out).toContain('REFUSED — the books could not be read before the release');
    expect(head()).toBe(before);
    const log = await callLog();
    expect(log).toContain(`docker compose -p sre-test -f docker-compose.yml --env-file .env.test run --rm --no-deps -T -v ${join(app, 'scripts')}:/app/scripts:ro migrate node scripts/release-reconcile.mjs snapshot`);
    expect(log.some((l) => l.startsWith('pnpm') || l.includes(' up -d --build'))).toBe(false);
    expect(await lastLogLine()).toContain(`result=reconcile_snapshot_failed sha=${V2} previous=${before}`);
    expect(await lastQg10()).toMatchObject({ release: V2, outcome: 'refused_books_unreadable', verified: false, checks: { reconciliation: 'failed' } });
    expect(r.out).not.toContain(SENTINEL);
  }, 30_000);

  it('QG-10: a box with the reconcile switched off says so on every run, and its QG-10 record says reconciliation was not run', async () => {
    await writeFile(upResults, 'ok\n');
    const r = run([V2, 'octocat', '407'], { SRE_RECONCILE: 'off' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('the post-deploy reconcile is SWITCHED OFF on this box');
    expect((await callLog()).some((l) => l.startsWith('snapshot'))).toBe(false);
    expect(await lastQg10()).toMatchObject({ outcome: 'deployed', verified: false, checks: { reconciliation: 'not_run' } });
  }, 30_000);

  it('WF-20 duplicate: the same release sent again is re-applied harmlessly — said, deployed once more, the books reconciled, one more log line', async () => {
    await writeFile(upResults, 'ok\n');
    const first = run([V2, 'octocat', '408']);
    expect(first.code, first.out).toBe(0);
    await writeFile(upResults, 'ok\n');
    const again = run([V2, 'octocat', '409']);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain(`this box is already at ${V2} — re-applying it (harmless, idempotent)`);
    expect(again.out).toContain('reconcile: RECONCILED');
    expect(head()).toBe(V2);
    expect(await lastLogLine()).toContain(`result=deployed sha=${V2} previous=${V2} by=octocat run=409`);
    expect(await lastQg10()).toMatchObject({ release: V2, outcome: 'deployed' });
  }, 30_000);

  // ── OB-423: the QG-10 line reaches head office's gate register under the release script's own machine identity ───────────
  it('OB-423: with no key on the box the release still runs and says plainly the QG-10 note was NOT POSTED', async () => {
    await writeFile(upResults, 'ok\n');
    const r = run([V3, 'octocat', '501']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`DEPLOYED ${V3}`);
    expect(r.out).toMatch(new RegExp(`release: QG-10 note NOT POSTED to head office's gate register \\(release ${V3}, box [^)]+\\) — the key file named by SRE_QG10_PUSH_TOKEN_FILE is not on this box`));
    expect(await lastQg10()).toMatchObject({ release: V3, outcome: 'deployed' }); // the box's own log still has the line
    // An empty key file is not a key either.
    await mkdir(join(sandbox, 'secrets'), { recursive: true });
    await writeFile(join(sandbox, 'secrets', 'qg10-push.token'), '\n', { mode: 0o600 });
    await writeFile(upResults, 'ok\n');
    const empty = run([V3, 'octocat', '502']);
    expect(empty.code, empty.out).toBe(0);
    expect(empty.out).toContain('the key file named by SRE_QG10_PUSH_TOKEN_FILE is empty');
    await rm(join(sandbox, 'secrets', 'qg10-push.token'));
  }, 60_000);

  it('OB-423: with the custodian\'s key the note is posted (key only in the header, never printed); a second, different note for the release is refused and said; an unreachable head office is said — the release runs every time', async () => {
    const portFile = join(sandbox, 'register.port'); const posted = join(sandbox, 'register.log');
    await writeFile(join(sandbox, 'register-stub.cjs'), REGISTER_STUB);
    await writeFile(posted, '');
    const server = spawn(process.execPath, [join(sandbox, 'register-stub.cjs'), portFile, posted], { stdio: 'ignore' });
    try {
      let port = '';
      for (let i = 0; i < 100 && port === ''; i += 1) { port = await readFile(portFile, 'utf8').catch(() => ''); if (port === '') await new Promise((d) => { setTimeout(d, 50); }); }
      expect(port).not.toBe('');
      await mkdir(join(sandbox, 'secrets'), { recursive: true });
      await writeFile(join(sandbox, 'secrets', 'qg10-push.token'), `${QG10_KEY}\n`, { mode: 0o600 });
      const env = { SRE_QG10_REGISTER_URL: `http://127.0.0.1:${port}` };
      const runAsync = (args: readonly string[]) => new Promise<{ code: number | null; out: string }>((done) => {
        const c = spawn('bash', [join(app, 'infra/deploy/release.sh'), ...args], { env: { ...baseEnv, ...env } });
        let out = ''; c.stdout.on('data', (d) => { out += String(d); }); c.stderr.on('data', (d) => { out += String(d); });
        c.on('close', (code) => { done({ code, out }); });
      });
      const sent = async () => (await readFile(posted, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method: string; path: string; auth: string | null; key: string | null; body: string });

      await writeFile(upResults, 'ok\n');
      const r = await runAsync([V2, 'octocat', '503', 'attempt=1']);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(new RegExp(`release: QG-10 note posted to head office's gate register \\(release ${V2}, box [^,]+, run 503, attempt 1\\)\\.`));
      // The run and the attempt are in the line itself.
      expect(r.out).toMatch(/release: QG-10 record: \{[^\n]*"run":"503","attempt":"1"/);
      const [first] = await sent();
      expect(first).toMatchObject({ method: 'POST', path: '/v1/compliance/gate-register/qg10-evidence', auth: `Bearer ${QG10_KEY}` });
      expect(first!.key).toMatch(/^qg10-note-[0-9a-f]{40}$/);
      const note = (JSON.parse(first!.body) as { note: { release: string; outcome: string; decision: string } }).note;
      expect(note).toMatchObject({ release: V2, outcome: 'deployed' });
      expect(note).toEqual(await lastQg10()); // exactly the line the box logged
      // The key is never printed, never on a command line the stand-ins saw, never in the box's logs.
      expect(r.out).not.toContain(QG10_KEY);
      expect((await callLog()).join('\n')).not.toContain(QG10_KEY);
      expect(await readFile(join(sandbox, 'state', 'qg10.jsonl'), 'utf8')).not.toContain(QG10_KEY);
      expect(await readFile(releaseLog, 'utf8')).not.toContain(QG10_KEY);

      // OB-423 (a): the pipeline re-runs the same release (attempt 2) — its own note, posted too; head office holds both.
      await writeFile(upResults, 'ok\n');
      const again = await runAsync([V2, 'octocat', '503', 'attempt=2']);
      expect(again.code, again.out).toBe(0);
      expect(again.out).toMatch(new RegExp(`release: QG-10 note posted to head office's gate register \\(release ${V2}, box [^,]+, run 503, attempt 2\\)\\.`));
      const attempts = (await sent()).map((x) => JSON.parse(x.body) as { note: { release: string; run: string; attempt: string } }).map((x) => `${x.note.release.slice(0, 7)} ${x.note.run}/${x.note.attempt}`);
      expect(attempts).toEqual([`${V2.slice(0, 7)} 503/1`, `${V2.slice(0, 7)} 503/2`]);
      // A DIFFERENT note claiming an attempt already noted (the same words typed again by hand): refused, the first kept; said.
      await writeFile(upResults, 'ok\n');
      const reused = await runAsync([V2, 'octocat', '503', 'attempt=1']);
      expect(reused.code, reused.out).toBe(0);
      expect(reused.out).toMatch(/release: QG-10 note NOT POSTED to head office's gate register \(release [0-9a-f]{40}, box [^,]+, run 503, attempt 1\) — head office already holds a different note from this box for this release attempt and keeps the first \(HTTP 409 qg10_note_already_recorded\)/);

      // A rollback leaves its note too.
      await writeFile(upResults, 'down\nok\n');
      const back = await runAsync([V3, 'octocat', '505']);
      expect(back.code, back.out).toBe(70);
      expect(back.out).toMatch(new RegExp(`QG-10 note posted to head office's gate register \\(release ${V3}`));
      expect((JSON.parse((await sent()).at(-1)!.body) as { note: { outcome: string } }).note.outcome).toBe('rolled_back');
      expect(back.out).not.toContain(QG10_KEY);
    } finally { server.kill(); }

    // Head office not listening: said, and the release still deploys.
    await writeFile(upResults, 'ok\n');
    const down = run([V3, 'octocat', '506'], { SRE_QG10_REGISTER_URL: 'http://127.0.0.1:9' });
    expect(down.code, down.out).toBe(0);
    expect(down.out).toContain('QG-10 note NOT POSTED to head office\'s gate register');
    expect(down.out).toContain('head office could not be reached at SRE_QG10_REGISTER_URL');
    expect(down.out).not.toContain(QG10_KEY);
    // An address that is neither https nor the box's loopback is refused before anything is sent.
    await writeFile(upResults, 'ok\n');
    const plain = run([V3, 'octocat', '507'], { SRE_QG10_REGISTER_URL: 'http://ho.example.test' });
    expect(plain.code, plain.out).toBe(0);
    expect(plain.out).toContain('neither https nor this box\'s own loopback');
    await rm(join(sandbox, 'secrets', 'qg10-push.token'));
  }, 90_000);

  it('OB-423 (a): the line names the run and the attempt — the CI\'s own run id and attempt when present, else "manual" and a box-local attempt time', async () => {
    // Run on a CI runner with no run words: GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT from the environment.
    await writeFile(upResults, 'ok\n');
    const ci = run([V3], { GITHUB_RUN_ID: '777001', GITHUB_RUN_ATTEMPT: '3' });
    expect(ci.code, ci.out).toBe(0);
    expect(await lastQg10()).toMatchObject({ release: V3, run: '777001', attempt: '3' });
    expect(ci.out).toContain('pipeline run 777001 (attempt 3)');
    // The words win over the environment (the pipeline hands them to the box over SSH, where its environment does not reach).
    await writeFile(upResults, 'ok\n');
    const words = run([V3, 'octocat', '777002', 'attempt=4'], { GITHUB_RUN_ID: 'other', GITHUB_RUN_ATTEMPT: '9' });
    expect(words.code, words.out).toBe(0);
    expect(await lastQg10()).toMatchObject({ run: '777002', attempt: '4' });
    // By hand on the box: run "manual", and the attempt is the box's own UTC time of this attempt.
    await writeFile(upResults, 'ok\n');
    const byHand = run([V3]);
    expect(byHand.code, byHand.out).toBe(0);
    const manual = await lastQg10();
    expect(manual.run).toBe('manual');
    expect(manual.attempt).toMatch(/^local-\d{8}T\d{6}Z$/);
    // Garbage in the attempt word is not believed: the box-local time is used instead, never the garbage.
    await writeFile(upResults, 'ok\n');
    const junk = run([V3, 'octocat', '777003', 'attempt=0;rm']);
    expect(junk.code, junk.out).toBe(0);
    expect((await lastQg10()).attempt).toMatch(/^local-\d{8}T\d{6}Z$/);
  }, 60_000);
});
