// `packages/demand/` — demand history and, in time, the forecast (D-1) and markdown ladder (D-4)
// that build on it. Everything here is a pure projection over the store's own banked sales: it reads
// what has already happened, and stores nothing new (hard rule #1 — the sale-commit path is untouched).

export * from './sales-history';
export * from './forecast';
