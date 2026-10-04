# The owner's professional reference (4 October 2026) — and the SRE gap-fix layer

**What this folder is.** The design reference the owner sent on 4 October 2026 (`SRE-Hypermarket-ERP-Professional-Pack.zip`),
kept byte-for-byte, plus three files of ours that fix the gaps between that reference and this product's design system
without changing a module, page, field, rule or workflow of it. Decision **OB-13** in `docs/registers/decisions.md` records
what the owner chose from it and what the product does and does not take. Section 3.2 of `../../design-system.md` carries
the tokens and the rules.

**Provenance, verified.** The pack's `preservation-check.json` records the SHA-256 of the owner's built file
(`a6e11174…237cdb0b`). Running the pack's own `python3 source/build.py` from this folder reproduces that exact hash, so the
sources here are the sources that built what the owner looked at. The pack's `design-reference/` copies of
`apps/web-erp/src/navigation.ts` and `docs/design/design-system.md` are not duplicated here: they are identical to the
repository files except for a trailing newline, which is also how we know the pack's 53-item mapping was made from the
current catalogue.

## Files

| File | Whose | What |
|---|---|---|
| `START-HERE.txt`, `REVISION-NOTES.md`, `DESIGN-HANDOVER.md` | owner's pack | How to open it; what the "professional" revision changed; the full hierarchy (15 modules, 147 destinations), role previews, route mappings and the preservation rules it asks implementers to keep. |
| `architecture.json` | owner's pack | Machine-readable inventory of the 15 modules and 147 destinations, the 53 existing navigation items mapped, 8 retired aliases, and the cross-cutting rules. |
| `preservation-check.json`, `verification.json` | owner's pack | Source hashes; the pack's 13 isolated logic checks (DOM stub, no browser), which pass. |
| `source/base.css`, `source/professional.css`, `source/icons.js`, `source/app.js`, `source/index.template.html`, `source/presentation-changes.json`, `source/build.py`, `source/verify.cjs` | owner's pack | The editable sources and the pack's own build and check scripts. Untouched. |
| `source/sre-gap-fixes.css` | ours | Type, targets, contrast and the fixtures' styling (below). Applied after the pack's two stylesheets. |
| `source/sre-gap-fixes.js` | ours | The English / தமிழ் toggle and the freshness line + honest "Not known" on figures. Runs after `app.js`, which it leaves untouched. |
| `source/build-v2.py` | ours | Builds `SRE-Hypermarket-ERP-Professional-v2.html` = the pack's composition + the two files above. The pack's `build.py` still builds the owner's original. |

Build either file from this folder (Python 3 standard library only, no network):

```
python3 source/build.py       # the owner's original, hash-identical
python3 source/build-v2.py    # the same page with the SRE fix layer
node source/verify.cjs        # the pack's own logic checks (unchanged by the layer)
```

Both outputs are single HTML files with no external resource, so they open offline from a USB stick or a phone.

## What the fix layer changes, and the numbers

Measured in headless Chromium at 1366×820 (home page) and 400×820 (phone), by script, counting every visible element
whose own text is under 14px and every button, select, input or link whose box is under 44px in either direction:

| Measure | Owner's file | With the layer |
|---|---:|---:|
| Text elements under 14px, home page | 129 of 147 | 14 of 152 (logo mark, avatar initials, the ⌘K hint) |
| Smallest text, home page | 10px (9px on the phone) | 11px (logo mark only); 14px for anything a person reads |
| Controls under 44px, home page | 3 | 0 |
| Status strip under the header | 10px, grey at 3.47:1 on the canvas | 14px, ink at 6.9:1 |
| Figure labels (KPI titles) | 12px | 14px |
| Till: primary action / product name / total | 50px / 16px / 25px | 56px / 17px / 34px |
| Languages | English only | English / தமிழ் toggle in the header (chrome, menu, roles, strip, home page; page titles stay English in the preview and the strip says so) |
| Freshness on figures | none (one global "Last synced" line) | every figure says where it came from and when; offline, every figure is "last known 10:32 am" and a figure that needs the cloud says **Not known** with the reason |

Everything else — the forest rail, white surfaces, emerald primary, tile stripes, panels, tables, the 15 modules, the 147
destinations, the role previews, the sample forms, the till layout, the pack's interactions — is exactly the owner's.

Rules served, from `docs/design/design-system.md`: §1 rule 4 (connection state and freshness on every screen), rule 6
(English and Tamil throughout), rule 7 (large targets, high contrast, readable at arm's length by staff aged 50 under
fluorescent light); §2 (unknown is a state, never a zero); §3 (base ≥ 16px, targets ≥ 44px, the total the largest text on a
tender screen); P-08 (no silent staleness).

## What the product takes from it, and what it does not (OB-13)

Takes: the visual language (tokens in design-system §3.2), the workspace structure (rail of modules, header with search /
language / notifications / person, status strip, module landing = purpose line + one primary action + summary panels +
subpage tiles, work page = register + record drawer), the purchase-to-shelf flow panel, the blind-count note on the cash
office, the status vocabulary (words, amber and red only for exceptions).

Does not take: the 147-destination owner preview as a menu (the product's menu stays derived from the person's real
permissions and the screens the store computer serves — never a link that 404s, `apps/web-erp/src/navigation.ts`); the role
switcher (a preview device; permissions decide); Arial at 14px with 9–11px labels; any module, page, field or workflow that
has no requirement ID in the roadmap (a tile in a mock is not a requirement, and the pack says the same in its own words).

The pack is a design reference and says so on every page: no backend, illustrative data, browser rendering not verified by
its author. Browser rendering of both files was done here by script (screenshots in the session record, not committed);
nobody from the store has used either file yet — SP-10 staff/device UAT stays pending.
