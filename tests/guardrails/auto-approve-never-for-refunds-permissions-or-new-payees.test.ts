// Guardrail — CR-01 OI-12 · OB-712 · P-05 · hard rule 5: owner-set auto-approve limits stay inside their fence.
//
//   1. NO rule can ever be set for a permission change, a refund or a payment to a new payee — a frozen closed list, and no
//      kind on the allowlist is one of them or a forbidden tool.
//   2. Nothing in the code adds to the allowlist or removes from the closed list at run time.
//   3. Setting a limit is two people: only the owner may ASK; only the owner and the accountant may CONFIRM; no machine or
//      assistant account holds either. The store manager may only stop.
//   4. The rule calls no model and imports no domain service — it decides, it does not act.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_APPROVE_KINDS, NEVER_AUTO_APPROVE, FORBIDDEN_TOOLS } from '../../packages/ai/src/index';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('guardrail: auto-approve limits never reach a refund, a permission change or a new payee (CR-01 OI-12)', () => {
  it('the closed list is exactly the three, frozen, and no allowed kind is one of them or a forbidden tool', () => {
    expect([...NEVER_AUTO_APPROVE].sort()).toEqual(['payment_to_new_payee', 'permission_change', 'refund']);
    expect(Object.isFrozen(NEVER_AUTO_APPROVE)).toBe(true);
    expect(Object.isFrozen(AUTO_APPROVE_KINDS)).toBe(true);
    for (const [kind, def] of Object.entries(AUTO_APPROVE_KINDS)) {
      expect(NEVER_AUTO_APPROVE).not.toContain(kind);
      expect(FORBIDDEN_TOOLS).not.toContain(kind);
      expect(FORBIDDEN_TOOLS).not.toContain(def.tool);
      expect(kind).not.toMatch(/refund|privilege|permission|role|payee|payment|grant/);
    }
  });

  it('nothing in the code writes to the allowlist or the closed list at run time', () => {
    const offenders: string[] = [];
    for (const dir of ['packages', 'services', 'apps', 'edge']) {
      for (const f of sources(dir)) {
        const src = readFileSync(f, 'utf8');
        if (/NEVER_AUTO_APPROVE\s*(?:\.(?:splice|pop|shift|length\s*=)|\[[^\]]*\]\s*=(?!=))/.test(src)
          || /AUTO_APPROVE_KINDS\s*(?:\[[^\]]*\]|\.\w+)\s*=(?!=)/.test(src)
          || /(?:Object\.assign|Reflect\.set|Object\.defineProperty)\(\s*(?:AUTO_APPROVE_KINDS|NEVER_AUTO_APPROVE)/.test(src)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the owner asks; only the owner and the accountant confirm; no machine or assistant account holds either', () => {
    const holders = (perm: string): string[] => ROLE_CATALOGUE.filter((r) => r.permissions.includes(perm)).map((r) => r.id).sort();
    expect(holders('ai.autoapprove.propose')).toEqual(['owner']);
    expect(holders('ai.autoapprove.confirm')).toEqual(['accountant', 'owner']);
    expect(holders('ai.autoapprove.stop')).toEqual(['owner', 'store_manager']);
  });

  it('the rule calls no model and imports no domain service — it decides, it does not act', () => {
    for (const file of ['packages/ai/src/auto-approve.ts', 'services/ai/src/auto-approve.ts']) {
      const src = read(file);
      expect(src, file).not.toMatch(/\bfetch\s*\(|model-gateway|callModel|governedModelCall|transport/);
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      expect(imports.filter((p) => /^\.\.\/\.\.\/(?!kernel\/)[a-z-]+\/src\//.test(p)), file).toEqual([]);
    }
  });

  it('the tripwire fires on a known-bad edit', () => {
    expect(/NEVER_AUTO_APPROVE\s*(?:\.(?:splice|pop|shift|length\s*=)|\[[^\]]*\]\s*=(?!=))/.test('NEVER_AUTO_APPROVE.splice(0, 1)')).toBe(true);
    expect(/AUTO_APPROVE_KINDS\s*(?:\[[^\]]*\]|\.\w+)\s*=(?!=)/.test("AUTO_APPROVE_KINDS['refund'] = x")).toBe(true);
    expect(/AUTO_APPROVE_KINDS\s*(?:\[[^\]]*\]|\.\w+)\s*=(?!=)/.test('AUTO_APPROVE_KINDS.stock_transfer === y')).toBe(false);
  });
});
