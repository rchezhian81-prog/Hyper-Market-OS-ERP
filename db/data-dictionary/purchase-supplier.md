# Data dictionary — Purchase & Supplier (M06–M07, M30)

- **Roadmap:** §5 M06/M07/M30, §16 D03, §28, §29. **API-03.**
- Buy well, receive accurately, and pay only what matches — with separation of duties so
  one person can't requisition, receive and pay the same deal (§28).

## Supplier (M06)

### Supplier 🔒 (bank details)
| Field | Type | Key | Notes |
| --- | --- | --- | --- |
| `name` | text | | |
| `gstin` | text | | |
| `status` | enum{draft,active,blocked} | | |
| `bank_account` | jsonb | 🔒 | **bank-change verification** (M06-FR-01) |
| `bank_verified_by` | uuid null | FK User | **separate approver** — creator can't approve (§28) |
| `scorecard` | jsonb | | supplier performance |

### SupplierContact 🔒
| `supplier_id` | uuid | FK | |
| `name` / `phone` / `email` | text | 🔒 | PII |

## Procurement flow (M07)

### Requisition + RequisitionLine
- **Requisition** — `requested_by`, `status` enum{draft,submitted,approved,rejected}.
- **RequisitionLine** — `product_id`, `qty` + `uom`.

### Rfq / Quotation
- **Rfq** — `supplier_ids`, `status`.
- **Quotation** — `supplier_id`, line `price_minor` + `currency`, `lead_time_days`
  (comparison highlights cheapest/fastest).

### PurchaseOrder + PoLine
| **PO** | | | |
| `supplier_id` | uuid | FK | |
| `number` | text | | NumberSeries |
| `status` | enum{draft,approved,sent,partially_received,closed,cancelled} | | |
| `approved_by` | uuid | FK User | **value-limit approval** (§28) |
| `total_minor` + `currency` | bigint | | |
| **PoLine** | | | `product_id`, `ordered_qty`+`uom`, `unit_cost_minor`+`currency`, `tax_class_id` |

### Grn (goods received note) ⊕ + GrnLine ⊕
- **Grn** — `po_id`, `received_at`, `received_by`, `status`.
- **GrnLine ⊕** — `product_id`, `received_qty`+`uom`, `batch`/`expiry`/`mrp`/`cost`,
  `condition` enum{good,quarantine}. Receiving **appends inventory movements** and is
  **queue-capable offline**.

### SupplierInvoice + InvoiceLine + MatchResult (M07-FR-04 / M30)
| **SupplierInvoice** | | | |
| `supplier_id` | uuid | FK | |
| `number` | text | | |
| `total_minor` + `currency` | bigint | | |
| `source` | enum{manual,import} | | **bulk import** (M30-FR-01) |
| `status` | enum{imported,previewed,approved,posted,rejected} | | nothing commits until approved |
| **InvoiceLine** | | | `product_id`, `qty`, `price_minor`, `tax`, `row_error text null` (preview shows bad rows) |
| **MatchResult** | | | `po_id`/`grn_id`/`invoice_id`, `variance jsonb`, `within_tolerance bool` |

_Three-way **PO-GRN-invoice match**; out-of-tolerance **blocks payment** pending approval._

## Offline (§31)
Receiving/QC is queue-capable offline (globally unique commands; conflicts on sync);
purchase drafting may cache; **issuing and approval are online** — no unsafe stale approval.
