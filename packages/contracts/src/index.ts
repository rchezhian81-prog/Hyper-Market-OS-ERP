// Public surface of @sre/contracts — the shared shapes and primitives every app,
// service and edge component builds against (roadmap §30, P-06).
//
// The value objects Money and Quantity share operation names (add, subtract,
// compare, zero, toDecimalString…). Their value TYPES are exported flat for
// clean annotations (`const total: Money`), and their OPERATIONS are exported as
// namespaces to avoid clashes — use `MoneyOps.add(...)`, `QuantityOps.add(...)`.
// Enums and event helpers have unique names and are exported flat. Grows one
// reviewed, tested unit at a time.

export type { Money, CurrencyCode, Rounding } from './money';
export type { Quantity, Uom } from './quantity';
export type { Rate } from './rate';
export * as MoneyOps from './money';
export * as QuantityOps from './quantity';
export * as RateOps from './rate';
export * from './enums';
export * from './event';
