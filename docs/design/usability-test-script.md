# Printable usability test script (Stage 3, QG-02)

Use this to sit **behind a real cashier and a real purchase clerk** and watch them
use the prototype **without helping them**. The goal is to find where the design
fails a real person before a line of code is written.

> Print this. One sheet per person per session. Do not coach. Silence is data.

## Before you start
- Person: __________________  Role: ____________  Date/time: __________ (test at a busy time, e.g. 7pm)
- Device: ____________________ (use the **cheapest phone/terminal your staff actually use**)
- Language set to: ☐ English ☐ Tamil
- Tell them: "Do what you'd normally do. I won't help. There are no wrong answers — we're testing the screen, not you."

## What to record for every task
For each task, note: **time taken**, **number of taps/interactions**, and mark each:
- ✋ **Hesitation** (paused, unsure) — where?
- ❓ **Question** (asked how) — what did they ask?
- 🖊 **Pen reach** (reached for paper/calculator) — why?
- ❌ **Error / wrong path** — what happened?

## Cashier tasks (target: unsupervised billing within 30 minutes of training)
| # | Task | Target | Time | Taps | Notes (✋❓🖊❌) |
| --- | --- | --- | --- | --- | --- |
| 1 | Open the till / start a shift | ≤3 taps | | | |
| 2 | Bill a 10-item basket (scan) | fast, no help | | | |
| 3 | Sell a weighed item (e.g. vegetables) | ≤3 taps | | | |
| 4 | Apply a promotion / member price | automatic/visible | | | |
| 5 | Take a **split tender** (part cash, part UPI) | ≤3 taps to tender | | | |
| 6 | **Pull the network cable** mid-basket, finish the sale | completes + prints | | | |
| 7 | Suspend a bill and recall it | ≤3 taps each | | | |
| 8 | Process a return with a receipt | guided | | | |
| 9 | Read the screen: is it online or offline? How many sales unsent? | answered correctly | | | |
| 10 | Close the shift / blind cash count | guided, no expected shown | | | |

## Purchase / receiving clerk tasks
| # | Task | Target | Time | Taps | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | **Import an 80-line supplier invoice** in one go | correct; faster than today | | | |
| 2 | Receive a delivery on the handheld (scan, batch, expiry) | works offline | | | |
| 3 | Handle a short/damaged receipt (quarantine) | guided | | | |
| 4 | See a PO-GRN-invoice mismatch flagged | clearly shown | | | |
| 5 | Try to approve a large purchase without authority | **blocked** | | | |

## After the session — quick verdict
- Did they bill/receive **unsupervised**? ☐ Yes ☐ No
- Any action that took **more than 3 interactions**? List: ____________________
- Top 3 confusions to fix before build:
  1. ______________________________
  2. ______________________________
  3. ______________________________
- Would this person be comfortable using it on a busy day? ☐ Yes ☐ No — why: __________

_Feed every finding into the screen specs in `docs/design/screens/` before the Stage 3 gate is signed (QG-02: silence is not approval)._
