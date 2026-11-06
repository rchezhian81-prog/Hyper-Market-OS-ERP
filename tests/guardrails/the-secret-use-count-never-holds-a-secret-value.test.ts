import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * W6 · M32-FR-03 · OB-688 · hard rule #4 — **the durable daily count of secret use can never hold a secret value.**
 *
 * The count is kept on head office's ledger forever (append-only), so the moment a token, a key or a value could reach it,
 * it would be kept forever too. This reads the code itself: every field of what the kernel hands the counter, of a kept
 * count and of a kept roll-up is on a short list of reference-and-number names; none is named like a value; the kernel
 * hands over the token's ID (`tokenId`, the signed `jti`) and never the token; and the counter's kept payload is built
 * from those named fields only — never by spreading what it was handed.
 */

const read = (f: string): string => readFileSync(f, 'utf8');
/** The field names of one `export interface Name { ... }` block (top-level `readonly x` members). */
function fieldsOf(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  expect(start, `interface ${name}`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^\s+readonly (\w+)\??:/gm)].map((m) => m[1]!);
}
const VALUE_LIKE = /token|value|plain|password|passwd|secret|key|signature|cvv|card|bearer/i;

describe('the secret-use count never holds a secret value (hard rule #4)', () => {
  const kernel = read('services/kernel/src/pipeline.ts');
  const pure = read('services/platform/src/secret-use.ts');
  const adapter = read('services/api/src/w6-secret-use-adapters.ts');

  it('what the kernel hands the counter, a kept count and a kept roll-up have reference-and-number fields only', () => {
    expect(fieldsOf(kernel, 'CredentialUse').sort()).toEqual(['api', 'at', 'callerId', 'credentialRef', 'roleIds', 'status', 'tenantId']);
    expect(fieldsOf(pure, 'SecretUseCount').sort()).toEqual(['api', 'callerId', 'calls', 'credentialRef', 'day', 'errors']);
    expect(fieldsOf(pure, 'SecretUseDayRollup').sort()).toEqual(['baselineDay', 'day', 'findings', 'judged', 'rolledUpAt', 'windows']);
    for (const f of [...fieldsOf(kernel, 'CredentialUse'), ...fieldsOf(pure, 'SecretUseCount'), ...fieldsOf(pure, 'SecretUseDayRollup')]) expect(f).not.toMatch(VALUE_LIKE);
  });

  it('the kernel passes the token\'s id, never the token or the Authorization header', () => {
    const hook = kernel.slice(kernel.indexOf('opts.credentialUse({'), kernel.indexOf('});', kernel.indexOf('opts.credentialUse({')));
    expect(hook).toContain('credentialRef: p.tokenId');
    expect(hook).not.toMatch(/token\b(?!Id)|authorization|header|request\.body/i);
  });

  it('the counter keeps a payload built from named fields only — never a spread of what it was handed', () => {
    const payload = adapter.slice(adapter.indexOf('const payload: SecretUseCount'), adapter.indexOf('\n', adapter.indexOf('const payload: SecretUseCount')));
    expect(payload).toMatch(/= \{ day, credentialRef, callerId, api, calls: g\.calls, errors: g\.errors, firstMinute: g\.first, lastMinute: g\.last \};$/);
    expect(adapter).not.toMatch(/\.\.\.use\b/);
    expect(adapter).not.toMatch(/process\.env/);
  });
});
