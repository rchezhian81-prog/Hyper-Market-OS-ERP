// Processor / sub-processor erasure NOTIFICATION (M20-FR-04 / PRV / DPDP, owner decision —
// DEVELOPMENT-APPROVED, LEGAL CONFIRMATION REQUIRED). When the shop erases a customer, the personal data
// it SHARED with other processors — an SMS gateway, an email sender, a loyalty or analytics provider — must
// be erased there too. This module plans that notification, provider-neutrally.
//
// It deliberately does NOT invent a delivery queue. The shop already has a tested, provider-neutral
// connector queue with retry, throttling and a dead letter that is read-never-deleted
// (`packages/integration/src/connector.ts`, M32-FR-02). A processor notice is just a message on that queue:
// so a processor that cannot be reached is retried and then DEAD-LETTERED for a person, never lost
// (hard rules #6 #8, P-08), and each notice carries a stable delivery key so a resend never doubles.
//
// This module's job is the PLAN: given the tombstone (what was erased / minimised) and the register of
// processors we shared each category with, produce exactly one notice per processor that actually holds
// affected data, for exactly the affected categories — and everything the caller needs to enqueue it on the
// processor's connector. A processor that only ever received a legally-retained category gets NO notice
// (there is nothing for it to erase). Pure and deterministic: the clock is injected, nothing is sent here.

import type { PrivacyTombstone } from './erasure-governance';

/** A processor / sub-processor we shared personal data with, and the connector we reach it through. */
export interface ProcessorRegistryEntry {
  readonly processorId: string;
  readonly name: string;
  /** The durable connector queue this processor is reached on (its retry/dead-letter live there). */
  readonly connectorId: string;
  /** The connector mapping version in force — travels with the enqueued message. */
  readonly connectorVersion: string;
  /** The PII categories the shop shared with this processor. */
  readonly categoriesShared: readonly string[];
}

/** The provider-neutral instruction sent to a processor: erase the subject's data in these categories. */
export interface ProcessorErasureNotice {
  readonly processorId: string;
  readonly subjectRef: string;
  readonly requestId: string;
  /** The shared categories that were erased or minimised here and must be erased downstream too. */
  readonly categories: readonly string[];
  readonly instruction: 'erase';
  readonly requestedAt: string;
}

/** A notice plus everything needed to enqueue it on the processor's connector queue (idempotently). */
export interface ProcessorNoticeEnqueue {
  readonly processor: ProcessorRegistryEntry;
  readonly notice: ProcessorErasureNotice;
  /** One message per (request, processor) — a stable id so a re-plan/resend never doubles. */
  readonly messageId: string;
  /** The idempotency key the processor sees — likewise stable per (request, processor). */
  readonly deliveryKey: string;
}

/**
 * Plan the processor notices for a completed (or partial) erasure. One notice per processor that shared a
 * category which was erased or minimised, carrying only that intersection. A processor that shared only a
 * legally-retained category is not notified — there is nothing to erase there, and telling it to erase a
 * record the law requires us to keep would be wrong. Deterministic (sorted by processor).
 */
export function planProcessorErasureNotices(input: {
  readonly tombstone: PrivacyTombstone;
  readonly processors: readonly ProcessorRegistryEntry[];
  readonly at: string;
}): readonly ProcessorNoticeEnqueue[] {
  const { tombstone } = input;
  // The categories whose personal data actually left us and must go downstream too. A retained-in-full
  // category is NOT here — the shop keeps it under statute and a processor was never asked to keep it.
  const affected = new Set<string>([...tombstone.categoriesErased, ...tombstone.categoriesMinimised]);

  return [...input.processors]
    .sort((a, b) => a.processorId.localeCompare(b.processorId))
    .map((processor): ProcessorNoticeEnqueue | undefined => {
      const categories = processor.categoriesShared.filter((c) => affected.has(c)).sort();
      if (categories.length === 0) return undefined; // nothing this processor holds was erased
      const key = `erasure-${tombstone.requestId}-${processor.processorId}`;
      return {
        processor,
        notice: {
          processorId: processor.processorId,
          subjectRef: tombstone.customerRef,
          requestId: tombstone.requestId,
          categories,
          instruction: 'erase',
          requestedAt: input.at,
        },
        messageId: key,
        deliveryKey: key,
      };
    })
    .filter((n): n is ProcessorNoticeEnqueue => n !== undefined);
}
