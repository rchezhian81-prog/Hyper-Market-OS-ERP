import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_API_CONFIG, loadConfig } from '../../services/kernel/src/config';
import { isIndiaRegion, PAYMENT_DATA_REGION_KEY, PAYMENT_BACKUP_REGION_KEY } from '../../services/kernel/src/data-residency';

// C12 (v2.1 addendum · M32/M35 · ADR-0002) — the NEVER claim: payment data is never configured to live outside India.
//   • the head-office API's boot configuration carries both region settings, each with the India check, and the default
//     is India;
//   • no deployment file in the repository (compose files, example settings) sets either region to anything but India;
//   • and the boot check really refuses: a configuration naming another region does not load.
// Regions are ISO 3166 (`IN`, `IN-<state>`) — this guardrail reads no hostnames and none are written.

const REGION_SETTING = /\b(PAYMENT_DATA_REGION|PAYMENT_BACKUP_REGION)\b\s*[:=]\s*['"]?([^'"\s#]*)['"]?/g;

/** Every value a deployment file gives a region setting: `KEY=value`, `KEY: value`, and `${KEY:-default}`. */
function regionValues(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(REGION_SETTING)) {
      const raw = m[2] ?? '';
      const dflt = /^\$\{[A-Z_]+:-([^}]*)\}$/.exec(raw);
      const value = dflt !== null ? dflt[1]! : raw;
      if (/^\$\{[A-Z_]+\}$/.test(value)) continue; // passed through from the environment — the boot check judges it
      out.push({ key: m[1]!, value });
    }
  }
  return out;
}

const DEPLOYMENT_FILES = (() => {
  const dir = 'infra/compose';
  return readdirSync(dir).filter((f) => /^docker-compose.*\.ya?ml$|^\.env.*\.example$/.test(f)).map((f) => join(dir, f));
})();

describe('guardrail: payment data never leaves India (C12)', () => {
  it('the API boot configuration carries both region settings with the India check; the default is India', () => {
    const primary = CLOUD_API_CONFIG.find((s) => s.key === PAYMENT_DATA_REGION_KEY);
    const backup = CLOUD_API_CONFIG.find((s) => s.key === PAYMENT_BACKUP_REGION_KEY);
    expect(primary?.fallback).toBe('IN');
    expect(typeof primary?.check).toBe('function');
    expect(primary?.optional).toBeUndefined();
    expect(typeof backup?.check).toBe('function');
    expect(primary?.check?.('IN')).toBeUndefined();
    expect(primary?.check?.('SG')).toContain('not India');
  });

  it('no deployment file sets a payment-data region outside India', () => {
    expect(DEPLOYMENT_FILES.length).toBeGreaterThan(1);
    const found = DEPLOYMENT_FILES.flatMap((f) => regionValues(readFileSync(f, 'utf8')).map((v) => ({ file: f, ...v })));
    expect(found.some((v) => v.key === PAYMENT_DATA_REGION_KEY)).toBe(true);
    const abroad = found.filter((v) => v.value !== '' && !isIndiaRegion(v.value));
    expect(abroad, JSON.stringify(abroad)).toEqual([]);
  });

  it('the boot check refuses another region — a configuration putting payment data elsewhere does not load', () => {
    const r = loadConfig(CLOUD_API_CONFIG.filter((s) => s.key === PAYMENT_DATA_REGION_KEY || s.key === PAYMENT_BACKUP_REGION_KEY), { PAYMENT_DATA_REGION: 'US-VA' });
    expect(r.ok).toBe(false);
  });

  it('the tripwire fires on a known-bad deployment file', () => {
    const bad = 'services:\n  api:\n    environment:\n      PAYMENT_DATA_REGION: ${PAYMENT_DATA_REGION:-SG}\n      PAYMENT_BACKUP_REGION: EU\n';
    expect(regionValues(bad).filter((v) => !isIndiaRegion(v.value)).map((v) => v.value)).toEqual(['SG', 'EU']);
  });
});
