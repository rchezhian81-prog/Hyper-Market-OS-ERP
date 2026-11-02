# SRE Retail OS — Design system (Stage 3)

- **Roadmap:** §27 (screen inventory), §27.1 (universal UX states), QG-02 (usability gate), NFR-07/08/13, P-07
- **Purpose:** One consistent, role-appropriate interface language so every screen is learnable, fast, and honest about system state. Built **before** any screen is coded (Stage 3). Design for the hardest case: a new cashier, aged 50, at arm's length, under fluorescent light, during a rush, on a low-spec Android.

> No application code yet. This is the specification the prototypes and, later, the
> UI components (`packages/ui`) implement. Human-tested with real staff before build
> (QG-02) — see `usability-test-script.md`.

## 1. Hard rules (QG-02 / §27.1) — non-negotiable
1. **≤ 3 interactions** for any action done more than ten times a day. Every exception is listed explicitly and justified (no blanket "where feasible").
2. **A new cashier with no computer background bills unsupervised after 30 minutes** of training. Design for that person, not a trained user.
3. **One primary action per screen**, visually dominant. Destructive/financial actions show consequence, required authority, and a confirm step.
4. **Every screen shows connection state** — online / degraded / offline / reconnecting — **and the unsent count** and last-sync freshness.
5. **Errors state three things:** what happened, whether data was saved, and the next safe action.
6. **English and Tamil throughout**, switchable per user.
7. **Large touch targets and high contrast**; usable at arm's length under fluorescent light by staff aged 50.
8. **Must work on a low-specification Android phone.**

## 2. Universal states every screen handles (§27.1)
- **Data states:** loading · empty · no-result · validation error · permission denied · dependency unavailable.
- **Connection states:** online · degraded · offline · reconnecting · unsent-count · conflict · last-sync freshness.
- **Record lifecycle:** draft · pending approval · approved · rejected · cancelled · failed · retrying · completed · archived.
- **Responsiveness:** desktop / tablet / mobile; keyboard and touch; English/Tamil; WCAG 2.2 AA target.

## 3. Foundations
- **Colour:** a high-contrast, brand-neutral palette; state colours are consistent everywhere — green = online/success, amber = degraded/pending, red = offline/error/destructive, neutral = idle. Colour is never the *only* signal (icon + text too), for colour-blind and glare conditions.
- **Typography:** large base size (min 16px equivalent on POS; larger on primary numbers); high legibility; Tamil and Latin scripts render cleanly (Unicode, tested fonts).
- **Spacing & targets:** touch targets ≥ 44×44px; generous spacing to prevent mis-taps during a rush.
- **Numbers & money:** money always shows currency and fixed precision (§29.1); quantities show UOM; totals are the largest text on a tender screen.
- **Iconography:** paired with text labels (never icon-only for critical actions). Since OB-201, one thin line set for
  every screen, never icon-only for any action or status (§3.4).

### 3.1 Implemented: the one foundation file (Stage G slice 1)
`packages/ui/web/sre-foundation.css` is the palette, type stack, touch target and fixtures above, as one stylesheet
every screen imports (`<link rel="stylesheet" href="./sre-foundation.css" />` before the page's own `<style>`), with
a tracked byte-identical copy in each `apps/<app>/web/` (`pnpm ui:sync`) because each screen is served and precached
from its own folder. Both token dialects the screens grew up with resolve to one value (`--ok`=`--good`,
`--degraded`=`--warn`, `--error`=`--danger`); red is three tokens because no single red is both readable text on a
dark panel and a surface under white text (`--error` signal · `--danger-text` words · `--danger-surface` button);
amber has a strip pair too (`--warn-surface` / `--on-warn-surface`, a warning that is not an error); a
page's own `:root` may declare **only** `--tap` (≥ 48px); the page's one heading is the header line, `h1.who`; wide
content sits in `.sre-scroll-x` so a page never scrolls sideways. **The ERP's one chrome (Stage G slice 5a):**
`apps/web-erp/web/sre-chrome.js`, loaded after each ERP page's own script, is the sync badge, the served-from-cache
strip and the language toggle for all 46 pages — a page keeps its own words and its own toggle handler, and may put
sharper strip wording on the element (`data-en` / `data-ta`). The till and the handhelds keep their own badges,
because theirs report a device outbox. **The ERP's one menu (Stage G slice 5b):** the store computer works out,
per request, which screens the viewer a page names may open — `navigationFor` over the pack's `roles` /
`roleAssignments`, filtered to the screens the box serves — and injects it as `window.sreNavigation`; the chrome draws
it as a "☰ Screens / திரைகள்" button and a `<nav>` landmark (groups and links in the reader's language, the served
screen `aria-current`, Escape closes). No named viewer or no register → the reason, not a blank; a page opened off the
box → no menu. Every item in `apps/web-erp/src/navigation.ts` is gated on the permission the screen itself or its
route checks, has a Tamil label, and says where it is served (`box` / `unserved` / `unbuilt`); retired items keep their
reason on the record. Every text pair is proven AA in
`tests/unit/ui-foundation.test.ts`; `tests/guardrails/every-screen-shares-the-foundation.test.ts` keeps every page on
the one file. Components (§4) ship namespaced as `.sre-*` and the screens move onto them slice by slice (G2–G5).

### 3.2 The look the owner chose (OB-13, 4 October 2026) — tokens, and the rules it keeps
The owner's reference (`reference/professional-pack-2026-10-04/`, README there) sets the visual language from here on:
a dark-forest navigation rail, white work surfaces on a cool neutral canvas, one emerald primary action, fine edge
stripes on tiles, compact panels, status as words with amber and red kept for exceptions. Contrast is against white
unless said.

| Token (light set) | Value | Use | Contrast |
| --- | --- | --- | --- |
| `--rail` | `#192F27` | navigation rail ground | white on it 14.2:1 |
| `--accent` | `#16614D` | the one primary action, links, the live dot, active rail item | 7.4:1 |
| `--canvas` | `#F3F5F4` | page ground | — |
| `--surface` | `#FFFFFF` | panels, tiles, tables, inputs | — |
| `--ink` | `#25362E` | headings, figures | 12.8:1 |
| `--text` | `#34443B` | body | 10.3:1 |
| `--muted` | `#617068` | secondary words — never under 14px | 5.2:1 (4.8:1 on canvas) |
| `--strip-ink` | `#4F5E56` | the status strip and figure captions | 7.6:1 (6.9:1 on canvas) |
| `--line` | `#DCE3DE` | borders, tile stripes at rest | — |
| `--mint` | `#EBF3EE` | selection, pale badges | accent on it 6.5:1 |
| `--warn` | `#8A5E1B` | pending · degraded · **not known** | 5.7:1 |
| `--error` | `#A03E36` | error · short · destructive | 6.5:1 |
| `--focus` | `#0F4C3A` | 3px focus ring, offset 2px | — |
| shape | radius 6px, no shadow, tile top stripe 3px (OB-201 keeps the radius and adds a soft layered elevation, §3.4) | | |

**Rules the look keeps — the design system's, so not negotiable (QG-02, §27.1, NFR-07/08, P-08):** §1 rules 4, 6 and 7
as written; base 16px with nothing a person must read under 14px (uppercase letter-spaced labels ≥ 12.5px; the logo
mark, avatar initials and a keyboard hint are the only exceptions); controls ≥ 44px on the back-office desktop, 48px for
the primary action, 56px on the till and the handhelds; every word in English and Tamil; status as word + icon, never
colour alone; a freshness line on every figure, and **Not known** in `--warn` with the reason instead of a zero; the
sample-data strip at 14px; the system font stack with the Tamil faces before Arial; one primary action per screen.
The handhelds keep their task-first layouts and take only the palette.

**How it reaches the product (UX-1, through the shared foundation only, no feature changes) — UX-1a IMPLEMENTED (4 Oct 2026):**
`packages/ui/web/sre-foundation.css` carries this light set as the default and the former dark set under
`:root[data-theme="dark"]`; `apps/web-erp/web/sre-chrome.js` draws the real menu as the rail (open at ≥ 1000px, a ☰ drawer
below) and the page's header is the top bar. The owner chose A (light everywhere) in the order 1a → DF-2 → 1b. **UX-1b IMPLEMENTED (4 Oct 2026, after OB-14 "the
look first"):** no shell pins a set any more — the till, the concession tag, the picker, driver and warehouse handhelds,
the owner, customer, B2B and supplier shells take the light default with their layouts and 56/60/64 px targets
unchanged; their own literal colours became tokens; the signal red is never a surface under words; each carries the
shared "new version" strip (`packages/ui/web/sre-update.js`, synced and precached like the foundation; the back office
has the same strip in its chrome). **UX-1c IMPLEMENTED (4 Oct 2026, Wave 1¾ by OB-14):** the page anatomy is drawn
by the chrome on every back-office page from what the page already has — the head (`[data-sre-head]`: the module's
name from the rail above the title, the purpose line under it), the page's own tab buttons as subpage tiles (title,
the subpage's purpose from its lead, a live count of the rows in its list, the accessible name exactly the label),
every table a register (`.sre-register`), and the page's sheet as a record drawer on the right at ≥ 1000px (scoped to
`body.sre-shell`, so the till's sheets keep their layout). Summary panels are the 22 pages' existing summary strips and
the manager's figure tiles; no figure is invented. One primary action at a time is now checked on every rendered page.
Nothing a person must read in the anatomy is under 14px. Extra tokens the light set needed, present
in both sets: `--field`, `--on-idle`, `--on-info`, `--ok-surface/--on-ok-surface`, `--error-surface`,
`--demo-surface/--demo-surface-2/--on-demo`, `--scrim`, `--rail/--rail-2/--on-rail/--on-rail-muted/--rail-accent/--rail-line`.
The three-reds rule holds in both sets (the light signal red `#e04e48` fails as words on purpose). Measured on the reference, as sent vs with the fix layer (headless Chromium, 1366×820 home):
texts under 14px 129 of 147 → 14 of 152; controls under 44px 3 → 0; strip 10px at 3.47:1 → 14px at 6.9:1.

### 3.3 The sign-in (OB-18, 5 October 2026) — the owner's approved design, on the real entry point
The owner's login design (`reference/login-pack-2026-10-05/`, README there) is the sign-in's look from here on — on the
hosted copy's sign-in today (`infra/pilot/demo-login/ui.ts`) and on the Keycloak login of ADR-0019 when it is built. Its
own token set, used only on that page: canvas `#F5F7F2`, surface white, ink `#193B31`, secondary `#586E61`, primary
`#17654F`, deep green `#143F32` (the S+ mark), sage `#EAF0E1`, border `#DCE4D9`, input border `#819483`, field `#FCFDFB`,
amber `#86571B` on `#FBF4E7`, red `#A13932` on `#FCF0EC`; card 451 px, radius 19, a 3 px stripe (68 % forest, 22 % sage,
10 % pale sage); inputs 53 px; buttons ≥ 44 px; breakpoints 1300 / 900 / 720 / 390 (below 720 the decorative panel
goes); the system stack with the Tamil faces. **What this document's rules add to it, and the page keeps:** one h1
(the hero line is a tagline); one primary action; the practice strip at 14 px; nothing a person must read under 14 px and
uppercase labels ≥ 12.5 px (the pack's 11–12 px lifted — the one visible change from what was sent); English and Tamil
on every word, switchable, the choice remembered; the 3 px focus ring; no inline style or script (the policy is
`self` only, the assets served by the page's own service under a content hash); the connection line says only what the
server knows (§1 rule 4 is met honestly: this is the ONLINE sign-in; the store computer's state is shown inside the
workspace after sign-in); errors generic for credentials, named for everything else; no sample state, no preview, no
*Remember me*, no role selector. Verified in headless Chromium at 1280 / 390 / 320, EN and TA, with the §5.1 audit
(`tests/e2e/sign-in-page.e2e.ts`).

### 3.4 The polish (OB-201, 18 October 2026): refined tokens, one icon set, motion
The owner's written decision OB-201: "Start UI/UX now, shared look first. Premium, crisp, polished, smooth." He chose
**Style A**: polish the approved sage look of §3.2 and §3.3, with no new palette. He chose **Icons A**: thin line icons,
one set, built in. This slice changes only the shared foundation every screen inherits. Pages are not redesigned yet.

**Where it lives.** `packages/ui/web/sre-foundation.css` holds the tokens and components. `packages/ui/web/sre-icons.js`
holds the icon set and its helper. Both are copied byte for byte into every `apps/<app>/web/` by
`node scripts/sync-ui-foundation.mjs`, and every service worker precaches both. The back office's chrome
(`apps/web-erp/web/sre-chrome.js`, which has no copies) says which icon fits each workspace, screen and control.

**Refined tokens (light set; the dark set carries the same names).** Every colour in §3.2 keeps its value. These are
added:

| Token | Value | Use |
| --- | --- | --- |
| `--space-1` … `--space-10` | 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 px | the one spacing scale; `--gap` = `--space-3`, `--pad` = `--space-4` |
| `--fs-label` | 12.5px | uppercase, letter-spaced labels only |
| `--fs-sm` · `--fs-base` · `--fs-md` · `--fs-lg` · `--fs-xl` · `--fs-2xl` · `--fs-figure` | 14 · 16 · 17 · 20 · 24 · 30 · 40 px | the type scale; nothing a person must read is under 14px |
| `--leading-tight` · `--tracking-caps` · `--tracking-tight` | 1.25 · .06em · −.01em | headings and figures; uppercase labels |
| `--numbers` | `tabular-nums lining-nums` | money and quantities (`.money .qty .amount .total .n .sre-num`, every register) |
| `--radius-sm` · `--radius` · `--radius-lg` · `--radius-xl` · `--radius-pill` | 4 · 6 · 8 · 12 · 999 px | one radius scale; 6px stays the default |
| `--hairline` | 1px | every border |
| `--shadow-xs` · `--shadow-sm` · `--shadow-md` · `--shadow-lg` | two layers each, forest-tinted, opacity ≤ .16 | a control off its panel · a resting card · a card under the pointer · the drawer, a sheet, a toast |
| `--hover` | `#F6F8F7` | a row or quiet button under the pointer (ink 12:1, muted 6.0:1) |
| `--ink-2` | `#34443B` | body copy one step quieter than a heading (10.3:1) |
| `--line-soft` | `#E7ECE9` | the hairline inside a panel (between register rows) |
| `--field-line` | `#7F8D86` | an input's edge: 3.5:1 on white, 3.2:1 on the canvas (WCAG 1.4.11) |
| `--accent-hover` · `--accent-press` | `#12523F` · `#0F4636` | the primary action under the pointer (9.1:1) and pressed (10.8:1) |
| `--danger-hover` | `#8A332C` | a red button under the pointer |
| `--focus-halo` | `rgba(22, 97, 77, .22)` | the soft glow inside the 3px ring on a focused field |
| `--dur-fast` · `--dur` · `--dur-slow` | 120 · 160 · 200 ms | motion durations |
| `--ease-out` · `--ease-in-out` | `cubic-bezier(.2,.8,.2,1)` · `cubic-bezier(.4,0,.2,1)` | motion curves |

The §3.2 row "radius 6px, no shadow" is replaced by OB-201: the same 6px radius, and a soft layered elevation.

**Components refined in the foundation:** buttons (`.sre-btn` secondary by default, `-primary`, `-quiet`, `-danger`:
one height, a hairline edge, hover shades, a 1px press); fields (`.sre-input`, `.sre-select`, `.sre-check`);
cards and panels (`.sre-card`, `.sre-panel`, `.sre-panel-head`); tiles and rows; registers (sticky head, hairline rows,
a row lit under the pointer, tabular figures); status chips (`.sre-chip`, tinted in their tone, with the tone's icon);
the record drawer and sheets (they slide in); the subpage tiles (they lift slightly under the pointer); toasts
(`.sre-toasts` / `.sre-toast`); empty and "not known" states (`.sre-empty`, `.sre-unknown`); skeleton loading
(`.sre-skeleton`, never for a figure the box does not know); and the "new version ready" strip (with its refresh icon).
The chrome draws the sync badge as a chip in its tone, the language toggle as a bordered button with a globe, and the
search with a magnifier inside the field.

**The icon set — rules.**
1. **One set:** Lucide's outline icons, drawn at **1.5px** on a **24px grid** with round caps and joins. Every shape is
   copied unchanged from the owner's approved reference pack. The one exception is `indian-rupee`, which is Lucide's
   own. 99 icons, only the ones in use. The ISC (and Feather MIT) notices are in `packages/ui/web/ICONS-LICENSE.txt`,
   `ICONS-ATTRIBUTION.md`, and the head of every copy of `sre-icons.js`.
2. **Built in:** inline SVG made with DOM calls, no CDN, no icon font, no fetch. It draws with the internet off (P-01).
3. **Never alone:** every icon sits beside its word. The SVG is `aria-hidden` and cannot take focus; the word is the
   name. `sreIcon.chip()` and `sreIcon.withWord()` refuse a blank word. No action and no status is icon-only.
4. **The colour of its words:** `stroke: currentColor`. An icon never carries meaning by colour alone.
5. **What the screens use:** `window.sreIcon(name)`, `sreIcon.forTone(tone)`, `sreIcon.chip({ tone, label })` and
   `sreIcon.statusDot(el)`. Tones map to shapes: ok = circle-check, pending = clock, degraded = triangle-alert,
   error = circle-alert, idle = pause-circle, not known = circle-help.
6. **Where it is wired:** the rail gives every screen of the menu catalogue its own icon, and every workspace has one
   for the Today page's workspace tiles. Workspace headings on the rail are words alone (one icon per row). The header
   has the menu, search and language icons; the branch card has the shop icon; the badge has the state's shape; the
   cache and update strips have the history and refresh icons. The till's and the handhelds' status dots wear the shape
   of their state (tick, clock, cross, pause) inside a thin ring in the tone. Their layouts and their 56 / 60 / 64px
   targets are unchanged.

**Motion — rules.**
1. **Short:** 120–200ms, ease-out.
2. **Opacity and transform only:** never a size or position that moves other things, so there is no layout jank.
3. **Entering words never fade:** a drawer, sheet, toast or strip moves in fully opaque, so it is readable from its
   first frame. Only the scrim (which has no words) fades. The skeleton's slow pulse is the one loop.
4. **None on request:** under `prefers-reduced-motion: reduce` every duration token is 0ms and every animation and
   transition stops.
5. **Never on the till's scan or total:** nothing in the foundation animates a bare element or the till's classes.
   The till's own page sets no motion.

**Proof:** `tests/guardrails/every-icon-comes-from-the-one-set.test.ts`,
`tests/guardrails/the-foundation-carries-the-refined-scale.test.ts`, `tests/unit/ui-token-contrast.test.ts` (each new
pair at AA in both sets), and `tests/e2e/the-chrome-wears-the-one-icon-set.e2e.ts` (the whole menu rendered, an icon per
screen beside its name, no icon-only element, no console error, the audit clean at a desk and on a phone in English and
Tamil, and no animation after twenty till scans).

## 4. Core components (implemented later in `packages/ui`)
| Component | Rules |
| --- | --- |
| Primary button | One per screen (per visible view), dominant, thumb-reachable; disabled state explains why. **Kept since U1 (2 Nov 2026):** every office page marks it with `.sre-btn-primary`, every other button is `.sre-btn` (secondary), `-quiet` or `-danger`, no page paints a button by itself, and a greyed button carries its reason beside it (`.sre-why`) and as its tooltip — `tests/guardrails/every-office-page-marks-one-primary-action.test.ts`, `tests/e2e/u1-every-office-page-shows-one-primary-action.e2e.ts`. |
| Secondary / destructive button | Destructive shows consequence + confirm; financial adds authority check. |
| Input / number pad | Large; POS number entry is a big on-screen pad; inline validation with the §27.1 error content. |
| List / line item | Clear line height; swipe/tap targets large; running total pinned. |
| **Sync-state badge** | Always visible: online/degraded/offline + unsent count + last-sync time. |
| Status chip | Shows record lifecycle state (draft…archived) with icon + text. |
| Dialog | Consequence + authorization + confirm for destructive/financial actions. |
| Toast / error banner | States what happened, whether data was saved, next safe action. |
| Language toggle | Per-user English/Tamil switch, persistent. |
| **Menu (ERP)** | One per page, from the person's real permissions and the screens this box serves; empty says why; never a link the box would 404 (Stage G slice 5b). |
| Approval inbox item | Shows request, value, requester, and one-tap approve/reject with reason. |

### 4.1 The office page components (W1, 1 November 2026) — implemented
The owner said (1 Nov 2026) the office pages looked plain and things were hard to find. These are the shared parts every
office page now uses, in the OB-13 look (no new brand, no new colour, no new icon). They live in the shared foundation:
the look in `packages/ui/web/sre-foundation.css` (copied to every app by `node scripts/sync-ui-foundation.mjs`), the
behaviour in the back office's one chrome `apps/web-erp/web/sre-chrome.js` as `window.sreOffice` (already precached, so
every part works with no internet — P-01). A page that paints before the chrome loads listens for `sre:chrome`.

| Part | Call | Rules |
| --- | --- | --- |
| **Register** (data table) | `sreOffice.table(host, { id, label, columns, rows, pageSize, rowKey, rowData, bodyId, drawer, empty })` | A tool row: a search over every shown column (every word must match), a filter per column marked `filter` (its choices are the values the rows really have), a "Columns" choice (remembered in this browser; one column always stays). Column headings marked `sort` are buttons that sort up then down (`aria-sort`); numbers sort as numbers. Pages of 10 by default with "Showing 1–10 of 24", Previous and Next. A row with a drawer has an "Open" button; the **record drawer** shows that row's facts (`sreOffice.facts`), Escape or Close shuts it and the focus goes back. `rows: null` is "reading"; `[]` is "nothing yet"; `setState('error' \| 'offline' \| 'denied', { detail })` says why the rows are missing. A value that is missing is drawn "Not known", never blank or nought. The table scrolls in its own box; the page never scrolls sideways. |
| **States** | `sreOffice.state(host, kind, { title, detail, action, actionLabel })`, `sreOffice.stateOf(outcome)` | `loading` "Reading the records…" · `empty` "Nothing here yet — an empty list does not mean everything is fine" · `noMatch` "No rows match … the list still has N rows" with "Clear search and filters" · `error` "Could not read this list. Nothing was changed." · `offline` "Head office cannot be reached … nothing here is current" · `denied` "Your role cannot open this". English and Tamil. **Empty never reads as "all clear" (P-08)**: a page's own empty words say what the list covers. |
| **Summary cards** | `sreOffice.cards(host, [{ label, value, note, tone, href, icon }])` | The label, the figure exactly as the page read it, a note. `value` null is **"Not known"** — never 0. Tone is a coloured edge AND the words (never colour alone). |
| **Status chip** | `sreOffice.chip(tone, label)` | The tone's shape from the one icon set and its words (`ok`, `pending`, `degraded`, `error`, `idle`, `unknown`). |
| **Form field** | `sreOffice.field({ id, label, type, required, hint, options })`, `sreOffice.check(form)` | A visible label that is the field's name; "(required)" said in words (not a lone star); a hint under it; a message beside the field in plain words when it is wrong ("Fill in "Customer code"."); the first wrong field takes the focus; nothing is sent until every field is right. |
| **Confirm sheet** (U1, OB-626, 2 Nov 2026) | `sreOffice.confirm({ title, detail, authority, confirmLabel, tone, reason? })` → `{ ok, reason? }` | Before money, stock, a price or a privilege moves: one modal sheet that says what will happen (with the figure and its unit), the consequence and how it is undone, in whose name and who approves afterwards, and a button with the action's own verb (never "OK"). Focus lands on **Go back**; Escape, the scrim, a second ask and leaving the page answer Go back; Enter in a field never confirms; a required reason is refused blank beside the field; `tone: 'danger'` for the irreversible (a recall, a write-off, lending authority). English and Tamil, repainted live; never a browser dialog; works with no internet. A second person's PIN or signature stays and comes after it. Every money, stock, price and privilege action in the office goes through it (`tests/guardrails/money-moves-only-after-the-confirm-sheet.test.ts`); the till has the same step in its own panel. |
| **Picker** (U2, 2 Nov 2026) | `sreOffice.pick({ kind, title, scope?, filter?, allowCode? })` → `{ ok, id, name, code?, item }`; `sreOffice.pickField({ id, label, kind, required, … })`, `pickedValue(id)`, `setPicked(id, …)` | A product, supplier, person, place, store, customer or approval is picked by its NAME: a modal sheet with the search box focused, a few letters of the name (or a code, or a barcode) find it, 44px rows, at most 50 with "N more — type more letters", the last ten picks offered first. The pack's people and places come from the store computer, so they work with head office down (P-01); products, suppliers, customers and approvals come from head office in the person's own session. A list the person may not read is said, never blank, and with `allowCode` the sheet offers "Type the code instead" — never a dead end (P-08). The pick field shows "name (code)", keeps the id hidden, says "(required)" in words. No office page asks a shop person to type an id or a code where a list exists (`tests/guardrails/the-chrome-carries-the-picker-and-the-date-field.test.ts`). |
| **Date field** (U2) | `sreOffice.dateField({ id, label, required, min?, max?, hint? })`, `dateValue(id)` → ISO, `dateWords(iso)`, `parseShopDate(text)` | A date is written as the shop writes it, dd/mm/yyyy, with the hint "Day / month / year, for example 31/10/2026" and a numeric keypad; an impossible day (31/02) and a day outside `min`/`max` are refused beside the field in words; the page gets ISO; `dateWords` reads "31 Oct 2026" / "31 அக் 2026". Never a native browser date widget (whose order follows the browser, not the shop) and never a typed "YYYY-MM-DD". The month lengths are calendar arithmetic, never the device clock (`no-shop-date-is-read-from-the-utc-date`). |
| **Directory: names for ids** (U2) | `window.sreDirectory` (from the store computer's signed pack); `sreOffice.nameOf(kind, id)`; `sreOffice.me()` | The store computer tells every office page who and where: the store and its name, the time zone, the person signed in (name, roles, permissions), the store's people and places. A page shows a NAME wherever it held an id ("Kavitha Rajan", "SRE Hyper Market", "India time (Kolkata)"), the id itself when no name is known, never blank and never invented; the header's "who" is the person's name on every page; the person's own store is filled in wherever a page asked for a store. Read defensively: an older or thin pack never fails a page. |

**Where they are used first (W1):** Customers (segment cards and the customer register with drawer), Approvals (inbox
cards, request chips, a required reason said beside the field, "not known" until head office answers — never "nothing
waiting" offline), Reports (catalogue cards, a report finder, the rows behind a report as a register), Month-end
(figures as summary cards, every empty or unreadable list as a state), Today (the empty attention list says what it
covers). Other pages move onto them as their builders reach them.

**Accessibility on office pages (W1):** every control at least 44px; the focus ring always shows (3px, `--focus`); no
page scrolls sideways at 1280px or at tablet width. Proved by `tests/e2e/w1-the-office-shell-finds-pages-and-shows-real-registers.e2e.ts`
with the audit in §5.1.

### 4.2 The menu you can find things in (W1, 1 November 2026) — implemented
- **Task workspaces with plain names**, in this order: Your daily work · Today & approvals · Products & prices · Buying
  from suppliers · Goods coming in · Stock & counts · Waste, expiry & returns · Shelves & shop floor · Customers & service
  · Online orders & delivery · Fresh food & café · Cash, accounts & GST · Staff, rota & tasks · My work & pay · Checks &
  investigations · Reports & figures · Setup, people & access · Tills, devices & connections · Open a device screen.
  (`NAV_GROUP_LABELS` in `apps/web-erp/src/navigation.ts`.) Screen ids, paths and permissions did not change.
- **A role's daily jobs first** (`DAILY_WORK`, keyed by the product's role ids): each is still opened only by its own
  permission, and is not repeated in its workspace below. Within a workspace the most-used screens lead (`NAV_ITEM_ORDER`).
- **A long menu is a dozen headings.** When a person may open more than 24 screens, only the daily work, the workspace
  they are in and the workspaces they opened stand open; each heading is a button (`aria-expanded`) and this browser
  remembers it. A short menu (a cashier's) stands fully open.
- **Pinned and recently opened** pages sit at the top of the rail ("Pin this page" in the top line). They are this
  browser's memory for this person only, and only ever screens the rail already offers.
- **Search by a plain word**: every word typed must be found in a screen's name, its plain words (`NAV_SEARCH_WORDS`,
  English and Tamil: "salary", "shortage", "GST", "காலாவதி") or its workspace's name; it says how many screens match;
  Enter opens the first.
- **Breadcrumbs**: "Workspace › the workspace › the screen", read off the rail.

## 5. Accessibility (NFR-07)
- Target **WCAG 2.2 AA** for customer/web surfaces; keyboard, touch and high-contrast paths for staff surfaces.
- Contrast ≥ 4.5:1 for text; focus indicators visible; no action requires fine motor precision.
- Screen-reader labels on all controls; error messages announced.

### 5.1 How it is checked (Stage G slice 3)
`tests/e2e/lib/a11y-audit.ts` audits the RENDERED page in real Chromium — contrast of every visible word against
the surface it actually sits on (1.4.3, with `packages/a11y`), non-text contrast (1.4.11), target size at this
product's 44px bar (2.5.8), an accessible name on every control (4.1.2), a label on every input (3.3.2), the page
language including after the EN/TA toggle (3.1.1), exactly one visible h1 (2.4.6), and no horizontal scroll at the
viewport under test (1.4.10). An inactive control (`disabled` / `aria-disabled`) is exempt from contrast and target
size, as WCAG exempts it, but still needs a name; `opacity` is composited, so dimmed words are measured as seen; a
wrapping `<label>` names its control and, for a tick box or radio, is the target that is measured.
Every screen slice runs it on every view a person reaches and keeps a tripwire that proves it bites. It cannot see
focus visibility under a real keyboard (the static guardrails hold `:focus-visible`), announcement order, the meaning
of the words, or that text under a modal overlay is covered. Budgets are counted with `tests/e2e/lib/tally.ts`.

## 6. Localization (NFR-08)
- English and Tamil first; per-user switch; Unicode throughout; locale-aware number, currency, date formats; a translation framework so strings are never hard-coded in screens.

## 7. Offline-first UX (P-01 / P-08 / §31)
- The sync-state badge is a permanent fixture, not a hidden setting.
- The **unsent count** is always visible on transactional surfaces; tapping it explains what is queued.
- **Conflicts surface as visible exceptions** with a clear next action — never silent.
- Stale data (owner dashboard) shows **prominent freshness per branch/domain**; nothing stale is presented as live.

## 8. Role surfaces (§27) — the design covers all
POS · Store/Manager · Product/Merchandising · Purchase/Supplier · Inventory/Warehouse ·
Finance · Owner · Customer app/web · Picker/Packer · Delivery · CRM/Service · Admin/Security ·
Migration · AI control. Each gets **only the simplest interface its role needs** (P-07);
screen specs live in `docs/design/screens/`.

## 9. How this is verified (QG-02)
- Count interactions for the ten most frequent actions on each surface — must be ≤ 3 (exceptions listed).
- Sit a real, untrained cashier down: unsupervised billing within 30 minutes.
- Test on the cheapest phone staff own, in the store, at 7pm.
- Use `usability-test-script.md` and record every hesitation, question and pen-reach.
