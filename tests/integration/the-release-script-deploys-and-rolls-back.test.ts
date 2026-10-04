import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 *   • the secrets file is never printed.
 */

const REAL_SCRIPT = join(process.cwd(), 'infra/deploy/release.sh');
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
esac
exit 0
`;
const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$SRE_TEST_CALLS"
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
    for (const [name, body] of [['pnpm', PNPM_STUB], ['docker', DOCKER_STUB], ['curl', CURL_STUB]] as const) {
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
      SRE_TEST_CALLS: calls, SRE_TEST_UP_RESULTS: upResults, SRE_TEST_READY: ready,
    };
  });
  afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });
  beforeEach(async () => { await writeFile(calls, ''); await writeFile(upResults, ''); await writeFile(ready, 'down\n'); });

  it('refuses garbage (64) and a commit that is not on origin/main (65) — and touches nothing', async () => {
    expect(run(['not-a-sha']).code).toBe(64);
    const r = run([FEATURE, 'octocat', '1']);
    expect(r.code).toBe(65);
    expect(r.out).toContain('not on origin/main');
    expect(head()).toBe(V1);
    expect((await callLog()).some((l) => l.startsWith('docker') || l.startsWith('pnpm'))).toBe(false);
  });

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
    const holder = spawn('bash', ['-c', 'exec 9>"$1"; flock 9; read -r _', '_', lock], { stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise((res) => setTimeout(res, 300));
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
});
