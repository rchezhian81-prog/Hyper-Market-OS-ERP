// Hosted demo health probe (runbook §9.5, owner option A: Healthchecks.io). Proves the pure rules the
// probe reports on: the unsent-sales backlog alerts only when it persists without draining past the
// agreed 30 minutes; edge log frames are counted by offset (a record may contain a newline); any failed
// check turns the report into a /fail; a TEST is always a clearly-labelled fail; and nothing shaped like
// a secret can leave the box in the report body.

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs operational script, no type declarations
import { countFrames, unsentVerdict, redact, summarise, UNSENT_ALERT_MINUTES } from '../../infra/pilot/health-probe/probe.mjs';

const MIN = 60_000;
const frame = (s: string): string => `${Buffer.byteLength(s)} ${s}\n`;

describe('health probe — counting the store box sales log', () => {
  it('counts length-prefixed frames, including a record that contains a newline', () => {
    const buf = Buffer.from(frame('{"id":"A"}') + frame('{"note":"two\nlines"}') + frame('{"id":"C"}'));
    expect(countFrames(buf)).toBe(3);
  });
  it('ignores a torn tail (a half-written record is not a sale)', () => {
    const buf = Buffer.from(frame('{"id":"A"}') + '40 {"id":"torn');
    expect(countFrames(buf)).toBe(1);
  });
  it('an empty log is zero', () => { expect(countFrames(Buffer.alloc(0))).toBe(0); });
});

describe('health probe — unsent sales alert only when not draining for 30 min', () => {
  const t0 = Date.parse('2026-09-28T09:00:00Z');
  it('zero unsent is fine and clears the memory', () => {
    const v = unsentVerdict(0, { backlogSinceMs: t0, lastUnsent: 4 }, t0 + 60 * MIN);
    expect(v.ok).toBe(true);
    expect(v.state).toEqual({});
  });
  it('a fresh backlog is noted, not alerted', () => {
    const v = unsentVerdict(3, {}, t0);
    expect(v.ok).toBe(true);
    expect(v.state).toEqual({ backlogSinceMs: t0, lastUnsent: 3 });
  });
  it(`a backlog that has not drained for ${UNSENT_ALERT_MINUTES} min alerts`, () => {
    const v = unsentVerdict(3, { backlogSinceMs: t0, lastUnsent: 3 }, t0 + UNSENT_ALERT_MINUTES * MIN);
    expect(v.ok).toBe(false);
    expect(v.line).toMatch(/not draining for 30 min/);
  });
  it('a backlog that is DRAINING restarts the clock (no alert while it shrinks)', () => {
    const v = unsentVerdict(2, { backlogSinceMs: t0, lastUnsent: 5 }, t0 + 45 * MIN);
    expect(v.ok).toBe(true);
    expect(v.state.backlogSinceMs).toBe(t0 + 45 * MIN);
  });
});

describe('health probe — the report', () => {
  const ok = { name: 'Disk', ok: true, line: '12% used' };
  const bad = { name: 'Services', ok: false, line: 'not running: sre-pilot-api-1' };
  it('all OK → a success ping', () => {
    const r = summarise([ok], { host: 'vm3' });
    expect(r.fail).toBe(false);
    expect(r.body).toMatch(/^OK — SRE demo pilot \(vm3\): all 1 checks passed/);
  });
  it('any failure → /fail, naming what failed', () => {
    const r = summarise([ok, bad], { host: 'vm3' });
    expect(r.fail).toBe(true);
    expect(r.body).toMatch(/^PROBLEM — .*1 of 2 checks failed/);
    expect(r.body).toContain('✗ Services: not running: sre-pilot-api-1');
  });
  it('a TEST is a /fail and says plainly that nothing is wrong', () => {
    const r = summarise([ok], { test: true, host: 'vm3' });
    expect(r.fail).toBe(true);
    expect(r.body).toMatch(/^TEST ALERT — .*nothing is wrong/);
  });
  it('never lets a connection string, token or ping URL leave the box', () => {
    // Assembled from parts, never one literal, so the repository's secret scan does not see a credential.
    const conn = ['postgres', '://', 'user', ':', 'pw', '@', 'db:5432/sre'].join('');
    const leaky = [conn, 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', 'https://hc-ping.com/abcd-1234'].join(' | ');
    const out = redact(leaky);
    expect(out).not.toMatch(/pw@|eyJhbGciOi|abcd-1234/);
    expect(summarise([{ name: 'X', ok: false, line: leaky }]).body).not.toMatch(/pw@|eyJhbGciOi|abcd-1234/);
  });
});
