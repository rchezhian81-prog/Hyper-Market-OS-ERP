import { describe, it, expect } from 'vitest';
import config from '../../vitest.config';

/**
 * The guardrails run with their own time limit (31 Oct 2026). Under a busy full local run the whole-tree scans ran out
 * of the default 5 s and failed with "Test timed out" while their checks were sound (2 of 3 contended runs). The limit
 * lives in `vitest.config.ts` as a `guardrails` project; this keeps it there, keeps every other folder on the default,
 * and keeps each test file in exactly one project (an inherited `include` would run every file twice).
 */
interface Project { test: { name: string; include?: string[]; exclude?: string[]; testTimeout?: number } }

const projects = (config as { test: { include?: string[]; projects: Project[] } }).test.projects;
const byName = (name: string): Project => {
  const p = projects.find((x) => x.test.name === name);
  if (p === undefined) throw new Error(`no "${name}" project in vitest.config.ts`);
  return p;
};

describe('the guardrails have their own time limit', () => {
  it('the guardrails project gives each test at least 30 s; the other tests keep the default', () => {
    expect(byName('guardrails').test.include).toEqual(['tests/guardrails/**/*.test.ts']);
    expect(byName('guardrails').test.testTimeout).toBeGreaterThanOrEqual(30_000);
    expect(byName('tests').test.testTimeout).toBeUndefined();
  });

  it('each file belongs to one project: no shared include, and the other project leaves the guardrails out', () => {
    expect((config as { test: { include?: string[] } }).test.include).toBeUndefined();
    expect(byName('tests').test.exclude).toContain('tests/guardrails/**');
  });
});
