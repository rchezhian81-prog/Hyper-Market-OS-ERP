# `packages/ui/`

Shared user-interface primitives so every screen looks and behaves consistently (owner directive item 3;
roadmap §19 usability-by-role, P-07). Framework-free — the web-erp shells are vanilla HTML/JS with the logic
in bundled `apps/web-erp/src/*-session.ts` models — so this package holds **pure presentation primitives**
the session models compose, not a component framework. Everything here is built on the tested
`packages/a11y` layer, so a state is never a bare colour: it always carries a word, an icon and a
screen-reader announcement.

## `src/copy.ts` — bilingual text

The store is in Tamil Nadu; Tamil is a first language for much of its staff, not a translation afterthought
(OA-9/OA-10). Until now each screen carried its own inline `WORDS = { en, ta }` and its own `t()`; this is
the shared primitive:

- `BilingualCopy<K>` — a screen's copy keyed by a string-literal union `K`, with **both** `en` and `ta`
  required, so a screen cannot ship English-only by construction.
- `translator(copy, lang)` → `t(key)` — resolves in `lang`, falls back to English, and only if even English
  is missing renders the key itself (a gap shows visibly, never as a blank).
- `bilingualGaps(copy, required?)` — the reusable **"speaks both languages"** check: the keys missing (absent
  or blank) in each language. Pass a screen's authoritative vocabulary (its session model's exported KINDS)
  to catch a kind added to the model but not the copy; omit it to check the two maps for symmetry. This is
  the tripwire each screen's guardrail calls instead of a bespoke regex over its view source.
- `isBilingualComplete(copy, required?)` — the boolean form.

> The Tamil wording itself is placeholder pending a native-speaker review before go-live (OWNER-ACTION
> OA-10) — these checks enforce **presence and completeness**, not translation quality.

## `src/states.ts` — the screen states

`ScreenState` is the closed set every data surface must handle: `loading` · `ready` · `empty` · `error` ·
`pending` · `locked` · `recovery`. A closed union makes a `switch` exhaustive (the compiler flags a forgotten
state). `pending` (awaiting a maker-checker approval or a portal acknowledgement), `loading` (fetching what we
already hold) and `recovery` (reconciling something that went unknown) are deliberately distinct; `locked` (a
closed period, a filed return) is terminal and **not** an error. `presentScreenState({ state, label,
announcement? })` maps a state to a tone + icon and the caller's own translated words, forcing attention on
`error`/`pending`/`recovery`.

## `src/queue-status.ts` — reconciliation queue categories

`QueueCategory` is the operator vocabulary the e-invoice and e-way-bill registers already emit
(`eInvoiceRowCategory`/`ewbRowCategory`, item 2): `processing` · `registered` · `generated` · `rejected` ·
`unknown` · `error` · `cancelled` · `mismatch`. `presentQueueCategory(...)` maps each to a tone + icon +
attention flag with the caller's translated label; `isQueueException(category)` is the exception set
(`unknown` + `error` + `rejected` + `mismatch`). `mismatch` (the inc4 additive flag) is presented as an
attention state in its own right — never folded into "registered".

Tested in `tests/unit/ui-copy.test.ts`, `tests/unit/ui-states.test.ts`, `tests/unit/ui-queue-status.test.ts`.

## `web/sre-foundation.css` — the one stylesheet every screen imports (Stage G slice 1)

Fifty-six pages each carried their own copy of the palette, the type stack and the fixtures every screen shares —
and the copies had drifted: two dialects of token names (`--ok/--degraded/--error/--idle` on 33 pages,
`--good/--warn/--danger` on 15), four pages with a light palette of their own, `--tap` anywhere from 48 to 64px, and
a `font:` shorthand on every page that reset the family, so a Tamil face could be present on one screen and absent on
the next. This file is the one source they all import now:

- **Tokens** — surfaces (`--bg`, `--panel`, `--panel-2`, `--line`), text (`--ink`, `--muted`, the `--on-*` inks),
  tones with **both dialects resolving to one value** (`--ok`=`--good`=`--accent`, `--degraded`=`--warn`,
  `--error`=`--danger`, `--idle`, `--info`), the one font stack `--font` (system faces incl. Noto Sans Tamil, Nirmala
  UI, Latha — nothing to download on a shop line), and `--tap` (48px; a page may raise it in its own `:root`, and that
  is the ONLY token a page may declare).
- **Three reds, because no one red can do every job**: `--error`/`--danger` #ef4444 is the *signal* (dots, borders,
  icons; ≥ 3:1 non-text) — as words on a panel it is 3.9:1 and under white it is 3.8:1, both short of AA;
  `--danger-text` #fca5a5 is red *words* (7.7:1); `--danger-surface` #b91c1c is a red *button or banner* under white
  (6.5:1). Every text pair is proven in `tests/unit/ui-foundation.test.ts` with `packages/a11y`.
- **Fixtures** every screen carries, styled once: `header`, `.who`, the sync badge (`.sync`, `.dot` + tone
  classes), the language toggle (`.lang`), the strips (`.sample`, `.stale`, `.nobody`); a focus ring on everything;
  `prefers-reduced-motion` and `prefers-contrast` honoured; Tamil line-height under `html[lang="ta"]`.
- **Namespaced components** (`.sre-btn`, `.sre-tile`, `.sre-row`, `.sre-chip`, `.sre-field`, `.sre-input`,
  `.sre-sheet`, `.sre-keypad`, `.sre-banner`) that screens move onto slice by slice (G2–G5). Nothing else targets a
  bare tag, so importing the file cannot rearrange a page that has not opted in.

**Source and copies.** `packages/ui/web/sre-foundation.css` is the source; `apps/<app>/web/sre-foundation.css` are
tracked, byte-identical copies written by `pnpm ui:sync` (`scripts/sync-ui-foundation.mjs`, also run by every
`scripts/build-app.mjs` build) — each screen is served from its own folder (the store box's screen socket, the nginx
shell container, the public proxy) and precaches its own files, so each folder needs the file. Edit the source,
never a copy: `tests/guardrails/every-screen-shares-the-foundation.test.ts` fails the build if a copy drifts, a page
does not link it before its own `<style>`, a service worker does not precache it, a page's `:root` declares anything
but `--tap`, a page names a literal font stack, or red words use the signal red.
