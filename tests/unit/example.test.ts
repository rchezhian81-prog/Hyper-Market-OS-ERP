import { describe, it, expect } from 'vitest';

// A first, ordinary unit test — proof that the test framework is wired up and
// that `pnpm test` runs and reports clearly. It is replaced by real tests as
// features are built. See docs/runbooks/how-to-check-tests.md for what a
// passing or failing run looks like.

describe('safety net is wired up', () => {
  it('runs a test and reports a pass', () => {
    expect(1 + 1).toBe(2);
  });
});
