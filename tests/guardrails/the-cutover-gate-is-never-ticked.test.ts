import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SIGN_REFUSAL_KINDS, RESOLVE_REFUSAL_KINDS, ROLLBACK_REFUSAL_KINDS,
} from '../../apps/web-erp/src/migration-session';
import { buildCutoverChecklist, decideCutover } from '../../packages/migration/src/index';

/**
 * **The cutover gate, guarded — and the eight checks nobody ever computed.**
 *
 * `decideCutover` is the gate on the single most irreversible act in this project: the night SRE
 * Hyper Market stops running on the old system. It refuses GO until all eight checks pass, names
 * every failure at once rather than one per evening, and types `shopKeepsTrading` as the literal
 * `true`.
 *
 * **It takes those eight as booleans supplied by the caller, and nothing in this codebase ever
 * derived one.** Both integration tests and its own unit test hand it a literal with
 * `qg07Passed: true`, `parallelRunSufficient: true`, `edgeUnsyncedItems: 0` typed in by hand —
 * including the test that stands as the Stage 11 gate evidence. Every one of the eight already
 * had a real producer sitting beside it; nothing joined them up.
 *
 * Six things must stay true, and each of them is a way that could come back:
 *
 *   1. **the checklist is DERIVED**, from the producers that own each answer, and the screen never
 *      builds one of its own;
 *   2. **not known FAILS** — no `?? 0` on the unsynced count, no `?? true` anywhere, and a
 *      tripwire proving an all-absent checklist really is NO GO on all eight;
 *   3. **an unanswerable check is told apart from a failed one**, because a failed check is work
 *      to finish and an unanswerable one is a producer that was never connected;
 *   4. **nothing is deleted** — an exception is resolved and stays on the list (hard rule #6), and
 *      retiring the legacy system never deletes the legacy data (MG-12);
 *   5. **the rollback needs nobody's approval**, at any time, in any state (MG-11);
 *   6. **nothing is signed, decided or rolled back under a name nobody holds**, and a load
 *      operator nobody named means nothing can be signed at all (§28).
 */

const PRODUCER = readFileSync('packages/migration/src/cutover-checklist.ts', 'utf8');
const CUTOVER = readFileSync('packages/migration/src/cutover.ts', 'utf8');
const MODEL = readFileSync('apps/web-erp/src/migration-session.ts', 'utf8');
const VIEW = readFileSync('apps/web-erp/web/migration.js', 'utf8');
const HTML = readFileSync('apps/web-erp/web/migration.html', 'utf8');
const ENTRY = readFileSync('apps/web-erp/src/browser-entry.ts', 'utf8');
const SCREEN_DATA = readFileSync('edge/store-edge/src/screen-data.ts', 'utf8');

const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const expectWordsFor = (vocabulary: readonly string[], mapName: string): void => {
  const from = code(VIEW).indexOf(`const ${mapName}`);
  expect(from, `${mapName} is missing from the view`).toBeGreaterThan(-1);
  const words = code(VIEW).slice(from);
  expect(vocabulary.length, `${mapName} guards nothing`).toBeGreaterThan(1);
  for (const member of vocabulary) {
    const at = words.indexOf(`${member}: {`);
    expect(at, `"${member}" has no words in ${mapName}`).toBeGreaterThan(-1);
    const entry = words.slice(at, words.indexOf('\n  },', at));
    expect(entry, `"${member}" has no English`).toMatch(/\ben:/);
    expect(entry, `"${member}" has no Tamil`).toMatch(/\bta:/);
  }
};

const CHECKS = [
  'control_totals_signed', 'rollback_demonstrated', 'parallel_run_sufficient',
  'edge_fully_synced', 'blocking_exceptions_cleared', 'delta_applied', 'team_named', 'owner_go',
] as const;

// ── 1 & 2. Derived, and absent fails ────────────────────────────────────────

describe('the eight checks are computed, never asserted', () => {
  it('a checklist built from nothing is NO GO on all eight', () => {
    const derived = buildCutoverChecklist({ cutoverId: 'c', tenantId: 't', evidence: {} });
    const decision = decideCutover(derived.checklist);
    expect(decision.go).toBe(false);
    expect([...decision.failed].sort()).toEqual([...CHECKS].sort());
  });

  it('tripwire — a hand-typed checklist really does reach GO, which is why this matters', () => {
    // Exactly the literal every call site in this codebase used to pass. It still reaches GO, so
    // the guard above is load-bearing rather than defensive decoration: nothing in `decideCutover`
    // stops somebody asserting their way through it, and the fix is that nobody does.
    const asserted = decideCutover({
      cutoverId: 'c', tenantId: 't', qg07Passed: true,
      rollbackDemonstratedAt: '2026-09-10T22:00:00Z', parallelRunSufficient: true,
      edgeUnsyncedItems: 0, blockingExceptionsOpen: 0, deltaApplied: true,
      namedTeam: [{ userId: 'u', role: 'r' }], ownerGoBy: 'u-owner',
    });
    expect(asserted.go, 'decideCutover no longer accepts an asserted checklist — update this guard')
      .toBe(true);
  });

  it('never turns an unknown unsynced count into a clear one', () => {
    // The single most dangerous default available anywhere in this file. `?? 0` here reads as
    // "all clear" on a box nobody asked, and an unsynced till is an unmigrated sale.
    const derived = buildCutoverChecklist({ cutoverId: 'c', tenantId: 't', evidence: {} });
    expect(derived.checklist.edgeUnsyncedItems).toBeGreaterThan(0);
    expect(derived.checklist.blockingExceptionsOpen).toBeGreaterThan(0);
    expect(derived.checklist.qg07Passed).toBe(false);
    expect(derived.checklist.parallelRunSufficient).toBe(false);
  });

  it('contains no comfortable default anywhere in the producer', () => {
    expect(code(PRODUCER), 'the producer invents an answer').not.toMatch(/\?\? 0|\?\? true|\?\? \{\}/);
  });

  it('the screen DERIVES its checklist and never builds one', () => {
    const cutover = code(MODEL).slice(code(MODEL).indexOf('cutover: () =>'));
    expect(cutover).toMatch(/buildCutoverChecklist\(\{/);
    // A literal here would put the whole fault straight back.
    expect(cutover, 'the screen asserts a check').not.toMatch(/qg07Passed: true|parallelRunSufficient: true|edgeUnsyncedItems: 0/);
  });

  it('takes each answer from the producer that owns it', () => {
    for (const producer of [
      'assessReconciliation', 'parallelRunPosition', 'outstandingExceptions',
    ]) {
      expect(code(MODEL), `${producer} is not used`).toMatch(new RegExp(`${producer}\\(`));
    }
    // And the unsynced count comes from the box's own outbox, never from a figure the cloud
    // asserts about the box.
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function migrationPayload'));
    expect(builder).toMatch(/edgeUnsyncedItems: input\.outbox\.pending\(\)\.length/);
  });

  it('serves no section the box was not sent, and invents none', () => {
    const builder = code(SCREEN_DATA).slice(code(SCREEN_DATA).indexOf('export function migrationPayload'));
    expect(builder).toMatch(/if \(input\.pack\.migrationExceptions\.known\) payload\['exceptions'\]/);
    expect(builder).toMatch(/if \(input\.pack\.migrationTotals\.known\) payload\['totals'\]/);
    expect(builder, 'the box invents an answer').not.toMatch(/\?\? \[\]|\?\? 0(?!\d)|\?\? \{\}/);
    expect(builder.slice(0, 200)).toMatch(/if \(!input\.pack\.migrationPolicy\.known\) return null;/);
  });

  it('never defaults a port in the browser entry', () => {
    const ports = code(ENTRY).slice(code(ENTRY).indexOf('export function migrationPortsFromData'));
    const body = ports.slice(0, ports.indexOf('\n}'));
    expect(body, 'a migration port was defaulted').not.toMatch(/\?\?/);
    expect(body).toMatch(/edgeUnsyncedItems: \(\) => data\?\.edgeUnsyncedItems,/);
  });
});

// ── 3. Two kinds of failure, drawn differently ──────────────────────────────

describe('a check nothing could answer is not a check that came back bad', () => {
  it('reports them separately in the producer', () => {
    const derived = buildCutoverChecklist({
      cutoverId: 'c', tenantId: 't',
      evidence: { namedTeam: [], ownerGoBy: undefined },
    });
    // Nobody named FAILS but is answerable; nobody told us who is named is NOT KNOWN.
    expect(derived.notKnown).not.toContain('team_named');
    expect(derived.notKnown).toContain('edge_fully_synced');
    expect(derived.detail).toContain('not connected');
  });

  it('draws them differently on the page', () => {
    expect(code(VIEW)).toMatch(/check\.state === 'not_known'/);
    expect(HTML).toMatch(/\.row\.unknown/);
    expect(HTML).toMatch(/\.row\.failed/);
    expect(code(VIEW)).toMatch(/notKnownNote/);
  });

  it('shows the evidence sentence for every check, in the producer’s own words', () => {
    expect(code(VIEW)).toMatch(/line\(check\.evidence\)/);
    // Never a summary the screen composed of its own.
    const render = code(VIEW).slice(code(VIEW).indexOf('function renderWhere'));
    expect(render, 'the screen rewrites the evidence').not.toMatch(/evidence\.slice|evidence\.replace/);
  });
});

// ── 4. Nothing is ever deleted ──────────────────────────────────────────────

describe('nothing on this surface deletes anything (hard rule #6)', () => {
  it('resolves an exception rather than removing it', () => {
    expect(code(MODEL)).toMatch(/resolveException\(\{/);
    for (const view of [code(MODEL), code(VIEW)]) {
      expect(view, 'something deletes an exception').not.toMatch(/\b(delete|discard|purge|remove|drop)(Exception|Total|Difference)/i);
    }
    // A decided one stays on the list, and the screen shows it.
    expect(code(VIEW)).toMatch(/exception\.resolution === undefined/);
  });

  it('says out loud that retiring the system is not deleting the data', () => {
    expect(code(MODEL)).toMatch(/assessRetirement\(\{/);
    expect(code(VIEW)).toMatch(/neverDeleted/);
  });

  it('will not assess retirement on an open-assessment count nobody supplied', () => {
    const retirement = code(MODEL).slice(code(MODEL).indexOf('retirement: () =>'));
    expect(retirement).toMatch(/openAssessments === undefined/);
    expect(retirement, 'the count was defaulted').not.toMatch(/openAssessments \?\? 0/);
  });
});

// ── 5. The rollback ─────────────────────────────────────────────────────────

describe('the rollback needs nobody’s approval and is always reachable', () => {
  it('is on the page, not behind a state', () => {
    expect(HTML).toMatch(/id="rollback"/);
    expect(code(VIEW)).toMatch(/session\.rollback\(/);
    // Never disabled or hidden by the checklist. It is the one control that must work when
    // everything else has gone wrong.
    expect(code(VIEW), 'the rollback is gated').not.toMatch(/el\('rollback'\)\.(disabled|hidden)/);
  });

  it('is gated on nothing but a name', () => {
    const rollback = code(MODEL).slice(code(MODEL).indexOf('rollback: (input)'));
    const body = rollback.slice(0, rollback.indexOf('\n    },'));
    expect(body).toMatch(/config\.userId === null/);
    expect(body, 'the rollback consults the checklist').not.toMatch(/decideCutover|qg07|approval/i);
  });

  it('keeps every piece of migration evidence, and the shop keeps trading', () => {
    const fn = code(CUTOVER).slice(code(CUTOVER).indexOf('export function performRollback'));
    expect(fn).toMatch(/evidenceRetained: true/);
    expect(fn).toMatch(/shopKeepsTrading: true/);
  });

  it('says so on the page too, not only in the types', () => {
    expect(code(VIEW)).toMatch(/tradingEither/);
    expect(HTML).toMatch(/id="trading"/);
  });
});

// ── 6. Nothing under a name nobody holds ────────────────────────────────────

describe('signing, deciding and rolling back all carry a name', () => {
  it('refuses all three when the box was not told who is at the desk', () => {
    expect(code(MODEL)).toMatch(/readonly userId: string \| null/);
    for (const fn of ['resolve: (input)', 'sign: (input)', 'rollback: (input)']) {
      const body = code(MODEL).slice(code(MODEL).indexOf(fn));
      expect(body.indexOf('config.userId === null'), `${fn} does not check who is asking`)
        .toBeGreaterThan(-1);
    }
    expect(code(ENTRY)).toMatch(/userId: data\.userId === undefined \? null : data\.userId/);
    expect(HTML).toMatch(/id="nobody"/);
  });

  it('refuses to sign at all when nobody named who ran the load (§28)', () => {
    // Not defaulted to a name that could never match. A separation of duties that cannot be
    // checked is not a separation, and this is the last place a wrong opening balance is stopped.
    expect(code(MODEL)).toMatch(/readonly loadOperator: string \| undefined/);
    const sign = code(MODEL).slice(code(MODEL).indexOf('sign: (input)'));
    expect(sign).toMatch(/config\.loadOperator === undefined/);
    expect(code(ENTRY)).toMatch(/loadOperator: data\.loadOperator,/);
    expect(code(ENTRY)).not.toMatch(/loadOperator: data\.loadOperator \?\?/);
  });

  it('offers all three ON THE SCREEN, so no control is worked around', () => {
    // A capability the session has and the screen does not is the fault this codebase keeps
    // finding — fourteen times now.
    expect(HTML).toMatch(/id="sign"/);
    expect(HTML).toMatch(/id="decide"/);
    expect(HTML).toMatch(/id="decide-reason"/);
    expect(code(VIEW)).toMatch(/session\.sign\(/);
    expect(code(VIEW)).toMatch(/session\.resolve\(/);
  });

  it('COMMITS a decision locally and queues it, rather than dropping it (hard rule #1)', () => {
    // Found by driving the real page: the first version returned a new list of totals and the
    // view dropped it, so a signature showed green and vanished on the next render. A signature
    // that lives only in a browser tab is not a signature.
    expect(code(MODEL)).toMatch(/ports\.outbox\(\)\.enqueue\(makeEvent\(/);
    expect(code(MODEL)).toMatch(/queue\('MigrationTotalSigned'/);
    expect(code(MODEL)).toMatch(/queue\('MigrationExceptionResolved'/);
    // The screen draws the WORKING copy, not the payload it re-reads each render.
    expect(code(MODEL)).toMatch(/workingTotals \?\? ports\.totals\(\)/);
    expect(code(MODEL)).toMatch(/workingExceptions \?\? ports\.exceptions\(\)/);
    // The idempotency key is deterministic, so a replayed decision collapses to one effect (§31.1).
    expect(code(MODEL)).toMatch(/idempotencyKey: `\$\{config\.tenantId\}:\$\{type\}:\$\{subject\}`/);
  });

  it('says on the page what it has decided and not yet sent (P-08)', () => {
    expect(code(MODEL)).toMatch(/unsent: \(\) => ports\.outbox\(\)\.pending\(\)\.length/);
  });
});

// ── The screen the owner reads on the night ─────────────────────────────────

describe('the page somebody makes the decision from', () => {
  it('opens on the decision, not on a data screen', () => {
    expect(code(VIEW)).toMatch(/show\('where'\)/);
    expect(HTML.indexOf('id="tab-where"')).toBeLessThan(HTML.indexOf('id="tab-figures"'));
  });

  it('shows both sides of every figure and who signed it', () => {
    expect(code(VIEW)).toMatch(/total\.detail/);
    expect(code(VIEW)).toMatch(/t\('signedBy'\)/);
    expect(code(VIEW)).toMatch(/t\('notSigned'\)/);
  });

  it('has words for every refusal and every check, in both languages', () => {
    expectWordsFor(SIGN_REFUSAL_KINDS, 'SIGN_REFUSAL_WORDS');
    expectWordsFor(RESOLVE_REFUSAL_KINDS, 'RESOLVE_REFUSAL_WORDS');
    expectWordsFor(ROLLBACK_REFUSAL_KINDS, 'ROLLBACK_REFUSAL_WORDS');
    expectWordsFor(CHECKS, 'CHECK_WORDS');
  });

  it('opens with no network and says where the page came from', () => {
    expect(HTML).toMatch(/<!--SCREEN-DATA-->/);
    expect(code(VIEW)).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    expect(code(VIEW)).toMatch(/window\.shellCachedAt/);
  });

  it('never interrupts anybody with a browser dialog', () => {
    expect(code(VIEW)).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
    expect(code(VIEW)).toMatch(/function tell\(/);
  });

  it('is offered in Tamil everywhere it is offered in English', () => {
    const en = code(VIEW).slice(code(VIEW).indexOf('en: {'), code(VIEW).indexOf('ta: {'));
    const ta = code(VIEW).slice(code(VIEW).indexOf('ta: {'), code(VIEW).indexOf('};'));
    const keys = (block: string): string[] => [...block.matchAll(/(\w+):\s*['"]/g)].map((m) => m[1]!);
    expect(keys(en).length).toBeGreaterThan(25);
    expect(keys(ta).length).toBe(keys(en).length);
    for (const key of keys(en)) expect(ta, `"${key}" has no Tamil`).toMatch(new RegExp(`\\b${key}:`));
  });
});
