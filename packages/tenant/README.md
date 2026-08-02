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

- **`src/settings.ts`** — `TenantSettings` over the versioned config engine: a `SETTINGS`
  catalogue (trading-day cut-off, base currency, languages, default GST, delivery radius, …)
  each with a stable key and a **sensible default**; `get` returns the tenant's chosen value
  or the default, `set` records an audited, reversible version. Per-tenant and isolated.
  Tested in `tests/unit/tenant-settings.test.ts`.

> Core features are always on; only *optional* modules are entitlement-gated. Per-tenant
> *settings* build on `packages/config` (keyed per tenant). Part of the repository layout in
> `CLAUDE.md`.
