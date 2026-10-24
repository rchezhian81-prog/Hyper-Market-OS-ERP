import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// OB-312 (owner, 23 Oct 2026, in writing · M24-FR-04): the versioned JSON API and CSV are sufficient for partners; EDI is
// deferred until a named supplier asks, with R8 as the target. Two things must stay true until that decision changes:
// the API documentation SAYS so (a partner reading it is not left guessing), and no EDI format is quietly built.

const CATALOGUE = readFileSync('docs/api/catalogue.md', 'utf8');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p)); else if (/\.(ts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('EDI is deferred in writing (OB-312, M24-FR-04)', () => {
  it('the API catalogue says partners use the versioned JSON API and CSV, that EDI is not built, and why and until when', () => {
    expect(CATALOGUE).toMatch(/versioned JSON API/);
    expect(CATALOGUE).toMatch(/EDI \(EDIFACT, ANSI X12, GS1 EANCOM\)\s+is NOT built/);
    expect(CATALOGUE).toMatch(/OB-312/);
    expect(CATALOGUE).toMatch(/\*\*R8\*\*/);
    expect(CATALOGUE.slice(CATALOGUE.indexOf('## 6. Deferred'))).toMatch(/EDI \(M24-FR-04\) — deferred in writing to R8 \(OB-312/);
  });

  it('no EDI message is built or parsed anywhere in the product (no EDIFACT segment, no X12 envelope)', () => {
    const code = [...files('packages'), ...files('services'), ...files('apps'), ...files('edge')];
    const offenders = code.filter((f) => /\bUNB\+UNOC|\bUNH\+|\bISA\*00\*|\bGS\*PO\*/.test(readFileSync(f, 'utf8')) || /\/edi-[^/]*\.ts$/.test(f));
    expect(offenders).toEqual([]);
  });

  it('tripwire — the detector recognises an EDIFACT interchange header', () => {
    expect(/\bUNB\+UNOC/.test("UNB+UNOC:3+SUPPLIER+SRE+261024:1000+1'")).toBe(true);
  });
});
