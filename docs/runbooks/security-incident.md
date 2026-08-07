# Security incident and data breach runbook

**SEC-10 · PRV-09 · C-05 (CERT-In) · M34-FR-04.** Written to be followed at 9pm by someone who
is not a programmer. If any step here does not work exactly as written, that is a defect in this
runbook — report it, do not improvise.

> **The rule this whole document exists for: the clock starts when you NOTICE, not when you
> understand.** CERT-In gives six hours from becoming aware of a reportable incident. The
> universal mistake is to spend the first five hours working out what happened, so that the
> report is late and the lateness is now a second problem on top of the first. **Report on what
> you know. Update it later.** An incomplete report filed at hour two is correct procedure; a
> complete one filed at hour nine is a breach of the rules about breaches.

---

## Part 0 — The first ninety seconds

Do these three things before anything else, in this order. Do not investigate first.

1. **Write down the time.** The actual clock time you first became aware. This one number decides
   every deadline below, and it is the one nobody can reconstruct afterwards.
2. **Do not switch anything off, delete anything, or "clean up".** Evidence lives in logs, in
   memory and in the audit trail. Turning a machine off to be safe destroys the record of what
   happened on it. If something must be isolated, unplug its **network cable**, not its power.
3. **Tell the second custodian** (D4, Mr Sivakumar) and the owner. Two people, both awake, from
   the start. Not a message to a group.

**The shop keeps trading.** The till works with no internet and no cloud (P-01, hard rule #1).
Nothing in this runbook is a reason to stop selling unless Part 3 says so explicitly.

---

## Part 1 — Is this actually an incident?

| What you are seeing | Incident? | First action |
| --- | --- | --- |
| Someone signed in as another person | **Yes** | Part 2 |
| A customer says they received someone else's receipt, order or data | **Yes — and a likely breach** | Part 2, then Part 4 |
| Card details appear anywhere on a screen, a printout or a file | **Yes, critical** | Part 2, then Part 5 |
| A device is missing, stolen or was taken home and not returned | **Yes** | Part 2 |
| Ransom message, files renamed, files you cannot open | **Yes, critical** | Part 3 first |
| Payments or refunds you cannot account for | **Yes** | Part 2 |
| An unfamiliar person had access to the back office or the server | **Yes** | Part 2 |
| Internet down; till still selling | No — that is normal operation | `backup-and-recovery.md` |
| Sync badge amber with sales waiting | No — that is the system working | Watch it clear |
| One report shows a number somebody disputes | Not yet | Raise it as a variance |

**When unsure, treat it as an incident.** The cost of opening one that turns out to be nothing is
an hour. The cost of not opening one is the six-hour clock running while nobody is counting.

---

## Part 2 — Contain, without destroying the evidence

Do these in order. Each is one action, and none of them requires understanding the cause.

1. **Suspend the account involved** — do not delete it. A deleted account takes its history with
   it, and the history is the investigation.
2. **Pull the AI kill switch** if any AI assistant is involved or might be. It needs nobody's
   approval and stops instantly. Your morning brief still arrives.
3. **Unplug the network cable** of a machine you believe is compromised. Leave it powered on.
4. **Take a backup now**, before anything else changes — `backup-and-recovery.md` Part 3. Label it
   with the word `incident` and the date.
5. **Write down what you did and when.** Every step, with times. You are creating the record that
   the report in Part 4 is built from, and memory at midnight is not a record.

**What you must never do**, however sensible it feels at the time:

- Never delete audit records, dead-letter items or migration exceptions (hard rule #6). They are
  the only account of what happened.
- Never let anyone "fix it quietly" and tell you afterwards.
- Never re-use the password that was involved anywhere else.
- Never email or WhatsApp customer data to anybody while investigating, including to yourself.

---

## Part 3 — If files are locked or renamed (ransomware)

This is the one case that comes before containment, because the damage is still spreading.

1. **Unplug the network cable from every affected machine.** Immediately. Do not wait to confirm.
2. **Do not pay anything, and do not reply.**
3. **Do not touch the backups.** Off-site backups are separate on purpose (SEC-08). Connecting to
   them to "check they are safe" is how they stop being safe.
4. **Keep selling.** The till holds three days of trading offline (§32) and its data is local.
5. Then Part 2, then Part 4.

---

## Part 4 — The reporting clock

Two separate obligations, two separate clocks, and they start at the **same** moment: when you
became aware.

| Obligation | Deadline | What it covers |
| --- | --- | --- |
| **CERT-In** (C-05) | **6 hours** | Cyber-security incidents — unauthorised access, data breach, ransomware, identity compromise |
| **DPDP Act — Data Protection Board** | **Without delay**, as prescribed | Any personal-data breach |
| **Affected customers** | **Without delay** | Personal-data breach affecting them |
| **Payment provider** (EX-03) | Immediately | Anything touching payments or card data |
| **Your CA / auditor** | Same day | Anything touching money, stock valuation or tax records |

**Report on what you know.** A first report reasonably says: *"At 20:40 on 7 August we became
aware that a staff account was used from an unrecognised device. The account is suspended. We do
not yet know what was accessed. We will update within 24 hours."* That is a correct report.
Waiting until you can write a complete one is the mistake.

The system can produce the evidence: the audit trail is append-only and tamper-evident (M34,
SEC-07), so *"what did that account touch, and when"* is a question with an answer. Ask for the
audit export for the account and the time window; do not attempt to reconstruct it by hand.

---

## Part 5 — If card data is involved

Hard rule #3: this system **never stores a card number, CVV or expiry date** — only provider
tokens, and `packages/tender` has nowhere to put anything else. So if card data has appeared
somewhere, it did not come from the system's storage. It came from a screen, a printout, a
photograph, a note, or a device outside the system.

1. Tell the payment provider immediately. They have their own procedure and their own clock.
2. Secure the physical thing — the printout, the note, the phone.
3. Do **not** copy the data anywhere while investigating, including into an email describing it.
4. Record where it came from. That is the actual defect, and it is a process defect, not a
   software one.

---

## Part 6 — Closing the incident

An incident is not closed when it stops. It is closed when all five of these are true:

1. The cause is written down in plain English.
2. The **control that should have caught it** is named — and if there is not one, that is the
   finding, and it becomes a remediation item (M34-FR-04).
3. Any reports required in Part 4 have been filed, and the reference numbers recorded.
4. Affected people have been told, if any were affected.
5. The incident, its control and its remediation are linked in the register — an incident with no
   linked control teaches nothing, and the same thing happens again in eighteen months.

**Evidence is retained permanently.** Hard rule #6. Not until the investigation ends, not until
the auditor is satisfied — permanently. An open critical risk blocks its quality gate (M34-FR-04),
which is deliberate: a gate that can be passed with an open critical incident is not a gate.

---

## Part 7 — What the owner personally must do

You are not expected to diagnose anything. Four things are yours and cannot be delegated:

1. **Note the time you were told.** Yours is the time that counts if anybody's is disputed.
2. **Decide whether to report.** The technical people advise; the obligation is the business's.
   When it is borderline, **report.**
3. **Decide whether to tell customers**, and approve the words. Nobody sends anything to a
   customer about their own data without you.
4. **Ask, at the end: which control should have caught this?** If the answer is *"none"*, the
   incident is not finished. If the answer is *"one we switched off because it was annoying"*,
   that is the real finding.

## Part 8 — What to check every quarter, before you need this

- **Is the phone number for CERT-In and the payment provider written down somewhere not on the
  system?** A contact list stored only inside the thing that is down is not a contact list.
- **Has a backup been restored in the last three months?** (AID-10, `backup-and-recovery.md`.)
  A backup nobody has restored is a file and a belief.
- **Can you pull the AI kill switch yourself, without help?** Try it. It should take seconds and
  need nobody's approval.
- **Is the incident register empty?** If a shop has had no incidents at all in a year, the more
  likely explanation is that nobody is recording them.

## Related

- `backup-and-recovery.md` — restoring, and the manifest that proves a restore is complete
- `environments-and-secrets.md` — where credentials live and how they are rotated
- `../security/threat-privacy-model.md` — the trust boundaries and what an attacker would target
- `../registers/compliance.md` — C-05 (CERT-In) and the other obligations, each with a named owner
- `../registers/risks.md` — open risks, and which gate each one blocks
