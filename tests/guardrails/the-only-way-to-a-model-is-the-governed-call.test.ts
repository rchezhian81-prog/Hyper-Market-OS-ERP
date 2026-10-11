import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GUARDRAIL: the only way from running code to a model is the governed call (audit EA-08 / EA-09 · AI-NFR-01/08/10 ·
 * QG-11 · hard rule #5).
 *
 * The governed call (`services/ai/src/model-gateway.ts`, `governedModelCall`) is where the kill switch, the enabled
 * list, the budget admission, the metering and the hash-chained audit are applied. A second place that called the
 * model engine (`callModel`) or invoked a provider transport directly would reach a model with none of that — the
 * shortcut somebody adds "just for the inbox narrative". So: outside the engine package, `callModel(` appears only in
 * the gateway, a transport is only ever handed to the gateway (never called), and the three shared-inbox agents' code
 * never reaches for either.
 */

const ROOTS = ['services', 'apps', 'edge'];
const GATEWAY = 'services/ai/src/model-gateway.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.|\.spec\./.test(name)) out.push(p);
  }
  return out;
}
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the only way to a model is the governed call', () => {
  const files = ROOTS.flatMap((r) => walk(r)).map((f) => ({ f, src: code(readFileSync(f, 'utf8')) }));

  it('callModel( is called only by the governed gateway', () => {
    const callers = files.filter(({ src }) => /\bcallModel\s*\(/.test(src)).map(({ f }) => f);
    expect(callers).toEqual([GATEWAY]);
  });

  it('no running code invokes a model transport itself — it is only handed to the gateway', () => {
    const invokers = files.filter(({ f, src }) => f !== GATEWAY && /\b(transport|modelTransport)\s*\(/.test(src)).map(({ f }) => f);
    expect(invokers).toEqual([]);
  });

  it('the three shared inboxes (A06 / A08 / A10) and their screens never touch the model engine', () => {
    const inboxFiles = [
      'services/ai/src/index.ts',
      'apps/web-erp/src/operations-inbox-session.ts', 'apps/web-erp/src/data-quality-inbox-session.ts', 'apps/web-erp/src/workforce-inbox-session.ts',
      'apps/web-erp/web/operations.js', 'apps/web-erp/web/data-quality.js', 'apps/web-erp/web/workforce.js',
    ];
    for (const f of inboxFiles) {
      const src = code(readFileSync(f, 'utf8'));
      expect(/\b(callModel|governedModelCall|simulatedTransport|ModelTransport)\b/.test(src), f).toBe(false);
    }
  });
});
