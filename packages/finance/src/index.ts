// Public surface of @sre/finance — the accounting bridge, starting with
// mapping-driven double-entry posting (M23-FR-01/02): turn operational events into
// balanced journals (GST included) from a configurable chart-of-accounts map;
// unmapped events surface as exceptions, never silent. Grows one reviewed, tested
// unit at a time.

export * from './posting';
