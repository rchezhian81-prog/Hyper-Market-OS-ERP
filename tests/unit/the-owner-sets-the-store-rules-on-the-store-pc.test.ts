import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runOwnerSetup, readChecklistText, type SetupClient, type SetupRequest } from '../../packages/migration/src/owner-steps-command';
import { main, prepare, parseCommandLine, SETUP_COMMANDS } from '../../scripts/lib/store-computer.mjs';
import { world as storePc } from '../support/store-computer-world';
import { PILOT_FOUNDATION } from '../../db/seed/pilot/dataset';

/**
 * D-3 (pilot-first audit, OB-739; fix round 1, OB-740) — nothing on the real store PC set the store's working rules
 * (POST /v1/stores/:storeId/rules), so the Today page's Tasks / Checklist / Expiring soon said "Not known" and Reports and
 * Expiry showed sample data. `store-rules` is an owner setup command like `store-settings` (OB-257): every value typed by
 * the owner (nothing defaulted), the closing checklist from a plain text file, the plan said and a YES asked, the owner's
 * OWN till PIN before any call, and the route called as the owner. A re-run with the same values records nothing new.
 */

const T = 'ab000000-0000-4000-8000-000000000740';
const STORE = 'SRE-MAIN';
const CHECKLIST_FILE = 'C:\\SRE\\closing-checklist.txt';
const CHECKLIST = '\uFEFF# The closing checklist\r\nMUST: Cash counted\r\n\r\nFreezers checked\r\nmust:   Back store locked  \r\n';

/** The demo seed's own figures (db/seed/pilot/dataset.ts storeSetup.rules), as the owner types them: rupees, percent. */
const VALUES: Record<string, string> = {
  as: 'u-owner', store: STORE, checklist: CHECKLIST_FILE,
  'approval-limit-rupees': '5000', 'margin-floor-percent': '20', 'near-expiry-days': '30',
  'reports-late-after-minutes': '5', 'reports-old-after-minutes': '60',
  'return-window-days': '7', 'refund-approval-rupees': '2000', 'no-receipt-cap-rupees': '500', 'desk-authority-rupees': '50', 'compensation-cap-rupees': '500',
  'journal-takings': 'TK', 'journal-tax': 'TX', 'journal-refunds': 'RF',
  'dormant-after-days': '60', 'ai-old-after-minutes': '60',
  'refill-below-percent': '50', 'shelf-count-old-after-minutes': '120', 'refill-role': 'store_manager',
  'write-off-second-person-rupees': '500',
};

const EXPECTED_BODY = {
  approvalLimitMinor: 500_000, marginFloorBps: 2_000, nearExpiryDays: 30,
  reporting: { laggingAfterMinutes: 5, staleAfterMinutes: 60 },
  service: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 },
  journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' }, dormantAfterDays: 60, aiStaleAfterMinutes: 60,
  merchandising: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' },
  writeOffMaterialThresholdMinor: 50_000,
  checklist: [
    { itemId: 'close-1', description: 'Cash counted', blocking: true },
    { itemId: 'close-2', description: 'Freezers checked', blocking: false },
    { itemId: 'close-3', description: 'Back store locked', blocking: true },
  ],
};

function world(over: { current?: Record<string, unknown>; files?: Record<string, string>; yes?: boolean; pin?: string } = {}) {
  const calls: SetupRequest[] = [];
  const client: SetupClient = {
    request: async (r) => {
      calls.push(r);
      if (r.method === 'GET') return over.current === undefined ? { status: 404, body: { error: { code: 'not_found' } } } : { status: 200, body: { rules: over.current } };
      return { status: over.current === undefined ? 201 : 200, body: { rules: { version: Number(over.current?.['version'] ?? 0) + 1 } } };
    },
  };
  const files = over.files ?? { [CHECKLIST_FILE]: CHECKLIST };
  const deps = {
    client,
    confirm: async () => over.yes ?? true,
    askPin: async () => over.pin ?? '135790',
    verifyPin: (_u: string, p: string) => (p === '135790' ? 'ok' as const : 'wrong' as const),
    readText: (f: string) => files[f],
  };
  const run = (values: Record<string, string>, extra: { targetKind?: string; tenantId?: string } = {}) => runOwnerSetup({
    step: 'store-rules', tenantId: extra.tenantId ?? T, targetKind: extra.targetKind ?? 'rehearsal', demoTenantIds: ['pilot-demo'], values, today: '2026-11-15', now: () => '2026-11-15T10:00:00.000Z',
  }, deps);
  return { calls, run };
}

describe('D-3 — store-rules: the store\'s working rules, set by the owner on the store PC', () => {
  it('is an owner setup command store-computer hands on, with every flag it reads', () => {
    expect(SETUP_COMMANDS).toContain('store-rules');
    const typed = ['store-rules', ...Object.entries(VALUES).flatMap(([k, v]) => [`--${k}`, v])];
    const cl = parseCommandLine(typed);
    expect(cl.problems).toEqual([]);
    expect(cl.command).toBe('store-rules');
    expect(Object.keys(cl.setup).length + 1).toBe(Object.keys(VALUES).length); // every flag but --as is a setup flag
  });

  it('the checklist file: one item per line, "MUST:" holds the day close, blank and # lines skipped, Notepad\'s marks ignored', () => {
    expect(readChecklistText(CHECKLIST)).toEqual({ items: EXPECTED_BODY.checklist });
    expect(readChecklistText('\n# nothing\n')).toEqual({ problem: 'the checklist file has no items — write one item per line (start a line with MUST: when the day cannot close without it)' });
    expect(readChecklistText('Cash counted\nMUST: cash counted')).toEqual({ problem: 'the checklist file lists "cash counted" twice' });
    expect(readChecklistText('MUST:\nCash counted')).toEqual({ problem: 'line 1 of the checklist file says MUST: but no item after it' });
  });

  it('refuses before it calls: every missing or unreadable value named at once, nothing defaulted, nothing sent', async () => {
    const w = world();
    const missing = await w.run({ as: 'u-owner', store: STORE, 'near-expiry-days': 'thirty', 'margin-floor-percent': '120' });
    expect(missing.exitCode).toBe(2);
    const said = missing.lines.join('\n');
    expect(said).toMatch(/^REFUSED — store-rules needs: /);
    for (const f of ['--near-expiry-days must be', '--margin-floor-percent must be', '--checklist', '--approval-limit-rupees', '--reports-late-after-minutes', '--reports-old-after-minutes',
      '--return-window-days', '--refund-approval-rupees', '--no-receipt-cap-rupees', '--desk-authority-rupees', '--compensation-cap-rupees', '--journal-takings', '--journal-tax',
      '--journal-refunds', '--dormant-after-days', '--ai-old-after-minutes', '--refill-below-percent', '--shelf-count-old-after-minutes', '--refill-role', '--write-off-second-person-rupees']) {
      expect(said, f).toContain(f);
    }
    expect(said).toMatch(/Nothing is filled in for you, and nothing was done/);
    // A checklist file that is not there, or holds nothing, is refused by name — before any question or call.
    const noFile = await world({ files: {} }).run(VALUES);
    expect(noFile.exitCode).toBe(2);
    expect(noFile.lines.join('\n')).toContain(`--checklist: the file ${CHECKLIST_FILE} could not be read`);
    const empty = await world({ files: { [CHECKLIST_FILE]: '# none yet\n' } }).run(VALUES);
    expect(empty.lines.join('\n')).toContain('the checklist file has no items');
    // Production and the demo tenant first (hard rule #7, gate G4); no YES or a wrong PIN, and nothing is sent.
    expect((await w.run(VALUES, { targetKind: 'production' })).lines.join('\n')).toMatch(/REFUSED \(production_target\)/);
    expect((await w.run(VALUES, { tenantId: 'pilot-demo' })).lines.join('\n')).toMatch(/REFUSED \(demo_tenant\)/);
    const no = world({ yes: false });
    expect((await no.run(VALUES)).lines.at(-1)).toBe('NOT DONE — you did not type YES. Nothing was done.');
    const wrong = world({ pin: '000000' });
    expect((await wrong.run(VALUES)).lines.join('\n')).toContain("REFUSED — that is not u-owner's till PIN. Nothing was done.");
    expect([...w.calls, ...no.calls, ...wrong.calls]).toEqual([]);
  });

  it('says every value back in words, then reads what head office holds and sends the rules as the owner — paise, basis points, minutes', async () => {
    const w = world();
    const out = await w.run(VALUES);
    expect(out.exitCode, out.lines.join('\n')).toBe(0);
    const said = out.lines.join('\n');
    for (const words of ['the closing checklist (3 items, 2 that must be done before the day closes)', 'MUST — Cash counted', 'Freezers checked', 'a batch is "expiring soon" 30 days before its date',
      'a manager approves up to ₹5000.00 alone', 'a price under 20% margin', 'a return within 7 days', 'Today\'s Tasks, Checklist and Expiring soon']) {
      expect(said, words).toContain(words);
    }
    expect(w.calls.map((c) => [c.method, c.path, c.userId])).toEqual([
      ['GET', `/v1/stores/${STORE}/rules`, 'u-owner'],
      ['POST', `/v1/stores/${STORE}/rules`, 'u-owner'],
    ]);
    expect(w.calls[1]!.body).toEqual(EXPECTED_BODY);
    expect(w.calls[1]!.idempotencyKey).toMatch(/^owner-setup-rules-SRE-MAIN-v0-[0-9a-f]{8}$/);
    expect(said).toContain('DONE — store SRE-MAIN\'s working rules are saved at head office on this computer');
    expect(said).not.toContain('135790');
  });

  it('the demo seed\'s rules are what these figures send — the same route, the same shape', () => {
    expect(EXPECTED_BODY).toEqual({ ...PILOT_FOUNDATION.storeSetup.rules, checklist: EXPECTED_BODY.checklist });
  });

  it('a re-run with the same values records nothing new; a change is keyed on the version it replaces (A → B → A works)', async () => {
    const same = world({ current: { storeId: STORE, ...EXPECTED_BODY, version: 3, setBy: 'u-owner', setAt: '2026-11-14T10:00:00.000Z' } });
    const again = await same.run(VALUES);
    expect(again.exitCode).toBe(0);
    expect(same.calls.map((c) => c.method)).toEqual(['GET']);
    expect(again.lines.join('\n')).toContain('already in force as version 3 — nothing new recorded');
    const changed = world({ current: { storeId: STORE, ...EXPECTED_BODY, nearExpiryDays: 14, version: 4, setBy: 'u-owner', setAt: '2026-11-14T10:00:00.000Z' } });
    expect((await changed.run(VALUES)).exitCode).toBe(0);
    expect(changed.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(changed.calls[1]!.idempotencyKey).toMatch(/^owner-setup-rules-SRE-MAIN-v4-/);
  });

  it('store-computer resolves the checklist file to its full path and hands every value to the setup tool, in this window', async () => {
    const seen: { args: readonly string[] }[] = [];
    const w = storePc({}, { sliceStdout: (args) => { seen.push({ args }); return { status: 0, stdout: '' }; } });
    expect(await prepare(w.deps)).toBe(0);
    expect(await main(['store-rules', '--as', 'u-o', '--store', 'S1', '--checklist', 'closing.txt', '--near-expiry-days', '30'], w.deps)).toBe(0);
    const args = seen.at(-1)!.args;
    expect(args.slice(0, 2)).toEqual([join('scripts', 'dist', 'owner-setup.js'), 'store-rules']);
    expect(args[args.indexOf('--checklist') + 1]).toBe(resolve('closing.txt'));
    expect(args[args.indexOf('--near-expiry-days') + 1]).toBe('30');
    expect(w.calls.filter((c) => c.args[0] === join('scripts', 'dist', 'owner-setup.js')).at(-1)!.stdio).toBe('inherit');
  });

  it('the owner guide gives the command as typed on the INSTALLED store PC, and every flag on it is one the tool reads', () => {
    const guide = readFileSync('docs/runbooks/store-computer-owner-guide-windows.md', 'utf8');
    const line = guide.split('\n').map((l) => l.trim()).find((l) => l.startsWith('.\\runtime\\node\\node.exe .\\scripts\\store-computer.mjs store-rules '));
    expect(line, 'the installed-PC line for store-rules').toBeDefined();
    const words = [...line!.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!).slice(2);
    const cl = parseCommandLine(words);
    expect(cl.problems).toEqual([]);
    expect(cl.command).toBe('store-rules');
    expect(Object.keys(cl.setup).sort()).toEqual(Object.keys(VALUES).filter((k) => k !== 'as').map((k) => `--${k}`).sort());
  });
});
