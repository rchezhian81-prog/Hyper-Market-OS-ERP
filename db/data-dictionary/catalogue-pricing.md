# Data dictionary — Catalogue & Pricing (M03–M05)

- **Roadmap:** §5 M03–M05, §16 D01 (product/catalogue) / D02 (merchandise planning), §29. **API-02.**
- See `README.md` for standard columns, types and markers. This is the shared product,
  price and promotion truth (P-02) that POS, orders and finance all read.

## Product & catalogue (M03 / D01)

### Product 🔒 (regulated flags)
| Field | Type | Key | Notes |
| --- | --- | --- | --- |
| `sku` | text | UQ | internal item id |
| `name` | text | | |
| `category_id` | uuid | FK | merchandising (M04) |
| `brand` | text | | |
| `tax_class_id` | uuid | FK | HSN/GST (M23) |
| `base_uom` | text | | |
| `regulated_flags` | jsonb | | age/restricted-item prompts (M12-FR-04) |
| `recall_block` | bool | | **stops sale/order** (M10); honoured **offline** |
| `completeness_score` | int | | D01 — gates online publish |
| `status` | enum{draft,active,discontinued,clearance} | | |

### Barcode
| `product_id` | uuid | FK | |
| `code` | text | UQ | GS1/GTIN/EAN/UPC or internal |
| `kind` | enum{standard,weight_embedded,price_embedded,alternate} | | variable-weight (M03-FR-02) |

### PackHierarchy — unit / inner / case / pallet
| `product_id` | uuid | FK | |
| `level` | enum{unit,inner,case,pallet} | | |
| `qty_in_base` | numeric | | supports pack-breaking |
| `barcode_id` | uuid null | FK | pack-level barcode |

### ProductAttribute
| `product_id` | uuid | FK | |
| `key` | text | | ingredients/allergens/nutrition/origin/storage (D01) |
| `value` | jsonb | | |

### TaxClass
| `code` | text | UQ | HSN |
| `gst_rate` | numeric | | ⟳ AVR-09 (GST config, M23) |

## Pricing & promotions (M05)

### PriceVersion ⊕ (effective-dated, approved)
| `product_id` | uuid | FK | |
| `price_minor` + `currency` | bigint | | money (§29.1) |
| `effective_at` | timestamptz | | |
| `approved_by` | uuid | FK User | **separate approver** (§28) — never self |
| `status` | enum{draft,approved,active,superseded} | | **never overwritten** |

_A price change is draft → approved → effective-dated; the history is append-only; the
maker cannot approve their own change (M05 / §28)._

### Promotion
| `name` | text | | |
| `rule` | jsonb | | conditions/discount + **stacking guardrails** |
| `starts_at` / `ends_at` | timestamptz | | |
| `approved_by` | uuid | FK User | |
| `status` | enum{draft,approved,active,ended} | | |

## Merchandising & space (M04 / D02)

### AssortmentEntry — range lifecycle
| `category_id` | uuid | FK | |
| `store_cluster` | text | | store clustering (D02) |
| `product_id` | uuid | FK | |
| `state` | enum{new,core,discontinued,clearance} | | |

### PlanogramSlot
| `store_id` | uuid | FK | |
| `aisle` / `shelf` | text | | space map |
| `product_id` | uuid | FK | |
| `capacity_qty` | numeric | | shelf capacity / sales per sq ft |
| `supplier_funded` | bool | | display-space contract |

## Offline
Product, price and tax are published to the store edge as **signed versioned packs**
(M01-FR-03); POS resolves price/promotion **deterministically from the local pack**
(M12-FR-01) with no cloud round-trip; a `recall_block` is honoured offline.
