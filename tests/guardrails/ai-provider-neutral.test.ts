import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GUARDRAIL: the AI implementation names no provider.
 *
 * The owner's decision of 4 August 2026 was to build the whole of Stage 17 now and choose a
 * provider later, with one binding condition: **changing provider must remain a configuration
 * and adapter change, never a rewrite.**
 *
 * A promise in a document does not survive contact with a deadline. The way that condition
 * stays true is to make the codebase physically unable to break it — so this test fails the
 * build if a provider name, SDK import or provider-shaped model identifier appears anywhere
 * outside a declared adapter directory.
 *
 * It matters most in eighteen months, when somebody under pressure adds "just one" provider
 * check inside an agent because it is quicker than extending the adapter. That is the commit
 * this exists to stop, and there will be nobody left who remembers why.
 */

/** Only these directories may name a provider. Today: none exist, because none is chosen. */
const ADAPTER_DIRS: readonly string[] = ['packages/ai/src/adapters'];

const SCANNED: readonly string[] = ['packages/ai/src', 'tests/unit', 'tests/integration'];

/** Provider names and SDK package names. Assembled at runtime so this file itself is clean. */
const PROVIDER_TOKENS: readonly string[] = [
  ['ant', 'hropic'].join(''),
  ['open', 'ai'].join(''),
  ['gemi', 'ni'].join(''),
  ['bed', 'rock'].join(''),
  ['ver', 'tex ai'].join(''),
  ['mis', 'tral'].join(''),
  ['coh', 'ere'].join(''),
  ['oll', 'ama'].join(''),
  ['hugging', 'face'].join(''),
  ['azure ', 'openai'].join(''),
];

/** Model-identifier shapes that leak a provider even without naming one. */
const MODEL_SHAPES: readonly RegExp[] = [
  /\bgpt-[0-9]/i,
  /\bclaude-[a-z0-9]/i,
  /\bllama-?[0-9]/i,
  /\bgemini-[0-9]/i,
];

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith('.ts')) out.push(path);
    }
  };
  walk(dir);
  return out;
}

function isAdapter(path: string): boolean {
  return ADAPTER_DIRS.some((d) => path.startsWith(d));
}

describe('guardrail: the AI implementation is provider-neutral', () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(dir)).filter(
    (f) => !f.endsWith('ai-provider-neutral.test.ts'),
  );

  it('names no AI provider outside a declared adapter directory', () => {
    const offences: { file: string; line: number; token: string }[] = [];

    for (const file of files) {
      if (isAdapter(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, index) => {
        const lower = text.toLowerCase();
        for (const token of PROVIDER_TOKENS) {
          if (lower.includes(token)) offences.push({ file, line: index + 1, token });
        }
      });
    }

    expect(offences, 'A provider name appeared outside an adapter. Move it behind the ModelTransport port — the owner\'s condition is that switching provider stays a configuration change.').toEqual([]);
  });

  it('uses no provider-shaped model identifier outside an adapter', () => {
    const offences: { file: string; line: number; match: string }[] = [];

    for (const file of files) {
      if (isAdapter(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, index) => {
        for (const shape of MODEL_SHAPES) {
          const m = shape.exec(text);
          if (m !== null) offences.push({ file, line: index + 1, match: m[0] });
        }
      });
    }

    expect(offences, 'A concrete model id appeared outside an adapter. Model names belong in GatewayConfig.modelForTier, which is per-tenant configuration.').toEqual([]);
  });

  it('routes every model call through the injected transport port', () => {
    // No direct network access anywhere in the AI package: the ONLY way to reach a provider
    // is the injected ModelTransport, which is what makes the simulator a complete substitute.
    const forbidden = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /require\(['"]https?['"]\)/, /from ['"]node:https?['"]/];
    const offences: { file: string; line: number }[] = [];

    for (const file of sourceFiles('packages/ai/src')) {
      if (isAdapter(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, index) => {
        if (forbidden.some((re) => re.test(text))) offences.push({ file, line: index + 1 });
      });
    }

    expect(offences, 'The AI package made a network call outside an adapter. Everything must go through ModelTransport.').toEqual([]);
  });

  it('fires on a known-bad sample, so the detector is real', () => {
    // A tripwire nobody has proven fires is a tripwire nobody should trust.
    const bad = `const model = "gpt-4o"; // and a call to ${['open', 'ai'].join('')}`;
    const hitToken = PROVIDER_TOKENS.some((t) => bad.toLowerCase().includes(t));
    const hitShape = MODEL_SHAPES.some((re) => re.test(bad));

    expect(hitToken).toBe(true);
    expect(hitShape).toBe(true);
  });
});
