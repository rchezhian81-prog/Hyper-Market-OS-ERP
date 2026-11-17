# Developer brief: emerald and gold look for SRE Retail OS

Nov 2, 2026 · \@chezhian

## What and why

On 2 November 2026 the owner chose a new look for every SRE Retail OS
screen: **emerald and gold, rounded and matte**. Please bring the shared
foundation in the Hyper-Market-OS-ERP repository in line with it. The
reference is the SRE Retail OS design system page, which already shows
every token and all 20 screen parts in the new look.

This is a styling change only. Layouts, screen flows, prices, tax,
payments and data stay exactly as they are.

**What does not change:**

-   All design-system hard rules: English and Tamil on every word,
    status always as word plus icon, nothing a person must read under
    14px, touch targets of 44, 48, 56 and 64px.

-   The meaning of every colour: green means OK, amber means pending or
    not known, red means a problem, grey means idle.

-   The three-reds rule: one red for signals, one for words, one for
    buttons.

-   No motion on the till\'s scan or total, and reduced motion still
    respected.

-   Offline first: nothing may load from the internet at run time, fonts
    included.

This is an owner decision. Please log it as a new decision record,
referenced from design-system.md §3, before building.

## Colours

Replace the light set (:root) and the dark set
(:root\[data-theme=\"dark\"\]) in sre-foundation.css with the values
below. Token names stay the same, so no screen needs to change. Four
gold tokens are new. The dark set moves from the old slate blue to a
deep green-black of the same palette.

All 98 text and edge pairs in the design system were checked in both
sets: text 4.5:1 or better, edges, icons and focus rings 3:1 or better.
Every token not listed keeps its current value, including the reds
(\--error, \--danger-text, \--danger-surface, \--danger-hover), \--info,
the demo stripes and the heat-map scale. The aliases (\--good,
\--accent, \--warn, \--danger, \--nobody-\*) keep pointing where they
do.

  ----------------------------------------------------------------------------
  Token                Light (new)        Dark (new)         Light (was)
  -------------------- ------------------ ------------------ -----------------
  \--bg                #fbf8f1            #0d1714            #f3f5f4

  \--panel             #ffffff            #15231e            #ffffff

  \--panel-2           #f5f0e4            #0f1b17            #eef2ef

  \--field             #ffffff            #0f1b17            #ffffff

  \--hover             #f9f5ec            #1a2b25            #f6f8f7

  \--mint              #e8f2ec            #163a2d            #ebf3ee

  \--line              #ece4d2            #2a3c35            #dce3de

  \--line-soft         #f3eee2            #213129            #e7ece9

  \--line-strong       #d8cbae            #3d5248            #aebbb3

  \--field-line        #8a806d            #71877d            #7f8d86

  \--ink               #173328            #f4efe3            #25362e

  \--ink-2             #2f4339            #e2dccd            #34443b

  \--muted             #5c5646            #a9b5ae            #53625a

  \--on-accent         #ffffff            #062018            #ffffff

  \--on-warn           #ffffff            #2b1405            #ffffff

  \--on-idle           #ffffff            #f4efe3            #ffffff

  \--ok                #17654f            #4cbf8e            #16614d

  \--accent-hover      #11533f            #6fd0a5            #12523f

  \--accent-press      #0e3b2e            #93ddba            #0f4636

  \--degraded          #9c4f17            #f0a050            #8a5e1b

  \--idle              #6e746a            #7d8c85            #6b7a72

  \--warn-surface      #fbe7d6            #3d2610            #f6e7c8

  \--on-warn-surface   #66310e            #fcd9b0            #5a3e0c

  \--ok-surface        #e3f1e8            #0f3326            #e3f1ea

  \--on-ok-surface     #0e4a35            #bdebd3            #0f4c3a

  \--error-surface     #fbeae6            #45120f            #fbe9e7

  \--scrim             rgba(14, 59, 46,   rgba(3, 10, 8, .8) rgba(20, 32, 27,
                       .55)                                  .55)

  \--focus             #0e3b2e            #e0b456            #0f4c3a

  \--focus-halo        rgba(23, 101, 79,  rgba(224, 180, 86, rgba(22, 97, 77,
                       .22)               .25)               .22)

  \--rail              #0e3b2e            #091210            #192f27

  \--on-rail           #f7f2e6            #f4efe3            #f3f5f4

  \--on-rail-muted     #afc6bb            #9fb2a9            #a9b8ae

  \--rail-accent       #d4a23a            #e0b456            #7fd1ae

  \--rail-2            #17493a            #15231e            #24403a

  \--rail-line         #215443            #1e2e28            #2a423a

  \--gold              #d4a23a            #e0b456            new

  \--on-gold           #0e3b2e            #1a1405            new

  \--gold-soft         #f6ebcf            #3a2e12            new

  \--on-gold-soft      #6a4b0f            #f3dda6            new
  ----------------------------------------------------------------------------

**Gold is decoration only:** the SRE mark, the current-screen marker in
the rail, and a highlight on a featured card. Never use it for a status,
never for words on white, and never more than one gold element per card.
The warning amber \--degraded was deliberately moved darker and redder
so it never reads as gold.

Also update the prefers-contrast: more block. Light: \--line: #9a8f78;
\--line-strong: #5f5847; \--muted: #2f4339; \--line-soft: #bdb29a. Dark:
\--line: #5c7268; \--line-strong: #8fa59b; \--muted: #d6dcd8.

## Fonts, shapes and icons

  -------------------------------------------------------------------------
  What           New                                   Was
  -------------- ------------------------------------- --------------------
  \--font        \"Plus Jakarta Sans\", \"Anek         system stack only
                 Tamil\", system-ui, -apple-system,    
                 \"Segoe UI\", Roboto, \"Noto Sans\",  
                 \"Noto Sans Tamil\", \"Nirmala UI\",  
                 \"Latha\", sans-serif                 

  \--radius-sm / 6 / 12 / 16 / 20 px                   4 / 6 / 8 / 12 px
  \--radius /                                          
  \--radius-lg /                                       
  \--radius-xl                                         

  Dark-set       removed: one radius scale for both    present
  radius         sets                                  
  override (12 /                                       
  16 px)                                               

  .sre-btn       border-radius: var(\--radius-pill),   var(\--radius), 0
                 padding: 0 20px                       16px

  .lang toggle   border-radius: var(\--radius-pill),   var(\--radius), 0
                 padding: 0 16px                       14px

  .sre-chip      no left border; tone shown by tint    4px left border
                 and icon                              

  .sre-icon      stroke-width: 1.75                    1.5

  \--shadow-xs   0 1px 2px rgba(14, 59, 46, .06)       forest tint

  \--shadow-sm   0 1px 2px rgba(14, 59, 46, .05), 0    forest tint
                 2px 8px rgba(14, 59, 46, .05)         

  \--shadow-md   0 2px 4px rgba(14, 59, 46, .05), 0    forest tint
                 8px 20px rgba(14, 59, 46, .08)        

  \--shadow-lg   0 4px 8px rgba(14, 59, 46, .06), 0    forest tint
                 18px 44px rgba(14, 59, 46, .14)       
  -------------------------------------------------------------------------

Dark shadows use black instead of emerald: .3 / .3 + .25 / .3 + .35 /
.35 + .5 at the same offsets.

Matte means no gradients, shine, glass or glow anywhere. Rows, summary
cards, toasts and tiles keep their tone edge on the new rounder corners.
Everything else in the stylesheet stays as it is.

## Where to change it

Edit the source only. Never edit an app\'s copy: node
scripts/sync-ui-foundation.mjs copies it into every apps/\<app\>/web/.

1.  **packages/ui/web/sre-foundation.css**: the colours, radii, shadows,
    \--font, button, toggle, chip and icon changes above. Update the
    header comment to name the new decision.

2.  **Fonts, offline:** add self-hosted woff2 files under
    packages/ui/web/fonts/: Plus Jakarta Sans 400/500/600/700/800 and
    Anek Tamil 400/500/600/700. Both are SIL Open Font License; put the
    licence beside the files. Declare \@font-face with font-display:
    swap at the top of the foundation file. Never link Google Fonts at
    run time; the design-system page does that only for previews.

3.  **scripts/sync-ui-foundation.mjs**: add the font files to
    SHARED_FILES so every app carries them. Add them to every service
    worker\'s precache list so a till opens with the internet down.

4.  **tests/guardrails/the-foundation-carries-the-refined-scale.test.ts**:
    the radius check expects \[4, 6, 8, 12\]; change to \[6, 12, 16,
    20\]. The palette check expects the old \--bg, \--ink, \--ok,
    \--degraded, \--rail, \--line, \--muted and \--focus; change to the
    new values.

5.  **tests/guardrails/every-icon-comes-from-the-one-set.test.ts**: the
    stylesheet check expects stroke-width: 1.5; change to 1.75. Keep the
    SVG attribute at 1.5; the stylesheet thickens it.

6.  **tests/unit/ui-foundation.test.ts and
    tests/unit/ui-token-contrast.test.ts**: update the colour pairs to
    the new values in both sets, and add the gold pairs (\--on-gold on
    \--gold, \--on-gold-soft on \--gold-soft, \--rail-accent on \--rail
    at 3:1).

7.  **tests/guardrails/every-screen-shares-the-foundation.test.ts**:
    should pass unchanged, because pages still use var(\--font). Confirm
    the precache check covers the font files.

8.  **docs/design/design-system.md**: update the token tables in §3.2
    and §3.4 and the \"compact corners\" wording, and record the
    decision.

9.  **Sign-in page (infra/keycloak/themes/sre/login/ and
    infra/pilot/demo-login/)**: it has its own token set. Moving it to
    emerald and gold is a separate small task; ask the owner before
    starting it.

## Delivery and sign-off

Work on a branch and merge through a pull request with all checks
passing, as CLAUDE.md requires. Update docs/traceability.md and
docs/STATUS.md, and write a plain-English summary for the owner.

**Done when:**

-   [ ] Every token in the Colours table matches in both sets, and the
    four gold tokens exist.

-   [ ] Fonts load from the app\'s own files with the network cut off:
    till, handhelds, kiosks and back office.

-   [ ] All unit, guardrail and end-to-end tests pass, including the
    accessibility audit at 1366, 1024 and 360px in English and Tamil.

-   [ ] No page scrolls sideways, and no control is under its target
    size.

-   [ ] A low-spec Android phone opens the till and a handheld no slower
    than before.

-   [ ] Screenshots of the till, Today page, a register and the price
    kiosk in light and dark, attached to the pull request.

**What the owner checks in the store:**

1.  Open the till with the internet unplugged. The text is in the new
    font and Tamil shows no boxes.

2.  Compare the screens with the SRE Retail OS design system page: ivory
    background, emerald menu, gold SRE badge, pill buttons.

3.  Stand at arm\'s length under the shop lights. Prices, totals and
    warnings read clearly, with no glare or shine.

4.  Make an item go \"Not known\". The warning is burnt amber with its
    word and icon, and does not look like the gold.
