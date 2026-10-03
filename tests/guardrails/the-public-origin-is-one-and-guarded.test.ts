import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **One public origin, and only what is public is on it (ADR-0018 · Stage F slice 2 · P-04 · hard rule #4).**
 *
 * The compose `proxy` (Caddy) is the single https address a customer's browser talks to. This guardrail pins
 * the routing table and the posture around it: the API behind an overwritten client address, the customer
 * app from the edge's private screen server, sign-in refused by name until it exists, every staff screen 404
 * BY DEFAULT — routed only inside the `(staff-demo-gate)` snippet that the hosted demo's pilot overlay switches
 * on (ADR-0016, merged 3 Oct 2026), and then only to the demo front behind the demo sign-in — TLS and the
 * hardening headers, http → https; the edge widened only inside the compose network with no host port;
 * `web`/`api`/`db` on loopback; the env templates carrying the settings and no secret; and the CI job that
 * proves the whole thing over TLS on every run, with and without the gate.
 */

const CADDY = readFileSync('infra/compose/Caddyfile', 'utf8');
const COMPOSE = readFileSync('infra/compose/docker-compose.yml', 'utf8');
const EDGE_DOCKERFILE = readFileSync('infra/docker/edge.Dockerfile', 'utf8');
const ENV = readFileSync('infra/compose/.env.example', 'utf8');
const PILOT_ENV = readFileSync('infra/compose/.env.pilot.example', 'utf8');
const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const PILOT = readFileSync('infra/compose/docker-compose.pilot.yml', 'utf8');

/** One `(name) { … }` snippet of the Caddyfile, braces included. */
const snippet = (name: string): string => {
  const start = CADDY.indexOf(`\n(${name}) {\n`);
  expect(start, `snippet ${name}`).toBeGreaterThan(0);
  const end = CADDY.indexOf('\n}\n', start);
  return CADDY.slice(start, end + 3);
};
/** The Caddyfile with both staff snippets removed: what every site gets whatever the switch says. */
const OUTSIDE_THE_GATE = CADDY.replace(snippet('staff-not-public'), '').replace(snippet('staff-demo-gate'), '');

const service = (name: string): string => {
  const start = COMPOSE.indexOf(`\n  ${name}:\n`);
  expect(start, `compose service ${name}`).toBeGreaterThan(0);
  const rest = COMPOSE.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z-]+:\n|\nvolumes:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe('the Caddyfile routes only what is public', () => {
  it('sends the API paths to the api and OVERWRITES the client address so the per-IP limits cannot be spoofed', () => {
    expect(CADDY).toMatch(/@api path \/v1\/\* \/livez \/readyz/);
    expect(CADDY).toMatch(/reverse_proxy api:8081 \{[^}]*header_up X-Forwarded-For \{remote_host\}/s);
  });

  it('answers /auth by name until sign-in is deployed, and can be switched to an upstream by configuration', () => {
    expect(CADDY).toContain('(auth-not-deployed)');
    expect(CADDY).toMatch(/sign_in_not_deployed[^\n]*` 503/);
    expect(CADDY).toContain('(auth-upstream)');
    expect(CADDY).toMatch(/reverse_proxy \{\$SRE_AUTH_UPSTREAM\} \{[^}]*header_up X-Forwarded-For \{remote_host\}/s);
    expect(CADDY).toContain('import {$SRE_AUTH_ROUTE}');
  });

  it('forwards ONE screen — the customer app — to the edge, sends / there, and refuses everything else by name', () => {
    expect(CADDY).toMatch(/@customer path \/customer \/customer\/\*/);
    expect(CADDY).toContain('reverse_proxy edge:8091');
    expect(CADDY).toMatch(/handle \/ \{\s*redir \/customer\/ 302/);
    expect(CADDY).toMatch(/not_on_the_public_origin[^\n]*` 404/);
    // (/login appears outside the gate only as the header scope `@notSignIn not path /login …` — a response-header
    // exception, not a route; with the gate off, /login is a 404 by name like every other staff path.)
    for (const staff of ['/pos', '/owner', '/manager', '/buying', '/catalogue', '/admin', '/erp', '/picker', '/driver', '/warehouse', '/store']) {
      expect(OUTSIDE_THE_GATE, `${staff} must not be routed on the public origin outside the gate snippet`).not.toMatch(new RegExp(`path [^\\n]*${staff.replace('/', '\\/')}(?:/| |$)`));
    }
    const code = OUTSIDE_THE_GATE.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code.match(/\/login/g) ?? []).toHaveLength(2); // exactly the two tokens of that header scope
    expect((CADDY.match(/reverse_proxy edge:/g) ?? []).length).toBe(1);
  });

  it('staff screens: 404 by name by default; the hosted demo may switch on a gate that forwards them ONLY to the demo front behind the demo sign-in', () => {
    expect(CADDY).toContain('import {$SRE_STAFF_ROUTE}');
    expect(CADDY.indexOf('import {$SRE_STAFF_ROUTE}')).toBeLessThan(CADDY.indexOf('@api path /v1/* /livez /readyz')); // the cookie route is matched before the API route
    const off = snippet('staff-not-public');
    expect(off).toMatch(/staff_screens_not_public[^\n]*` 404/);
    expect(off).not.toContain('reverse_proxy');
    const on = snippet('staff-demo-gate');
    const targets = [...on.matchAll(/reverse_proxy ([^ \n{]+)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(new Set(targets)).toEqual(new Set(['web:80'])); // never the API or the edge directly
    expect(on).toMatch(/header !Authorization/); // an explicit token wins; only the cookie-only /v1 call takes the detour
    expect(on).toMatch(/header_regexp Cookie \(\^\|;\\s\*\)sre_demo_session=/);
    for (const staff of ['/pos', '/owner', '/erp', '/picker', '/delivery', '/warehouse', '/supplier', '/store', '/store-lane', '/login']) {
      expect(on, `${staff} is behind the gate`).toMatch(new RegExp(`@staff path [^\\n]* ${staff.replace('/', '\\/')}(?:/\\*| |$)`));
    }
    // Both switches say so: the base is off; the pilot overlay is on.
    expect(service('proxy')).toContain('SRE_STAFF_ROUTE: ${SRE_STAFF_ROUTE:-staff-not-public}');
    expect(PILOT).toContain('SRE_STAFF_ROUTE: ${SRE_STAFF_ROUTE:-staff-demo-gate}');
    expect(ENV).toMatch(/^SRE_STAFF_ROUTE=staff-not-public$/m);
    expect(PILOT_ENV).toMatch(/^SRE_STAFF_ROUTE=staff-demo-gate$/m);
  });

  it('the sign-in page keeps its own Referrer-Policy; every other response gets no-referrer last', () => {
    expect(CADDY).toMatch(/@notSignIn not path \/login \/login\/\*/);
    expect(CADDY).toMatch(/header @notSignIn \{\s*Referrer-Policy no-referrer\s*defer\s*\}/);
    expect(CADDY.match(/Referrer-Policy/g)).toHaveLength(1);
  });

  it('terminates TLS by configuration, hardens the headers, redirects http, and exposes no admin endpoint', () => {
    expect(CADDY).toContain('tls {$SRE_TLS}');
    expect(CADDY).toMatch(/^\{\$SRE_PUBLIC_HOST\} \{/m);
    expect(CADDY).toContain('Strict-Transport-Security');
    expect(CADDY).toContain('X-Content-Type-Options nosniff');
    expect(CADDY).toContain('X-Frame-Options DENY');
    expect(CADDY).toContain('-Server');
    expect(CADDY).toMatch(/:80 \{\s*redir https:\/\/\{host\}\{uri\} permanent/);
    expect(CADDY).toContain('admin off');
    expect(CADDY).toContain('default_sni {$SRE_DEFAULT_SNI}'); // a bare-IP client sends no server name; it still gets a certificate
  });
});

describe('compose publishes one front and binds the rest to loopback', () => {
  it('the proxy is the only service with public ports, and it runs the committed Caddyfile read-only', () => {
    const proxy = service('proxy');
    expect(proxy).toContain('image: caddy:');
    expect(proxy).toContain("'${HTTPS_PORT:-443}:443'");
    expect(proxy).toContain("'${HTTP_PORT:-80}:80'");
    expect(proxy).toContain('./Caddyfile:/etc/caddy/Caddyfile:ro');
    expect(proxy).toContain('no-new-privileges:true');
    expect(proxy).toContain("SRE_PUBLIC_HOST: '${SRE_PUBLIC_HOST:-localhost, 127.0.0.1}'"); // never a bare :443 — the internal issuer needs names
    expect(proxy).toContain('SRE_AUTH_ROUTE: ${SRE_AUTH_ROUTE:-auth-not-deployed}');
    expect(proxy).toContain('SRE_DEFAULT_SNI: ${SRE_DEFAULT_SNI:-localhost}');
  });

  it('db, api and web are bound to 127.0.0.1', () => {
    expect(service('db')).toContain("'127.0.0.1:${POSTGRES_PORT:-5432}:5432'");
    expect(service('api')).toContain("'127.0.0.1:${API_PORT:-8081}:8081'");
    expect(service('web')).toContain("'127.0.0.1:${WEB_PORT:-8080}:80'");
  });

  it('the edge serves screens on the private network only — widened by explicit setting, no host port, shells in the image', () => {
    const edge = service('edge');
    expect(edge).toContain("EDGE_SCREEN_PORT: '8091'");
    expect(edge).toContain("EDGE_SCREEN_HOST: '0.0.0.0'");
    expect(edge).toContain('EDGE_APPS_DIR: apps');
    expect(edge).not.toMatch(/^\s+ports:/m);
    expect(EDGE_DOCKERFILE).toMatch(/^COPY apps \.\/apps$/m);
  });

  it('both env templates carry the front settings, none of them a secret', () => {
    for (const [name, text] of [['.env.example', ENV], ['.env.pilot.example', PILOT_ENV]] as const) {
      expect(text, name).toMatch(/^SRE_PUBLIC_HOST=$/m);
      expect(text, name).toMatch(/^SRE_TLS=internal$/m);
      expect(text, name).toMatch(/^SRE_DEFAULT_SNI=localhost$/m);
      expect(text, name).toMatch(/^SRE_AUTH_ROUTE=auth-not-deployed$/m);
      expect(text, name).toMatch(/^HTTPS_PORT=443$/m);
    }
  });
});

describe('CI proves the public origin over TLS on every run', () => {
  it('readiness, /v1 refused without a token, the customer app, /auth 503 by name, staff paths 404, http redirect, HSTS, no Server header', () => {
    expect(CI).toContain('https://127.0.0.1/readyz');
    expect(CI).toContain('https://127.0.0.1/v1/catalogue/pack');
    expect(CI).toContain("customer-app.bundle.js");
    expect(CI).toContain('sign_in_not_deployed');
    expect(CI).toContain('for p in /owner/ /pos/ /manager/ /buying/ /admin.html');
    expect(CI).toContain('http://127.0.0.1:80/customer/');
    expect(CI).toContain('strict-transport-security');
    expect(CI).toContain("'^server:'");
    expect(CI).toContain('EDGE_TENANT_ID=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('…and with the pilot overlay on: every staff path and the store box go to the sign-in, the sign-in keeps its policy, a forged cookie is refused, the lane refuses', () => {
    expect(CI).toContain('P="docker compose -f docker-compose.yml -f docker-compose.pilot.yml"');
    expect(CI).toContain('$P up -d --build');
    expect(CI).toContain('EDGE_TENANT_ID=de300000-0000-4000-8000-000000000001'); // the demo sign-in serves only the synthetic demo tenant
    expect(CI).toContain('node scripts/build-service.mjs demo-login');
    expect(CI).toContain("sed -i 's/^SRE_STAFF_ROUTE=.*/SRE_STAFF_ROUTE=staff-demo-gate/' .env"); // the CI .env comes from .env.example (gate off)
    expect(CI).toContain('for p in /pos/ /erp/ /owner/ /picker/ /store/pos/');
    expect(CI).toContain('302 https://127.0.0.1/login/?next=$p');
    expect(CI).toContain("'^referrer-policy: same-origin'");
    expect(CI).toContain("'^referrer-policy: no-referrer'");
    expect(CI).toContain("'Cookie: sre_demo_session=not-a-token'");
    expect(CI).toContain('https://127.0.0.1/store-lane/lane/sale');
    expect(CI).toContain('http://127.0.0.1:8080/pos/');
    expect(CI).toContain('down -v --remove-orphans');
  });
});
