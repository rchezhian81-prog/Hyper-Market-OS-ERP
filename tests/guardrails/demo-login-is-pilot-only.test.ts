import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadCodeEntries } from './lib/scan.js';

/**
 * **The demo sign-in can never reach a real store.**
 *
 * `infra/pilot/demo-login` MINTS tokens (it is the demo box's stand-in for an identity provider, owner
 * decision 27 Sep 2026, defect H-01). A minter in a store deployment would be a token factory next to
 * real money (hard rule #4). So, structurally:
 *   1. only the PILOT overlay defines the service — the base (store) compose file does not;
 *   2. it publishes no port — it is reachable only through the HTTPS front's /login;
 *   3. nothing in the product (services/, apps/, edge/, packages/) imports it;
 *   4. the front turns the session cookie into a bearer token for /v1/ ONLY, and an explicit
 *      Authorization header still wins.
 * Its own refusal to start outside the synthetic `pilot-demo` tenant is proven in
 * tests/unit/demo-login.test.ts.
 */

const BASE = readFileSync('infra/compose/docker-compose.yml', 'utf8');
const PILOT = readFileSync('infra/compose/docker-compose.pilot.yml', 'utf8');
const NGINX = readFileSync('infra/compose/nginx.pilot.conf', 'utf8');
const BASE_NGINX = readFileSync('infra/compose/nginx.conf', 'utf8');

function serviceBlock(yaml: string, service: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('the demo sign-in is pilot-only', () => {
  it('the base (store) compose file has no demo sign-in and no cookie bridge', () => {
    expect(BASE).not.toMatch(/demo-login/);
    expect(BASE_NGINX).not.toMatch(/sre_demo_session|demo-login/);
  });

  it('the pilot overlay defines it, switched on explicitly, with no published port', () => {
    const svc = serviceBlock(PILOT, 'demo-login');
    expect(svc).not.toBe('');
    expect(svc).toMatch(/DEMO_LOGIN_ENABLED: '1'/);
    expect(svc).not.toMatch(/^\s+ports:/m);
    expect(svc).toMatch(/read_only: true/);
    expect(svc).toMatch(/user: '1000:1000'/);
    // A DIRECTORY mount: a single-file bind mount pins the old inode, so an atomically replaced login
    // file would never be seen by the running service (found on the demo box, 27 Sep 2026).
    expect(svc).toMatch(/\$\{DEMO_LOGIN_DIR:-\/etc\/sre-pilot\/demo-login\}:\/etc\/demo-login:ro/);
    expect(svc).not.toMatch(/\.json:\/etc\/[^\n]*:ro/);
  });

  it('nothing in the product imports it', () => {
    const offenders = loadCodeEntries(['services', 'apps', 'edge', 'packages'])
      .filter((e) => /demo-login|infra\/pilot/.test(e.content))
      .map((e) => e.file);
    expect(offenders).toEqual([]);
  });

  it('the cookie becomes a bearer token on /v1/ only, and an explicit Authorization header wins', () => {
    expect(NGINX).toMatch(/map \$http_authorization \$sre_api_authorization \{ default \$http_authorization; "" \$sre_cookie_bearer; \}/);
    const uses = NGINX.split('\n').filter((l) => l.includes('$sre_api_authorization') && l.includes('proxy_set_header'));
    expect(uses).toHaveLength(1);
    const v1 = /location \/v1\/ \{([^}]*)\}/.exec(NGINX)?.[1] ?? '';
    expect(v1).toMatch(/proxy_set_header Authorization \$sre_api_authorization;/);
    const login = /location \/login \{([^}]*)\}/.exec(NGINX)?.[1] ?? '';
    expect(login).not.toMatch(/Authorization/);
    expect(login).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
  });
});
