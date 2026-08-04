// Public surface of @sre/b2b — sell to businesses on the one-commerce-truth core
// (M22): credit-limit control with approval override (M22-FR-01), the quote → order →
// proforma → challan → invoice document chain where each document is derived from the one
// before it and the tax invoice follows what was DELIVERED (M22-FR-02), exact salesperson
// commission (M22-FR-03), and the customer portal with due-date ageing, allocated payments
// and human-committed collections (M22-FR-04). Pure and deterministic.

export * from './credit';
export * from './commission';
export * from './documents';
export * from './collections';
