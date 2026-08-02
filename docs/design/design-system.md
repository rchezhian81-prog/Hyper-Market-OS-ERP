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
| Approval inbox item | Shows request, value, requester, and one-tap approve/reject with reason. |

## 5. Accessibility (NFR-07)
- Target **WCAG 2.2 AA** for customer/web surfaces; keyboard, touch and high-contrast paths for staff surfaces.
- Contrast ≥ 4.5:1 for text; focus indicators visible; no action requires fine motor precision.
- Screen-reader labels on all controls; error messages announced.

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
