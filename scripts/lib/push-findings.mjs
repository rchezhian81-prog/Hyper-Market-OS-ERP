// OB-331 (owner, 23 Oct 2026, in writing): the CI scan findings go to head office's findings register AUTOMATICALLY, under
// an authenticated push — the CI scanner's own machine identity (role `findings_push`, which may do nothing else).
//
//   • The key is read ONLY from the environment the CI step gives it — the GitHub Actions secret FINDINGS_PUSH_TOKEN, set by
//     the owner or administrator (docs/runbooks/environments-and-secrets.md). Never from a file, never in code, never
//     printed, never put in a message (hard rule #4).
//   • With no key set, it says so VISIBLY — "findings not sent: no key set" — and does not fail the build: the scan verdict
//     is the build's gate; the register push is its record (P-08: absent is said, never silent).
//   • Production code never mints a token: the credential is issued out of band (scripts/issue-store-token.mjs --no-store).
//
// Pure apart from the injected `fetch`, `read` and `say`, so a test drives it with no network.

/** The register's push route — the scanner's own; a person imports on POST /v1/compliance/finding-scans. */
export const PUSH_PATH = '/v1/compliance/finding-scans/pushed';

/**
 * Push every findings report to the register. Answers what happened to each, and never throws for a refusal or a lost
 * line: each is said, as a warning the CI log shows, and the build goes on.
 */
export async function pushFindings({ env, reports, read, fetch, say }) {
  const token = (env.FINDINGS_PUSH_TOKEN ?? '').trim();
  const base = (env.FINDINGS_REGISTER_URL ?? '').trim().replace(/\/+$/, '');
  if (token === '') {
    say('::warning title=Security findings not sent::findings not sent: no key set (the FINDINGS_PUSH_TOKEN secret is absent)');
    return { sent: 0, notSent: reports.length, why: 'no_key_set', results: [] };
  }
  if (base === '') {
    say('::warning title=Security findings not sent::findings not sent: no register address set (FINDINGS_REGISTER_URL)');
    return { sent: 0, notSent: reports.length, why: 'no_register_address', results: [] };
  }
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
    say('::warning title=Security findings not sent::findings not sent: the register address is not https');
    return { sent: 0, notSent: reports.length, why: 'not_https', results: [] };
  }
  const results = [];
  for (const file of reports) {
    let report;
    try { report = JSON.parse(await read(file)); } catch {
      say(`::warning title=Security findings not sent::findings not sent for ${file}: the report could not be read`);
      results.push({ file, outcome: 'unreadable' });
      continue;
    }
    const key = `findings-push-${report.tool}-${report.runId}`;
    let status;
    try {
      const res = await fetch(`${base}${PUSH_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ report }),
      });
      status = res.status;
    } catch {
      say(`::warning title=Security findings not sent::findings not sent for ${report.tool} run ${report.runId}: head office could not be reached`);
      results.push({ file, outcome: 'unreachable' });
      continue;
    }
    if (status === 201) { say(`findings sent: ${report.tool} run ${report.runId} recorded on the register`); results.push({ file, outcome: 'sent' }); continue; }
    if (status === 409) { say(`findings already on the register: ${report.tool} run ${report.runId}`); results.push({ file, outcome: 'already_recorded' }); continue; }
    say(`::warning title=Security findings not sent::findings not sent for ${report.tool} run ${report.runId}: head office answered ${status}`);
    results.push({ file, outcome: 'refused', status });
  }
  const sent = results.filter((r) => r.outcome === 'sent' || r.outcome === 'already_recorded').length;
  return { sent, notSent: reports.length - sent, why: null, results };
}
