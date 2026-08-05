# Owner Configuration Register

Store-specific values the owner will confirm during **master-data configuration / UAT**.

**None of these blocks development.** Every item below is already implemented as
**configuration with a documented safe default**, per the owner's autonomous-execution
authorization (3 Aug 2026): *"When information is incomplete but does not create legal,
financial, security or irreversible risk — implement the capability as configurable, use a
clearly documented safe default, add it to the Owner Configuration Register, and continue."*

Defaults are deliberately conservative: where a wrong value would cost money or breach a
rule, the default **blocks and asks** rather than guessing (e.g. approval thresholds default
low, so more things need a second person until the owner raises them).

Status: **Default in use** · **Confirmed** · **Changed by owner**.

| ID | Configuration item | Where it lives | Safe default in use | Confirm at |
| --- | --- | --- | --- | --- |
| OC-01 | Café recipes / bill of materials — which items are made on site and from what | `packages/production` (`Recipe`) + seed templates | Sample templates only; **no café recipe is production truth** until entered | Master-data config |
| OC-02 | Café yields and portion sizes per recipe | `Recipe.outputQuantityMinor` | Per-recipe, entered with the recipe | Master-data config |
| OC-03 | Café use-by / shelf-life hours per product | `Recipe.shelfLifeHours` + product-level override | Per-recipe; a recipe **cannot be saved without one** | Master-data config |
| OC-04 | Café yield tolerance before a variance is raised | `Recipe.yieldToleranceBp` | 5% (500 bp) | UAT |
| OC-05 | Wastage / spill reason codes | `packages/waste`, `packages/production` | Standard retail set, extensible per tenant | Master-data config |
| OC-06 | Trading-day cut-off (when "today" ends for close and GST) | `SETTINGS.TRADING_DAY_CUTOFF` | `00:00` | Master-data config (A-11) |
| OC-07 | Age-restricted minimum age | `SETTINGS.AGE_RESTRICTED_MINIMUM_AGE` | **18** — confirmed by owner (OB-03) | ✅ Confirmed |
| OC-08 | Licensed selling hours | `SETTINGS.LICENCE_HOURS_ENABLED` | **off** — confirmed by owner (OB-03) | ✅ Confirmed |
| OC-09 | Production departments operated | `SETTINGS.PRODUCTION_DEPARTMENTS` | **`['cafe']`** — confirmed by owner (OB-04) | ✅ Confirmed |
| OC-10 | Approval thresholds (adjustment, refund, discount, write-off, PO value) | per-tenant policy on each engine | Deliberately **low**, so more things need a second person until raised | UAT |
| OC-11 | Supervisor override limits and escalation path | `SupervisorAuthority` | Low limit, escalates to store manager | UAT |
| OC-12 | Goods-in tolerances (excess, shortage, near-expiry days, cold-chain °C) | `ReceiptPolicy` | 2% excess, 1% shortage, 30 days, 5°C | UAT |
| OC-13 | Three-way-match tolerances (price bp, quantity bp, immaterial value) | `MatchPolicy` | 1% price, 0% quantity, ₹1 immaterial | UAT |
| OC-14 | Delivery radius and zones | `SETTINGS.DELIVERY_RADIUS_KM` | 0 (off) — roadmap commits **10 km** at launch | Stage 15 |
| OC-15 | Receipt header/footer, logo, statutory lines | `packages/receipt` template | Generic tenant template | Master-data config |
| OC-16 | Notification wording and templates (WhatsApp/SMS/email) | `packages/notifications` | Approved neutral templates | Stage 14 |
| OC-17 | Stock ageing buckets | `DEFAULT_AGEING_BUCKETS` | 0-30 / 31-60 / 61-90 / 90+ days | UAT |
| OC-18 | Retention periods per data class | `packages/audit` `RetentionPolicy` | **Keep** — no policy means never delete | With legal/CA |
| OC-19 | Licence/certificate register contents and named owners | `packages/compliance` | Empty; alerts cannot fire until entered | Master-data config |
| OC-20 | Number-series formats per document type | `packages/numbering` | `PREFIX-YYYY-NNNNNN` | Master-data config |
| OC-21 | Default GST rate and HSN mapping per category | `SETTINGS.DEFAULT_TAX_BPS` + product master | 0 — a product **cannot publish** without a tax class | Master-data config (with CA) |
| OC-22 | Languages offered on POS and customer app | `SETTINGS.LANGUAGES` | `['en', 'ta']` | UAT |
| OC-23 | Session idle/absolute timeout, lockout threshold | `SessionPolicy` | 15 min idle, 10 h absolute, 5 failures | UAT |
| OC-24 | Offline cached-identity window at the lane | `SessionPolicy.offlineIdentityMaxMinutes` | 12 h | UAT |
| OC-25 | Emergency-access maximum duration | `EmergencyPolicy.maxMinutes` | 4 h | UAT |
| OC-26 | Catch-weight standard yields per cut (weighed tenants) | `CatchWeightRun.standardYieldBp` | Per-process, entered with the process | Per tenant |
| OC-27 | Embedded weight/price barcode layout for the store's scales | `EmbeddedBarcodeRule` | Common EAN-13 scheme (prefix `2`) | Master-data config |
| OC-28 | Backup retention and restore-test frequency | `infra/` + DR runbook | 30 days, restore tested monthly | Stage 5 gate |
| OC-29 | Supplier-statement timing window — how many days before a difference stops being "in the post" | `reconcileSupplierStatement` `timingWindowDays` | **15 days** | Migration (with CA) |
| OC-30 | Unexplained supplier difference that need not block the opening balance | `supplierPosition` `toleranceMinor` | **₹0** — every difference is worked. There is **no** tolerance for a supplier who never replied, and none for an invoice only they have | Migration (with CA) |
| OC-31 | Card/UPI commission rate, GST on it, and settlement lag per provider | `RouteTerms` | **None assumed.** The check **refuses** to run until the rate is given, and refuses a rate worked out from the gap it explains — take it off the merchant agreement | Migration (from the merchant agreement) |
| OC-32 | Cash taken but not yet lodged that need not block — the float and the till change | `verifySalesAgainstBank` `toleranceMinor` | **₹0** — every rupee is explained until the owner sets the real float | Migration (with CA) |

> **How to use this at UAT:** work down the list. For each row either accept the default
> (say nothing) or give the value. Nothing here needs a technical answer — every one is a
> business fact about how the store runs.
