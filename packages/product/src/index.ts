// Public surface of @sre/product — the product master (M03): hierarchy, attributes,
// tax/MRP and safety content with publish rules (FR-01/FR-03), pack hierarchy and
// barcode uniqueness (FR-02), and lifecycle, duplicate review and reversible merge
// (FR-04). The single trusted product truth every channel shares (P-02).

export * from './product';
export * from './pack';
export * from './duplicates';
export * from './completeness';
export * from './data-quality';
export * from './unit-price';
export * from './label-height';
export * from './loose-food-label';
export * from './pack-declarations';
export * from './dual-mrp';
export * from './category-policy';
export * from './category-presets';
export * from './tobacco-warning';
// OB-288 P2 (M03-FR-01/02/03/04 · D01-FR-04): nutrition (OB-307), variants and manufacturer, own-barcode bundles (OB-306)
// and the approved substitute list.
export * from './nutrition';
export * from './variants';
export * from './bundles';
export * from './substitutes';
