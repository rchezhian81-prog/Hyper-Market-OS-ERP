# `packages/tenant/`

Tenants and per-tenant feature entitlements — **ADR-0003** (commercial, multi-tenant
product) and **M33 / D12 / M36** (tenant/entitlements/white-label). SRE Retail OS is sold to
many retailers; each **tenant** (a retail business) **chooses** which optional modules and
departments it runs. This is how "make everything choose-able" is enforced for modules.

- **`src/tenant.ts`** — the `Tenant` shape, the `OPTIONAL_FEATURES` catalogue (bakery,
  pharmacy, concession, delivery, customer app, loyalty, B2B, …), and `Entitlements`:
  `enable` / `revoke` / `isEnabled` / `enabled`. **Optional features are default-OFF** — a
  tenant gets only what it enables (the "conditional departments", AVR-12, become per-tenant
  toggles), and tenants are isolated from one another. Tested in `tests/unit/tenant.test.ts`.

> Core features are always on; only *optional* modules are entitlement-gated. Per-tenant
> *settings* (trading day, tax, currencies, …) use `packages/config` keyed by tenant. Part
> of the repository layout in `CLAUDE.md`.
