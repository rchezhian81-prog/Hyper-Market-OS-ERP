# Icons: where they come from (OB-201 "Icons A")

The one icon set, `packages/ui/web/sre-icons.js`, is a small part of **Lucide** (https://lucide.dev).
Lucide is released under the ISC licence. Some of its shapes come from **Feather**, which is released under the MIT licence.
Both licence texts are in `ICONS-LICENSE.txt` in this folder. The notices are also at the top of `sre-icons.js`, so every
copy that `scripts/sync-ui-foundation.mjs` writes into `apps/<app>/web/` carries them too.

- **What was taken:** only the icons a screen uses (102 of them), with their shapes unchanged. Each one is copied from the
  owner's approved reference pack (`docs/design/reference/professional-pack-2026-10-04/source/icons.js`), which is itself
  Lucide. The one exception is `indian-rupee`. It is Lucide's own icon (same licence) and is not in the pack.
- **What was changed:** the stroke is drawn at 1.5px instead of Lucide's 2px. This is the owner's "thin line" choice
  (OB-201). No shape was redrawn.
- **How it ships:** inline SVG built by the script, precached by every screen's service worker. There is no CDN, no
  font and no download, so an icon draws with the store's internet off.
- **Proof:** `tests/guardrails/every-icon-comes-from-the-one-set.test.ts` checks every icon against the pack. It also
  checks that this licence file and this note are present, and that no screen uses an icon outside the set or without
  its word.
