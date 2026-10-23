// Guardrail — hard rule #5 / AI-NFR-12 (OB-288 lane 4 · P1): an AI agent never writes to the database directly and
// never commits a price, payment, refund, purchase, stock or privilege change. It only drafts; a person commits through
// the ordinary route.
//
// `ai-agent-db-write.test.ts` watches files with "agent" in their path. The agents' real code lives elsewhere, so this
// pins the actual places:
//   1. the agents' deterministic LEGS (A01/A02/A03/A04 readers and the prediction legs) append nothing and call nothing;
//   2. the agents' RUN (`run:` in the AI adapter) appends nothing — the run ROUTE records the run, the agent does not;
//   3. the AI services import no domain service that could commit (pos, purchase, pricing, inventory, finance, identity…);
//   4. every route under /v1/ai/ — and the customer's AI suggestions — holds an AI or a read permission, never a
//      permission that commits money, stock, price or privilege, and no AI route is named for a commit.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { buildSurface } from '../../services/api/src/main';

const PACK_KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
// A write, an event or an outbound call — none belongs in code that only reads and drafts.
const WRITES = /\.\s*(?:append|appendBatch|recordRun|recordRequisition|recordQuote|record[A-Z]\w*)\s*\(|\bmakeEvent\s*\(|\bfetch\s*\(|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/;

describe('guardrail: an AI agent only drafts (hard rule #5)', () => {
  it('the agents\' deterministic legs append nothing and call out to nothing', () => {
    for (const file of ['services/api/src/ai-insights.ts', 'services/api/src/ai-predictions.ts', 'services/api/src/ai-shopping.ts']) {
      const src = read(file);
      expect(WRITES.test(src), `${file} writes or calls out`).toBe(false);
    }
  });

  it('the agents\' run reads and drafts — the route, not the agent, records the run', () => {
    const src = read('services/api/src/ai-adapters.ts');
    const start = src.indexOf('    run: async (tenantId, agent) => {');
    const end = src.indexOf('    openProposals:', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(WRITES.test(src.slice(start, end)), 'the agent run writes something').toBe(false);
  });

  it('the AI services import no domain service that could commit anything', () => {
    const dir = new URL('../../services/ai/src/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const imports = [...readFileSync(new URL(f, dir), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      const domain = imports.filter((p) => /^\.\.\/\.\.\/(?!kernel\/)[a-z-]+\/src\//.test(p));
      expect(domain, `services/ai/src/${f} imports a domain service`).toEqual([]);
    }
  });

  it('every AI route holds an AI or a read permission — never one that commits money, stock, price or privilege', () => {
    const routes = buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal' });
    const ai = routes.filter((r) => r.path.startsWith('/v1/ai/') || r.path === '/v1/me/ai-suggestions');
    expect(ai.length).toBeGreaterThan(30);
    const allowed = /^(?:ai\.[a-z.]+|service\.case\.read|storefront\.order\.read)$/;
    for (const r of ai) {
      expect(r.permission, `${r.method} ${r.path}`).toMatch(allowed);
      // No AI route is named for a commit: no apply, execute, commit, issue, adjust, approve-a-price or refund path.
      expect(r.path, `${r.method} ${r.path}`).not.toMatch(/\/(?:apply|execute|commit|issue|adjust|refund|pay|grant)(?:\/|$)/);
    }
    // And the shapes the run route and the decision route answer with say so on every reply.
    const src = read('services/ai/src/governance.ts') + read('services/ai/src/index.ts');
    expect(src).not.toMatch(/(?:function\s+applyProposal|applyProposal\s*[:=(])/);
    expect(src).toMatch(/committedAnything: false/);
  });

  it('the tripwire fires on a known-bad leg', () => {
    expect(WRITES.test('await store.append(tenantId, STREAM.pricing, makeEvent({ type: "PriceChanged" }))')).toBe(true);
    expect(WRITES.test('await fetch("/v1/prices/changes", { method: "POST" })')).toBe(true);
    expect(WRITES.test('const rows = await inventoryAdapter({ store }).availability(t);')).toBe(false);
  });
});
