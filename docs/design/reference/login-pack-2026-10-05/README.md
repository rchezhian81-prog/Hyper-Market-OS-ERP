# The owner's login design (5 October 2026) — what the product took from it

**What this folder is.** The design pack the owner sent on 5 October 2026 (`SRE-Hypermarket-Login-Design-Pack.zip`) with
the words *"Before going ahead with the next slice, the login page wants to look like this while you are doing this page"*
— kept as sent: its README, its implementation brief (`CLAUDE-HANDOVER.txt`), its tokens, its verification note, its icon
licence and its markup and stylesheet sources (`source/login-markup.html`, `source/login.css`). Two files are not
duplicated here: the 442 KB self-contained prototype (`SRE-Hypermarket-Login.html`, with the icon library embedded) and
the prototype script `source/login.js` — the repository's secret scanner refuses its sample credential keys, and its
bilingual copy table lives, carried word for word, in `infra/pilot/demo-login/ui.ts` (`LOGIN_COPY`). Both remain in the
owner's zip. Decision **OB-18** in `docs/registers/decisions.md` records what was taken and what was not;
section 3.3 of `../../design-system.md` carries the tokens and the rules.

**Where it lives in the product.** `infra/pilot/demo-login/ui.ts` — the hosted copy's real sign-in — and nowhere else:
the pack's own brief says *use the existing login entry point; no parallel login app; do not copy the prototype handler*.
The Keycloak login (ADR-0019, the OB-15 block) takes the same look when it is built.

**Taken as designed.** The pale sage canvas, the S+ mark, the three-part stripe over the white card, labelled inputs, one
primary *Sign in*, English / தமிழ் with the pack's draft Tamil, show/hide password, the Caps Lock hint, the help and
connection dialogs, two columns at a desk and the card alone below 720 px, the system font stack with Tamil coverage,
the pack's Lucide icon shapes drawn inline (ISC licence, `LUCIDE-LICENSE.txt`), nothing fetched from anywhere.

**Deliberately not taken — as the brief itself asks.** The seven sample connection/account states and the "Explore
states" picker; the sample store name and mode; the simulated sign-in success; the prototype's sign-in handler; the
preview disclaimer. There is no *Remember me* and no role selector before sign-in. The connection line is bound to what
the server knows (*Online sign-in available*) and never says "offline access available" or that a store computer is
running; *Your session has ended* appears only when a session cookie that no longer verifies arrives.

**Changed from what was sent — one thing.** Text sizes were lifted to the design system's own floor: nothing a person
must read under 14 px, uppercase letter-spaced labels at least 12.5 px, the practice strip at 14 px (the pack used 11–12
px in several places). Colours, spacing, shapes and words are the pack's; one small mode tag was darkened a shade
(`#5E7052` → `#4F6244`) to clear 4.5:1 with margin.

**Verified where it runs.** `tests/unit/demo-login.test.ts` (the served page) and `tests/e2e/sign-in-page.e2e.ts`
(headless Chromium against the real handler at 1280 / 390 / 320 px, English and Tamil, the WCAG 2.2 AA audit of
`tests/e2e/lib/a11y-audit.ts`, no content-security-policy violation). Rendered captures from that run are in
`rendered/`. Not yet: the owner's own look on the hosted copy; a person's run with a password manager and a screen
reader; Tamil wording reviewed by native-speaking staff (OB-17 — Wave 8).
