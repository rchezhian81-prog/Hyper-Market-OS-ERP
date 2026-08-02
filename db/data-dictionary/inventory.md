# Data dictionary — Inventory (M08–M11)

- **Roadmap:** §5 M08–M11, §16 D05, §29, §31.1. **API-04.**
- The one true record of stock: **every movement is an append-only event; balances are
  projected, never overwritten** (hard rule #2). Enforced by `ledger-append-only.test.ts`.

## The ledger (M08-FR-01) — the heart of the domain

### StockMovement ⊕ — the append-only event
| Field | Type | Key | Notes |
| --- | --- | --- | --- |
| `product_id` | uuid | FK | |
| `batch_id` | uuid null | FK | |
| `location_id` | uuid | FK | bin / back-room / shelf |
| `qty` + `uom` | numeric | | signed (+ in / − out) |
| `state` | enum{on_hand,reserved,quarantine,damaged,expired,in_transit} | | M08-FR-02 |
| `reason_code` | text | | receive/sell/transfer/adjust/return |
| `source_type` / `source_ref` | text/uuid | | e.g. Sale, GRN, Adjustment |
| `idempotency_key` | text | UQ | replay collapses to one effect (§31.1) |
| `occurred_at` | timestamptz | | deterministic order key |

_INSERT-only (no UPDATE/DELETE, #2); **balance = Σ events**; a correction is a compensating
event; conflicts become **exceptions**, never last-write-wins (#10)._

### StockStateProjection — derived read model (not a source of truth)
| `product_id` / `location_id` / `batch_id` | uuid | | |
| `on_hand_qty` / `reserved_qty` / `quarantine_qty` / `damaged_qty` / `expired_qty` / `in_transit_qty` | numeric | | |
| `available_qty` | numeric | | **= on_hand − reserved − quarantine − damaged − expired** (M08-FR-02) |
| `as_of` | timestamptz | | freshness watermark (P-08) |

_Reserved online stock is **excluded from walk-in availability** (no oversell)._

## Batches & locations (M08 / M10)

### Batch / Lot
| `product_id` | uuid | FK | |
| `lot_code` | text | | supplier→customer lot traceability |
| `expiry_date` | date | | FEFO/expiry (M10) |
| `cold_chain` | bool | | quality/cold-chain evidence |
| `status` | enum{good,quarantine,recalled,destroyed} | | |

### Location / Bin
| `warehouse_id` | uuid | FK | |
| `code` | text | UQ | bin / shelf / back-room |
| `kind` | enum{shelf,back_room,bin,cold,quarantine} | | |
| `capacity_qty` | numeric null | | bin capacity (put-away) |
| `ownership` | enum{owned,consignment,concession} | | ownership status (D05) |

## Adjustments & counts (M08-FR-03 / M09)

### Adjustment ⊕ (compensating)
| `product_id` / `location_id` / `batch_id` | uuid | | |
| `qty` + `uom` | numeric | | |
| `reason_code` | text | | **mandatory** |
| `value_minor` + `currency` | bigint | | financial impact (feeds M23) |
| `approval_ref` | uuid | FK ApprovalRequest | over-threshold; **raiser ≠ approver** (§28) |

### StockCount (M09) + CountLine
- **StockCount** — `location_scope`, `type` enum{blind,full,cycle},
  `status` enum{open,counting,variance_review,closed}.
- **CountLine** — `product_id`, `counted_qty` (**blind — expected hidden**, M09-FR-04),
  `variance_qty` (system-filled), `resolution_ref` → ApprovalRequest.

## Recall, expiry, wastage (M10–M11)
- **RecallEvent** — `batch_id`/`product_id`, `initiated_at`, `scope`,
  `status` enum{open,closed}; the **recall block stops sale/order, honoured offline**
  (M10-FR-01).
- **ExpiryActionItem** — derived near-expiry list for markdown/disposal (M10).
- **WastageEvent ⊕** — `product_id`/`batch_id`, `qty`, `reason`, `value_minor`.

## Offline (§31)
All movements/counts are **queue-capable offline** with globally unique command ids;
availability is computed at the edge from the cached ledger; conflicts surface as
exceptions on sync. Acceptance: replay → one effect; an offline day reconciles to the
event sum.
