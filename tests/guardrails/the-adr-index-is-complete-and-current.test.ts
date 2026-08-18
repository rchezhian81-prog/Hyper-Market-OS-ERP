import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 2 — architecture closure.
//
// docs/adr/README.md is the index of Architecture Decision Records. It had gone stale — it claimed the
// folder was "intentionally empty ... no application code is written during setup" while six ADRs and a
// full codebase existed. This guardrail keeps the index honest: it must not carry the stale claim, and
// every ADR file on disk must be linked from it, so a new ADR cannot be added without being indexed.

const ADR_DIR = join(process.cwd(), 'docs', 'adr');
const readme = readFileSync(join(ADR_DIR, 'README.md'), 'utf8');

// ADR record files: *.md in docs/adr except the index and the template.
const adrFiles = readdirSync(ADR_DIR)
  .filter((f) => f.endsWith('.md'))
  .filter((f) => f !== 'README.md' && f !== 'template.md');

describe('the ADR index is complete and current', () => {
  it('there is at least one ADR on disk (the folder is not empty)', () => {
    expect(adrFiles.length).toBeGreaterThan(0);
  });

  it('the index does not carry the stale "no application code" / "intentionally empty" claim', () => {
    const lower = readme.toLowerCase();
    expect(lower).not.toContain('intentionally empty');
    expect(lower).not.toContain('no application code');
  });

  it('every ADR file on disk is linked from the index', () => {
    const missing = adrFiles.filter((f) => !readme.includes(`(./${f})`));
    expect(missing, `ADR files not linked in docs/adr/README.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('the five §19 substitution ADRs and the topology ADR are all present', () => {
    // Closes the CLAUDE.md mandate: each deliberate §19 substitution carries a covering ADR.
    const required = [
      '0007-erp-no-framework-shell.md',
      '0008-messaging-postgres-outbox.md',
      '0009-redis-deferred-single-instance.md',
      '0010-documents-as-events-not-object-storage.md',
      '0011-edge-durability-file-log.md',
      '0012-modular-monolith-cloud-topology.md',
    ];
    const absent = required.filter((f) => !adrFiles.includes(f));
    expect(absent, `expected §19-closure ADRs missing from docs/adr/: ${absent.join(', ')}`).toEqual([]);
  });
});
