import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The hosted demo publishes HTTPS and nothing else — and TLS is the proxy's.**
 *
 * Until 3 Oct 2026 the pilot overlay's nginx (`web`) terminated TLS on 443 itself. Since the public proxy
 * (ADR-0018, in the base compose file) is the ONE public origin, the overlay publishes NOTHING to the network:
 * `web` keeps the base's loopback-only port for `standup:check`, the demo sign-in and the relay publish no
 * port, the edge publishes no port, and the database and the API stay on loopback. A port published in the
 * overlay would be open to the internet whatever the firewall says — Docker writes its own iptables rules for
 * a published port, so UFW's "allow SSH + 443 only" is bypassed for it — which is why this detector reads the
 * compose port lists and not the firewall.
 *
 * The client address: the proxy OVERWRITES X-Forwarded-For from the connection; the demo front takes the
 * address from that one header (realip) and forwards `$remote_addr` — never `$proxy_add_x_forwarded_for`,
 * which would let a client rotate a fake leftmost entry past the API's per-IP rate limit and sign-in lockout.
 *
 * And the staff shells the demo front serves are behind the demo sign-in (ADR-0018 §2: a staff screen joins a
 * public origin only behind a sign-in gate); the customer app is public by design.
 */

const BASE = readFileSync('infra/compose/docker-compose.yml', 'utf8');
const PILOT = readFileSync('infra/compose/docker-compose.pilot.yml', 'utf8');
const NGINX = readFileSync('infra/compose/nginx.pilot.conf', 'utf8');
const CADDY = readFileSync('infra/compose/Caddyfile', 'utf8');

/** The lines of one top-level service block (two-space indented key) in a compose file. */
function serviceBlock(yaml: string, service: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Every top-level service name in a compose file. */
const serviceNames = (yaml: string): string[] =>
  yaml.split('\n').map((l) => /^ {2}([a-z-]+):$/.exec(l)?.[1]).filter((n): n is string => n !== undefined);

/** The published port entries (the quoted `- '…'` items) under a block's `ports:` key. */
function publishedPorts(block: string): string[] {
  const m = /ports:[^\n]*\n((?:\s+(?:- |#)[^\n]*\n?)+)/.exec(block);
  if (m === null) return [];
  return [...m[1]!.matchAll(/- '([^']+)'/g)].map((x) => x[1]!);
}

/** A mapping is network-exposed unless it names the loopback host. */
const exposed = (mapping: string): boolean => !mapping.startsWith('127.0.0.1:');

/** A nginx `location` block's body by its exact opening line. */
const location = (opening: string): string => {
  const start = NGINX.indexOf(`\n  ${opening} {\n`);
  if (start === -1) return '';
  const end = NGINX.indexOf('\n  }\n', start);
  return NGINX.slice(start, end);
};

describe('the hosted demo exposes only HTTPS to the network', () => {
  it('the detector fires on a network binding (why the lists below are read, not the firewall)', () => {
    expect(exposed("'${HTTPS_PORT:-443}:443'".replace(/'/g, ''))).toBe(true);
    expect(exposed('127.0.0.1:8080:80')).toBe(false);
  });

  it('the base publishes the proxy and nothing else to the network', () => {
    const names = serviceNames(BASE);
    expect(names).toContain('proxy');
    expect(publishedPorts(serviceBlock(BASE, 'proxy')).filter(exposed).sort()).toEqual(['${HTTPS_PORT:-443}:443', '${HTTP_PORT:-80}:80'].sort());
    for (const svc of names.filter((n) => n !== 'proxy')) {
      expect(publishedPorts(serviceBlock(BASE, svc)).filter(exposed), `${svc} publishes a network port`).toEqual([]);
    }
  });

  it('the pilot overlay publishes NO port to the network, in any service — and adds none to web, the sign-in, the relay or the edge', () => {
    const names = serviceNames(PILOT);
    expect(names).toEqual(expect.arrayContaining(['web', 'proxy', 'demo-login', 'edge-relay', 'edge', 'api', 'db']));
    for (const svc of names) {
      expect(publishedPorts(serviceBlock(PILOT, svc)).filter(exposed), `${svc} publishes a network port in the overlay`).toEqual([]);
    }
    for (const svc of ['web', 'demo-login', 'edge-relay', 'edge', 'proxy']) {
      expect(serviceBlock(PILOT, svc), `${svc} must not add a ports: list in the overlay`).not.toMatch(/^\s+ports:/m);
    }
  });

  it('the database and the API stay loopback-only', () => {
    for (const svc of ['db', 'api']) {
      const ports = publishedPorts(serviceBlock(BASE, svc));
      expect(ports.length).toBeGreaterThan(0);
      expect(ports.filter(exposed)).toEqual([]);
    }
  });

  it('the edge publishes no port — its lane socket stays inside its own container', () => {
    expect(publishedPorts(serviceBlock(BASE, 'edge'))).toEqual([]);
    expect(serviceBlock(PILOT, 'edge')).not.toMatch(/^\s+ports:/m);
    expect(serviceBlock(PILOT, 'edge')).toMatch(/EDGE_LANE_PORT: '8095'/);
  });

  it('the demo front terminates no TLS and mounts no certificate — TLS is the proxy\'s', () => {
    expect(NGINX).not.toMatch(/listen\s+443/);
    expect(NGINX).not.toMatch(/ssl_/);
    expect(serviceBlock(PILOT, 'web')).not.toMatch(/\/etc\/nginx\/tls/);
    expect(CADDY).toContain('tls {$SRE_TLS}');
  });
});

describe('the demo front behind the proxy', () => {
  it('listens on plain 80 only, for the proxy and the box\'s own loopback', () => {
    expect(NGINX.match(/^\s*listen\s+[^;]+;/gm)).toEqual(['  listen 80;']);
  });

  it('takes the client address from the proxy\'s overwritten header and forwards it from the socket — a client cannot forge the address the lockout keys on', () => {
    expect(NGINX).toMatch(/^real_ip_header X-Forwarded-For;$/m);
    expect(NGINX).toMatch(/^set_real_ip_from 0\.0\.0\.0\/0;$/m);
    expect(NGINX).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(NGINX).not.toMatch(/\$proxy_add_x_forwarded_for/);
    // …and the proxy really does overwrite it on every hop to the demo front.
    const gate = CADDY.slice(CADDY.indexOf('\n(staff-demo-gate) {'), CADDY.indexOf('\n}\n', CADDY.indexOf('\n(staff-demo-gate) {')));
    const hops = gate.match(/reverse_proxy web:80 \{[^}]*\}/gs) ?? [];
    expect(hops.length).toBeGreaterThanOrEqual(2);
    for (const hop of hops) expect(hop).toContain('header_up X-Forwarded-For {remote_host}');
  });

  it('keeps its redirects relative, so the sign-in redirect never carries the plain-http scheme out to a browser', () => {
    expect(NGINX).toMatch(/^\s+absolute_redirect off;$/m);
    expect(NGINX).toMatch(/location @sre_sign_in \{ return 302 \/login\/\?next=\$uri; \}/);
  });

  it('serves every shell the overlay mounts — the supplier portal behind the demo sign-in, the customer app open — and nothing it does not mount', () => {
    const mounted = [...serviceBlock(PILOT, 'web').matchAll(/:\/usr\/share\/nginx\/html\/([a-z]+):ro/g)].map((m) => m[1]!);
    expect([...mounted].sort()).toEqual(['customer', 'supplier']);
    const routed = [...NGINX.matchAll(/location ~ \^\/\(([a-z|]+)\)\//g)].flatMap((m) => m[1]!.split('|'));
    expect([...routed].sort()).toEqual([...mounted].sort());
    const staff = location('location ~ ^/(supplier)/');
    expect(staff).toMatch(/auth_request \/_auth\/verify;/);
    expect(staff).toMatch(/error_page 401 = @sre_sign_in;/);
    const customer = location('location ~ ^/(customer)/');
    expect(customer).not.toBe('');
    expect(customer).not.toMatch(/auth_request/);
  });

  it('is ONE application (OB-16): every old shell address goes to the store computer\'s own screen, and the root to the workspace', () => {
    expect(NGINX).toMatch(/location = \/ \{ return 302 \/store\/manager\/; \}/);
    expect(NGINX).toMatch(/location ~ \^\/\(pos\|owner\|picker\|warehouse\)\(\/\.\*\)\?\$ \{ return 302 \/store\/\$1\/; \}/);
    expect(NGINX).toMatch(/location ~ \^\/delivery\(\/\.\*\)\?\$ \{ return 302 \/store\/driver\/; \}/); // the box names the delivery screen /driver/
    expect(NGINX).toMatch(/location ~ \^\/erp\(\/\.\*\)\?\$ \{ return 302 \/store\/manager\/; \}/);
    // The box's own per-app mounts are gone with their routes: a shell nobody is routed to is not served either.
    for (const gone of ['pos', 'owner', 'erp', 'picker', 'delivery', 'warehouse']) expect(serviceBlock(PILOT, 'web')).not.toContain(`/usr/share/nginx/html/${gone}:ro`);
  });

  it('hands the store box the signed-in person from the gate\'s answer — never from the visitor\'s own header (OB-16)', () => {
    const store = location('location /store/');
    expect(store).toMatch(/auth_request \/_auth\/verify;/);
    expect(store).toMatch(/auth_request_set \$sre_user \$upstream_http_x_sre_user;/);
    expect(store).toMatch(/proxy_set_header X-Sre-User \$sre_user;/);
    // and the box only believes it because the overlay says so — a store box never sets this
    expect(serviceBlock(PILOT, 'edge')).toMatch(/EDGE_SCREEN_TRUST_FORWARDED_USER: '1'/);
    expect(readFileSync('infra/compose/docker-compose.yml', 'utf8')).not.toContain('EDGE_SCREEN_TRUST_FORWARDED_USER');
  });

  it('routes /v1/ to the API with the cookie-or-header authorization and the real client address', () => {
    const v1 = location('location /v1/');
    expect(v1).toMatch(/proxy_pass http:\/\/api:8081;/);
    expect(v1).toMatch(/proxy_set_header Authorization \$sre_api_authorization;/);
    expect(v1).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(v1).toMatch(/proxy_set_header X-Forwarded-Proto https;/);
  });
});
