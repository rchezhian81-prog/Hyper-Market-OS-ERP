// Public surface of @sre/catalogue — the lane's local catalogue cache and barcode
// lookup (M03 / M12 / §31 / §32): O(1) scans from a versioned offline snapshot,
// variable-weight/price barcodes, and safety refusals (recall, non-sellable status)
// at the scan. Grows one reviewed, tested unit at a time.

export * from './catalogue';
