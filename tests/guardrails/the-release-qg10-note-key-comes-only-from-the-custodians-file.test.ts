import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MACHINE_ONLY_ROLES } from '../../services/identity/src/machine-identities';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **OB-423: the release script's QG-10 note goes to head office under a least-privilege machine identity whose key comes
 * only from the custodian's file on the box.** Pinned here:
 *   • the role `qg10_release_evidence` holds exactly one permission — add a QG-10 release note — and is machine-only;
 *     the owner holds that permission only so he can approve the grant, and no other role holds it;
 *   • release.sh hands the post tool only the key file's PATH: it never reads, prints or passes the key, and runs on when
 *     the post fails (`|| true`); the tool reads the key from the file and never prints it;
 *   • no key value anywhere: deploy.conf.example names only the path, CI never mentions the key, and the docs name the
 *     setting and the custodian's steps; production code never mints the token.
 */

const SCRIPT = readFileSync('infra/deploy/release.sh', 'utf8');
const CODE = SCRIPT.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const TOOL = readFileSync('scripts/release-reconcile.mjs', 'utf8');
const LIB = readFileSync('scripts/lib/release-reconcile.mjs', 'utf8');
const CONF = readFileSync('infra/deploy/deploy.conf.example', 'utf8');
const CI = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('the release script\'s QG-10 note key (OB-423)', () => {
  it('the role may only add QG-10 release evidence, is machine-only, and only the owner also holds the right (to approve the grant)', () => {
    const role = ROLE_CATALOGUE.find((r) => r.id === 'qg10_release_evidence');
    expect(role?.permissions).toEqual(['compliance.qg10.evidence.push']);
    expect(MACHINE_ONLY_ROLES).toContain('qg10_release_evidence');
    const holders = ROLE_CATALOGUE.filter((r) => r.permissions.includes('compliance.qg10.evidence.push')).map((r) => r.id).sort();
    expect(holders).toEqual(['owner', 'qg10_release_evidence']);
    const roles = readFileSync('services/api/src/roles.ts', 'utf8');
    expect(roles.match(/── OB-423 \(QG-10 release evidence\) — begin/g)?.length).toBe(3);
    expect(roles.match(/── OB-423 — end/g)?.length).toBe(3);
  });

  it('release.sh hands over only the key file\'s path, never the key, and never lets the post stop the release', () => {
    expect(CODE).toContain(': "${SRE_QG10_PUSH_TOKEN_FILE:=/etc/sre-pilot/qg10-push.token}"');
    expect(CODE).toContain(': "${SRE_QG10_REGISTER_URL:=$SRE_API_URL}"');
    expect(CODE).toMatch(/reconcile_tool post-qg10 --line "\$RECON_DIR\/qg10-line\.json" --url "\$SRE_QG10_REGISTER_URL" --token-file "\$SRE_QG10_PUSH_TOKEN_FILE" 2>\/dev\/null\)" \|\| true/);
    // Never read, printed or passed as a value by the shell.
    expect(CODE).not.toMatch(/(cat|source|\.|<)\s*"?\$\{?SRE_QG10_PUSH_TOKEN_FILE/);
    expect(CODE).not.toMatch(/(echo|printf|say)[^\n]*SRE_QG10_PUSH_TOKEN_FILE/);
    expect(CODE).not.toMatch(/--token(?!-file)/);
    // Every QG-10 line written is offered to head office.
    expect(CODE).toMatch(/say "QG-10 record: \$line"\n\s*qg10_post "\$line"/);
  });

  it('the tool reads the key only from that file and never prints it; the pure post never logs the key', () => {
    expect(TOOL).toContain("token = readFileSync(keyFile, 'utf8').trim()");
    expect(TOOL).not.toMatch(/process\.env\[?['".]?\w*TOKEN/);
    expect(TOOL).not.toMatch(/(write|log)\([^)]*\btoken\b(?!-)/);
    expect(LIB).not.toMatch(/import\s/);
    expect(LIB).toMatch(/authorization: `Bearer \$\{String\(token\)\.trim\(\)\}`/);
    expect(LIB.match(/\btoken\b/g)?.length).toBeLessThan(8); // the parameter, its check and the header — nothing more
  });

  it('no key value anywhere: deploy.conf names the path, CI never mentions it, the docs name the setting and the steps', () => {
    expect(CONF).toMatch(/^SRE_QG10_PUSH_TOKEN_FILE=\/etc\/sre-pilot\/qg10-push\.token$/m);
    expect(CONF).toMatch(/^SRE_QG10_REGISTER_URL=http:\/\/127\.0\.0\.1:8081$/m);
    expect(CI).not.toMatch(/QG10_PUSH|qg10-push|qg10_release_evidence/);
    const runbook = readFileSync('docs/runbooks/automatic-deployment.md', 'utf8');
    expect(runbook).toContain('SRE_QG10_PUSH_TOKEN_FILE');
    expect(runbook).toContain('### The QG-10 note on head office\'s gate register (OB-423)');
    expect(readFileSync('docs/runbooks/environments-and-secrets.md', 'utf8')).toMatch(/SRE_QG10_PUSH_TOKEN_FILE[^\n]*qg10_release_evidence/);
  });

  it('OB-423 (owner, 27 Oct 2026): Mr Sivakumar is named as the key holder; one login per computer; the pipeline hands over its attempt', () => {
    // (d) the custodian who sets each computer's QG-10 machine login secret is named — in both runbooks, never with a value.
    const runbook = readFileSync('docs/runbooks/automatic-deployment.md', 'utf8');
    const secrets = readFileSync('docs/runbooks/environments-and-secrets.md', 'utf8');
    const section = runbook.slice(runbook.indexOf('### The QG-10 note on head office\'s gate register (OB-423)'), runbook.indexOf('## Signed releases'));
    expect(section).toMatch(/Mr Sivakumar/);
    expect(section).toContain('#### The custodian\'s steps (Mr Sivakumar) — once per computer that runs releases');
    expect(secrets).toMatch(/SRE_QG10_PUSH_TOKEN_FILE[^\n]*\*\*Mr Sivakumar\*\*/);
    // (b) one machine login per computer: the runbooks name the login after the computer, never one shared login.
    expect(section).toContain('qg10-release-<box>');
    expect(secrets).toMatch(/one machine login per computer[^\n]*qg10-release-<that box's host name>/);
    // (a) both release jobs hand the box this run's attempt after the optional signature (SSH carries no environment).
    expect(CI.match(/release "\$GITHUB_SHA" "\$GITHUB_ACTOR" "\$GITHUB_RUN_ID" \$\{RELEASE_SIGNATURE:\+"\$RELEASE_SIGNATURE"\} "attempt=\$GITHUB_RUN_ATTEMPT"/g)?.length).toBe(2);
    expect(CODE).toContain('--attempt "$ATTEMPT"');
  });

  it('production code never mints the release identity\'s token', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); } else if (/\.(ts|mjs|js)$/.test(f)) files.push(p); } };
    for (const d of ['services', 'apps', 'edge', 'packages']) walk(d);
    const minting = files.filter((f) => { const t = readFileSync(f, 'utf8'); return /qg10_release_evidence/.test(t) && /createHmac|\.sign\(|issueToken|mintToken/.test(t); });
    expect(minting).toEqual([]);
  });
});
