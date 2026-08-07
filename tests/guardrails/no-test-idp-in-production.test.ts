import { describe, it, expect } from 'vitest';
import { loadCodeEntries } from './lib/scan.js';

// The local/test IdP (`tests/support/local-idp`) can MINT tokens, and the harness
// (`tests/support/api-harness`) wires it. Production must never be able to mint — `services/identity`
// verifies and never issues, because a module that can mint tokens is a token factory (hard rule #4).
// This proves no production source under services/, apps/ or edge/ imports the test IdP or the
// test-support harness, so that capability cannot leak into a running deployment.

describe('the token-minting test IdP never reaches production code', () => {
  const offenders = loadCodeEntries(['services', 'apps', 'edge'])
    .filter((e) => /tests\/support|['"][^'"]*\/(local-idp|api-harness)['"]/.test(e.content))
    .map((e) => e.file);

  it('is imported by nothing under services/, apps/ or edge/', () => {
    expect(offenders).toEqual([]);
  });

  it('would FIRE if a production file imported it (tripwire)', () => {
    const sample = `import { LocalIdp } from '../../tests/support/local-idp';`;
    expect(/tests\/support|['"][^'"]*\/(local-idp|api-harness)['"]/.test(sample)).toBe(true);
  });
});
