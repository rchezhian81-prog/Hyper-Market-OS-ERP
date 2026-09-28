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

  it('the identity bridge is injected only by the pilot front, with a whitelisted page path', () => {
    expect(BASE_NGINX).not.toMatch(/sub_filter|screen-data\.js/);
    const subs = NGINX.split('\n').filter((l) => /^\s*sub_filter\s'/.test(l));
    expect(subs).toEqual([`    sub_filter '<!--SCREEN-DATA-->' '<script src="/login/screen-data.js?page=$sre_bridge_page"></script>';`]);
    // Only plain shell paths reach the HTML attribute; anything else becomes "" (the bridge then says nothing).
    expect(NGINX).toMatch(/map \$uri \$sre_bridge_page \{ ~\^\/\[a-z\]\+\/\(\?:\[a-z0-9-\]\+\\\.html\)\?\$ \$uri; default ""; \}/);
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
    // The /login location must NOT inherit the server's `Referrer-Policy: no-referrer` (a browser then
    // posts the sign-in with Origin: null and it is refused): it declares its own header set.
    expect(login).toMatch(/add_header /);
    expect(login).not.toMatch(/add_header Referrer-Policy/);
  });
});

describe('the DEMO store box relay (ADR-0016) is pilot-only and gated', () => {
  const RELAY = readFileSync('infra/compose/nginx.edge-relay.conf', 'utf8');

  it('the base (store) compose file has no relay and no screen server exposure', () => {
    expect(BASE).not.toMatch(/edge-relay|EDGE_SCREEN_PORT|network_mode/);
  });

  it('the relay shares the edge namespace and publishes no port', () => {
    const svc = serviceBlock(PILOT, 'edge-relay');
    expect(svc).toMatch(/network_mode: 'service:edge'/);
    expect(svc).not.toMatch(/^\s+ports:/m);
    expect(svc).toMatch(/read_only: true/);
  });

  it('the relay only forwards to the edge loopback sockets, screens read-only', () => {
    expect(RELAY).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:8097\/;/);
    expect(RELAY).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:8095;/);
    expect(RELAY).toMatch(/location \/store\/ \{\s*limit_except GET \{ deny all; \}/);
    expect(RELAY).toMatch(/location \/ \{ return 404; \}/);
  });

  it('the HTTPS front reaches the relay only behind the demo sign-in gate', () => {
    const store = /location \/store\/ \{([^}]*)\}/.exec(NGINX)?.[1] ?? '';
    const lane = /location \/store-lane\/ \{([^}]*)\}/.exec(NGINX)?.[1] ?? '';
    expect(store).toMatch(/auth_request \/_auth\/verify;/);
    expect(lane).toMatch(/auth_request \/_auth\/verify-sell;/);
    for (const block of [store, lane]) expect(block).toMatch(/proxy_pass http:\/\/\$sre_relay;/);
    // Nothing else in the front talks to the relay.
    expect(NGINX.split("\n").filter((l) => !l.trim().startsWith("#") && l.includes("edge:8096"))).toHaveLength(2);
    expect(NGINX).toMatch(/location = \/_auth\/verify \{\s*internal;/);
    expect(NGINX).toMatch(/location = \/_auth\/verify-sell \{\s*internal;/);
  });
});
