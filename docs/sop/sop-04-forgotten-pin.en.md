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

4. In **your own** Windows account (never the cashier's `Till` account), open PowerShell in `C:\SRE` and type, with
   the cashier's staff ID and your own name:
   ```
   C:\SRE\till\start-till.cmd till-pin --user <their staff id> --by "Your Name"
   ```
5. The new six-digit PIN appears **once**. **This window holds a secret: never photograph it.** Tell the cashier the
   PIN face to face. Do not write it down for them, do not send it by phone or message. The old PIN stops working at
   once.
6. If the PIN may be known to someone else, or the person is leaving, use the same line with `--revoke` at the end
   instead. Their next sign-in is refused.
7. Write in the workbook: the date, the staff ID, "new PIN given" or "PIN revoked", and your initials. **Never the PIN
   itself.**
