import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script module, imported for its pure helpers (no types file needed).
import { parseEnv, findUnsetSettings, interpretProbe, interpretSync, rollup, renderReport, PLACEHOLDER } from '../../scripts/standup-check.mjs';

/**
 * The stand-up readiness check is what a non-programmer pilot lead runs to get a plain-English
 * GREEN / RED before day 1. These prove its judgement: it fails on exactly the settings the API
 * itself refuses to start on, reads the two health probes correctly, treats the offline-first sync
 * default as "fine to start" rather than a failure, and never lets an advisory line block the gate.
 */

describe('standup-check — settings', () => {
  it('parses KEY=VALUE, keeping = inside a value (a database URL) and ignoring comments', () => {
    const env = parseEnv('# a comment\nA=1\nDATABASE_URL=postgres://localhost:5432/store?sslmode=require\n\nB = two\n');
    expect(env).toEqual({ A: '1', DATABASE_URL: 'postgres://localhost:5432/store?sslmode=require', B: 'two' });
  });

  it('flags every still-unfilled required setting, and passes a fully filled file', () => {
    const filled = {
      POSTGRES_PASSWORD: 'abc', DATABASE_URL: 'postgres://localhost:5432/store', PACK_SIGNING_KEY: 'k'.repeat(40),
      IDP_SIGNING_KEY: 's'.repeat(40), IDP_ISSUER: 'https://idp', EDGE_TENANT_ID: 't-sre',
    };
    expect(findUnsetSettings(filled)).toEqual([]);

    const half = { ...filled, PACK_SIGNING_KEY: `${PLACEHOLDER}_A_GENERATED_VALUE`, DATABASE_URL: '' };
    const keys = findUnsetSettings(half).map((f: { key: string }) => f.key);
    expect(keys).toContain('PACK_SIGNING_KEY'); // still the placeholder
    expect(keys).toContain('DATABASE_URL');     // blank
    expect(keys).not.toContain('IDP_ISSUER');   // filled
  });
});

describe('standup-check — health probes', () => {
  it('reads a live/ready 200 as ready', () => {
    expect(interpretProbe('livez', true, 200, { live: true, ready: true }).ok).toBe(true);
    expect(interpretProbe('readyz', true, 200, { ready: true }).ok).toBe(true);
  });

  it('reads a 503 on readyz as "running but not ready", with a database-shaped fix', () => {
    const r = interpretProbe('readyz', false, 503, { ready: false });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not ready/i);
    expect(r.fix).toMatch(/database/i);
  });

  it('reads no answer at all as not ready, and says to bring the stack up', () => {
    const r = interpretProbe('livez', false, 0, null);
    expect(r.ok).toBe(false);
    expect(r.fix).toMatch(/docker compose up/);
  });
});

describe('standup-check — sync setting is advisory, never a failure', () => {
  it('offline-first default (no cloud url) passes but says it is not yet syncing to the books', () => {
    const r = interpretSync('');
    expect(r.ok).toBe(true);
    expect(r.advisory).toBe(true);
    expect(r.detail).toMatch(/NOT yet syncing/);
    expect(r.note).toMatch(/signal 1/i);
  });

  it('a configured cloud url reports where it will sync', () => {
    const r = interpretSync('http://api:8081');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('http://api:8081');
  });
});

describe('standup-check — verdict', () => {
  it('an advisory-only failure never blocks the gate; a real failure does', () => {
    const greenish = rollup([{ ok: true }, { ok: true, advisory: true }]);
    expect(greenish.ready).toBe(true);

    const red = rollup([{ ok: true }, { ok: false }, { ok: true, advisory: true }]);
    expect(red.ready).toBe(false);
    expect(red.failed).toHaveLength(1);
  });

  it('renders GREEN when everything passes and RED when something is not ready', () => {
    const green = renderReport([{ name: 'Cloud API', ok: true, detail: 'up' }, { name: 'Sync', ok: true, advisory: true, detail: 'queuing' }]);
    expect(green).toMatch(/GREEN/);
    expect(green).toMatch(/day 1 of the pilot/);

    const red = renderReport([{ name: 'Cloud API', ok: false, detail: 'no answer', fix: 'bring it up' }]);
    expect(red).toMatch(/RED/);
    expect(red).toMatch(/Fix: bring it up/);
  });
});
