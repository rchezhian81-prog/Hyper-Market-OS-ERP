# Sheet 4 — When a cashier forgets their PIN

**Sheet id:** SOP-04 · **Rules:** hard rule 4 (no shared logins), ADR-0020 (till PINs) · **Language:** English (Tamil:
`sop-04-forgotten-pin.ta.md`)
**For:** the cashier (steps 1–3) and the owner (steps 4–7).

**The cashier:**

1. Do not keep guessing. **Five wrong PINs lock your staff ID for fifteen minutes**, and twenty failed sign-ins lock
   the whole till's sign-in for fifteen minutes.
2. **Never use someone else's staff ID or PIN**, and never let anyone sign in for you.
3. Tell the owner. Until you have a new PIN, bill on the old till as always and do not key the new till: write the time
   in Sheet 1's table, with "no PIN" in the middle column.

**The owner:**

4. In **your own** Windows account (never the cashier's `Till` account), open PowerShell in the system's folder
   (`C:\SRE`, or the newer release folder after an update) and type, with the cashier's staff ID and your own name:
   ```
   pnpm run till:pin -- --user <their-staff-id> --by "Your Name"
   ```
5. The window says `<their-staff-id>: please come to the keyboard. Everyone else, look away.` **Give the keyboard to the
   cashier and look away.** The cashier types their new six-digit PIN and presses Enter — it shows only as stars — then
   types the same PIN again and presses Enter. They choose six digits nobody could guess: not a birthday, not a phone
   number, not 123456.
   - **When it worked:** `Till PIN for <their-staff-id> set: <their-staff-id> typed it themselves …`. The PIN is never
     on the screen, so nobody else sees it — not you either. They do not write it down or tell anyone. The old PIN stops
     working at once — at the till and, for a manager, on the office screens.
   - **If it says** `The two did not match` or `That was not 6 digits`, the cashier types it again (three tries). After
     three, nothing was changed: type the same line again.
6. If the PIN may be known to someone else, or the person is leaving, use the same line with `--revoke` at the end
   instead. Their next sign-in is refused.
7. Write in the workbook: the date, the staff ID, "new PIN set by the person" or "PIN revoked", and your initials.
   **Never the PIN itself** — you never saw it.
