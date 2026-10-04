# Professional revision of the full ERP model

This revision uses the uploaded `SRE-Hypermarket-ERP-Design(1).html` as its base.
It keeps the complete model instead of substituting the smaller professional
demo. It does not start another requirements audit or implementation baseline.

## Visual direction

| Element | Treatment |
|---|---|
| Navigation | Dark forest, clear active state, legible secondary labels |
| Workspace | Cool neutral canvas and white surfaces |
| Primary action | Emerald; neutral secondary controls |
| Tiles | Consistent fine top stripe and compact corners |
| Panels and registers | Thin borders, aligned rows and restrained spacing |
| Type | System sans-serif with clearer working labels and tabular figures |
| Status | Explicit text labels; amber/red reserved for exceptions |

| Token | Hex |
|---|---|
| Navigation forest | `#192F27` |
| Primary emerald | `#16614D` |
| Working surface | `#FFFFFF` |
| Canvas | `#F3F5F4` |
| Primary ink | `#25362E` |
| Muted text | `#617068` |
| Border | `#DCE3DE` |
| Pale selection | `#EBF3EE` |

The exact implementation lives in `source/professional.css`, appended after
the unchanged `source/base.css`. Small headline edits are listed exhaustively
in `source/presentation-changes.json`. Icons and interaction behavior are
retained. Architecture metadata now explicitly identifies the source snapshots
as retained references; the modules, destinations and route mappings are intact.

## Preservation and verification

- 15 workspaces and 147 page destinations retained.
- All original architecture data outside explanatory metadata preserved.
- Original interaction code preserved except the recorded presentation text.
- The existing isolated verification script passes 13 check groups, rendering
  147 owner pages and 430 permitted routes across seven role previews.
- 2,968 emitted page links resolve in those checks.

See `verification.json` and `preservation-check.json` for the concrete scope,
source hashes and results. These are prototype logic and source checks, not
browser, backend or production acceptance tests. Browser visual verification,
responsive rendering, keyboard/focus behavior and accessibility review remain
pending. Displayed data and transactions are illustrative.

## Continue without repeating work

Use `DESIGN-HANDOVER.md`, the retained route mappings and the existing repository
completion ledger together. A design destination can map to an existing page,
tab or drawer; it is not automatically a new feature to build. Apply this visual
system to existing verified screens and services first. This package changes
no repository files, deployed application, store data or provider connections.

To rebuild the standalone file, run `python3 source/build.py`. To rerun the
existing isolated checks, run `node source/verify.cjs`. Neither command installs
dependencies; the finished HTML runs offline.
