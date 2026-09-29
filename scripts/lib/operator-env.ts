// Shared by the operator tools (`scripts/migration-load.ts`, `scripts/bootstrap-tenant.ts`): read the
// deployment's `.env` the way the stand-up check does, and mint the operator's token the way the
// pilot's stand-in identity provider does (`scripts/issue-store-token.mjs`) — HS256 over
// { sub, tenant_id, iss, aud, exp }, which is exactly what the API's `verifyToken` checks.
//
// This lives under scripts/ ON PURPOSE: production code never mints (hard rule #4; the guardrail
// `no-test-idp-in-production` proves nothing under services/, apps/, edge/ or packages/ can). A
// person with the signing key already holds the power to mint; this only saves them the arithmetic.
// The token goes to the API over the wire and nowhere else — never printed, never written to a file.

import { createHmac } from 'node:crypto';

/** `KEY=value` lines; blanks and `#` comments ignored; first `=` splits. */
export function parseEnvText(text: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export interface TokenPolicy {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
}

export interface OperatorClaims {
  readonly sub: string;
  readonly tenantId: string;
  readonly ttlSeconds: number;
}

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Identical bytes to `buildStoreToken` in issue-store-token.mjs — proven by a test so the two cannot drift. */
export function buildOperatorToken(claims: OperatorClaims, policy: TokenPolicy, nowMs: number): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ sub: claims.sub, tenant_id: claims.tenantId, iss: policy.issuer, aud: policy.audience, exp: nowSec + claims.ttlSeconds });
  const signature = createHmac('sha256', policy.secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The identity-provider policy from the env, or the names of what is missing. */
export function tokenPolicyFromEnv(env: Readonly<Record<string, string>>): { readonly policy?: TokenPolicy; readonly missing: readonly string[] } {
  const missing = ['IDP_SIGNING_KEY', 'IDP_ISSUER', 'IDP_AUDIENCE'].filter((k) => (env[k] ?? '') === '');
  if (missing.length > 0) return { missing };
  return { policy: { secret: env['IDP_SIGNING_KEY']!, issuer: env['IDP_ISSUER']!, audience: env['IDP_AUDIENCE']! }, missing: [] };
}

/** `--flag value` pairs and bare `--flag` switches. */
export function parseFlags(argv: readonly string[]): Readonly<Record<string, string | true>> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[a.slice(2)] = true; } else { out[a.slice(2)] = next; i += 1; }
  }
  return out;
}

/** The demo tenant(s) this box must never load real data into: the seed's label, the env's list, the flags. */
export function demoTenantIds(env: Readonly<Record<string, string>>, flag: string | true | undefined): readonly string[] {
  const fromEnv = (env['DEMO_TENANT_IDS'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const fromFlag = typeof flag === 'string' ? flag.split(',').map((s) => s.trim()).filter((s) => s !== '') : [];
  return [...new Set(['pilot-demo', ...fromEnv, ...fromFlag])];
}
