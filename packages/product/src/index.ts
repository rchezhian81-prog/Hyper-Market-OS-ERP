// Public surface of @sre/product — the product master (M03): hierarchy, attributes,
// tax/MRP and safety content with publish rules (FR-01/FR-03), pack hierarchy and
// barcode uniqueness (FR-02), and lifecycle, duplicate review and reversible merge
// (FR-04). The single trusted product truth every channel shares (P-02).

export * from './product';
export * from './pack';
export * from './duplicates';
export * from './completeness';
export * from './unit-price';
export * from './label-height';
