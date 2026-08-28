#!/usr/bin/env node
// Issue a store-edge token for the pilot — the operator's stand-in for the deployment identity
// provider (OA-4), so the till's edge can sync its sales to the cloud (M02-FR-01, hard rule #4).
//
// ── Why this is a SCRIPT, and outside the running product ────────────────────
//
// Production issues NO tokens: `services/identity` VERIFIES and never mints, because a service that
// can mint the tokens it also trusts is a forgery machine (hard rule #4), and a guardrail proves
// nothing under services/, apps/ or edge/ can mint. So this lives in `scripts/` — an out-of-band
// admin action a person runs with the signing key they already hold, exactly what a real identity
// provider's admin console does at go-live. It is the PILOT stand-in; a real deployment replaces it
// with the chosen IdP (OA-4), and this key stops being one a script can reach.
//
// It signs precisely what the API's `verifyToken` checks — HS256 over
// { sub, tenant_id, iss, aud, exp } — proven in the test by running a minted token through the REAL
// authenticator and banking a real sale with it.
//
// ── Two things it must never do ──────────────────────────────────────────────
//
//   • Never print or write the signing key — only the token it produces.
//   • Never write the token to a file. It is a credential; it goes to the operator's screen once,
//     with a warning, and into the edge's `CLOUD_API_TOKEN` by hand.

import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEnv } from './standup-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// ── Pure token builder (unit-tested against the REAL verifier) ────────────────

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * Mint a store-edge token. `policy` is the same `{ secret, issuer, audience }` the API's
 * `tokenAuthenticator` verifies against, so a token from here is one the cloud accepts. `nowMs` is
 * injected so the test is deterministic. The shape mirrors the identity provider's exactly:
 * HS256 over `{ sub, tenant_id, iss, aud, exp }`.
 */
export function buildStoreToken(claims, policy, nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    sub: claims.sub,
    tenant_id: claims.tenantId,
    iss: policy.issuer,
    aud: policy.audience,
    exp: nowSec + claims.ttlSeconds,
  });
  const signature = createHmac('sha256', policy.secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Read `--flag value` pairs from argv into a map. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a?.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

// ── The runner ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = process.env['STANDUP_ENV_FILE'] ?? join(REPO, 'infra', 'compose', '.env');

  let env = {};
  try { env = parseEnv(await readFile(envFile, 'utf8')); } catch { /* fall through to the checks below */ }

  const secret = env['IDP_SIGNING_KEY'];
  const issuer = env['IDP_ISSUER'];
  const audience = env['IDP_AUDIENCE'];
  const tenantId = args['tenant'] ?? env['EDGE_TENANT_ID'];
  const sub = args['user'] ?? 'store-edge';
  const ttlHours = Number(args['ttl-hours'] ?? 720); // 30 days by default

  const missing = [];
  if (secret === undefined || secret === '' || secret.includes('REPLACE_WITH')) missing.push('IDP_SIGNING_KEY');
  if (issuer === undefined || issuer === '' || issuer.includes('REPLACE_WITH')) missing.push('IDP_ISSUER');
  if (audience === undefined || audience === '') missing.push('IDP_AUDIENCE');
  if (tenantId === undefined || tenantId === '' || tenantId.includes('REPLACE_WITH')) missing.push('a tenant (--tenant, or EDGE_TENANT_ID in .env)');
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) missing.push('a positive --ttl-hours');
  if (missing.length > 0) {
    console.error(`Cannot issue a token — missing: ${missing.join(', ')}.`);
    console.error(`Fill them in ${envFile} (see infra/compose/.env.example), or pass them as flags.`);
    process.exitCode = 1;
    return;
  }

  const token = buildStoreToken({ sub, tenantId, ttlSeconds: Math.round(ttlHours * 3600) }, { secret, issuer, audience }, Date.now());

  console.log('');
  console.log(`Store-edge token for user "${sub}" in tenant "${tenantId}", valid ${ttlHours} hour(s):`);
  console.log('');
  console.log(token);
  console.log('');
  console.log('This is a SECRET. Put it in the edge\'s CLOUD_API_TOKEN setting by hand — do not commit it,');
  console.log('paste it into a chat, or write it to a file. It only works while the account holds the sync');
  console.log(`permission (pos.sale.sync): provision the "${sub}" login with a sync-capable role first.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
