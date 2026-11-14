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
> **Superseded in colour, corners, type and shadow by OB-728 (emerald and gold, 2 Nov 2026) — see §3.5.** The rules
> below ("Rules the look keeps") still hold unchanged; the table is kept as the record of the October look.

The owner's reference (`reference/professional-pack-2026-10-04/`, README there) sets the visual language from here on:
a dark-forest navigation rail, white work surfaces on a cool neutral canvas, one emerald primary action, fine edge
stripes on tiles, compact panels (rounded since OB-728, §3.5), status as words with amber and red kept for exceptions. Contrast is against white
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
sample-data strip at 14px; the system font stack with the Tamil faces before Arial (since OB-728: the two self-hosted faces first, then that stack, §3.5); one primary action per screen.
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
| `--radius-sm` · `--radius` · `--radius-lg` · `--radius-xl` · `--radius-pill` | 4 · 6 · 8 · 12 · 999 px (**6 · 12 · 16 · 20 · 999 px since OB-728, §3.5**) | one radius scale |
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

### 3.5 Emerald and gold, rounded and matte (OB-728, owner, 2 November 2026)
The owner chose a new look for every screen: **emerald and gold, rounded and matte** (brief: "Developer brief: emerald and
gold look for SRE Retail OS", 2 Nov 2026; reference: the SRE Retail OS design system page). It is a **styling change
only**: layouts, flows, prices, tax, payments and data are untouched; token NAMES did not change, so no screen changed.

**What does not change:** every §1 hard rule (English and Tamil on every word; status as word + icon; nothing a person
must read under 14px; targets 44 / 48 / 56 / 64px); the meaning of every colour (green ok, amber pending or not known,
red a problem, grey idle); the three-reds rule; no motion on the till's scan or total and reduced motion respected;
offline first — nothing loads from the internet at run time, fonts included.

**Colour.** Both sets in `packages/ui/web/sre-foundation.css`; the dark set moves from slate blue to a deep green-black
of the same palette. Every token not listed keeps its value (the reds, `--info`, the demo stripes, the heat-map scale).

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` · `--panel` · `--panel-2` · `--field` | `#fbf8f1` · `#ffffff` · `#f5f0e4` · `#ffffff` | `#0d1714` · `#15231e` · `#0f1b17` · `#0f1b17` |
| `--hover` · `--mint` | `#f9f5ec` · `#e8f2ec` | `#1a2b25` · `#163a2d` |
| `--line` · `--line-soft` · `--line-strong` · `--field-line` | `#ece4d2` · `#f3eee2` · `#d8cbae` · `#8a806d` | `#2a3c35` · `#213129` · `#3d5248` · `#71877d` |
| `--ink` · `--ink-2` · `--muted` | `#173328` · `#2f4339` · `#5c5646` | `#f4efe3` · `#e2dccd` · `#a9b5ae` |
| `--on-accent` · `--on-warn` · `--on-idle` | `#ffffff` · `#ffffff` · `#ffffff` | `#062018` · `#2b1405` · `#0d1714` (see note) |
| `--ok` · `--accent-hover` · `--accent-press` | `#17654f` · `#11533f` · `#0e3b2e` | `#4cbf8e` · `#6fd0a5` · `#93ddba` |
| `--degraded` (burnt amber, never gold) · `--idle` | `#9c4f17` · `#6e746a` | `#f0a050` · `#7d8c85` |
| `--warn-surface` / `--on-warn-surface` | `#fbe7d6` / `#66310e` | `#3d2610` / `#fcd9b0` |
| `--ok-surface` / `--on-ok-surface` · `--error-surface` | `#e3f1e8` / `#0e4a35` · `#fbeae6` | `#0f3326` / `#bdebd3` · `#45120f` |
| `--scrim` · `--focus` · `--focus-halo` | `rgba(14,59,46,.55)` · `#0e3b2e` · `rgba(23,101,79,.22)` | `rgba(3,10,8,.8)` · `#e0b456` · `rgba(224,180,86,.25)` |
| `--rail` · `--rail-2` · `--rail-line` | `#0e3b2e` · `#17493a` · `#215443` | `#091210` · `#15231e` · `#1e2e28` |
| `--on-rail` · `--on-rail-muted` · `--rail-accent` | `#f7f2e6` · `#afc6bb` · `#d4a23a` | `#f4efe3` · `#9fb2a9` · `#e0b456` |
| **new** `--gold` / `--on-gold` | `#d4a23a` / `#0e3b2e` | `#e0b456` / `#1a1405` |
| **new** `--gold-soft` / `--on-gold-soft` | `#f6ebcf` / `#6a4b0f` | `#3a2e12` / `#f3dda6` |

**Note (found while building, 14 Nov 2026):** the brief's dark `--on-idle` `#f4efe3` reads **3.1:1** on the dark
`--idle`, under the 4.5:1 floor the brief itself requires; the build uses the dark ink `#0d1714` (5.2:1) and keeps
`--idle` as given. And `--on-rail-warn` — "Not known" on the Today band, not in the brief's table — is burnt amber
`#f5b06a` (5.4:1), not the pale yellow `#ffd166` that read as gold. Every other pair passes in both sets (tests/unit/ui-foundation.test.ts, ui-token-contrast.test.ts).

**Gold is decoration only:** the SRE mark, the current screen's marker in the rail, a highlight on a featured card.
Never a status, never words on white, never more than one gold element on a card. (The rail's branch-card dot was
`--rail-accent`; it is now a neutral, so no gold dot reads as a warning light.) A guardrail fails the build if any status
rule — a chip, a dot, a row, a toast, a banner, a strip — uses gold.

**Shape and shadow:** radii **6 / 12 / 16 / 20px** (one scale for both sets — the dark set's own override is gone);
`.sre-btn` and the language toggle are **pills**; a chip shows its tone by tint and icon with **no left border**; rows,
summary cards, toasts and tiles keep their tone edge on the rounder corners; icons are thickened to **1.75** in the
stylesheet (the SVG keeps 1.5); shadows are tinted with the emerald (black in the dark set). **Matte:** no gradient, shine,
glass or glow anywhere in the foundation (a guardrail checks).

**Type:** `"Plus Jakarta Sans", "Anek Tamil"`, then the system's Tamil-capable faces. Both are **self-hosted** woff2 files
(Plus Jakarta Sans 400–800, Anek Tamil 400–700, ~130 KB in all) under `packages/ui/web/fonts/` with their SIL Open Font
Licences, copied into each app by `scripts/sync-ui-foundation.mjs` and precached by each service worker, declared with
`font-display: swap` so nothing waits on a font. `packages/ui/web/sre-faces.js` (copied and precached the same way,
linked by every store page before its own scripts) asks for all nine faces as a screen opens: a browser otherwise reads a
face the first time a word needs it — the first ₹ on a till line read Anek Tamil from the cache in the middle of a scan,
which the browser suite caught (a scan must make no request at all). Anek Tamil also draws the rupee sign. Google Fonts is never linked at run
time. **Exception — OB-729 (owner, 14 Nov 2026):** the customer app keeps the phone's own faces (`<html
class="sre-system-type">`), carries no font file and precaches none, so its first load stays within the 150 KB
low-bandwidth budget (M20 · D08).

**The sign-in page** (§3.3, `infra/pilot/demo-login/ui.ts`, regenerated into the identity server's theme) takes the same
palette: ivory canvas, gold SRE mark, emerald pill buttons, burnt-amber notices, rounder corners. It fetches nothing; it
names the two faces first and uses them only where a device has them installed.

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
| **Confirm sheet** (U1, OB-698, 2 Nov 2026) | `sreOffice.confirm({ title, detail, authority, confirmLabel, tone, reason? })` → `{ ok, reason? }` | Before money, stock, a price or a privilege moves: one modal sheet that says what will happen (with the figure and its unit), the consequence and how it is undone, in whose name and who approves afterwards, and a button with the action's own verb (never "OK"). Focus lands on **Go back**; Escape, the scrim, a second ask and leaving the page answer Go back; Enter in a field never confirms; a required reason is refused blank beside the field; `tone: 'danger'` for the irreversible (a recall, a write-off, lending authority). English and Tamil, repainted live; never a browser dialog; works with no internet. A second person's PIN or signature stays and comes after it. Every money, stock, price and privilege action in the office goes through it (`tests/guardrails/money-moves-only-after-the-confirm-sheet.test.ts`); the till has the same step in its own panel. |
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

### 4.3 The till, the handhelds and the kiosks (UI-2, 1 November 2026) — implemented
The owner said (1 Nov 2026) "UI/UX also very poor" and chose the till and the handhelds as one area. These are the
patterns the device screens now share, in the OB-13 look (no new colour, no new icon). The look is in the shared
foundation `packages/ui/web/sre-foundation.css` (copied to every app by `node scripts/sync-ui-foundation.mjs`); each
screen keeps its own small script. Nothing here moves (§3.4 rule 5), no word is colour alone, nothing a person must read
is under 14px, every word is in English and Tamil, and none of it changes a price, a tax, a payment or a sale's path.

| Part | Class | Rules |
| --- | --- | --- |
| **Scan line** | `.sre-scan-ready` with `.sre-scan-say`, `.sre-scan-code`, `.sre-scan-last`; `data-state="ready" \| "reading"` | Sits over the bill and never leaves it. Says "Ready to scan" in words; shows the digits a scanner or a keyboard has typed since the last Enter (the panel turns mint AND the words change to "Typed so far — press Enter…"); Backspace takes a digit back, Esc clears; names the last item a scan added as the bill now holds it ("Last added: Toor dal 1kg · 3 · ₹435.00"). A wedge scanner types into the page, never a field, so this is words on a panel, not an input. Its one button, **Type a barcode**, opens the screen's own keypad (14 digits) and sends the code down exactly the scan's path. |
| **Customer figure** | `.sre-figure-xl` | A price or an amount to pay read from two metres: 48–104px, tabular figures, never wraps. The largest thing on a kiosk. |
| **Customer card** | `.sre-kiosk-card` (`data-tone="warn"` for a refusal), `.sre-kiosk-name`, `.sre-kiosk-note` | One plain answer on a white panel: the name large, the figure, the note under it. A refusal is the same card in amber with the words as the message. The sentence the model wrote is kept whole for a screen reader; only its parts are laid out. |

**Where they are used (UI-2):**
- **The till** (`apps/pos/web`): the scan line over the bill; the bill's lines at 20px; the number of lines under "Total
  to pay"; a code the price list does not hold says what happened, that nothing was added and what to do next ("Not in
  the price list … Scan it again, or type the number under the barcode. If it is still not found, put the item aside and
  call the manager."). Hold/Recall and Tender stay one tap; the five actions, the strip and the total are unchanged. A
  scan still makes no network call and is drawn before the key handler returns (measured < 300 ms, §32).
- **The price kiosk** (`apps/price-kiosk/web`): the answer on the customer card — name, price as the customer figure,
  "Offers are applied at the till" under it; a refusal on the amber card.
- **Self-checkout** (`apps/self-checkout/web`) and **the queue till** (`apps/queue-pos/web`): the amount to pay is the
  largest figure; each line's quantity is said in words ("Quantity 2"); the self-checkout's screen-reader names are in
  Tamil too.
- **Who is signed in (OB-638, owner's option A, 1 Nov 2026):** the till header, the self-checkout lane's "Opened by" and
  the queue till say the person's NAME with the staff code beside it — "Signed in: Ravi (u-ravi)" — using the name the
  store computer gave at sign-in (`apps/pos/src/operator-label.ts`, the till session's `operatorShown()`, the lane's
  `attendantShown`). With no name known, the code alone. Words only: every record still carries the code.
- **The handhelds** keep their task-first layouts (§3.2): the warehouse header names the job ("Stock room work") with the
  staff code and the job under it, each said as what it is; a count of pieces reads "12 units" (the code "EA" is gone; a
  unit the handheld does not know keeps its code beside the word). Their sync badge stays in the header, always seen.

**Proof:** `tests/e2e/ui2-the-till-reads-at-arms-length-and-is-always-ready-to-scan.e2e.ts` and
`tests/e2e/ui2-the-handhelds-and-kiosks-read-at-a-glance.e2e.ts` — real Chromium, the till at 1366 and 1024, the
handhelds and the queue till at 360px, the kiosks at their own screens, English and Tamil: no sideways scroll, every
control at the screen's own target (56px on the till, the handhelds and the self-checkout lane, 64px on the price kiosk;
never under 44px), the §5.1 audit clean.

### 4.4 Charts (UI-3, 1 November 2026) — implemented
The owner said (1 Nov 2026) the owner app and the reports were hard to read. Where a figure over time or a comparison is
the point, a page may draw it as a simple chart — and only through the one chart code, so every chart reads the same way.

| Rule | How |
| --- | --- |
| **One drawing, no library, no network (P-01)** | `packages/ui/src/charts.ts` draws inline SVG. Each app's own bundle puts it on the page as `window.sreCharts` (`attachCharts`), and every service worker already precaches the bundle, so a chart opens with the line down like the figures beside it. No screen loads a chart library or any script from the internet. |
| **Call** | `sreCharts.draw(host, { id, kind, title, covers, labelHeading, valueHeading, rows, empty }, lang)`. `kind: 'bars'` is a comparison (one row each, in the order the page gives — largest first for a ranking); `kind: 'columns'` is a figure over time, in time order. Each row: `{ key, label, value, text, mark }`. Words are a string or `{ en, ta }`. |
| **Honest** | Bars are measured from zero against the largest magnitude; no trimmed axis, no 3-D. A value the page was not given (`null`) is drawn as **"Not known"** with no bar — never a bar of nought — and the chart says how many rows have no figure. A value below zero is drawn as a dashed outline and keeps its minus sign in the words. The chart never formats a figure: the page passes `text` (₹ and paise as it already writes them), so a chart and the page cannot disagree. An empty chart says nothing was read — it is never an all-clear (P-08). |
| **Says its source** | `covers` is required: the dates, the store or branches, and when the figures were read (at the shop's clock, OB-607). A guardrail fails a page that draws a chart without it. |
| **Colour is never the only signal** | One series, so colour carries no meaning. A bar chart prints every figure beside its bar; a column chart labels the tallest column and any marked one ("today") in words, and the rest are in the table. |
| **A table behind every chart** | The picture is `aria-hidden`; the same rows, from the same model, are a real `<table>` with a caption that a screen reader reads. One button ("Show the figures as a table" / "Show the chart", `aria-pressed`) shows the table in place of the picture. |
| **Light and dark** | Only foundation tokens: `--accent` bars on a `--panel-2` track, `--muted` words, `--warn` for "Not known", `--error` outline for a value below zero (`.sre-chart-*` in `sre-foundation.css`). Pairs proved AA in both sets in `tests/unit/ui-charts.test.ts`. |
| **Phone** | Bar rows stack label / figure over a full-width bar under 520px; a column chart labels every column up to 12 and every k-th beyond (24 hours fit a 360px phone). No sideways scroll. |

**Where they are used first (UI-3):** the owner app (today by the shop's hour, the last trading days the store computer
holds, how today was paid), Reports (sales by hour, today against the last days, sales by cashier, how people paid,
what is selling by department — drawn from each report's own rows), Compare side by side (head office's ranking), the
Company report (branches side by side), Waste analytics (write-offs and waste records by the shop's day, from head
office's `GET /v1/waste/analytics/by-day`, OB-641). Compare side by side, the Company report, Waste analytics, Bill
findings, Owner alerts and Bought together also use the §4.1 cards, registers and states, each with a source line
(what it covers, when head office answered). A register's parts never widen a phone page (`.sre-datatable > *`). **Proof:** `tests/unit/ui-charts.test.ts`,
`tests/guardrails/every-chart-is-drawn-by-the-one-chart-code.test.ts`,
`tests/e2e/ui3-the-owner-app-and-reports-read-at-a-glance.e2e.ts` (360px and 1280px, light and dark, English and Tamil).

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
