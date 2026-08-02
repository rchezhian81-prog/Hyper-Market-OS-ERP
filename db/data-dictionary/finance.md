# Data dictionary — Finance (M23)

- **Roadmap:** §5 M23, §16 D10, §9.3 (GST), §28, §29. **API-09.**
- Everything reconciles; ledgers are **append-only** (#2); **no card data** (#3); control
  totals are **CA-signable** before close (QG-07).

## Ledger & journals (M23-FR-01)

### LedgerAccount (chart of accounts)
| Field | Type | Key | Notes |
| --- | --- | --- | --- |
| `code` | text | UQ | ⟳ AVR-09 (chart mapping) |
| `name` | text | | |
| `type` | enum{asset,liability,income,expense,equity} | | |
| `cost_centre` | text null | | cost/profit centre |

### LedgerMapping
| `event_type` | text | | operational event → accounts |
| `debit_account_id` / `credit_account_id` | uuid | FK | deterministic posting |

### Journal ⊕ (append-only posting)
| `source_type` / `source_ref` | text/uuid | | POS/purchase/inventory event |
| `debit_account_id` / `credit_account_id` | uuid | FK | |
| `amount_minor` + `currency` | bigint | | |
| `trading_day` / `period_id` | date/uuid | | |
| `idempotency_key` | text | UQ | |

_Finance **reads** the operational ledger and **posts journals**; it never edits
operational data (§28); corrections are journals, not edits._

### ApArItem
| `party_type` | enum{supplier,customer} | | |
| `party_ref` | uuid | | |
| `amount_minor` + `currency` | bigint | | |
| `due_date` | date | | |
| `status` | enum{open,part_paid,settled} | | |

## Tax (M23-FR-02)

### TaxDocument (credit / debit note)
| `kind` | enum{credit_note,debit_note} | | |
| `original_ref` | uuid | | reverses tax correctly |
| `gst_breakup` | jsonb | | per HSN/tax class |
| `period_id` | uuid | FK | GST period **from the trading-day rule** |

## Reconciliation (M23-FR-03)

### ReconciliationItem ⊕
| `channel` | enum{cash,bank,card,upi,gateway,refund} | | |
| `statement_ref` | text | | imported line |
| `matched_tender_ref` | uuid null | FK | to POS tender/refund |
| `status` | enum{matched,exception} | | |
| `variance_minor` + `currency` | bigint | | **difference always visible** (P-08) |

_No card PAN — **tokens/refs only** (#3); every tender/refund independently reconcilable;
events `ReconciliationExceptionRaised` / `…Resolved`._

## Tally bridge & period close (M23-FR-04)

### TallyOutboxItem ⊕ (with dead-letter)
| `payload` | jsonb | | |
| `status` | enum{queued,retrying,failed_dead_letter,posted} | | poison → **visible DLQ, never dropped** (#6) |
| `attempts` | int | | idempotent, versioned connector (M32) |

### Period
| `code` | text | | aligns to trading day |
| `status` | enum{open,closed,reopened} | | reopen only with approval |
| `closed_by` / `reopened_by` | uuid null | FK | |

### ControlTotal
| `period_id` | uuid | FK | |
| `kind` | enum{sales,purchase,inventory,tax,loyalty,migration} | | |
| `computed_minor` + `currency` | bigint | | |
| `signed_by` | uuid null | FK | **CA-signable; must validate before close** (QG-07) |

_A period **cannot close** with unvalidated control totals._

## Offline (§31)
Finance is generally online; POS/purchase feed on sync; tenders captured offline reconcile
when settlement arrives; the Tally queue is durable with a **visible dead-letter**.
