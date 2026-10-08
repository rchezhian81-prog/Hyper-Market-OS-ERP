import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The identity server is set up the way ADR-0019 says, and stays that way (OB-15 · M02-FR-01 · SEC-03 · hard rule #4).**
 *
 * The realm file is imported as written on every start, so a careless edit to it is a security change. These pin what
 * must not drift: the product client signs people in only by the browser flow with PKCE (no password grant, no implicit
 * flow); passwords are long and locked after repeated failures; a privileged person needs a second factor; the tokens
 * carry the product's person, the shop and our audience; the file holds no person and no secret; the service is opt-in,
 * pinned, not published on a port, and its admin console is refused at the public proxy; and head office's side holds
 * only public keys.
 */

const realm = JSON.parse(readFileSync('infra/keycloak/realm-sre-store.json', 'utf8')) as Record<string, unknown>;
const raw = readFileSync('infra/keycloak/realm-sre-store.json', 'utf8');
const client = (realm['clients'] as Record<string, unknown>[]).find((c) => c['clientId'] === 'sre-web')!;
const compose = readFileSync('infra/compose/docker-compose.yml', 'utf8');
const caddy = readFileSync('infra/compose/Caddyfile', 'utf8');

describe('the realm file', () => {
  it('the product client: public, browser flow with PKCE S256, no password grant, no implicit flow, no service account', () => {
    expect(client).toMatchObject({
      publicClient: true, standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
    });
    expect((client['attributes'] as Record<string, string>)['pkce.code.challenge.method']).toBe('S256');
    // Sign-in returns only to the product's own callback — never a wildcard.
    expect(client['redirectUris']).toEqual(['${SRE_WEB_ORIGIN}/auth/callback']);
  });

  it('passwords are long and a run of wrong ones locks the account; tokens are short-lived; https outside the private network', () => {
    expect(String(realm['passwordPolicy'])).toMatch(/length\((1[2-9]|[2-9]\d)\)/);
    expect(realm).toMatchObject({ bruteForceProtected: true, sslRequired: 'external', registrationAllowed: false });
    expect(Number(realm['failureFactor'])).toBeLessThanOrEqual(5);
    expect(Number(realm['accessTokenLifespan'])).toBeLessThanOrEqual(900);
  });

  it('a privileged person needs a second factor: the browser flow requires a one-time code for sre-privileged', () => {
    expect(realm['browserFlow']).toBe('sre browser');
    const flows = realm['authenticationFlows'] as { alias: string; authenticationExecutions: Record<string, unknown>[] }[];
    const second = flows.find((f) => f.alias === 'sre privileged second factor')!;
    expect(second.authenticationExecutions.map((e) => [e['authenticator'], e['requirement']])).toEqual([
      ['conditional-user-role', 'REQUIRED'], ['auth-otp-form', 'REQUIRED'],
    ]);
    const cond = (realm['authenticatorConfig'] as { alias: string; config: Record<string, string> }[]).find((c) => c.alias === 'sre privileged')!;
    expect(cond.config).toMatchObject({ condUserRole: 'sre-privileged', negate: 'false' });
  });

  it('tokens carry the product person, the shop, our audience and how the person proved it', () => {
    const mappers = (client['protocolMappers'] as { protocolMapper: string; config: Record<string, string> }[]);
    expect(mappers.map((m) => m.protocolMapper).sort()).toEqual(['oidc-amr-mapper', 'oidc-audience-mapper', 'oidc-hardcoded-claim-mapper', 'oidc-usermodel-attribute-mapper']);
    expect(mappers.find((m) => m.protocolMapper === 'oidc-hardcoded-claim-mapper')!.config).toMatchObject({ 'claim.name': 'tenant_id', 'claim.value': '${SRE_TENANT_ID}' });
    expect(mappers.find((m) => m.protocolMapper === 'oidc-usermodel-attribute-mapper')!.config).toMatchObject({ 'user.attribute': 'sre_user_id', 'claim.name': 'sre_user_id' });
    // The product's person id is set by the product's provisioning only — a person cannot edit their own.
    const profile = JSON.parse((realm['components'] as Record<string, { config: Record<string, string[]> }[]>)['org.keycloak.userprofile.UserProfileProvider']![0]!.config['kc.user.profile.config']![0]!) as { attributes: { name: string; permissions: { edit: string[] } }[] };
    expect(profile.attributes.find((a) => a.name === 'sre_user_id')!.permissions.edit).toEqual(['admin']);
  });

  it('holds no person, no credential and no secret', () => {
    expect(realm['users']).toBeUndefined();
    expect(raw).not.toMatch(/"(secret|credentials|password|value)"\s*:\s*"[^$]/i);
  });
});

describe('the stack', () => {
  it('the identity server is opt-in, pinned, not published on a port, and takes its secrets from the environment only', () => {
    const block = compose.slice(compose.indexOf('\n  idp:'), compose.indexOf('\nvolumes:'));
    expect(block).toMatch(/image: quay\.io\/keycloak\/keycloak:\d+\.\d+\.\d+\n/);
    expect(block).toMatch(/profiles: \['identity'\]/);
    expect(block).not.toMatch(/\n\s+ports:/);
    expect(block).toMatch(/KC_BOOTSTRAP_ADMIN_PASSWORD: \$\{KEYCLOAK_ADMIN_PASSWORD:\?/);
    expect(block).toMatch(/KC_DB_PASSWORD: \$\{KEYCLOAK_DB_PASSWORD:\?/);
    expect(block).toMatch(/realm-sre-store\.json:ro/);
  });

  it('the public proxy refuses the identity server\'s admin console before forwarding anything under /auth/', () => {
    const upstream = caddy.slice(caddy.indexOf('(auth-upstream) {'));
    expect(upstream.indexOf('handle /auth/admin*')).toBeGreaterThan(-1);
    expect(upstream.indexOf('handle /auth/admin*')).toBeLessThan(upstream.indexOf('handle /auth/* {'));
  });

  it('head office\'s side holds public keys only: the key-set reader neither signs nor reads a private key', () => {
    const jwks = readFileSync('services/identity/src/jwks.ts', 'utf8');
    const token = readFileSync('services/identity/src/token.ts', 'utf8');
    for (const src of [jwks, token]) {
      expect(src).not.toMatch(/createPrivateKey|createSign\(|\bsign\(|privateKey/);
    }
    expect(jwks).toMatch(/createPublicKey/);
  });
});
