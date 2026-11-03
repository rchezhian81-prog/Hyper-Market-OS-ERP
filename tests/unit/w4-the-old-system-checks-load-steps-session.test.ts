import { describe, it, expect } from 'vitest';
import {
  createOldSystemSession, OLD_SYSTEM_COPY, oldSystemWords, readSeal, dataRowsOf, msOfMinutes, RESOLUTION_ACTIONS,
} from '../../apps/web-erp/src/old-system-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { dataRowsOf as commandRowsOf } from '../../packages/migration/src/owner-steps-command';

/**
 * W4 · WF-19 · MG-02 · MG-04 · MG-05 · MG-06 — the Old system checks page's load steps, in its DOM-free session: what it
 * refuses before asking head office and exactly what it sends.
 *
 *   MG-02  the seal file is read as the seal (or slice.json's `{ seal }`), the rows counted the way the seal was taken;
 *   MG-05  a trial load is refused until the export was checked on this page; the check's answer and head office's OWN
 *          count of undecided blocking problems are what it sends — never a typed "verified" or a typed count;
 *   MG-04  a decision needs a problem, an action and a reason (a merge also the record that stays); never the person's name;
 *   MG-06  a signature needs a figure and a statement; never the person's name or role;
 *   WF-19  the gate is READ with no owner GO and no evidence of the page's own.
 * Synthetic values only.
 */

function recorder(reply: (url: string, method: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const r = reply(url, init?.method ?? 'GET');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const ALL = ['migration.preservation.verify', 'migration.trial.run', 'migration.cleaning.read', 'migration.exception.resolve', 'migration.reconciliation.read', 'migration.controltotal.sign', 'migration.cutover.decide', 'migration.parallel.read'];
const session = (fetch: typeof globalThis.fetch, permissions = ALL) => createOldSystemSession({ viewer: { userId: 'u-owner', permissions }, fetch });
const SEAL = { extractId: 'items', tenantId: 't-syn', sourceId: 'old-erp', digest: 'abc123', rowCount: 2, extractedAt: '2026-11-01T10:00:00.000Z', extractedBy: 'u-owner', sealed: true };
const CSV = 'Code,Name\nA1,Synthetic rice\nA2,Synthetic dal\n\n';
const ok = (url: string, method: string) => {
  if (url.endsWith('/v1/migration/extracts/verify')) return { status: 200, body: { matches: true, rowCountMatches: true, expected: 'abc123', actual: 'abc123', detail: 'verified' } };
  if (url.endsWith('/v1/migration/exceptions') && method === 'GET') return { status: 200, body: { exceptions: [], outstanding: { total: 1, blockingUnresolved: [{ exceptionId: 'EX-1' }], clearForCutover: false, detail: '' } } };
  return { status: 200, body: { ok: true, trialId: 'trial-1', rowsLoaded: 15000, elapsedMs: 750000, projectedFullVolumeMs: 750000, repeatable: true, detail: 'x' } };
};

describe('the load steps\' words and pure checks', () => {
  it('every new word has a Tamil twin; every action and check has words', () => {
    const keys = Object.keys(OLD_SYSTEM_COPY.en) as (keyof typeof OLD_SYSTEM_COPY.en)[];
    const gaps = bilingualGaps(OLD_SYSTEM_COPY as never, keys as never);
    expect(gaps).toEqual({ en: [], ta: [] });
    for (const a of RESOLUTION_ACTIONS) expect(oldSystemWords('ta', `a_${a}`)).not.toBe(`a_${a}`);
    for (const c of ['control_totals_signed', 'rollback_demonstrated', 'parallel_run_sufficient', 'edge_fully_synced', 'blocking_exceptions_cleared', 'delta_applied', 'team_named', 'owner_go', 'backup_verified', 'rollback_limits_agreed']) {
      expect(oldSystemWords('en', `ck_${c}`)).not.toBe(`ck_${c}`);
      expect(oldSystemWords('ta', `ck_${c}`)).not.toBe(`ck_${c}`);
    }
  });
  it('MG-02: the seal file is the seal (or slice.json\'s { seal }); rows are counted the way the seal command counts them', () => {
    expect(readSeal(JSON.stringify(SEAL))).toEqual(SEAL);
    expect(readSeal(JSON.stringify({ seal: SEAL }))).toEqual(SEAL);
    expect(readSeal('not json')).toBeUndefined();
    expect(readSeal(JSON.stringify({ ...SEAL, sealed: false }))).toBeUndefined();
    expect(readSeal(JSON.stringify({ digest: 'x' }))).toBeUndefined();
    expect(dataRowsOf(CSV)).toBe(2);
    for (const text of [CSV, '﻿a\r\nb\r\n', 'h\n', '']) expect(dataRowsOf(text)).toBe(commandRowsOf(text));
  });
  it('MG-05: minutes read to milliseconds; nothing else is a time', () => {
    expect(msOfMinutes('12.5')).toBe(750_000);
    expect(msOfMinutes('3')).toBe(180_000);
    for (const bad of ['', '0', '-1', 'ten', '1,5']) expect(msOfMinutes(bad)).toBeUndefined();
  });
});

describe('the load steps refuse before asking, and send only what head office reads', () => {
  it('MG-02 then MG-05: no trial before the check; then the check\'s own answer and head office\'s own blocking count go with it', async () => {
    const r = recorder(ok);
    const s = session(r.fetch);
    expect(await s.trialLoad({ trialId: 'trial-1', rows: '15000', minutes: '12.5', fullRows: '', preparedEmpty: true })).toEqual({ result: 'invalid', why: 'verifyFirst' });
    expect(await s.verifyExtract('', CSV)).toEqual({ result: 'invalid', why: 'noSealFile' });
    expect(await s.verifyExtract('{}', CSV)).toEqual({ result: 'invalid', why: 'notASeal' });
    expect(await s.verifyExtract(JSON.stringify(SEAL), ' ')).toEqual({ result: 'invalid', why: 'noExtractFile' });
    expect(r.calls).toEqual([]);
    expect((await s.verifyExtract(JSON.stringify({ seal: SEAL }), CSV)).result).toBe('ok');
    expect(r.calls[0]).toEqual({ url: '/v1/migration/extracts/verify', method: 'POST', body: { extract: SEAL, material: CSV, rowCount: 2 } });
    const base = { trialId: 'trial-1', rows: '15000', minutes: '12.5', fullRows: '', preparedEmpty: true };
    for (const [d, why] of [[{ trialId: 'a b' }, 'noTrialId'], [{ rows: '1.5' }, 'noTrialRows'], [{ minutes: 'soon' }, 'noMinutes'], [{ fullRows: 'all' }, 'noFull']] as const) {
      expect(await s.trialLoad({ ...base, ...d })).toEqual({ result: 'invalid', why });
    }
    const out = await s.trialLoad({ trialId: ' trial-1 ', rows: '15000', minutes: '12.5', fullRows: '30000', preparedEmpty: false });
    expect(out.result).toBe('ok');
    expect(r.calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/migration/exceptions', 'POST /v1/migration/trial-loads']);
    expect(r.calls[2]!.body).toEqual({ trialId: 'trial-1', rowsToLoad: 15000, elapsedMs: 750000, extractVerified: true, blockingExceptionsOpen: 1, targetPreparedEmpty: false, fullVolumeRows: 30000 });
  });

  it('MG-02: an export that does not match its seal is sent as NOT verified — head office then refuses the trial by name', async () => {
    const r = recorder((url, m) => (url.endsWith('/verify') ? { status: 200, body: { matches: false, rowCountMatches: true, expected: 'a', actual: 'b', detail: 'digest does not match' } } : ok(url, m)));
    const s = session(r.fetch);
    await s.verifyExtract(JSON.stringify(SEAL), CSV);
    await s.trialLoad({ trialId: 'trial-2', rows: '2', minutes: '1', fullRows: '', preparedEmpty: true });
    expect((r.calls.at(-1)!.body as { extractVerified: boolean }).extractVerified).toBe(false);
  });

  it('MG-04: a decision needs a problem, an action and a reason (a merge also the record that stays); never the person\'s name', async () => {
    const r = recorder();
    const s = session(r.fetch);
    expect(await s.decideProblem('', 'correct', 'x', '')).toEqual({ result: 'invalid', why: 'noProblem' });
    expect(await s.decideProblem('EX-1', 'delete', 'x', '')).toEqual({ result: 'invalid', why: 'noAction' });
    expect(await s.decideProblem('EX-1', 'correct', ' ', '')).toEqual({ result: 'invalid', why: 'noProblemReason' });
    expect(await s.decideProblem('EX-1', 'merge', 'same shop', ' ')).toEqual({ result: 'invalid', why: 'noSurvivor' });
    expect(r.calls).toEqual([]);
    await s.decideProblem('EX-1', 'correct', ' counted the shelf: 4 on hand ', 'ignored');
    await s.decideProblem('EX 2', 'merge', 'same customer twice', 'C-7');
    expect(r.calls.map((c) => [c.url, c.body])).toEqual([
      ['/v1/migration/exceptions/EX-1/resolution', { action: 'correct', reason: 'counted the shelf: 4 on hand' }],
      ['/v1/migration/exceptions/EX%202/resolution', { action: 'merge', reason: 'same customer twice', survivingLegacyId: 'C-7' }],
    ]);
  });

  it('MG-06: a signature needs a figure and a statement — the signer and their role are head office\'s, never sent', async () => {
    const r = recorder();
    const s = session(r.fetch);
    expect(await s.signTotal(' ', 'x')).toEqual({ result: 'invalid', why: 'noTotal' });
    expect(await s.signTotal('CT-1', ' ')).toEqual({ result: 'invalid', why: 'noTotStatement' });
    await s.signTotal('CT-1', ' counted a sample on the shelf ');
    expect(r.calls).toEqual([{ url: '/v1/migration/control-totals/CT-1/signature', method: 'POST', body: { statement: 'counted a sample on the shelf' } }]);
  });

  it('WF-19: the gate is READ — no owner GO, no evidence of the page\'s own; the rehearsed going-back is a read', async () => {
    const r = recorder();
    const s = session(r.fetch);
    expect(await s.gate(' ')).toEqual({ result: 'invalid', why: 'noCutover' });
    await s.gate(' C-1 ');
    await s.rollback('C-rehearsal');
    expect(r.calls).toEqual([
      { url: '/v1/migration/cutover/decision', method: 'POST', body: { cutoverId: 'C-1', evidence: {} } },
      { url: '/v1/migration/cutover/rollback/C-rehearsal', method: 'GET', body: undefined },
    ]);
  });

  it('each step asks its own permission; nobody signed in can do none of them', async () => {
    const r = recorder();
    const none = session(r.fetch, []);
    expect(none.may).toMatchObject({ verify: false, trial: false, resolve: false, sign: false });
    expect(await none.signTotal('CT-1', 'x')).toEqual({ result: 'invalid', why: 'notAllowed' });
    const nobody = createOldSystemSession({ viewer: undefined, fetch: r.fetch });
    expect(await nobody.gate('C-1')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(r.calls).toEqual([]);
  });
});
