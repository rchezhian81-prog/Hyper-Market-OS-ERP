# wired_via — which running service executes which tested engine

_The human-readable companion to `tests/guardrails/services-run-on-their-tested-engine.test.ts`,
which enforces this as a machine-checked fact. This closes **GAP-ARCH-01 / RTM-01**: the deep audit
found that a green "built" traceability row can certify a tested `packages/*` engine that **no
running path executes** — roughly half the packages were imported only by their own tests. The
guardrail proves each domain service's running code imports at least one tested engine; this table
says which._

## Status

| Domain service | Runs on tested engine(s) | Wired? |
|---|---|---|
| `services/catalogue` | `packages/catalogue` | ✅ wired |
| `services/customer` | `packages/loyalty` | ✅ wired |
| `services/finance` | `packages/b2b`, `packages/concession`, `packages/settlement`, `packages/reconciliation`, `packages/waste`, `packages/numbering`, `packages/approvals`, `packages/contracts` | ✅ wired |
| `services/identity` | `packages/rbac`, `packages/numbering` | ✅ wired |
| `services/inventory` | `packages/stock`, `packages/ledger`, `packages/counts`, `packages/replenishment`, `packages/warehouse`, `packages/production`, `packages/waste`, `packages/adjustment` | ✅ wired |
| `services/migration` | `packages/migration` | ✅ wired |
| `services/orders` | `packages/orders` | ✅ wired |
| `services/platform` | `packages/platform`, `packages/platform-admin`, `packages/integration`, `packages/audit`, `packages/tenant` | ✅ wired |
| `services/pos` | `packages/till`, `packages/cash`, `packages/returns`, `packages/loss-prevention`, `packages/bank-controls`, `packages/catalogue` | ✅ wired |
| `services/pricing` | `packages/price-list`, `packages/promotions`, `packages/price-guard`, `packages/approvals`, `packages/contracts` | ✅ wired |
| `services/purchase` | `packages/purchasing`, `packages/supplier-portal` | ✅ wired |
| **`services/reporting`** | **`packages/reporting`** (`reportCatalogue`, `whatWouldUnlockMost`) | ✅ **wired — CORE-01 inc1** |
| **`services/fulfilment`** | **`packages/fulfilment`** (`transitionDelivery`, `isTerminalDelivery`) | ✅ **wired — CORE-01 inc2** |
| **`services/ai`** | **`packages/ai`** (`AGENTS`, `FORBIDDEN_TOOLS`, `AgentId`) | ✅ **wired — CORE-01 inc3** |

`services/api` (the composition root that assembles every route) and `services/kernel` (the request
framework) are not domain services and are excluded from the check.

## The ratchet

`PENDING` in the guardrail may only shrink. Wiring a pending service to its engine makes the test
fail until the service is removed from `PENDING`; a wired service that later drops its engine import
fails the same way. **`PENDING` is now empty — every domain service provably runs on its tested
engine.** A new service that re-implements an engine instead of importing it fails the check rather
than being quietly added back, so no new GAP-ARCH-01 drift can be introduced without CI noticing.

## What "wired" does and does not certify

Wired means the running service *imports and calls* the tested engine, so the engine executes on a
real path. It does not by itself certify the whole feature is UAT- or production-verified — that
remains the assembly-ladder's job in `docs/traceability.md`. `wired_via` removes one specific lie:
"this engine is tested" no longer implies "this engine runs" unless the import exists.
