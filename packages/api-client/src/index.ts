// The client every screen uses to reach the thirteen APIs.
//
// One rule above all others: the idempotency key belongs to the DECISION, not to the attempt.
// See `client.ts` for why that is the reason this package exists.

export {
  intend, attempt, drain, read,
  type SavedState, type ApiErrorBody, type Intent, type Transport, type IntentQueue,
  type Outcome, type DrainResult, type CachedRead,
} from './client';
