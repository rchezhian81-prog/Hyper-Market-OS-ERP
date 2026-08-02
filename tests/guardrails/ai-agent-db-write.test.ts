import { describe, it, expect } from 'vitest';
import { loadCodeEntries, scan, sample, type Rule } from './lib/scan.js';

// Hard rule #5 (CLAUDE.md) / roadmap AI-NFR-12: an AI agent never writes to the
// database directly and never commits a price, payment, refund, purchase, stock
// or privilege change. Agents recommend or draft; deterministic code and
// authorised humans commit. This guardrail trips if code on an agent path
// performs a database write.

const RULES: Rule[] = [
  {
    rule: 'Database write on an AI agent path',
    re: /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b|\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany|save|insert)\s*\(/i,
  },
];

// Files whose path marks them as agent code — an "agent"/"agents" token in any
// path segment (e.g. services/ai-agents/…, …/purchase-agent.ts).
const isAgentPath = (file: string): boolean => /(^|[/\-_.])agents?([/\-_.]|$)/i.test(file);

describe('guardrail: AI agents never write to the database (hard rule #5)', () => {
  it('no agent-path file performs a database write', () => {
    const findings = scan(loadCodeEntries(), RULES, isAgentPath);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('the tripwire fires on a known-bad sample', () => {
    const bad = sample(
      'services/ai-agents/src/purchase-agent.ts',
      'export async function act(po: DraftPO) {\n  await db.purchaseOrder.create({ data: po });\n}',
    );
    const findings = scan([bad], RULES, isAgentPath);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });
});
