import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **One public origin, and only what is public is on it (ADR-0018 · Stage F slice 2 · P-04 · hard rule #4).**
 *
 * The compose `proxy` (Caddy) is the single https address a customer's browser talks to. This guardrail pins
 * the routing table and the posture around it: the API behind an overwritten client address, the customer
 * app from the edge's private screen server, sign-in refused by name until it exists, every staff screen 404,
 * TLS and the hardening headers, http → https; the edge widened only inside the compose network with no host
 * port; `web`/`api`/`db` on loopback; the env templates carrying the settings and no secret; and the CI job
 * that proves the whole thing over TLS on every run.
 */

const CADDY = readFileSync('infra/compose/Caddyfile', 'utf8');
const COMPOSE = readFileSync('infra/compose/docker-compose.yml', 'utf8');
const EDGE_DOCKERFILE = readFileSync('infra/docker/edge.Dockerfile', 'utf8');
const ENV = readFileSync('infra/compose/.env.example', 'utf8');
const PILOT_ENV = readFileSync('infra/compose/.env.pilot.example', 'utf8');
const CI = readFileSync('.github/workflows/ci.yml', 'utf8');

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
    for (const staff of ['/pos', '/owner', '/manager', '/buying', '/catalogue', '/admin', '/erp', '/picker', '/driver', '/warehouse']) {
      expect(CADDY, `${staff} must not be routed on the public origin`).not.toMatch(new RegExp(`path ${staff.replace('/', '\\/')}`));
    }
    expect((CADDY.match(/reverse_proxy edge:/g) ?? []).length).toBe(1);
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
});
