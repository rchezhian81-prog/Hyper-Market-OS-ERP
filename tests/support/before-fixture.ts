import { readFileSync } from 'node:fs';

/**
 * A file as it was BEFORE a round, for the tests that prove a rule bites (the UI/UX gap audit rounds U0–U4).
 *
 * These used to run `git show <commit>:<path>`. The CI checkout is one commit deep and a squash merge keeps none of the
 * branch's commits, so the old files are kept under `tests/fixtures/before-ui-ux/<commit>/<path>.txt` (a plain-text suffix, so the type check and lint never read them as source) instead — exactly as
 * `git show` gave them on 5 Nov 2026. A fixture that is missing is a test error, never a quiet pass.
 */
export function beforeFixture(commit: string, path: string): string {
  return readFileSync(`tests/fixtures/before-ui-ux/${commit}/${path}.txt`, 'utf8');
}
