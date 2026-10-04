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
- **Iconography:** paired with text labels (never icon-only for critical actions).

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
| shape | radius 6px, no shadow, tile top stripe 3px | | |

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
below) and the page's header is the top bar. The owner chose A (light everywhere) in the order 1a → DF-2 → 1b: until
UX-1b every shell outside the back office pins the dark set on its `<html>`. Extra tokens the light set needed, present
in both sets: `--field`, `--on-idle`, `--on-info`, `--ok-surface/--on-ok-surface`, `--error-surface`,
`--demo-surface/--demo-surface-2/--on-demo`, `--scrim`, `--rail/--rail-2/--on-rail/--on-rail-muted/--rail-accent/--rail-line`.
The three-reds rule holds in both sets (the light signal red `#e04e48` fails as words on purpose). Measured on the reference, as sent vs with the fix layer (headless Chromium, 1366×820 home):
texts under 14px 129 of 147 → 14 of 152; controls under 44px 3 → 0; strip 10px at 3.47:1 → 14px at 6.9:1.

## 4. Core components (implemented later in `packages/ui`)
| Component | Rules |
| --- | --- |
| Primary button | One per screen, dominant, thumb-reachable; disabled state explains why. |
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
