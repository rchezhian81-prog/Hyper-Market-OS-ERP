// Prompt-injection defence, PII and secret protection (Stage 17 / §35 / PRV / hard rules #3, #4).
//
// The roadmap requires prompt injection, data leakage, excessive authority and hallucination to
// be **explicit test cases**. This module is the first three; `evaluation.ts` is the fourth.
//
// The single most important thing to be honest about here: **detection is not the defence.**
//
// You cannot reliably spot hostile instructions in text. People writing them are trying not to
// be spotted, and every pattern list is a list of the phrasings somebody already thought of.
// Any system whose safety rests on catching "ignore previous instructions" is one rephrasing
// away from failing.
//
// So the real defence, built in `authority.ts` and `gateway.ts`, is structural: **a model that
// has been successfully steered still cannot do anything, because the tools were never granted
// to it.** The injection can persuade the model to *ask*; it cannot make the gateway hand over
// `issue_refund`. That is what the simulator's `obey_injected_instruction` case exists to prove
// — the test asserts the system holds *while the model is fully compromised*.
//
// What this file adds on top of that structural defence:
//
//   • **UNTRUSTED CONTENT IS FENCED, NEVER CONCATENATED.** A customer's message goes inside a
//     delimited block labelled as data. Concatenating it into the instruction is the actual
//     vulnerability, and no amount of scanning fixes it.
//   • **SECRETS ARE REDACTED ON THE WAY OUT AND ON THE WAY BACK.** Both directions, because a
//     model can repeat back what it was shown and a log line captures either.
//   • **PII IS MINIMISED BY PURPOSE**, not by best effort. An agent answering a stock question
//     gets no customer names, because the safest data is the data that was never sent.
//   • **DETECTION IS ADVISORY AND SAID TO BE.** Findings are logged for review; nothing depends
//     on them. Claiming a scanner makes injection safe is how a team stops building the
//     controls that actually work.
//
// Pure and deterministic: no I/O, no clock beyond what is injected.

import type { EvidenceItem } from './gateway';

// ─── Fencing: the defence that actually works ──────────────────────────────────

/**
 * Fence delimiters. Written with EXPLICIT escapes and plain ASCII — a raw control byte here
 * would make this file's diff render as "Binary files differ" (hard rule #8) and, worse,
 * would stop the strip below from matching the plain text an attacker actually sends.
 *
 * The unit separator on each end is what an attacker cannot type into a web form, so the
 * fence cannot be forged even if they guess the wording.
 */
const SEP = '\u001f';
const FENCE_OPEN = `${SEP}<<UNTRUSTED_DATA${SEP}`;
const FENCE_CLOSE = `${SEP}UNTRUSTED_DATA>>${SEP}`;
/** The plain-text forms an attacker WOULD type, stripped so they cannot forge a fence. */
const FORGEABLE = ['<<UNTRUSTED_DATA', 'UNTRUSTED_DATA>>'];

export interface FencedPrompt {
  readonly instruction: string;
  readonly evidence: readonly EvidenceItem[];
  /** How many items were fenced, so the caller can see the boundary was applied. */
  readonly fencedCount: number;
  readonly detail: string;
}

/**
 * Fence every untrusted evidence item.
 *
 * **This is the defence.** A customer's message, a supplier's catalogue description, a product
 * review — none of it is instruction, all of it is data, and the way to say so is a delimiter
 * the content cannot forge. Any delimiter characters already inside the content are stripped,
 * because otherwise the content can close the fence and escape.
 *
 * Trusted evidence — our own sales figures, our own stock ledger — is passed through unfenced.
 * Fencing everything trains the model to ignore the fence.
 */
export function fenceUntrusted(input: {
  readonly instruction: string;
  readonly evidence: readonly EvidenceItem[];
}): FencedPrompt {
  let fencedCount = 0;

  const evidence = input.evidence.map((e): EvidenceItem => {
    if (!e.untrusted) return e;
    fencedCount += 1;
    // Strip both the real delimiters and their forgeable plain-text forms, repeatedly —
    // a single pass lets "<<UNTRUSTED<<UNTRUSTED_DATA_DATA" become a valid fence when the
    // inner match is removed and the outer halves join up.
    let cleaned = e.content;
    for (const token of [FENCE_OPEN, FENCE_CLOSE, ...FORGEABLE]) {
      while (cleaned.includes(token)) cleaned = cleaned.split(token).join('');
    }
    return {
      ...e,
      content: `${FENCE_OPEN}\nsource: ${e.source}\n${cleaned}\n${FENCE_CLOSE}`,
    };
  });

  return {
    instruction: input.instruction,
    evidence,
    fencedCount,
    detail:
      fencedCount === 0
        ? 'no untrusted evidence in this call'
        : `${fencedCount} untrusted item(s) fenced as DATA — concatenating them into the instruction is the actual vulnerability, and no amount of scanning fixes it`,
  };
}

// ─── Detection: advisory, and said to be ───────────────────────────────────────

export type InjectionSignal =
  | 'instruction_override'
  | 'role_confusion'
  | 'tool_request'
  | 'exfiltration_request'
  | 'delimiter_forgery'
  | 'encoded_payload';

export interface InjectionFinding {
  readonly evidenceId: string;
  readonly source: string;
  readonly signal: InjectionSignal;
  readonly excerpt: string;
  /** ALWAYS false. Nothing in the system depends on this finding. */
  readonly blocks: false;
  readonly detail: string;
}

const PATTERNS: readonly { readonly signal: InjectionSignal; readonly re: RegExp }[] = [
  { signal: 'instruction_override', re: /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\b(instruction|prompt|rule|direction)/i },
  { signal: 'role_confusion', re: /\b(you are now|act as|pretend to be|from now on you)\b/i },
  { signal: 'tool_request', re: /\b(call|invoke|use|run|execute)\b[^.]{0,30}\b(tool|function|api|command)\b/i },
  { signal: 'exfiltration_request', re: /\b(send|email|post|forward|leak|reveal|print)\b[^.]{0,40}\b(all |every |the )?(customer|password|secret|key|token|database|record)/i },
  { signal: 'delimiter_forgery', re: /(<<\s*UNTRUSTED|UNTRUSTED_DATA\s*>>|<\|.*?\|>|\[\/?INST\])/i },
  { signal: 'encoded_payload', re: /\b(base64|rot13|hex decode|fromCharCode)\b/i },
];

/**
 * Scan untrusted evidence for injection attempts.
 *
 * **Advisory only. `blocks` is typed as the literal `false`.**
 *
 * That type is a statement about the architecture, not a limitation. You cannot reliably detect
 * hostile instructions — people writing them are trying not to be detected, and every pattern
 * list is the phrasings somebody already thought of. A system whose safety depends on this
 * scanner is one rephrasing from failure.
 *
 * What it is genuinely good for: **seeing that somebody is trying.** Three injection attempts
 * in a week from one customer account is a fact worth knowing, and the structural defence in
 * `authority.ts` is what keeps the shop safe while you find out.
 */
export function scanForInjection(evidence: readonly EvidenceItem[]): readonly InjectionFinding[] {
  const findings: InjectionFinding[] = [];

  for (const item of evidence.filter((e) => e.untrusted)) {
    for (const { signal, re } of PATTERNS) {
      const match = re.exec(item.content);
      if (match === null) continue;
      findings.push({
        evidenceId: item.evidenceId,
        source: item.source,
        signal,
        excerpt: match[0].slice(0, 120),
        blocks: false,
        detail: `${signal.replace(/_/g, ' ')} in content from ${item.source}. Recorded for review — the model may well be steered by this, and it still cannot do anything, because the tools were never granted`,
      });
    }
  }

  return findings;
}

// ─── Redaction: both directions ────────────────────────────────────────────────

export type SecretKind = 'api_key' | 'vault_ref' | 'bearer_token' | 'connection_string' | 'private_key';

export interface RedactionFinding {
  readonly kind: SecretKind;
  readonly where: 'outbound' | 'inbound';
  readonly detail: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly findings: readonly RedactionFinding[];
  readonly clean: boolean;
  readonly detail: string;
}

export const REDACTED = '[redacted]';

const SECRET_PATTERNS: readonly { readonly kind: SecretKind; readonly re: RegExp }[] = [
  { kind: 'vault_ref', re: /vault:\/\/[^\s'"]+/g },
  { kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/g },
  { kind: 'connection_string', re: /\b(?:postgres|postgresql|mysql|mongodb)(?:\+\w+)?:\/\/[^\s'"]+/g },
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'api_key', re: /\b(?:sk|rzp|pk|ak)_(?:live|test|prod)_[A-Za-z0-9]{8,}/g },
];

/**
 * Redact secrets from text going to the model **and coming back from it**.
 *
 * Both directions matter and the inbound one is the less obvious: a model repeats back what it
 * was shown, and an answer containing a connection string ends up in a log, a screenshot, a
 * support ticket. Redacting only outbound is the version of this that leaks.
 *
 * Note this redacts even a `vault://` **reference**. It is not itself a secret, but it names
 * exactly which secret to go and steal, and an agent has no reason to see one.
 */
export function redactSecrets(text: string, where: 'outbound' | 'inbound'): RedactionResult {
  let out = text;
  const findings: RedactionFinding[] = [];

  for (const { kind, re } of SECRET_PATTERNS) {
    const before = out;
    out = out.replace(re, REDACTED);
    if (out !== before) {
      findings.push({
        kind,
        where,
        detail:
          where === 'inbound'
            ? `the model repeated a ${kind.replace(/_/g, ' ')} back — redacted before it could reach a log, a screenshot or a support ticket`
            : `a ${kind.replace(/_/g, ' ')} was about to be sent to a model — redacted`,
      });
    }
  }

  return {
    text: out,
    findings,
    clean: findings.length === 0,
    detail: findings.length === 0 ? 'no secret material' : `${findings.length} secret(s) redacted ${where}`,
  };
}

// ─── PII minimisation: by purpose ──────────────────────────────────────────────

export type PiiField = 'name' | 'phone' | 'email' | 'address' | 'customer_id' | 'loyalty_id' | 'dob';

export type AgentPurpose =
  | 'stock_question'
  | 'purchase_question'
  | 'owner_brief'
  | 'customer_service'
  | 'customer_shopping'
  | 'marketing_segment'
  | 'fraud_review'
  | 'operations'
  | 'data_quality'
  | 'workforce';

/**
 * The PII each purpose may legitimately see. **Anything absent is stripped** — an allowlist,
 * so a field invented later is minimised by default rather than leaked by default.
 *
 * The safest customer data is the data that was never sent. An agent answering a stock question
 * has no business knowing anybody's name, and giving it one because "it might help" is how a
 * customer list ends up in a model provider's logs.
 */
export const PII_BY_PURPOSE: Readonly<Record<AgentPurpose, readonly PiiField[]>> = {
  stock_question: [],
  purchase_question: [],
  owner_brief: [],
  operations: [],
  data_quality: ['customer_id'],
  workforce: [],
  fraud_review: ['customer_id', 'loyalty_id'],
  marketing_segment: ['customer_id'],
  // Only the two customer-facing agents see a person, and only what the conversation needs.
  customer_service: ['name', 'customer_id'],
  customer_shopping: ['name', 'customer_id'],
};

export interface MinimisationResult {
  readonly purpose: AgentPurpose;
  readonly record: Readonly<Record<string, unknown>>;
  readonly removed: readonly PiiField[];
  readonly detail: string;
}

/**
 * Strip PII a purpose has no need for, **before** the record is anywhere near a model.
 *
 * This is data minimisation in the plain sense the DPDP Act intends: not "we protect it", but
 * "we never sent it". A field that never left the building cannot be in anybody's logs, cannot
 * be in a breach and cannot be subpoenaed from a third party.
 */
export function minimisePii(input: {
  readonly purpose: AgentPurpose;
  readonly record: Readonly<Record<string, unknown>>;
  /**
   * Non-personal fields this call genuinely needs — a product id, a quantity, a date.
   *
   * **Opt-in, and that is the entire control.** Everything not named here and not permitted by
   * the purpose is removed. Listing the business fields is real friction; it is also the only
   * version of this function that is true to its own name.
   */
  readonly businessFields?: readonly string[];
}): MinimisationResult {
  const permitted = new Set<string>(PII_BY_PURPOSE[input.purpose]);
  const business = new Set<string>(input.businessFields ?? []);

  const record: Record<string, unknown> = {};
  const removed: PiiField[] = [];

  // DEFAULT DENY. This was previously a blocklist wearing an allowlist's name: it checked each
  // key against a fixed list of seven known PII fields and passed anything else straight
  // through. `aadhaar_number`, `pan`, `gstin`, `bank_account`, `passport_number` — none of them
  // were on that list, so all of them reached the model untouched. The failure mode is precisely
  // the one every blocklist has: it is a list of what somebody already thought of, and the field
  // that leaks is the one added to a customer record next year by somebody who never read this
  // file.
  for (const [key, value] of Object.entries(input.record)) {
    if (permitted.has(key) || business.has(key)) {
      record[key] = value;
      continue;
    }
    removed.push(key as PiiField);
  }

  return {
    purpose: input.purpose,
    record,
    removed: removed.sort(),
    detail:
      removed.length === 0
        ? `nothing to minimise for ${input.purpose.replace(/_/g, ' ')}`
        : `${removed.join(', ')} removed before this reached a model — the safest customer data is the data that was never sent`,
  };
}

// ─── The whole pipeline, in the right order ────────────────────────────────────

export interface PreparedCall {
  readonly instruction: string;
  readonly evidence: readonly EvidenceItem[];
  readonly injectionFindings: readonly InjectionFinding[];
  readonly redactionFindings: readonly RedactionFinding[];
  readonly piiRemoved: readonly PiiField[];
  /** True when nothing suspicious was seen. Advisory — the call proceeds either way. */
  readonly clean: boolean;
  readonly detail: string;
}

/**
 * Prepare a call: **minimise, redact, fence, then scan.**
 *
 * The order is the argument. Minimisation removes what should never travel; redaction removes
 * what must never travel; fencing marks what travels as data rather than instruction. Scanning
 * comes **last and changes nothing**, because it is the weakest of the four and putting it
 * first would invite somebody to treat it as the gate.
 */
export function prepareCall(input: {
  readonly instruction: string;
  readonly evidence: readonly EvidenceItem[];
  readonly purpose: AgentPurpose;
  readonly records?: readonly Readonly<Record<string, unknown>>[];
}): PreparedCall {
  const piiRemoved = new Set<PiiField>();
  for (const record of input.records ?? []) {
    for (const field of minimisePii({ purpose: input.purpose, record }).removed) piiRemoved.add(field);
  }

  const outbound = redactSecrets(input.instruction, 'outbound');
  const redactedEvidence = input.evidence.map((e) => {
    const r = redactSecrets(e.content, 'outbound');
    return { item: { ...e, content: r.text }, findings: r.findings };
  });

  const fenced = fenceUntrusted({
    instruction: outbound.text,
    evidence: redactedEvidence.map((r) => r.item),
  });

  const injectionFindings = scanForInjection(fenced.evidence);
  const redactionFindings = [...outbound.findings, ...redactedEvidence.flatMap((r) => r.findings)];
  const clean = injectionFindings.length === 0 && redactionFindings.length === 0;

  return {
    instruction: fenced.instruction,
    evidence: fenced.evidence,
    injectionFindings,
    redactionFindings,
    piiRemoved: [...piiRemoved].sort(),
    clean,
    detail: clean
      ? `prepared: ${fenced.fencedCount} item(s) fenced, nothing suspicious`
      : `prepared: ${fenced.fencedCount} fenced, ${redactionFindings.length} secret(s) redacted, ${injectionFindings.length} injection signal(s) noted for review — the call PROCEEDS, because the defence is that the tools were never granted, not that the text was clean`,
  };
}

export interface ProbePattern {
  readonly source: string;
  readonly attempts: number;
  readonly signals: readonly InjectionSignal[];
  readonly detail: string;
}

/**
 * Find repeat injection attempts by source.
 *
 * One attempt is somebody curious. A pattern is somebody working at it — and while the
 * structural defence holds regardless, the shop should hear about it from its own system rather
 * than from a customer whose data appeared somewhere.
 */
export function findInjectionProbes(
  findings: readonly InjectionFinding[],
  threshold = 3,
): readonly ProbePattern[] {
  const bySource = new Map<string, InjectionFinding[]>();
  for (const f of findings) bySource.set(f.source, [...(bySource.get(f.source) ?? []), f]);

  return [...bySource]
    .filter(([, rows]) => rows.length >= threshold)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, rows]) => ({
      source,
      attempts: rows.length,
      signals: [...new Set(rows.map((r) => r.signal))].sort(),
      detail: `${rows.length} injection attempt(s) from ${source} — one is curiosity, ${rows.length} is somebody working at it`,
    }));
}
