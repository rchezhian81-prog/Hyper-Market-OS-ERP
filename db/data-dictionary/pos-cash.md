# Data dictionary — POS & Cash (M12–M15)

- **Roadmap:** §5 M12–M15, §16 D04, §4.2, §31, §32, §35. **API-05.**
- The critical path (OD-04): fast, offline-capable, and **no card data ever** (#3). Enforced
  by `pos-offline.test.ts` and `card-data.test.ts`.

## Sale (M12)

### Sale ⊕ (immutable, globally unique)
| Field | Type | Key | Notes |
| --- | --- | --- | --- |
| `id` | uuid | PK | globally unique, **immutable** (M12-FR-03) |
| `lane_id` / `cashier_id` | uuid | FK | |
| `number` | text | | NumberSeries (offline **reserved range**) |
| `trading_day` | date | | trading-day rule (M01-FR-02) |
| `status` | enum{completed,suspended,voided} | | |
| `subtotal_minor` / `tax_minor` / `total_minor` + `currency` | bigint | | total is the source figure |
| `customer_id` | uuid null | FK | optional — **guest sale allowed** |
| `idempotency_key` | text | UQ | one ledger effect on replay (§31.1) |
| `committed_at` | timestamptz | | **durable local commit before "success"** (§4.2) |

_Never depends on the network (#1); committed locally first, synced idempotently._

### SaleLine
| `sale_id` | uuid | FK | |
| `product_id` | uuid | FK | |
| `qty` + `uom` | numeric | | weight precision UOM-aware |
| `unit_price_minor` + `currency` | bigint | | resolved from the **local pack** (M05) |
| `price_version_ref` | uuid | | which price applied |
| `tax_minor` | bigint | | |
| `promotion_ref` | uuid null | | |

### Tender (M12-FR-03) 🔒 (payment)
| `sale_id` | uuid | FK | |
| `kind` | enum{cash,card,upi,store_credit,split} | | split balances to total |
| `amount_minor` + `currency` | bigint | | |
| `status` | enum{pending,authorized,uncertain,settled,declined} | | **never a fake approval** |
| `provider_token` | text null | 🔒 | **token only — never PAN/CVV/expiry** (#3) |
| `provider_ref` | text null | | reconciliation reference |

_Cash/store-credit are **full offline**; card/UPI are provider-dependent and shown
honestly; **no card number anywhere** in data or logs (card-data guardrail)._

## Returns, till & suspends (M13–M15)

### Refund / Exchange ⊕ (M13)
| `original_sale_ref` | uuid | | |
| `kind` | enum{refund,exchange} | | |
| `amount_minor` + `currency` | bigint | | compensating (append-only spirit) |
| `reason_code` | text | | no-receipt policy controls |
| `approval_ref` | uuid null | FK | |

### TillSession (M14)
| `lane_id` / `cashier_id` | uuid | FK | |
| `opened_at` / `closed_at` | timestamptz | | |
| `opening_float_minor` | bigint | | |
| `pickups` / `safe_drops` | jsonb | | cash movements |
| `declared_total_minor` / `counted_total_minor` | bigint | | **blind** count |
| `status` | enum{open,closing,closed,reopened} | | close aligned to trading day; audited reopen |

_Close is **blocked** while unsent sales/exceptions remain (M14-FR-04)._

### SuspendedBill (M12-FR-02)
| `lane_id` | uuid | FK | durable locally; survives a lane restart |
| `payload` | jsonb | | recallable per policy |

### Override ⊕ & LaneHealth (M12-FR-04 / M15)
- **Override ⊕** — `sale_ref`, `type` enum{price,age,restricted,void},
  `approved_by` (**supervisor ≠ cashier**), `reason` — audited (loss-prevention, M15).
- **LaneHealth** — `lane_id`, `peripherals jsonb`, `sync_state` enum{online,degraded,offline},
  `unsent_count int` (from the edge outbox).

## Offline (§31 / hard rule #1)
Full offline for the core sale, cash/store-credit tender, suspend/recall and receipt;
**durable local commit before success** (§4.2); syncs **exactly once**; the unsent count
comes from the edge outbox. Performance: scan-to-line p95 ≤ 300 ms, total/tender p95
≤ 500 ms excl. external auth (§32).
