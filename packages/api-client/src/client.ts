// The client every screen uses to reach the thirteen APIs — §30, §31.1, §27.1, P-01, P-08.
//
// **The idempotency key is minted when the person acts, not when the request is sent.**
//
// That one line is the reason this package exists. Generate the key per *attempt* and a retry
// carries a new one, so a till that resends a sale it could not confirm creates a second sale —
// and the server, which is doing everything right, sees two different requests and banks both.
// Every idempotency guarantee on the server side is undone by a client that gets this wrong, and
// it is wrong by default in almost every HTTP client ever written, because retrying is a transport
// concern and the key looks like a transport detail.
//
// So an `Intent` is created once, at the moment the cashier presses Tender, and it carries its key
// through every attempt, every reconnection and every restart of the application.
//
// Two more things the screens must not have to think about:
//
//   • **`wasItSaved` reaches the person.** The server takes trouble to say whether the write
//     landed; a client that maps everything to "request failed" throws that away, and the cashier
//     presses the button again.
//   • **Offline is queued, not failed** (P-01). A write made with no line goes to the outbox and
//     the screen says so. A *read* with no line returns what is cached, labelled with its age.

export type SavedState = 'saved' | 'not_saved' | 'unknown';

export interface ApiErrorBody {
  readonly code: string;
  readonly whatHappened: string;
  readonly wasItSaved: SavedState;
  readonly nextSafeAction: string;
  readonly traceId?: string;
}

/** One thing a person decided to do. Created once; retried as often as needed. */
export interface Intent {
  readonly intentId: string;
  /** Minted with the intent, never with the attempt. This is the whole point. */
  readonly idempotencyKey: string;
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body: unknown;
  readonly createdAt: string;
  readonly attempts: number;
}

export interface Transport {
  send(request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
  }): Promise<{ readonly status: number; readonly body: unknown }>;
}

/** Where intents wait when there is no line. Durable in a real deployment. */
export interface IntentQueue {
  enqueue(i: Intent): Promise<void> | void;
  pending(): Promise<readonly Intent[]> | readonly Intent[];
  remove(intentId: string): Promise<void> | void;
  bump(intentId: string): Promise<void> | void;
}

export type Outcome =
  /** The server took it. */
  | { readonly kind: 'done'; readonly status: number; readonly body: unknown }
  /** No line, or a transient failure. It is queued and will go. Nothing was lost. */
  | { readonly kind: 'queued'; readonly intent: Intent; readonly message: string }
  /** The server refused it and will refuse it again. A person has to look. */
  | { readonly kind: 'refused'; readonly status: number; readonly error: ApiErrorBody; readonly message: string };

/**
 * Create an intent.
 *
 * Separate from sending, deliberately: the key belongs to the decision, and the decision happens
 * before any request does.
 */
export function intend(input: {
  readonly method: Intent['method'];
  readonly path: string;
  readonly body: unknown;
  readonly newId: () => string;
  readonly now: string;
}): Intent {
  const intentId = input.newId();
  return {
    intentId,
    // Derived from the intent id rather than generated separately, so there is no second source
    // of randomness that could differ between the queue record and the request.
    idempotencyKey: intentId,
    method: input.method,
    path: input.path,
    body: input.body,
    createdAt: input.now,
    attempts: 0,
  };
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Turn a server error body into something a person can act on. */
function messageFor(error: ApiErrorBody): string {
  const saved = error.wasItSaved === 'saved' ? 'Your data WAS saved.'
    : error.wasItSaved === 'not_saved' ? 'Nothing was saved.'
      : 'We do not know whether it saved.';
  return `${error.whatHappened} ${saved} ${error.nextSafeAction}`;
}

/**
 * Send an intent, once.
 *
 * A transport failure and a 5xx are the same thing to the person in front of the screen — the
 * request did not get an answer — so both queue. Only a server that has *decided* is a refusal.
 */
export async function attempt(input: {
  readonly intent: Intent;
  readonly transport: Transport;
  readonly token: string;
  readonly queue: IntentQueue;
}): Promise<Outcome> {
  const { intent } = input;
  let reply: { status: number; body: unknown };

  try {
    reply = await input.transport.send({
      method: intent.method,
      path: intent.path,
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        // The key from the intent. Not a fresh one. Not one per attempt.
        'idempotency-key': intent.idempotencyKey,
      },
      body: intent.body,
    });
  } catch {
    await input.queue.enqueue(intent);
    return {
      kind: 'queued', intent,
      message: 'No connection. This is saved here and will be sent as soon as the line is back — nothing is lost.',
    };
  }

  if (reply.status < 400) {
    await input.queue.remove(intent.intentId);
    return { kind: 'done', status: reply.status, body: reply.body };
  }

  if (RETRYABLE.has(reply.status)) {
    await input.queue.enqueue(intent);
    await input.queue.bump(intent.intentId);
    return {
      kind: 'queued', intent,
      message: 'The server could not answer just now. This is saved here and will be sent again — nothing is lost.',
    };
  }

  const error = (reply.body as { error?: ApiErrorBody })?.error ?? {
    code: 'unknown', whatHappened: 'The server refused this.',
    wasItSaved: 'unknown' as const,
    nextSafeAction: 'Check whether it applied before trying again.',
  };
  // A decided refusal is removed from the queue: resending it forever produces the same answer and
  // buries everything behind it.
  await input.queue.remove(intent.intentId);
  return { kind: 'refused', status: reply.status, error, message: messageFor(error) };
}

export interface DrainResult {
  readonly sent: number;
  readonly stillQueued: number;
  readonly refused: readonly { readonly intent: Intent; readonly message: string }[];
  readonly detail: string;
}

/**
 * Send everything waiting, oldest first.
 *
 * Order matters and is not cosmetic: a refund sent before the sale it refunds arrives at a server
 * that has never heard of the sale. Stops on the first queued outcome — if the line is down, the
 * next one will be too, and hammering it just spends battery.
 */
export async function drain(input: {
  readonly transport: Transport;
  readonly token: string;
  readonly queue: IntentQueue;
}): Promise<DrainResult> {
  const pending = [...(await input.queue.pending())]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  let sent = 0;
  const refused: { intent: Intent; message: string }[] = [];

  for (const intent of pending) {
    const outcome = await attempt({ intent, transport: input.transport, token: input.token, queue: input.queue });
    if (outcome.kind === 'done') { sent += 1; continue; }
    if (outcome.kind === 'refused') { refused.push({ intent, message: outcome.message }); continue; }
    break; // still offline — stop rather than hammer a dead link
  }

  const stillQueued = (await input.queue.pending()).length;
  return {
    sent, stillQueued, refused,
    detail: `${sent} sent, ${stillQueued} still waiting, ${refused.length} refused and needing a person`,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface CachedRead<T> {
  readonly value: T;
  readonly asAt: string;
  readonly fromCache: boolean;
  /** Shown whenever the answer did not come from the server just now (P-08). */
  readonly freshnessMessage: string;
}

/**
 * Read, falling back to the cache with its age shown.
 *
 * A screen that silently renders cached data is a screen somebody makes a decision on an hour
 * after the line went down. The age is part of the answer, not a banner beside it.
 */
export async function read<T>(input: {
  readonly path: string;
  readonly transport: Transport;
  readonly token: string;
  readonly cache: { get(path: string): { value: T; asAt: string } | undefined; put(path: string, value: T, asAt: string): void };
  readonly now: string;
}): Promise<CachedRead<T> | undefined> {
  try {
    const reply = await input.transport.send({
      method: 'GET', path: input.path,
      headers: { authorization: `Bearer ${input.token}` },
    });
    if (reply.status < 400) {
      input.cache.put(input.path, reply.body as T, input.now);
      return { value: reply.body as T, asAt: input.now, fromCache: false, freshnessMessage: 'Up to date.' };
    }
  } catch { /* fall through to the cache */ }

  const cached = input.cache.get(input.path);
  if (cached === undefined) return undefined;

  const minutes = Math.max(0, Math.floor((Date.parse(input.now) - Date.parse(cached.asAt)) / 60_000));
  return {
    value: cached.value, asAt: cached.asAt, fromCache: true,
    freshnessMessage: minutes < 60
      ? `Showing what was here ${minutes} minute(s) ago — no connection.`
      : `Showing what was here ${Math.floor(minutes / 60)} hour(s) ago. Do not make a decision on these figures until the connection is back.`,
  };
}
