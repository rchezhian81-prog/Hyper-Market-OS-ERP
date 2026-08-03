// Public surface of @sre/bank-controls — bank fraud controls: supplier bank-change
// verification (M06-FR-01, maker ≠ approver) and duplicate bank-account detection
// across suppliers/employees (M15-FR-03). Pure and deterministic. Grows one
// reviewed, tested unit at a time.

export * from './bank-verification';
export * from './duplicate-bank';
