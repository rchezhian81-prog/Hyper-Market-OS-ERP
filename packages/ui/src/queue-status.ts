// The shared presentation for a GST-portal RECONCILIATION queue category — the operator vocabulary the
// e-invoice and e-way-bill registers already emit (`eInvoiceRowCategory`/`ewbRowCategory`, item 2). A queue
// screen (item 3) has to show, at a glance and under warehouse glare, which documents are done and which
// need a human — so the category maps to a tone (colour), an icon (shape) and whether it needs attention,
// with the words supplied by the screen's own bilingual copy. Colour is never the only signal (it delegates
// to the a11y `presentStatus`), and `mismatch` — the additive flag from inc4 — is presented as an attention
// state in its own right, never folded into "registered".
//
// Pure and deterministic: no I/O, no DOM, no clock.

import { presentStatus, type StatusPresentation, type Tone } from '../../a11y/src/signals';

/**
 * The union of operator categories both registers can produce. `processing` (an e-invoice awaiting the IRP)
 * and `registered`/`generated` (a done document) are e-invoice/e-way-bill specific; `rejected`, `unknown`,
 * `error`, `cancelled` and `mismatch` are shared. This is the closed set the presenter is exhaustive over.
 */
export type QueueCategory =
  | 'processing' | 'registered' | 'generated' | 'rejected' | 'unknown' | 'error' | 'cancelled' | 'mismatch';

export const QUEUE_CATEGORIES: readonly QueueCategory[] =
  ['processing', 'registered', 'generated', 'rejected', 'unknown', 'error', 'cancelled', 'mismatch'];

/** Tone + icon + attention per category. The three attention categories are the reconciliation exception set. */
const CATEGORY_FACE: Readonly<Record<QueueCategory, { readonly tone: Tone; readonly icon: string; readonly needsAttention: boolean }>> = {
  registered: { tone: 'ok', icon: '✓', needsAttention: false },
  generated: { tone: 'ok', icon: '✓', needsAttention: false },
  processing: { tone: 'idle', icon: '…', needsAttention: false }, // in-flight — not yet an exception
  cancelled: { tone: 'idle', icon: '⊘', needsAttention: false },  // terminal and deliberate — not an error
  unknown: { tone: 'degraded', icon: '?', needsAttention: true }, // timeout — poll to recover
  error: { tone: 'error', icon: '!', needsAttention: true },      // provider error — a signature that did not verify
  rejected: { tone: 'error', icon: '✕', needsAttention: true },   // the portal refused it — fix and re-issue
  mismatch: { tone: 'error', icon: '≠', needsAttention: true },   // a re-query disagreed with the stored number
};

/** Does a category need a person to act? The reconciliation exception set (unknown + error + rejected + mismatch). */
export function isQueueException(category: QueueCategory): boolean {
  return CATEGORY_FACE[category].needsAttention;
}

/**
 * Present a queue category with the caller's already-translated label and optional announcement. Tone and
 * icon come from the category; the words come from the screen's bilingual copy — language-neutral, testable,
 * and colour is never the only signal (delegates to `presentStatus`).
 */
export function presentQueueCategory(input: {
  readonly category: QueueCategory;
  readonly label: string;
  readonly announcement?: string;
}): StatusPresentation {
  const face = CATEGORY_FACE[input.category];
  return presentStatus({
    tone: face.tone,
    label: input.label,
    icon: face.icon,
    ...(input.announcement !== undefined ? { announcement: input.announcement } : {}),
    needsAttention: face.needsAttention,
  });
}
