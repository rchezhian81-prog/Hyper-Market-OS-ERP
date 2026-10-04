# SRE Hyper Market ERP — professional design handover

**Revision — 4 October 2026:** the uploaded full-model design remains the base. This revision applies a professional visual treatment: dark forest navigation, white work surfaces, restrained typography, compact panels and fine tile-edge stripes. The original 15-module, 147-destination architecture, page mappings and preview interactions are preserved. This is a stylesheet and presentation revision, not a new requirements baseline or repository implementation audit.

**Open:** `SRE-Hypermarket-ERP-Professional.html`. Editable files are in `source/`; rebuild with `python3 source/build.py` from the package root. Run isolated interaction checks with `node source/verify.cjs`.

**Verification limit:** browser visual verification has not been completed. The package includes responsive styles, but actual desktop/mobile rendering and browser accessibility checks remain to be performed before implementation sign-off. Logic checks are separate from visual and production verification.


**Purpose:** a proposed page, panel and subpage-tile design for the existing ERP. This package is an interactive design reference. It does not replace the application, change its backend or claim that every proposed screen is implemented.

## Design inventory

| Measure | Count | Meaning |
|---|---:|---|
| Major navigation modules | 15 | Role-filtered families in the proposed sidebar |
| Proposed destinations | 147 | A mix of workspaces, registers, reports and settings; some can remain tabs or drawers |
| Current navigation items mapped | 53 | Every item in the supplied ERP_NAVIGATION source |
| Retired aliases retained | 8 | Existing consolidated entry points preserved in the mapping |
| M01–M36 module families covered | 36 | Design coverage of the known module families, not an acceptance verdict |

The 147 destinations are not 147 new development tasks. Reuse existing screens, tabs, routes and services first. The existing requirement IDs, baseline and completion denominator remain authoritative. A design tile is not evidence of implementation, successful integration, deployment or staff acceptance.

## Hierarchy and source anchors

| Module ID | Sidebar label | Tiles | Requirement anchors |
|---|---|---:|---|
| `overview` | Today | 6 | `docs/requirements/M02.md`, `docs/requirements/M29.md` |
| `products` | Products & pricing | 11 | `docs/requirements/M03.md`, `docs/requirements/M05.md`, `docs/requirements/M30.md` |
| `purchase` | Purchase | 9 | `docs/requirements/M06.md`, `docs/requirements/M24.md` |
| `receiving` | Receiving & QC | 7 | `docs/requirements/M07.md`, `docs/requirements/M10.md` |
| `inventory` | Inventory & backstore | 13 | `docs/requirements/M08.md`, `docs/requirements/M09.md`, `docs/requirements/M10.md`, `docs/requirements/M28.md` |
| `floor` | Shop floor | 9 | `docs/requirements/M04.md`, `docs/requirements/M09.md` |
| `sales` | Sales & service | 10 | `docs/requirements/M12.md`, `docs/requirements/M13.md`, `docs/requirements/M14.md`, `docs/requirements/M15.md`, `docs/requirements/M21.md`, `docs/requirements/M27.md` |
| `orders` | Orders & delivery | 11 | `docs/requirements/M18.md`, `docs/requirements/M19.md`, `docs/requirements/M20.md`, `docs/requirements/M22.md` |
| `finance` | Cash & finance | 14 | `docs/requirements/M14.md`, `docs/requirements/M17.md`, `docs/requirements/M22.md`, `docs/requirements/M23.md`, `docs/requirements/M27.md` |
| `customers` | Customers & loyalty | 9 | `docs/requirements/M16.md`, `docs/requirements/M17.md`, `docs/requirements/M21.md`, `docs/requirements/M22.md` |
| `production` | Fresh food & café | 7 | `docs/requirements/M11.md`, `docs/requirements/M28.md` |
| `people` | People & tasks | 8 | `docs/requirements/M25.md` |
| `operations` | Store operations | 10 | `docs/requirements/M15.md`, `docs/requirements/M26.md`, `docs/requirements/M27.md`, `docs/requirements/M28.md`, `docs/requirements/M33.md`, `docs/requirements/M34.md`, `docs/requirements/M35.md` |
| `reports` | Reports | 10 | `docs/requirements/M29.md`, `docs/requirements/index.md` → Developer extensions D13 |
| `admin` | Administration | 13 | `docs/requirements/M01.md`, `docs/requirements/M02.md`, `docs/requirements/M30.md`, `docs/requirements/M31.md`, `docs/requirements/M32.md`, `docs/requirements/M33.md`, `docs/requirements/M34.md`, `docs/requirements/M35.md`, `docs/requirements/M36.md` |

The requirements anchors refer to the existing repository requirements reviewed in the audit snapshot. `architecture.json` carries family references for each page; it is not a new full per-functional-requirement traceability matrix. Link implementation work into the existing RTM/evidence register instead of creating a competing ledger.

Navigation evidence comes from `design-reference/navigation.ts`, retained from the source review for the original full-model design. The professional restyle did not fetch or audit the repository again:

- `ERP_NAVIGATION`: current labels, paths, permission words, groups and declared served state.
- `RETIRED_NAV_ITEMS`: eight aliases consolidated into existing screens or tabs.
- `navigationFor`: actual navigation derives from authorization; illustrative role previews must not replace it.

## Availability and maturity

| Source declaration | Items | Interpretation |
|---|---:|---|
| `box` (explicit or default) | 48 | Source catalogue declares a store-computer entry point. This is not an independent runtime or E2E test. |
| `unserved` | 3 | Payroll, My payslip and Store setup are declared as not served through that entry point. |
| `unbuilt` | 2 | Reconciliation and Settings are explicitly declared unbuilt in that navigation catalogue. |

Some tasks may already exist under another path or within a screen. The prototype must not turn `unbuilt` into a claim that no related backend exists, or turn `box` into a claim that the entire redesigned destination works. Each mapping retains the observed permission and source state.

## Shared page and panel pattern

| Layer | Design intent |
|---|---|
| Global header | Company/branch, trading day, search, language, data/sync state, notifications, help and own profile |
| Sidebar | Role-filtered major modules, with the core store lifecycle easy to find |
| Module landing | Short purpose statement, primary action, actionable summary panels and grouped subpage tiles |
| Work page | Scope, freshness, filters, saved view and a table/task board suited to the operation |
| Record drawer | Source documents, quantities/money, assigned person, related records, evidence and timeline |
| Approval panel | Request, reason, amount/quantity impact, policy, evidence and authorized maker-checker decision |
| Exception panel | Exact problem, consequence, owner, due time and available recovery action |
| Mobile task surface | One main task, large targets, scan/camera entry, clear offline/queued status and retry visibility |

Keep these role surfaces distinct: a cashier needs a dedicated till; a backstore user needs issue/receive tasks; a floor colleague needs indents and shelf work; a buyer needs supplier commitments; finance needs reconciliation; the owner needs summaries and decisions.

## Preview roles

| Preview | Visible destinations | Boundary |
|---|---:|---|
| Owner | 147 | Design-review mode showing the complete architecture; not unrestricted real account access. |
| Manager | 101 | Store-management work; payroll, private rights requests and privileged administration hidden. |
| Buyer | 41 | Buying, catalogue and supplier work; operational and financial links only where needed. |
| Warehouse | 48 | Receiving, backstore, stock and fulfilment tasks; no general finance or administration. |
| Floor | 19 | Floor work and illustrative handheld fulfilment tasks; real picker/driver permissions remain separate. |
| Cashier | 21 | Till, returns, pickup and limited customer-service work, plus own staff tasks. |
| Finance | 53 | Accounting, reconciliation, payables, authorized payroll and financial reporting; actual grants still required. |

Filter each `page.roles` before rendering tiles and before computing module visibility. A direct hash/URL must also respect the prototype preview filter. Production must additionally enforce its actual permission checks on every server action and read. A role label is not a grant. Payroll preview is owner/finance only; privacy requests, consent administration and privileged administration are owner-only in this design. Global own-profile and My self-service stay own-account/own-record scoped.

## Requirements preserved during implementation

| Control | Required behavior |
|---|---|
| Existing decisions | Preserve recorded owner decisions and approved scope. Do not ask again merely because a screen is redesigned. |
| Approvals | Preserve maker-checker, thresholds, evidence, delegation, expiry and audit. Do not let UI input supply its own authority. |
| Stock truth | Use the same movement ledger, locations, batches and ownership model across purchase, receiving, backstore, floor, sales and returns. |
| Financial truth | Preserve source-document links, matched quantities/values, journals and settlement reconciliation. Display zero and unavailable distinctly. |
| Offline work | Preserve stable event IDs, original context and visible queued/failed/conflicting states. A queued action must not appear cloud-confirmed. |
| Delivery | Keep physical delivery outcome, payment outcome, partial quantities, exact failure reasons and run reconciliation separate and linked. |
| Product safety data | Unknown handling classification or temperature limit remains unknown and actionable; never infer it from a product name. |
| Language | Support complete English/Tamil navigation, field labels, errors, date/number presentation and print workflows. Avoid a half-translated interface. |
| Accessibility | Preserve keyboard operation at tills, clear focus, adequate contrast, readable labels and practical handheld target sizes. |
| Role and scope | Preserve tenant, company, branch, department, value, state and own-record restrictions. |
| Maturity and evidence | Distinguish design, implementation, integration tests, browser verification, deployed smoke tests and physical staff/device UAT. |
| Audit and privacy | Preserve immutable changes, retention decisions, legal hold and controlled access to sensitive fields and exports. |
| Optional departments | Keep café, fresh food, concession and future departments configurable; a tenant’s current enabled range does not erase product scope. |

## Implement without repeating completed work

1. Read the current branch, status, owner decisions, requirement evidence and relevant screen before opening a new task.
2. Use `existingNavigationMapping` and `retiredNavigationMapping` to locate the current implementation. Keep observed routes as stable entry points unless a deliberate migration is required.
3. Implement navigation and visual layout as thin views over existing contracts. Do not add a second stock ledger, delivery lifecycle, customer master, approval engine or accounting record.
4. Prefer a tab or record drawer when a proposed destination belongs to an existing workspace. Never rebuild a completed workflow simply to match the 147-tile inventory.
5. Preserve server-enforced permissions and only expose actions the current account may perform. Test forbidden reads/actions as well as the permitted path when changing authorization.
6. Verify affected connected workflows and required gates. Re-run broader tests only for a concrete dependency risk; avoid rerunning the entire programme after every visual edit.
7. Update the existing evidence record with the changed screen, requirement ID, commit/PR, test evidence, remaining limitations and exact next step.
8. Keep deployment and physical UAT as distinct evidence. A polished prototype, passing isolated test or catalogue `box` flag does not establish live readiness.

## Destination inventory

Each row is a design destination. “Observed path” means a source navigation path or a specifically identified existing-screen entry point. It does not assert that every field or action proposed for that destination exists today.

### Today

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `dashboard` | Store overview | workspace | `/manager/` | owner, manager |
| `my-work` | My work | workspace | Proposed task; implementation mapping required | owner, manager, buyer, warehouse, floor, cashier, finance |
| `approval-inbox` | Approval inbox | workspace | `/manager/` | owner, manager, buyer, warehouse, finance |
| `exceptions` | Exceptions | workspace | `/manager/` | owner, manager, buyer, warehouse, floor, finance |
| `branch-comparison` | Branch comparison | report | Proposed task; implementation mapping required | owner, finance |
| `daily-briefing` | Daily briefing | report | Proposed task; implementation mapping required | owner, manager, finance |

### Products & pricing

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `product-catalogue` | Product catalogue | register | `/products` | owner, manager, buyer, warehouse |
| `categories` | Categories & brands | settings | Proposed task; implementation mapping required | owner, buyer |
| `units-barcodes` | Units & barcodes | settings | Proposed task; implementation mapping required | owner, buyer |
| `handling-attributes` | Product handling | register | Proposed task; implementation mapping required | owner, manager, buyer, warehouse |
| `category-rules` | Category rules | settings | `/category-policy` | owner, buyer |
| `price-lists` | Price lists | register | `/pricing` | owner, manager, buyer |
| `promotions` | Promotions & coupons | workspace | `/promotions` | owner, manager, buyer |
| `promotion-simulator` | Offer simulator | workspace | Proposed task; implementation mapping required | owner, manager, buyer |
| `markdowns` | Markdowns & clearance | workspace | Proposed task; implementation mapping required | owner, manager, buyer |
| `publish-review` | Products to publish | workspace | `/product-publish-review` | owner, buyer |
| `data-quality` | Data quality | workspace | `/data-quality` | owner, manager, buyer |

### Purchase

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `purchase-orders` | Purchase orders | register | `/buying/` | owner, manager, buyer |
| `purchase-requests` | Purchase requests | workspace | Proposed task; implementation mapping required | owner, manager, buyer, warehouse |
| `quotation-comparison` | Enquiries & quotations | workspace | Proposed task; implementation mapping required | owner, buyer |
| `supplier-register` | Suppliers | register | `/suppliers` | owner, buyer, finance |
| `supplier-contracts` | Contracts & schemes | register | Proposed task; implementation mapping required | owner, buyer, finance |
| `purchase-budget` | Buying budget | report | Proposed task; implementation mapping required | owner, buyer, finance |
| `supplier-invoices` | Supplier invoices | workspace | `/buying/` | owner, buyer, finance |
| `supplier-claims` | Supplier returns & claims | register | Proposed task; implementation mapping required | owner, buyer, warehouse, finance |
| `supplier-portal` | Supplier portal desk | workspace | Proposed task; implementation mapping required | owner, buyer |

### Receiving & QC

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `expected-deliveries` | Expected deliveries | workspace | Proposed task; implementation mapping required | owner, manager, buyer, warehouse |
| `goods-receipts` | Goods receipts | register | `/goods-receipt` | owner, manager, buyer, warehouse |
| `quality-checks` | Quality checks | workspace | Proposed task; implementation mapping required | owner, manager, warehouse |
| `receipt-discrepancies` | Receipt differences | workspace | Proposed task; implementation mapping required | owner, manager, buyer, warehouse |
| `quarantine` | Quarantine & release | workspace | Proposed task; implementation mapping required | owner, manager, warehouse |
| `three-way-match` | PO · receipt · invoice match | workspace | `/buying/` | owner, buyer, finance |
| `putaway-handoff` | Put-away handoff | workspace | Proposed task; implementation mapping required | owner, warehouse |

### Inventory & backstore

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `stock-on-hand` | Stock on hand | register | `/stock-health` | owner, manager, buyer, warehouse, finance |
| `stock-ledger` | Stock movement ledger | register | Proposed task; implementation mapping required | owner, manager, warehouse, finance |
| `bins-putaway` | Bins & put-away | workspace | `/warehouse-supervisor/` | owner, manager, warehouse |
| `stock-transfers` | Stock transfers | register | `/warehouse-supervisor/` | owner, manager, warehouse |
| `reservations` | Reservations | register | Proposed task; implementation mapping required | owner, manager, warehouse |
| `reorder-planning` | Reorder planning | workspace | `/warehouse-supervisor/` | owner, manager, buyer, warehouse |
| `stock-counts` | Stock counts | workspace | `/counts` | owner, manager, warehouse |
| `adjustments` | Stock adjustments | register | Proposed task; implementation mapping required | owner, manager, warehouse, finance |
| `batch-traceability` | Batch traceability | report | Proposed task; implementation mapping required | owner, manager, warehouse |
| `expiry-recalls` | Expiry & recalls | workspace | `/expiry/` | owner, manager, warehouse |
| `waste-writeoffs` | Waste & write-offs | workspace | `/waste`, `/write-off-capture` | owner, manager, warehouse |
| `unsellable-products` | Products nobody can sell | workspace | `/unsellable` | owner, manager, buyer, warehouse |
| `stock-ownership` | Ownership & consignment | register | Proposed task; implementation mapping required | owner, manager, buyer, warehouse, finance |

### Shop floor

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `floor-indents` | Floor indents | workspace | `/indents` | owner, manager, warehouse, floor |
| `backstore-issue` | Backstore issue | workspace | Proposed task; implementation mapping required | owner, manager, warehouse |
| `floor-receiving` | Floor receiving | workspace | Proposed task; implementation mapping required | owner, manager, floor |
| `refill-tasks` | Shelf refill tasks | workspace | `/merchandising/` | owner, manager, warehouse, floor |
| `shelf-counts` | Shelf counts | workspace | `/merchandising/` | owner, manager, floor |
| `space-planograms` | Shelves & planograms | workspace | `/merchandising/` | owner, manager, floor |
| `assortment-range` | Range & assortment | workspace | `/merchandising/` | owner, manager, buyer |
| `price-labels` | Shelf labels & price checks | workspace | Proposed task; implementation mapping required | owner, manager, floor |
| `display-contracts` | Display-space contracts | register | Proposed task; implementation mapping required | owner, manager, buyer |

### Sales & service

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `point-of-sale` | Point of sale | workspace | Proposed task; implementation mapping required | owner, manager, cashier |
| `sales-register` | Sales register | register | Proposed task; implementation mapping required | owner, manager, cashier, finance |
| `held-bills` | Held bills & quotations | workspace | Proposed task; implementation mapping required | owner, manager, cashier |
| `returns-exchanges` | Returns & exchanges | workspace | Proposed task; implementation mapping required | owner, manager, cashier |
| `service-desk` | Service desk | workspace | `/service/` | owner, manager, cashier |
| `refund-exceptions` | Refund exceptions | workspace | `/return-governance` | owner, manager, finance |
| `till-sessions` | Till sessions | register | Proposed task; implementation mapping required | owner, manager, cashier |
| `cash-movements` | Float, pickups & safe drops | workspace | Proposed task; implementation mapping required | owner, manager, cashier, finance |
| `shift-close` | Shift close | workspace | Proposed task; implementation mapping required | owner, manager, cashier, finance |
| `concession-counters` | Concession counters | workspace | Proposed task; implementation mapping required | owner, manager, cashier |

### Orders & delivery

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `all-orders` | All orders | register | Proposed task; implementation mapping required | owner, manager, warehouse |
| `serviceability-slots` | Service areas & slots | settings | Proposed task; implementation mapping required | owner, manager |
| `picking-waves` | Picking waves | workspace | Proposed task; implementation mapping required | owner, manager, warehouse, floor |
| `packing-manifests` | Packing & manifests | workspace | Proposed task; implementation mapping required | owner, manager, warehouse, floor |
| `route-assignment` | Routes & assignments | workspace | Proposed task; implementation mapping required | owner, manager |
| `driver-stops` | Driver stops | workspace | Proposed task; implementation mapping required | owner, manager, floor |
| `delivery-reconciliation` | Run reconciliation | workspace | Proposed task; implementation mapping required | owner, manager, finance |
| `substitutions-exceptions` | Substitutions & exceptions | workspace | `/substitution-exceptions` | owner, manager, warehouse |
| `pickup-desk` | Customer pickup | workspace | Proposed task; implementation mapping required | owner, manager, floor, cashier |
| `storefront-control` | Online storefront | workspace | Proposed task; implementation mapping required | owner, manager, buyer |
| `b2b-orders` | B2B & recurring orders | workspace | Proposed task; implementation mapping required | owner, manager, finance |

### Cash & finance

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `cash-office` | Cash office | workspace | Proposed task; implementation mapping required | owner, manager, finance |
| `over-short-approval` | Over / short sign-off | workspace | `/cash-office` | owner, manager, finance |
| `day-close` | Day close & reopen | workspace | `/day-reopen`, `/manager/` | owner, manager, finance |
| `reconciliation` | Bank & payment reconciliation | workspace | `/reconciliation` | owner, finance |
| `day-book` | Day book | workspace | `/day-book` | owner, finance |
| `supplier-payables` | Supplier payables | register | Proposed task; implementation mapping required | owner, finance |
| `customer-receivables` | Customer receivables | register | Proposed task; implementation mapping required | owner, finance |
| `journals-ledger` | Journals & ledger mapping | workspace | `/finance` | owner, finance |
| `gst-reconciliation` | GST document reconciliation | workspace | `/gst-reconciliation` | owner, finance |
| `gst-returns` | GST returns | workspace | `/gst-returns` | owner, finance |
| `tally-bridge` | Tally bridge | workspace | Proposed task; implementation mapping required | owner, finance |
| `period-close` | Period close | workspace | Proposed task; implementation mapping required | owner, finance |
| `concession-settlement` | Concession settlement | workspace | Proposed task; implementation mapping required | owner, finance |
| `credit-notes` | Credit & debit notes | register | Proposed task; implementation mapping required | owner, finance |

### Customers & loyalty

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `customer-directory` | Customer directory | register | Proposed task; implementation mapping required | owner, manager, cashier |
| `loyalty-memberships` | Loyalty & membership | workspace | Proposed task; implementation mapping required | owner, manager, cashier |
| `store-credit-vouchers` | Store credit & vouchers | register | `/stored-value/` | owner, manager, cashier, finance |
| `segments` | Customer segments | workspace | Proposed task; implementation mapping required | owner, manager |
| `campaigns` | Campaigns & offers | workspace | Proposed task; implementation mapping required | owner, manager |
| `consent-preferences` | Consent & preferences | workspace | Proposed task; implementation mapping required | owner |
| `privacy-requests` | Privacy requests | workspace | Proposed task; implementation mapping required | owner |
| `feedback-cases` | Feedback & service history | workspace | `/service/` | owner, manager, cashier |
| `business-accounts` | Business accounts | register | Proposed task; implementation mapping required | owner, manager, finance |

### Fresh food & café

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `production-plan` | Production plan | workspace | Proposed task; implementation mapping required | owner, manager, warehouse |
| `recipes-bom` | Recipes & ingredients | settings | Proposed task; implementation mapping required | owner, manager |
| `material-issue` | Ingredient issue | workspace | Proposed task; implementation mapping required | owner, manager, warehouse |
| `production-batches` | Production batches | workspace | `/production/` | owner, manager, warehouse |
| `repack-labels` | Repacking & labels | workspace | Proposed task; implementation mapping required | owner, manager, warehouse |
| `quality-release` | Finished-goods release | workspace | `/production/` | owner, manager |
| `cafe-service` | Café service | workspace | Proposed task; implementation mapping required | owner, manager, floor, cashier |

### People & tasks

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `staff-directory` | Staff directory | register | Proposed task; implementation mapping required | owner, manager |
| `roster-attendance` | Rosters & attendance | workspace | `/rostering/` | owner, manager |
| `daily-checklists` | Opening & closing checklists | workspace | `/checklist/` | owner, manager, buyer, warehouse, floor, cashier, finance |
| `staff-tasks` | Staff tasks | workspace | `/workforce` | owner, manager, buyer, warehouse, floor, cashier, finance |
| `training-sop` | Training & SOP centre | workspace | Proposed task; implementation mapping required | owner, manager, buyer, warehouse, floor, cashier, finance |
| `payroll` | Payroll workspace | workspace | `/payroll` | owner, finance |
| `my-self-service` | My self-service | workspace | `/my-payslip`, `/ess` | owner, manager, buyer, warehouse, floor, cashier, finance |
| `handover-log` | Shift handover | register | Proposed task; implementation mapping required | owner, manager, buyer, warehouse, floor, cashier, finance |

### Store operations

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `operations-inbox` | Operations inbox | workspace | `/operations` | owner, manager |
| `loss-prevention` | Loss prevention | workspace | `/loss-prevention` | owner |
| `assets-maintenance` | Assets & maintenance | register | `/facilities/` | owner, manager |
| `cold-chain` | Cold-chain monitoring | workspace | Proposed task; implementation mapping required | owner, manager, warehouse, floor |
| `safety-compliance` | Safety & compliance | register | Proposed task; implementation mapping required | owner, manager |
| `concessions-contracts` | Concessions & shop-in-shop | register | Proposed task; implementation mapping required | owner, manager, finance |
| `incident-register` | Incidents & lost property | register | Proposed task; implementation mapping required | owner, manager |
| `waste-sustainability` | Waste & sustainability | report | Proposed task; implementation mapping required | owner, manager, warehouse |
| `backup-recovery` | Backup & recovery | workspace | Proposed task; implementation mapping required | owner |
| `risk-register` | Risks & corrective actions | register | `/risk-acceptance` | owner |

### Reports

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `report-centre` | Report centre | workspace | `/reporting/` | owner, manager, buyer, warehouse, finance |
| `sales-performance` | Sales & margin | report | Proposed task; implementation mapping required | owner, manager, finance |
| `purchase-performance` | Purchase & suppliers | report | Proposed task; implementation mapping required | owner, manager, buyer, finance |
| `stock-valuation` | Stock & valuation | report | Proposed task; implementation mapping required | owner, manager, warehouse, finance |
| `shrinkage-expiry` | Shrinkage, expiry & waste | report | Proposed task; implementation mapping required | owner, manager, warehouse, finance |
| `cash-settlements` | Cash & settlement reports | report | Proposed task; implementation mapping required | owner, finance |
| `customer-insights` | Customer & loyalty reports | report | Proposed task; implementation mapping required | owner, manager |
| `fulfilment-performance` | Order & delivery reports | report | Proposed task; implementation mapping required | owner, manager, warehouse, finance |
| `finance-profitability` | Finance & profitability | report | Proposed task; implementation mapping required | owner, finance |
| `scheduled-reports` | Scheduled reports | settings | Proposed task; implementation mapping required | owner, manager, finance |

### Administration

| Destination ID | Tile / page title | Type | Observed path(s) | Preview roles |
|---|---|---|---|---|
| `organization-setup` | Company & store setup | settings | `/admin/setup` | owner |
| `users-roles` | Users & permissions | settings | `/admin/?tab=people` | owner |
| `approval-rules` | Approval rules | settings | Proposed task; implementation mapping required | owner |
| `devices-sync` | Tills, devices & sync | workspace | `/fleet/` | owner |
| `integrations` | Connections & APIs | workspace | `/integration-health/` | owner |
| `support-access` | Outside support access | workspace | `/admin/?tab=support` | owner |
| `ai-governance` | AI controls & proposals | workspace | `/ai/` | owner |
| `migration` | Migration & parallel run | workspace | `/migration/` | owner |
| `import-export` | Import & export | workspace | `/data-io` | owner |
| `documents-notifications` | Documents & notifications | workspace | `/document-templates` | owner |
| `audit-retention` | Audit & retention | workspace | `/admin/?tab=records` | owner |
| `configuration` | Settings & feature controls | settings | `/admin/settings` | owner |
| `tenants-entitlements` | Tenants & entitlements | settings | Proposed task; implementation mapping required | owner |

## Separate experiences

Customer shopping web/mobile, supplier portal and B2B customer portal are separate experiences. Their management and access desks are present in this ERP architecture. The 147 count does not claim to enumerate every page in those external applications.

Use the prototype’s synthetic data for review. Backend wiring, production data, live payment/tax/messaging services and deployment are outside this design deliverable unless separately authorized.
