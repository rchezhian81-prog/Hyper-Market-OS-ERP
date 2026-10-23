// Customer personal data stripped before ANY model call (OB-288 lane 4 · P1 · AI-NFR-05/06 · DPDP data minimisation).
//
// The tested pipeline is `prepareCall` (packages/ai/src/safety.ts): minimise, redact, fence, then scan — in that order.
// It was used by no service, so evidence went to a model unminimised and untrusted text went unfenced. This module is
// the wiring: every governed call runs it, and the audit records what was removed.
//
// Evidence reaches the gateway as TEXT (a governed record's summary), so the purpose's allowlist (`PII_BY_PURPOSE`,
// default-deny) is applied to the personal data that can be recognised in text: a phone number and an e-mail address.
// No purpose in this product is allowed either (not even the two customer-facing agents), so both are always removed.
// A name cannot be recognised reliably in free text; the governed readers already cite customers by an opaque reference
// (P-04), never a name — that stays the first line of defence, and this the second.

import { PII_BY_PURPOSE, prepareCall, type AgentId, type AgentPurpose, type EvidenceItem, type PiiField } from '../../../packages/ai/src/index';

/** The purpose each agent works for — the key into `PII_BY_PURPOSE`. */
export const AGENT_PURPOSE: Readonly<Record<AgentId, AgentPurpose>> = {
  A01: 'owner_brief',
  A02: 'purchase_question',
  A03: 'stock_question',
  A04: 'customer_shopping',
  A05: 'customer_service',
  A06: 'operations',
  A07: 'fraud_review',
  A08: 'data_quality',
  A09: 'marketing_segment',
  A10: 'workforce',
};

// An Indian mobile or landline-style 10-digit number (optionally +91 / 0), not part of a longer digit run such as a
// 13-digit barcode; and an e-mail address.
const PATTERNS: readonly { readonly field: PiiField; readonly re: RegExp }[] = [
  { field: 'phone', re: /(?<![\d])(?:\+91[\s-]?|0)?[6-9]\d{9}(?![\d])/g },
  { field: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

/** Remove the personal data a purpose may not see from one piece of text. */
export function minimiseText(purpose: AgentPurpose, text: string): { readonly text: string; readonly removed: readonly PiiField[] } {
  const permitted = new Set<PiiField>(PII_BY_PURPOSE[purpose]);
  let out = text;
  const removed: PiiField[] = [];
  for (const { field, re } of PATTERNS) {
    if (permitted.has(field)) continue;
    const before = out;
    out = out.replace(re, `[${field} removed]`);
    if (out !== before) removed.push(field);
  }
  return { text: out, removed };
}

export interface MinimisedCall {
  readonly instruction: string;
  readonly evidence: readonly EvidenceItem[];
  /** What the audit records — hashed with the request, so an edited record is detectable. */
  readonly facts: {
    readonly purpose: AgentPurpose;
    readonly piiRemoved: readonly PiiField[];
    /** Evidence items that had personal data removed. */
    readonly itemsMinimised: number;
    readonly secretsRedacted: number;
    /** Untrusted items fenced as DATA (a customer's message, a supplier's note, the caller's own text). */
    readonly fenced: number;
    /** Injection signals noticed — ADVISORY, recorded for review; the defence is that the tools were never granted. */
    readonly injectionSignals: readonly string[];
  };
}

/** Minimise, redact, fence, scan — the whole tested pipeline, for one call. */
export function minimiseForModel(agent: AgentId, instruction: string, evidence: readonly EvidenceItem[]): MinimisedCall {
  const purpose = AGENT_PURPOSE[agent];
  const removed = new Set<PiiField>();
  let itemsMinimised = 0;
  const minimisedInstruction = minimiseText(purpose, instruction);
  for (const f of minimisedInstruction.removed) removed.add(f);
  const minimised = evidence.map((e) => {
    const m = minimiseText(purpose, e.content);
    if (m.removed.length > 0) itemsMinimised += 1;
    for (const f of m.removed) removed.add(f);
    return { ...e, content: m.text };
  });
  const prepared = prepareCall({ instruction: minimisedInstruction.text, evidence: minimised, purpose });
  return {
    instruction: prepared.instruction,
    evidence: prepared.evidence,
    facts: {
      purpose,
      piiRemoved: [...removed].sort(),
      itemsMinimised,
      secretsRedacted: prepared.redactionFindings.length,
      fenced: prepared.evidence.filter((e) => e.untrusted).length,
      injectionSignals: [...new Set(prepared.injectionFindings.map((f) => f.signal))].sort(),
    },
  };
}
