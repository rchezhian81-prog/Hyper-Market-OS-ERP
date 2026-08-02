# SRE Retail OS

A hybrid **offline-first + cloud** retail operating system for **SRE Hyper
Market**, a 14,000 sq ft hypermarket in Tamil Nadu, India. It replaces a
manpower-heavy standalone ERP and POS.

This repository is built by the owner working directly with Claude Code, using
the **Claude Code Build Pack (Annexure H)** and audited against the **Roadmap
v2.0 Audit (Annexure G)**. The owner is not a programmer; he is the decision
maker. The project rules that make that possible live in
[`CLAUDE.md`](./CLAUDE.md) and are read at the start of every session.

## Where the project is right now

**Setup (Part 1 of the Build Pack) — no application code yet, by design.**
The current state, what is blocked, and what needs an owner decision are always
in [`docs/STATUS.md`](./docs/STATUS.md). Read that first.

## The one rule that matters most

> **Never accept work you cannot see working.** Not "the code looks right". Not
> "the tests pass" alone. You scan a real barcode, you unplug the router, you
> check the number against a real invoice.

## Repository layout

| Folder | What it holds |
| --- | --- |
| `apps/` | pos, web-erp, owner-app, customer-app, picker-app, delivery-app |
| `services/` | one folder per cloud domain service |
| `packages/` | shared contracts, types, ui, utils |
| `edge/` | store-edge services and the sync agent (keeps the shop trading offline) |
| `db/` | migrations, seed data, data dictionary |
| `infra/` | infrastructure as code, environments, CI/CD |
| `tests/` | unit, integration, e2e, contract, performance, migration, security, guardrails |
| `docs/` | roadmap, requirements, adr, api, runbooks, sop, registers, traceability |

## The safety net

Everything below runs automatically in CI on every pull request, and `main` is
protected so nothing merges without it passing (see
[`docs/runbooks/branch-protection.md`](./docs/runbooks/branch-protection.md)).

```bash
pnpm install        # once, to fetch the tools (also installs the pre-commit hook)
pnpm test           # run every test; look for "passed"
pnpm run check      # typecheck + lint + secret-scan + tests, in one go
```

- **Guardrails** (`tests/guardrails/`) turn the six hard rules from `CLAUDE.md`
  into automated tripwires: no card data, no committed secrets, append-only
  ledgers, POS never depends on the network, AI agents never write to the
  database, no shared logins.
- **Secret scanning** blocks a commit that contains a secret (pre-commit hook)
  and re-checks the whole repository in CI.
- New to this? Read
  [`docs/runbooks/how-to-check-tests.md`](./docs/runbooks/how-to-check-tests.md) —
  written for a non-programmer.

## The controlling document

`docs/roadmap/roadmap-v2.0.docx` is the single source of truth. It must be placed
in the repository before Setup 2 and the roadmap-sourced work can proceed — see
[`docs/roadmap/README.md`](./docs/roadmap/README.md).
