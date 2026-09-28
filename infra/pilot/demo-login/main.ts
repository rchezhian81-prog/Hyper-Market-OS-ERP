// Entry point for the DEMO-ONLY sign-in (see login.ts for what it is and why it cannot reach a store).
//
//   node demo-login.mjs serve                                   (in the pilot `demo-login` container)
//   node demo-login.mjs add --login <name> --user <pilot-user> --by "<operator>" [--file PATH]
//                                                               (on the box, by a person)
//
// `add` generates the password ON THE BOX and prints it ONCE to the operator's own terminal; only its
// scrypt hash is stored. Run it in your own SSH session, not through a chat tool, so the password is
// never copied anywhere else.

import { createServer } from 'node:http';
import { chmodSync, chownSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  addLogin, createDemoLoginHandler, FailureThrottle, generatePassword, loginFileProblems, startupRefusals,
  type DemoLoginFile,
} from './login';
import { createScreenBridgeHandler } from './screen-bridge';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

function readLogins(path: string): DemoLoginFile {
  if (!existsSync(path)) return { version: 1, logins: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const problems = loginFileProblems(parsed);
  if (problems.length > 0) throw new Error(`demo login file ${path} is unusable: ${problems.join('; ')}`);
  return parsed as DemoLoginFile;
}

function serve(): void {
  const env = process.env;
  const refusals = startupRefusals({
    DEMO_LOGIN_ENABLED: env['DEMO_LOGIN_ENABLED'], DEMO_TENANT_ID: env['DEMO_TENANT_ID'],
    MIGRATION_TARGET_KIND: env['MIGRATION_TARGET_KIND'], IDP_SIGNING_KEY: env['IDP_SIGNING_KEY'],
    IDP_ISSUER: env['IDP_ISSUER'], IDP_AUDIENCE: env['IDP_AUDIENCE'],
  });
  if (refusals.length > 0) {
    for (const r of refusals) process.stderr.write(`demo sign-in REFUSED to start — ${r}\n`);
    process.exit(78); // EX_CONFIG: do not crash-loop quietly on a config that will never be right
  }
  const file = env['DEMO_LOGIN_FILE'] ?? '/etc/demo-login/logins.json';
  // Read per request so a login added on the box works without a restart; a broken file fails closed.
  const logins = (): DemoLoginFile => readLogins(file);
  const count = logins().logins.length;

  const handle = createDemoLoginHandler({
    logins,
    idp: { secret: env['IDP_SIGNING_KEY']!, issuer: env['IDP_ISSUER']!, audience: env['IDP_AUDIENCE']! },
    throttle: new FailureThrottle(),
    now: () => Date.now(),
    audit: (line) => { process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`); },
  });

  // The identity bridge (H-11): asks the INTERNAL API who the session is. Never the public front.
  const apiUrl = (env['API_INTERNAL_URL'] ?? 'http://api:8081').replace(/\/+$/, '');
  const bridge = createScreenBridgeHandler({
    idp: { secret: env['IDP_SIGNING_KEY']!, issuer: env['IDP_ISSUER']!, audience: env['IDP_AUDIENCE']! },
    now: () => Date.now(),
    fetchMe: async (token, forwardedFor) => {
      const res = await fetch(`${apiUrl}/v1/identity/me`, {
        // The person's own address, so the API's per-IP limits apply per tester, not to this service.
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'x-forwarded-for': forwardedFor },
        signal: AbortSignal.timeout(5000),
      });
      return { status: res.status, body: res.ok ? await res.json() as unknown : undefined };
    },
  });

  const port = Number(env['PORT'] ?? '8090');
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 8192) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        const request = { method: req.method ?? 'GET', url: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') };
        if (request.method === 'GET' && request.url.startsWith('/login/screen-data.js')) {
          void bridge(request).then(
            (out) => { res.writeHead(out.status, out.headers).end(out.body); },
            (err: unknown) => {
              process.stderr.write(`demo identity bridge error: ${err instanceof Error ? err.message : String(err)}\n`);
              // Fail closed and visibly: the page boots "told nothing", exactly as without the bridge.
              res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
                .end('/* demo identity bridge unavailable — the screen shows what it knows without it */\n');
            },
          );
          return;
        }
        const out = handle(request);
        res.writeHead(out.status, out.headers).end(out.body);
      } catch (err) {
        process.stderr.write(`demo sign-in error: ${err instanceof Error ? err.message : String(err)}\n`);
        res.writeHead(500, { 'content-type': 'text/plain' }).end('The demo sign-in could not complete. Nothing was changed.');
      }
    });
  });
  server.listen(port, () => process.stdout.write(`demo sign-in (DEMO ONLY, synthetic tenant pilot-demo) on :${port} — ${count} login(s)\n`));
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => server.close(() => process.exit(0)));
}

function add(): void {
  const file = arg('file') ?? '/etc/sre-pilot/demo-login/logins.json';
  const login = (arg('login') ?? '').toLowerCase();
  const userId = arg('user') ?? '';
  const by = arg('by') ?? '';
  if (login === '' || userId === '' || by.trim() === '') {
    process.stderr.write('Usage: pnpm run demo-login:add -- --login <name> --user <pilot-user> --by "<your name>"\n');
    process.exit(2);
  }
  const password = generatePassword();
  const next = addLogin(readLogins(file), { login, userId, password, createdBy: by, now: new Date() });
  // Atomic replace, owner-only. The container runs as uid 1000 (`node`), so the file is handed to it.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try { chownSync(tmp, 1000, 1000); } catch { /* not root: leave ownership as is */ }
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  process.stdout.write(`\nDemo login created: ${login}  →  signs in as ${userId}\n`);
  process.stdout.write(`Password (shown ONCE — give it to that one person, privately): ${password}\n\n`);
}

const command = process.argv[2];
if (command === 'serve') serve();
else if (command === 'add') add();
else { process.stderr.write('Usage: demo-login.mjs serve | add --login <name> --user <pilot-user> --by "<name>"\n'); process.exit(2); }
