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
    expect(client['redirectUris']).toEqual(['${SRE_WEB_ORIGIN}/login/callback']);
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

  it('holds no person, no credential and no secret — its only account is the provisioner\'s service account', () => {
    const users = realm['users'] as Record<string, unknown>[];
    expect(users.map((u) => u['username'])).toEqual(['service-account-sre-provisioner']);
    for (const u of users) {
      expect(u['serviceAccountClientId']).toBe('sre-provisioner');
      expect(u['credentials']).toBeUndefined();
      expect(u['realmRoles']).toBeUndefined();
    }
    expect(raw).not.toMatch(/"(secret|credentials|password|value)"\s*:\s*"[^$]/i);
  });

  it('the provisioner (OB-15-c): a confidential service account that manages users and nothing else; its secret is generated by the server', () => {
    const p = (realm['clients'] as Record<string, unknown>[]).find((c) => c['clientId'] === 'sre-provisioner')!;
    expect(p).toMatchObject({
      publicClient: false, clientAuthenticatorType: 'client-secret', serviceAccountsEnabled: true,
      standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
    });
    expect(p['secret']).toBeUndefined();
    expect(p['redirectUris']).toBeUndefined();
    const sa = (realm['users'] as Record<string, unknown>[])[0]!;
    expect(sa['clientRoles']).toEqual({ 'realm-management': ['manage-users', 'view-users', 'query-users'] });
  });

  it('every client\'s description fits the identity server\'s 255-character column (a longer one stops the server starting)', () => {
    for (const c of realm['clients'] as Record<string, unknown>[]) {
      expect(String(c['description'] ?? '').length, String(c['clientId'])).toBeLessThanOrEqual(255);
    }
  });
});

describe('the stack', () => {
  it('the identity server is opt-in, pinned, not published on a port, and takes its secrets from the environment only', () => {
    const block = compose.slice(compose.indexOf('\n  idp:'), compose.indexOf('\nvolumes:'));
    expect(block).toMatch(/image: quay\.io\/keycloak\/keycloak:\d+\.\d+\.\d+\n/);
    expect(block).toMatch(/profiles: \['identity'\]/);
    expect(block).not.toMatch(/\n\s+ports:/);
    // From the environment only — never a value written here. (Optional markers, not required ones: Compose reads every
    // service's settings even when this one is off, and a required marker would stop the whole stack.)
    expect(block).toMatch(/KC_BOOTSTRAP_ADMIN_PASSWORD: \$\{KEYCLOAK_ADMIN_PASSWORD:-\}/);
    expect(block).toMatch(/KC_DB_PASSWORD: \$\{KEYCLOAK_DB_PASSWORD:-\}/);
    expect(block).not.toMatch(/:\?/);
    expect(block).toMatch(/realm-sre-store\.json:ro/);
  });

  it('the sign-in service is opt-in with it, holds no secret, publishes no port and runs read-only', () => {
    const block = compose.slice(compose.indexOf('\n  sign-in:'), compose.indexOf('\nvolumes:'));
    expect(block).toMatch(/profiles: \['identity'\]/);
    expect(block).not.toMatch(/\n\s+ports:/);
    expect(block).not.toMatch(/SECRET|PASSWORD|SIGNING_KEY/);
    expect(block).toMatch(/read_only: true/);
    expect(block).toMatch(/SIGN_IN_INTERNAL_ISSUER: http:\/\/idp:8080\//);
  });

  it('the sign-in service believes a sign-in only through head office\'s own checker, keeps the session server-side, and signs nothing', () => {
    // The code, without its comments (which say, in words, what it does not hold).
    const src = readFileSync('services/identity/src/sign-in.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(src).toMatch(/verifyToken\(body\.access_token, deps\.policy/);
    expect(src).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(src).toMatch(/code_challenge_method: 'S256'/);
    expect(src).not.toMatch(/createPrivateKey|createSign\(|\bsign\(|client_secret|password/);
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

describe('the sign-in page is the product\'s own (OB-15-b · OB-18)', () => {
  it('the realm uses the owner\'s theme, which the identity server reads read-only; only the trial server shows the practice strip', () => {
    expect(realm['loginTheme']).toBe('sre');
    const block = compose.slice(compose.indexOf('\n  idp:'), compose.indexOf('\n  sign-in:'));
    expect(block).toMatch(/- \.\.\/keycloak\/themes\/sre:\/opt\/keycloak\/themes\/sre:ro/);
    expect(block).not.toMatch(/PILOT_DEMO_BANNER/);
    const pilot = readFileSync('infra/compose/docker-compose.pilot.yml', 'utf8');
    expect(pilot.slice(pilot.indexOf('\n  idp:'))).toMatch(/^\s+idp:\n\s+environment:\n\s+PILOT_DEMO_BANNER: '1'/);
  });
});

describe('people\'s sign-ins from the product (OB-15-c)', () => {
  const src = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

  it('the people route declares the one-time password shown once, requires a recent second factor, and logs nothing', () => {
    const people = src('services/identity/src/people.ts');
    expect(people).toMatch(/shownOnce: \['oneTimePassword'\]/);
    expect(people).toMatch(/reauth: \{ withinSeconds: 300, amr: \['mfa'\] \}/);
    expect(people).not.toMatch(/console\.|process\.std(out|err)|deps\.log/);
    // The password goes to the identity server and into the reply — never into an event or the audit.
    expect(people).not.toMatch(/recordPerson\([^)]*password/i);
    expect(people).not.toMatch(/recordAudit[\s\S]{0,400}temporaryPassword|after: \{[^}]*password/);
  });

  it('the directory keeps no password and writes none to an error or a log', () => {
    const dir = src('services/identity/src/identity-directory.ts');
    expect(dir).not.toMatch(/console\.|process\.std(out|err)/);
    expect(dir).not.toMatch(/DirectoryUnavailableError\([^)]*(temporaryPassword|clientSecret|value)/);
    expect(dir).toMatch(/temporary: true/);
  });

  it('the Admin screen holds the one-time password in memory and on screen only — no storage, console, attribute or address', () => {
    const page = src('apps/web-erp/web/admin.js');
    expect(page).not.toMatch(/localStorage|sessionStorage|console\.|indexedDB|history\.(push|replace)State/);
    expect(page).not.toMatch(/setAttribute\([^)]*oneTimePassword|dataset\.[a-zA-Z]+\s*=\s*[^;]*oneTimePassword/);
    expect(page).toMatch(/el\('handover-otp'\)\.textContent = /);
    const model = src('apps/web-erp/src/people-session.ts');
    expect(model).not.toMatch(/localStorage|sessionStorage|console\.|indexedDB/);
    expect(model).toMatch(/handedOver: \(\) => \{ pending = null; \}/);
  });

  it('the provisioner secret is a secret setting, optional, from the environment only', () => {
    expect(readFileSync('services/kernel/src/config.ts', 'utf8')).toMatch(/\{ key: 'IDP_PROVISIONER_SECRET', secret: true, optional: true, minLength: 16 \}/);
    const block = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  idp:'));
    expect(block).toMatch(/IDP_PROVISIONER_SECRET: \$\{IDP_PROVISIONER_SECRET:-\}/);
  });
});

describe('the front door signed in through the identity server (OB-15-b)', () => {
  const front = readFileSync('infra/compose/nginx.identity.conf', 'utf8');
  const pilotCompose = readFileSync('infra/compose/docker-compose.pilot.yml', 'utf8');

  it('asks the product\'s sign-in service — never the pilot sign-in — and keeps no token in a cookie', () => {
    expect(front).not.toMatch(/demo-login|sre_demo_session|cookie_/);
    expect(front).toMatch(/set \$sre_gate http:\/\/sign-in:8092\/login\/verify;/);
    expect(front).toMatch(/set \$sre_gate_sell http:\/\/sign-in:8092\/login\/verify-sell;/);
    expect(front).toMatch(/set \$sre_sign_in_service http:\/\/sign-in:8092;/);
  });

  it('a head-office call carries the session\'s current token unless the caller sent its own', () => {
    const v1 = front.slice(front.indexOf('location /v1/ {'), front.indexOf('}', front.indexOf('location /v1/ {')));
    expect(v1).toMatch(/auth_request \/_auth\/verify-optional;/);
    expect(v1).toMatch(/auth_request_set \$sre_session_bearer \$upstream_http_x_sre_bearer;/);
    expect(v1).toMatch(/proxy_set_header Authorization \$sre_api_authorization;/);
    expect(front).toMatch(/map \$http_authorization \$sre_api_authorization \{ default \$http_authorization; "" \$sre_session_bearer; \}/);
  });

  it('the store computer hears WHO from the sign-in\'s answer only — a visitor\'s own header is overwritten', () => {
    for (const loc of ['location /store/ {', 'location /store-lane/ {']) {
      const block = front.slice(front.indexOf(loc), front.indexOf('\n  }', front.indexOf(loc)));
      expect(block).toMatch(/auth_request_set \$sre_user \$upstream_http_x_sre_user;/);
      expect(block).toMatch(/proxy_set_header X-Sre-User \$sre_user;/);
    }
  });

  it('the trial server keeps the pilot front door unless told otherwise, and the proxy forwards either session cookie', () => {
    expect(pilotCompose).toMatch(/\.\/\$\{SRE_FRONT_CONF:-nginx\.pilot\.conf\}:\/etc\/nginx\/conf\.d\/default\.conf:ro/);
    expect(caddy).toMatch(/header_regexp Cookie \(\^\|;\\s\*\)\(sre_demo_session\|sre_session\)=/);
  });
});

