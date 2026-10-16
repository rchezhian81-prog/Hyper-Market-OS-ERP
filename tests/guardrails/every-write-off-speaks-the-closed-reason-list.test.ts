import { describe, it, expect } from 'vitest';
import { loadCodeEntries, sample, type Entry } from './lib/scan.js';
import { WASTE_REASON_CODES } from '../../packages/waste/src/reasons';
import { writeOffCommittedEntry } from '../../services/api/src/adapters';
import type { StoredWriteOff } from '../../services/inventory/src/write-off';

// NEW-7 (D-5 · OB-159, owner, 16 Oct 2026: "Use these six"). Every write-off on the register carries a reason from the
// closed waste reason list, whichever path raised it — the write-off route, a held returned unit's decision, a damaged
// arrival, a held write-off applied at a count's close. Free text is a NOTE beside the reason, never the reason.
//
// The tripwire has three parts:
//   1. There is exactly ONE place in the code that builds a `WriteOffCommitted` event — the store's
//      `writeOffCommittedEntry` — and that builder refuses an off-list reason before anything is appended.
//   2. No code that builds a write-off writes a reason literal that is not on the list (e.g. the old 'arrived_damaged').
//   3. The builder really does refuse: an off-list reason throws, a listed one passes.

const BUILDS_EVENT = /type:\s*['"]WriteOffCommitted['"]/;
const WRITE_OFF_FILE = /StoredWriteOff/;
const REASON_LITERAL = /reasonCode:\s*['"]([A-Za-z0-9_ -]+)['"]/g;

function eventBuilders(entries: readonly Entry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    e.content.split('\n').forEach((line, i) => { if (BUILDS_EVENT.test(line)) out.push(`${e.file}:${i + 1}`); });
  }
  return out;
}

function offListLiterals(entries: readonly Entry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!WRITE_OFF_FILE.test(e.content)) continue;
    for (const m of e.content.matchAll(REASON_LITERAL)) {
      if (!(WASTE_REASON_CODES as readonly string[]).includes(m[1]!)) out.push(`${e.file}: reasonCode '${m[1]}'`);
    }
  }
  return out;
}

const code = loadCodeEntries(['services', 'packages', 'edge']).filter((e) => /\.(ts|js|mjs)$/.test(e.file));

describe('guardrail: every write-off speaks the closed waste reason list (NEW-7, D-5, OB-159)', () => {
  it('exactly one place builds a WriteOffCommitted event — the store builder that checks the reason', () => {
    const sites = eventBuilders(code);
    expect(sites, sites.join('\n')).toHaveLength(1);
    expect(sites[0]).toMatch(/services\/api\/src\/adapters\.ts:/);
    const adapters = code.find((e) => e.file.endsWith('services/api/src/adapters.ts'))!.content;
    const builder = adapters.slice(adapters.indexOf('export function writeOffCommittedEntry'));
    expect(builder.slice(0, builder.indexOf('WriteOffCommitted'))).toContain('assertWriteOffReasonOnList(w)');
  });

  it('no code that builds a write-off writes a reason that is not on the list', () => {
    const odd = offListLiterals(code);
    expect(odd, odd.join('\n')).toEqual([]);
  });

  it('the tripwires fire on known-bad samples', () => {
    const bad = sample('services/x/src/sneaky.ts', "const e = makeEvent({ type: 'WriteOffCommitted', payload: w });");
    expect(eventBuilders([...code, bad])).toHaveLength(2);
    const literal = sample('services/x/src/sneaky.ts', "const w: StoredWriteOff = { reasonCode: 'arrived_damaged' };");
    expect(offListLiterals([literal])).toEqual(["services/x/src/sneaky.ts: reasonCode 'arrived_damaged'"]);
  });

  it('the one builder refuses an off-list reason and passes every listed one', () => {
    const w: StoredWriteOff = {
      id: 'wo-1', productId: 'P1', locationId: 'L1', lossType: 'damage', qtyRemoved: 1, uom: 'each', valueMinor: 100, currency: 'INR',
      reasonCode: 'smelt funny', requiredApproval: false, evidenceRef: null, raisedBy: 'u-a', approvedBy: null, at: '2026-10-16T10:00:00.000Z',
    };
    expect(() => writeOffCommittedEntry('t1', w)).toThrow(/not on the waste reason list/);
    expect(() => writeOffCommittedEntry('t1', { ...w, reasonCode: 'arrived_damaged' })).toThrow(/not on the waste reason list/);
    for (const r of WASTE_REASON_CODES) expect(writeOffCommittedEntry('t1', { ...w, reasonCode: r }).event.type).toBe('WriteOffCommitted');
  });
});
