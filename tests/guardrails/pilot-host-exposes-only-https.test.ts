import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The hosted demo publishes HTTPS and nothing else.**
 *
 * The base compose file publishes the web port on every interface, because a store back-office PC
 * serves its tills over the shop LAN. On an internet-facing VPS that same line is plain HTTP open to
 * the world — and a firewall does not help: Docker writes its own iptables rules for a published
 * port, so UFW's "allow SSH + 443 only" is bypassed for it. The pilot overlay therefore REPLACES the
 * web port list (`!override`, not a merge, which would keep the base's all-interface binding) and
 * keeps plain HTTP on 127.0.0.1 for `standup:check` only.
 *
 * The HTTPS front also forwards the caller's address to the API, which keys its per-IP rate limit and
 * auth lockout on the LEFTMOST X-Forwarded-For entry. So the front must SET that header from the
 * socket, never append to what the client sent — otherwise an attacker rotates a fake leftmost entry
 * and the lockout never locks.
 */

const BASE = readFileSync('infra/compose/docker-compose.yml', 'utf8');
const PILOT = readFileSync('infra/compose/docker-compose.pilot.yml', 'utf8');
const NGINX = readFileSync('infra/compose/nginx.pilot.conf', 'utf8');

/** The lines of one top-level service block (two-space indented key) in a compose file. */
function serviceBlock(yaml: string, service: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The published port entries (the quoted `- '…'` items) under a block's `ports:` key. */
function publishedPorts(block: string): string[] {
  const m = /ports:[^\n]*\n((?:\s+(?:- |#)[^\n]*\n?)+)/.exec(block);
  if (m === null) return [];
  return [...m[1]!.matchAll(/- '([^']+)'/g)].map((x) => x[1]!);
}

/** A mapping is network-exposed unless it names the loopback host. */
const exposed = (mapping: string): boolean => !mapping.startsWith('127.0.0.1:');

describe('the hosted demo exposes only HTTPS to the network', () => {
  it('the detector fires on the base web binding (why the overlay must replace it)', () => {
    const base = publishedPorts(serviceBlock(BASE, 'web'));
    expect(base.length).toBeGreaterThan(0);
    expect(base.some(exposed)).toBe(true);
  });

  it('the pilot overlay REPLACES the web port list rather than merging into it', () => {
    expect(serviceBlock(PILOT, 'web')).toMatch(/ports: !override/);
  });

  it('every port the pilot web publishes is loopback, except the one HTTPS port', () => {
    const ports = publishedPorts(serviceBlock(PILOT, 'web'));
    expect(ports).toContain('${TLS_PORT:-443}:443');
    const network = ports.filter(exposed);
    expect(network).toEqual(['${TLS_PORT:-443}:443']);
  });

  it('the database and the API stay loopback-only', () => {
    for (const svc of ['db', 'api']) {
      const ports = publishedPorts(serviceBlock(BASE, svc));
      expect(ports.length).toBeGreaterThan(0);
      expect(ports.filter(exposed)).toEqual([]);
      expect(publishedPorts(serviceBlock(PILOT, svc)).filter(exposed)).toEqual([]);
    }
  });

  it('the edge publishes no port — its lane socket stays inside its own container', () => {
    expect(publishedPorts(serviceBlock(BASE, 'edge'))).toEqual([]);
    expect(serviceBlock(PILOT, 'edge')).not.toMatch(/^\s+ports:/m);
    expect(serviceBlock(PILOT, 'edge')).toMatch(/EDGE_LANE_PORT: '8095'/);
  });

  it('the certificate is mounted from the host, never from the repository', () => {
    const web = serviceBlock(PILOT, 'web');
    expect(web).toMatch(/\$\{TLS_CERT_DIR:-\/etc\/sre-pilot\/tls\}:\/etc\/nginx\/tls:ro/);
    expect(NGINX).toMatch(/ssl_certificate\s+\/etc\/nginx\/tls\/cert\.pem;/);
    expect(NGINX).toMatch(/ssl_certificate_key\s+\/etc\/nginx\/tls\/key\.pem;/);
  });
});

describe('the HTTPS front', () => {
  /** The server block that listens on a given port. */
  const serverFor = (port: string): string =>
    NGINX.split(/\nserver \{/).find((b) => new RegExp(`listen ${port}\\b`).test(b)) ?? '';

  it('terminates TLS on 443 with modern protocols only', () => {
    const tls = serverFor('443 ssl');
    expect(tls).not.toBe('');
    expect(tls).toMatch(/ssl_protocols TLSv1\.2 TLSv1\.3;/);
  });

  it('routes /v1/ to the API only on the HTTPS server', () => {
    expect(serverFor('443 ssl')).toMatch(/location \/v1\/ \{[^}]*proxy_pass http:\/\/api:8081;/);
    expect(serverFor('80')).not.toMatch(/proxy_pass/);
  });

  it('SETS X-Forwarded-For from the socket — a client cannot forge the address the lockout keys on', () => {
    expect(NGINX).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(NGINX).not.toMatch(/\$proxy_add_x_forwarded_for/);
  });

  it('serves every shell the overlay mounts', () => {
    const mounted = [...serviceBlock(PILOT, 'web').matchAll(/:\/usr\/share\/nginx\/html\/([a-z]+):ro/g)].map((m) => m[1]!);
    expect(mounted.length).toBeGreaterThanOrEqual(8);
    const routed = /location ~ \^\/\(([a-z|]+)\)\//.exec(serverFor('443 ssl'))?.[1]?.split('|') ?? [];
    expect([...routed].sort()).toEqual([...mounted].sort());
  });
});
