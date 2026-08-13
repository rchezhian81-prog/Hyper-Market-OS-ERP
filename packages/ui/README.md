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
