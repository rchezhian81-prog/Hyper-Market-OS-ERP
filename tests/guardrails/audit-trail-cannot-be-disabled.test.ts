import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Roadmap v2.1 A27 / M34-FR-02 (hard rules #4, #6): the audit trail cannot be disabled and stamps every
// book change with a date; a disable attempt fails.
//
// The tamper-evident trail (FND-02's SHA-256 hash chain, sealed under a per-tenant lock in FND-01) is
// only a control if it is ALWAYS ON. The kernel types `audit` as optional — deliberately, so a unit
// test that is not about auditing can leave it out — which means the one thing standing between
// "production audits everything" and "production silently audits nothing" is that the production
// composition in `main.ts` wires a real sink, unconditionally, with no flag that could turn it off.
//
// That is a fact a refactor can erase in one line with the suite still green, and it is precisely the
// fact A27 exists to protect. So it is asserted here, and the tripwire proves the assertion bites.

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const MAIN = read('services/api/src/main.ts');
const AUDIT_SINK = read('services/kernel/src/audit-sink.ts');

// The production composition must set `audit` to a real sink.
const WIRES_AUDIT = /\baudit:\s*new SqlAuditSink\(/;
// No env/flag that omits or toggles the sink in production. (The word "audit" appears in comments as
// "audit FND-01" etc.; those do not match these disable-flag shapes.)
const DISABLE_FLAG = /disableAudit|noAudit|skipAudit|audit(?:Enabled|Disabled)|AUDIT_(?:ENABLED|DISABLED|OFF)/i;

describe('guardrail: the audit trail cannot be disabled (A27 / M34-FR-02)', () => {
  it('the production API composition always wires a real audit sink', () => {
    // Drop this line, or gate it behind a flag, and the tamper-evident trail silently goes dark.
    expect(WIRES_AUDIT.test(MAIN), '`main.ts` must wire `audit: new SqlAuditSink(...)`').toBe(true);
  });

  it('the audit wiring is unconditional — no enable/disable flag exists to turn it off', () => {
    expect(DISABLE_FLAG.test(MAIN), 'no audit disable/enable flag may exist in the production composition').toBe(false);
  });

  it('every audit record is stamped with a date (recorded_at)', () => {
    // "stamps every book change with a date" — the sink writes a timestamp column on every row.
    expect(/recorded_at/.test(AUDIT_SINK), 'the audit sink must record a timestamp on every entry').toBe(true);
  });

  it('FIRES on a composition that dropped the audit sink', () => {
    // The tripwire: a refactor that removes the wiring must fail this guardrail, not pass silently.
    const broken = MAIN.replace(/\baudit:\s*new SqlAuditSink\([^\n]*/, '// audit removed');
    expect(broken, 'the tripwire must actually change the source').not.toBe(MAIN);
    expect(WIRES_AUDIT.test(broken)).toBe(false);
  });
});
