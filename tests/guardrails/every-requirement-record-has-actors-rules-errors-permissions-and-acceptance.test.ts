import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// QG-01 (roadmap §22 "No build without approved ID, rules, actors, errors, permissions and testable acceptance").
//
// Every module requirement `M##-FR-##` in `docs/requirements/M##.md` is the Appendix B record a build starts from. This
// guardrail reads each one and checks it carries the five things QG-01 names — each a labelled field with something in it:
//
//   actors       "Actors & scope" / "Actors/scope"
//   rules        "Business rules" / "Rules"
//   errors       "Alternate / error flows" / "Alt/error"
//   permissions  "Permissions / approval" / "Permissions (§28)"
//   acceptance   "Acceptance criteria" / "Acceptance"
//
// The requirement texts are the owner's approved records, so this test never edits them. When it was written (W3,
// 2 Nov 2026) all 144 records carried the five fields (a field's text may wrap onto the next line — six error flows do).
// Any record found incomplete would be listed below by name — a visible list, never a hidden pass — and the list is a
// RATCHET: a new incomplete record fails the build, and a listed record that has been completed must come off the list
// (so it only ever shrinks). It is empty today, so it can only stay empty.

const ROOT = new URL('../../', import.meta.url).pathname;
const DIR = join(ROOT, 'docs/requirements');

type Field = 'actors' | 'rules' | 'errors' | 'permissions' | 'acceptance';
const LABELS: Readonly<Record<Field, RegExp>> = {
  actors: /\*\*Actors[^*\n]{0,40}:\*\*/i,
  rules: /\*\*(?:Business rules|Rules)[^*\n]{0,40}:\*\*/i,
  errors: /\*\*(?:Alternate \/ error flows|Alt\/error|Alt \/ error|Error flows?)[^*\n]{0,40}:\*\*/i,
  permissions: /\*\*Permissions[^*\n]{0,40}:\*\*/i,
  acceptance: /\*\*Acceptance(?: criteria)?[^*\n]{0,40}:\*\*/i,
};
/** Where a field's text ends: the next labelled field on the line, or the next bullet. */
const NEXT_FIELD = /\*\*[^*\n]{1,60}:\*\*|\n\s*-\s+\*\*/;

/** QG-01's known gaps when this guardrail was written — the ratchet. It may only shrink. */
const KNOWN_INCOMPLETE: Readonly<Record<string, readonly Field[]>> = Object.freeze({
  // Empty: on 2 Nov 2026 every one of the 144 records carried all five fields. Nothing may be added here without the
  // owner's written deferral of the missing field (CLAUDE.md "never silently drop a requirement").
});

interface RequirementRecord { readonly id: string; readonly file: string; readonly body: string }

function records(): readonly RequirementRecord[] {
  const out: RequirementRecord[] = [];
  for (const file of readdirSync(DIR).filter((f) => /^M\d\d\.md$/.test(f)).sort()) {
    const text = readFileSync(join(DIR, file), 'utf8');
    for (const part of text.split(/^## (?=M\d\d-FR-\d\d)/m).slice(1)) {
      const id = part.slice(0, 9);
      out.push({ id, file, body: part.split(/^##? /m)[0]! });
    }
  }
  return out;
}

/** The fields a record is missing — a label that is absent, or present with nothing after it. */
function missingFields(body: string): readonly Field[] {
  const missing: Field[] = [];
  for (const [field, label] of Object.entries(LABELS) as [Field, RegExp][]) {
    const m = label.exec(body);
    if (m === null) { missing.push(field); continue; }
    const rest = body.slice(m.index + m[0].length);
    const end = NEXT_FIELD.exec(rest);
    if ((end === null ? rest : rest.slice(0, end.index)).trim() === '') missing.push(field);
  }
  return missing;
}

describe('QG-01 — every module requirement record has actors, rules, error flow, permissions and acceptance', () => {
  const all = records();

  it('reads all 144 module requirement records (36 modules × 4), each id once', () => {
    expect(all.length).toBe(144);
    expect(new Set(all.map((r) => r.id)).size).toBe(144);
  });

  it('the check itself tells an empty field from a full one', () => {
    expect(missingFields('- **Actors/scope:** Owner. **Alt/error:**\n  refused clearly.\n- **Rules:** one.\n- **Permissions:** owner.\n- **Acceptance:** shown.')).toEqual([]);
    expect(missingFields('- **Actors/scope:** Owner. **Alt/error:** **Rules:** one.\n- **Permissions:** owner.\n- **Acceptance:** shown.')).toEqual(['errors']);
    expect(missingFields('- **Actors/scope:** Owner.\n- **Rules:** one.')).toEqual(['errors', 'permissions', 'acceptance']);
  });

  it('no record is incomplete beyond the known list (the ratchet cannot grow) — and the known ones are listed by name', () => {
    const incomplete = Object.fromEntries(all.map((r) => [r.id, missingFields(r.body)] as const).filter(([, m]) => m.length > 0));
    const beyond = Object.entries(incomplete).filter(([id, m]) => !m.every((f) => (KNOWN_INCOMPLETE[id] ?? []).includes(f)));
    expect(beyond.map(([id, m]) => `${id} is missing ${m.join(', ')}`), 'a requirement record must carry actors, rules, error flow, permissions and acceptance (QG-01)').toEqual([]);
    // The visible list: exactly what is still incomplete.
    expect(Object.keys(incomplete).sort()).toEqual(Object.keys(KNOWN_INCOMPLETE).filter((id) => id in incomplete).sort());
  });

  it('a known gap that has been completed comes off the list (the ratchet only shrinks)', () => {
    const byId = new Map(all.map((r) => [r.id, missingFields(r.body)]));
    const stale = Object.entries(KNOWN_INCOMPLETE).filter(([id, fields]) => fields.some((f) => !(byId.get(id) ?? []).includes(f)));
    expect(stale.map(([id]) => `${id} is now complete for a listed field — remove it from KNOWN_INCOMPLETE`)).toEqual([]);
  });
});
