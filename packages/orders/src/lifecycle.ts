// Order lifecycle state machine (M18-FR-01, cancellation M18-FR-04) — ONE order
// truth across every channel (P-02). An order moves through auditable states via
// explicit, allowed transitions only; an illegal transition is refused, never
// silently applied. Cancellation is allowed up to dispatch and releases the
// reservation (handled by packages/orders/reservation). Pure and deterministic.

export type OrderState =
  | 'placed'
  | 'confirmed'
  | 'picking'
  | 'packed'
  | 'dispatched'
  | 'delivered'
  | 'collected'
  | 'cancelled';

export type OrderEvent = 'confirm' | 'pick' | 'pack' | 'dispatch' | 'deliver' | 'collect' | 'cancel';

/** Allowed transitions. A cancel is possible up to (and including) 'packed'. */
const TRANSITIONS: Readonly<Record<OrderState, Partial<Record<OrderEvent, OrderState>>>> =
  Object.freeze({
    placed: { confirm: 'confirmed', cancel: 'cancelled' },
    confirmed: { pick: 'picking', cancel: 'cancelled' },
    picking: { pack: 'packed', cancel: 'cancelled' },
    packed: { dispatch: 'dispatched', collect: 'collected', cancel: 'cancelled' },
    dispatched: { deliver: 'delivered' },
    delivered: {},
    collected: {},
    cancelled: {},
  });

const TERMINAL: ReadonlySet<OrderState> = new Set<OrderState>(['delivered', 'collected', 'cancelled']);

export class InvalidOrderTransitionError extends Error {
  constructor(from: OrderState, event: OrderEvent) {
    super(`Order cannot "${event}" from state "${from}".`);
    this.name = 'InvalidOrderTransitionError';
  }
}

/** Apply an event to an order state, returning the next state or throwing. */
export function transitionOrder(from: OrderState, event: OrderEvent): OrderState {
  const next = TRANSITIONS[from][event];
  if (next === undefined) {
    throw new InvalidOrderTransitionError(from, event);
  }
  return next;
}

/** True if `event` is a legal transition from `from`. */
export function canTransition(from: OrderState, event: OrderEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

/** True once the order can no longer transition (delivered/collected/cancelled). */
export function isTerminal(state: OrderState): boolean {
  return TERMINAL.has(state);
}

/** True if the order can still be cancelled (releasing its reservation, M18-FR-04). */
export function canCancel(state: OrderState): boolean {
  return canTransition(state, 'cancel');
}
