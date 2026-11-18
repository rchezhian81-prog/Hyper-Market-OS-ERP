import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMOTE_DOOR_HOST, REMOTE_DOOR_PORT } from '../../edge/store-edge/src/remote-door';
import { SERVICE_ORDER, REMOTE_LINK_SERVICE } from '../../scripts/lib/store-computer-services.mjs';

/**
 * **OB-840 · ADR-0035 — the owner's remote access stays narrow, and OFF until he turns it on.** Pinned here, by reading
 * the files that would run, so a later change cannot quietly widen it:
 *   • the relay's sshd: one user, one approved key, forwarding only to 127.0.0.1:18095 inside its own container — no
 *     shell, no password, no agent, no X11, no local forward, no gateway ports;
 *   • the key line `sre-relay approve-link` writes: `restrict,port-forwarding,permitlisten="127.0.0.1:18095"`;
 *   • the relay's Caddy: automatic TLS for the owner's domain, HSTS, no Server header, the identity server's admin console
 *     and master realm never proxied; the relay's front: the sign-in first, the token in Authorization, no cookie onward;
 *   • only 80, 443 and the link port are published; no secret in any relay file (each from the server's own .env);
 *   • the relay's setup refuses the DEMO server (hard rule #7);
 *   • the store computer: no link service and no remote door unless `remote-access setup` was run; the door listens on
 *     this PC's loopback only, never on a configurable address.
 */

const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');
const RELAY = ['infra', 'remote-access'];
const sshd = read(...RELAY, 'sshd', 'sshd_config');
const caddy = read(...RELAY, 'Caddyfile');
const nginx = read(...RELAY, 'nginx.remote.conf');
const compose = read(...RELAY, 'docker-compose.yml');
const setup = read(...RELAY, 'setup-relay.sh');
const cli = read(...RELAY, 'sre-relay');
const lines = (t: string): string[] => t.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

describe('the relay\'s tunnel end (sshd) is forwarding-only, to one loopback port, for one key', () => {
  it('pins every narrowing line', () => {
    const l = lines(sshd);
    for (const want of [
      'AllowUsers sre-link', 'AuthorizedKeysFile /etc/ssh/authorized/sre-link', 'AuthenticationMethods publickey', 'PasswordAuthentication no',
      'KbdInteractiveAuthentication no', 'PermitRootLogin no', 'PermitEmptyPasswords no', 'AllowTcpForwarding remote', 'GatewayPorts no',
      'PermitListen 127.0.0.1:18095', 'PermitOpen none', 'AllowAgentForwarding no', 'AllowStreamLocalForwarding no', 'X11Forwarding no',
      'PermitTunnel no', 'PermitTTY no', 'PermitUserRC no', 'MaxSessions 0', 'ForceCommand /sbin/nologin', 'ClientAliveInterval 15',
    ]) expect(l, want).toContain(want);
    expect(l.filter((x) => /^PermitListen\b/.test(x))).toEqual(['PermitListen 127.0.0.1:18095']);
    expect(sshd).not.toMatch(/^\s*Subsystem\b/m);
    expect(sshd).not.toMatch(/^\s*(AllowTcpForwarding\s+(yes|all|local)|GatewayPorts\s+(yes|clientspecified)|PasswordAuthentication\s+yes|PermitRootLogin\s+yes)/m);
  });

  it('the approved key line is restricted to that one listen, and replaces any before it (one store computer)', () => {
    expect(cli).toMatch(/LISTEN_PORT=18095/);
    expect(cli).toContain(`printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s" %s sre-store-pc\\n' "$LISTEN_PORT" "$KEY" > "$RELAY_HOME/ssh/authorized/sre-link.new"`);
    expect(cli).toContain('mv "$RELAY_HOME/ssh/authorized/sre-link.new" "$RELAY_HOME/ssh/authorized/sre-link"');
    // Only an ed25519 public key is ever taken from a pairing request.
    expect(cli).toMatch(/"publicKey":"\\\(ssh-ed25519 \[A-Za-z0-9\+\/=\]\*\\\)"/);
  });

  it('the front reaches the line on its own loopback only, inside the tunnel\'s network', () => {
    expect(nginx).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:18095;/);
    expect(compose).toMatch(/front:\n(?:.*\n){0,4}\s+network_mode: 'service:tunnel'/);
    expect(setup).toMatch(/LISTEN_PORT=18095/);
  });
});

describe('the relay\'s public address: TLS, HSTS, no Server header, the admin console never proxied', () => {
  it('Caddy', () => {
    expect(caddy).toMatch(/^\s*admin off$/m);
    expect(caddy).toMatch(/^\{\$RELAY_DOMAIN\} \{$/m);
    expect(caddy).toMatch(/^\s*tls \{\$RELAY_TLS_EMAIL\}$/m);
    expect(caddy).toMatch(/Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
    expect(caddy).toMatch(/^\s*-Server$/m);
    expect(caddy).toMatch(/X-Frame-Options DENY/);
    expect(caddy).toMatch(/header \{\n\s*Referrer-Policy same-origin\n\s*defer\n\s*\}/);
    expect(caddy).not.toMatch(/Referrer-Policy (unsafe-url|no-referrer-when-downgrade|origin)\b/);
    // Only the store's realm and its resources reach the identity server; every other /auth path is refused by name.
    expect(caddy).toMatch(/@idpAllowed path \/auth\/realms\/sre-store\/\* \/auth\/resources\/\*/);
    const idpProxies = caddy.match(/reverse_proxy idp:8080/g) ?? [];
    expect(idpProxies).toHaveLength(1);
    expect(caddy).toMatch(/handle \/auth\/\* \{\n\s*header Content-Type application\/json\n\s*respond `\{"error":\{"code":"not_public"/);
    expect(caddy).not.toMatch(/\/auth\/admin[^*]*\{\s*\n\s*reverse_proxy/);
    expect(caddy).not.toMatch(/tls internal/);
  });

  it('the front: the sign-in first, the person\'s current token in Authorization, nothing a visitor sent, no cookie onward', () => {
    expect(nginx).toMatch(/location \/ \{\n\s*auth_request \/_auth\/verify;/);
    expect(nginx).toMatch(/auth_request_set \$sre_bearer \$upstream_http_x_sre_bearer;/);
    expect(nginx).toMatch(/proxy_set_header Authorization \$sre_bearer;/);
    expect(nginx).toMatch(/proxy_set_header Cookie "";/);
    expect(nginx).toMatch(/server_tokens off;/);
    expect(nginx).toMatch(/set \$sre_gate http:\/\/sign-in:8092\/login\/verify;/);
  });

  it('only 80, 443 and the link port are published; every secret comes from the server\'s own .env', () => {
    const published = [...compose.matchAll(/^\s+- '([^']+)'\s*$/gm)].map((m) => m[1]!).filter((v) => /^\$?\{?[A-Z_:-]*\}?\d*:?\d+$|^\d+:\d+$|^\$\{RELAY_SSH_PORT/.test(v));
    expect(published.sort()).toEqual(['${RELAY_SSH_PORT:-2222}:2222', '443:443', '80:80'].sort());
    for (const k of ['RELAY_DB_PASSWORD', 'KEYCLOAK_ADMIN_PASSWORD']) expect(compose).toMatch(new RegExp(`\\$\\{${k}:\\?run setup-relay\\.sh first\\}`));
    expect(compose).not.toMatch(/PASSWORD:\s*['"]?[A-Za-z0-9]{8,}['"]?\s*$/m);
    // The identity server is reached only through the proxy; it publishes no port, nor do the others.
    for (const service of ['db', 'idp', 'sign-in', 'front', 'link-desk']) {
      const block = compose.split(/\n {2}(?=[a-z-]+:\n)/).find((b) => b.startsWith(`${service}:`))!;
      expect(block, service).toBeDefined();
      expect(block, service).not.toMatch(/\n\s+ports:/);
    }
  });

  it('the setup makes its secrets on the server, keeps them root-only and never shows them; it refuses the DEMO server', () => {
    expect(setup).toMatch(/RELAY_DB_PASSWORD=%s\\n' "\$\(openssl rand -hex 24\)"/);
    expect(setup).toMatch(/KEYCLOAK_ADMIN_PASSWORD=%s\\n' "\$\(openssl rand -hex 24\)"/);
    expect(setup).toMatch(/chmod 600 "\$ENV_FILE"/);
    expect(setup).not.toMatch(/(say|echo|printf)[^\n]*\$\{?(RELAY_DB_PASSWORD|KEYCLOAK_ADMIN_PASSWORD)/);
    expect(setup).toMatch(/if \[ -e \/opt\/sre\/deploy\.conf \] \|\| \[ -d \/opt\/sre\/app \]; then\n\s*refuse "this is the DEMO server/);
    // The administrator's password reaches kcadm through its own environment variable, never a command line.
    expect(cli).toMatch(/exec -T -e KC_CLI_PASSWORD idp/);
    expect(cli).not.toMatch(/--password\s/);
    // The owner's one remote sign-in must set up the authenticator app and hold the second-factor role (3A).
    expect(cli).toContain('requiredActions=["CONFIGURE_TOTP","UPDATE_PASSWORD"]');
    expect(cli).toContain('--rolename sre-privileged');
  });
});

describe('the store computer: OFF by default; the door on this PC\'s loopback only', () => {
  it('no link service among the store PC\'s own, and the setup and the till\'s installer never open the door', () => {
    expect(SERVICE_ORDER).not.toContain(REMOTE_LINK_SERVICE);
    // The setup only starts the link again after an update when the owner had turned it on; it never installs it.
    const setupJs = read('scripts', 'lib', 'store-computer-setup.mjs');
    expect(setupJs).not.toMatch(/remoteAccessSetup|remoteAccessOn|EDGE_REMOTE_|REMOTE_DOOR/);
    expect(setupJs).toMatch(/if \(serviceState\(deps, REMOTE_LINK_SERVICE\) !== 'missing' && serviceConfig\(deps, REMOTE_LINK_SERVICE\)\.auto\)/);
    expect(read('scripts', 'install-till.mjs')).not.toMatch(/EDGE_REMOTE_/);
    // The setup program stops it before replacing files, and never installs it.
    const iss = read('infra', 'windows', 'sre-setup.iss');
    expect(iss).toContain("'stop SRE-RemoteLink /y'");
    expect(iss).not.toMatch(/remote-access|RemoteLink.*install/i);
  });

  it('the edge opens the door only when the till\'s settings name it, and only on 127.0.0.1', () => {
    expect(REMOTE_DOOR_HOST).toBe('127.0.0.1');
    expect(REMOTE_DOOR_PORT).toBe(8095);
    const server = read('edge', 'store-edge', 'src', 'screen-server.ts');
    expect(server).toMatch(/remoteServer\.listen\(rd!\.port, REMOTE_DOOR_HOST,/);
    const main = read('edge', 'store-edge', 'src', 'main.ts');
    expect(main).toMatch(/const remoteDoorWhyNot = remoteDoorPort === undefined \? null/);
    expect(main).toMatch(/const remoteLog = remoteDoorPort === undefined \|\| remoteDoorWhyNot !== null \? null/);
  });
});
