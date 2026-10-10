// The provider-neutral delivery transport (audit PA-08 · M31-FR-04 · M32-FR-02) — the one shape every channel
// provider (SMS, WhatsApp, email, push) is wired behind, so the durable queue and its sender never change when a
// provider does. Real providers are external gates: the SMS transport is release R4 (owner decision OB-29), and every
// provider needs credentials and certification. Until then the only transport is the RECORDING one below — a test
// adapter that sends nothing anywhere and keeps what it was asked to send, so the queue, the consent re-check, the
// backoff and the dead-letter path are all provable today.

/** One message, as the sender hands it to a transport. Never a card number or a secret (hard rules #3, #4). */
export interface OutboundMessage {
  /** The queue item's id — the provider's idempotency key, so a resend after a lost reply is one message. */
  readonly messageId: string;
  readonly channel: string;
  readonly customerId: string;
  readonly text: string;
}

/** What a transport says back. `permanent` failures dead-letter at once; others are retried with backoff. */
export type TransportOutcome =
  | { readonly ok: true; readonly providerRef: string }
  | { readonly ok: false; readonly reason: string; readonly permanent?: boolean };

export interface NotificationTransport {
  /** What this transport is, said on every receipt (e.g. `recording-test-adapter`). */
  readonly name: string;
  send(message: OutboundMessage): Promise<TransportOutcome> | TransportOutcome;
}

/**
 * The RECORDING test adapter: sends nothing, keeps every message it was handed, and answers with a deterministic
 * provider reference — idempotent on the message id. `failWith` makes the next sends fail (for retry / dead-letter
 * proofs). Never configured in production: a production composition has no transport until a real provider is certified.
 */
export function recordingTransport(): NotificationTransport & {
  readonly sent: OutboundMessage[];
  failWith(outcome: { reason: string; permanent?: boolean } | undefined, times?: number): void;
} {
  const sent: OutboundMessage[] = [];
  let failure: { reason: string; permanent?: boolean } | undefined;
  let remaining = 0;
  return {
    name: 'recording-test-adapter',
    sent,
    failWith(outcome, times = Number.POSITIVE_INFINITY) { failure = outcome; remaining = times; },
    send(message) {
      if (failure !== undefined && remaining > 0) {
        remaining -= 1;
        return { ok: false, reason: failure.reason, ...(failure.permanent === undefined ? {} : { permanent: failure.permanent }) };
      }
      if (!sent.some((m) => m.messageId === message.messageId)) sent.push(message);
      return { ok: true, providerRef: `rec-${message.messageId}` };
    },
  };
}

/** Exponential backoff with a ceiling — the wait after the n-th failed attempt before the next (1 min … 1 h). */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}
