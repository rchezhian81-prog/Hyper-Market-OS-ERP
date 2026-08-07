# The cutover weekend — hour by hour

This is the plan for the weekend the shop stops using the old system and starts using this one.

`extraction-work-plan.md` is what happens in the **weeks before**. This page is the weekend itself:
what happens, in what order, who does it, and — the part that matters most — **when we stop and go
back**.

Nothing here is a decision to be taken on the day. Everything on this page is decided now, while
nobody is tired.

---

## Before you read the timings: the two things that decide everything

**1. There is a point of no return, and it is late on purpose.** Right up until the shop opens on
Monday morning, the answer to "should we go back?" is *yes, and it costs us a weekend*. After the
first real sale on Monday, going back means reconciling two systems. So the decision to open on the
new system is taken **on Monday morning, with the checks in front of you**, not on Saturday when
the load finishes and everybody is pleased with themselves.

**2. The old system is not switched off.** It is switched to **read-only** and kept, running, for
at least ninety days. It costs nothing to leave it there and it is the only thing that makes "go
back" a real option rather than a thing we say.

---

## Who needs to be there

| Role | Who | When |
| --- | --- | --- |
| **Decision** | The owner | Saturday evening, and Monday 06:00 |
| **The run** | Whoever is doing the extraction and load | Friday close → Sunday |
| **Second technical custodian** | Mr Sivakumar (D4) | Present for the load, so two people have seen it |
| **The books** | The CA | Sunday, remotely, for the opening-balance check |
| **The floor** | Shift-in-charge for Monday | Sunday afternoon, for the walk-through |

Nobody does the cutover alone. Not because of trust — because at 2am one person cannot see their
own mistake.

---

## Friday

### Friday, before close — the last ordinary day

- [ ] **Trading continues as normal.** Nothing changes for anybody on the floor today.
- [ ] Take the **final delivery** of the week and receive it **on the old system**. A delivery
      half-received across two systems is the single messiest thing that can happen this weekend.
- [ ] Stop raising new purchase orders on the old system from midday. Anything urgent waits until
      Monday.
- [ ] Confirm the **rehearsal has been run at least twice** end to end, and that the exception list
      from the last rehearsal is **shorter than the one before**. If it is not, the weekend does not
      go ahead — see *When to stop*, below.

### Friday, at close — freeze

- [ ] **Cash up on the old system, as normal.** This is the last day-close it ever does.
- [ ] **Take the untouched copy** (MG-02). Close the old system on *every* machine first, then copy
      before anything reads the data. Onto a separate drive. Nobody opens it.
- [ ] **Put the old system into read-only** if it can be. If it cannot, write on a sheet of paper
      taped to the back-office screen: *"Do not enter anything into this system. Ask before you
      touch it."* — and tell the Saturday staff in person.
- [ ] Note the time. Everything from here is "as at" that moment.

**Done when:** the copy exists, nobody has opened it, and no member of staff can enter anything into
the old system by accident.

---

## Saturday

### Saturday morning — extract and check

- [ ] Export every file, and run each one through the checker **as it comes out**:

      node --experimental-strip-types scripts/extract-check.mts <file> \
        --column "Item Code" --rows <the number you wrote down>

- [ ] **Do not argue with a REFUSED.** A short export is the dangerous one: it parses cleanly, its
      rows are well formed, and its own total agrees with the sum of its rows to the paisa. It is
      internally consistent about a shop a fraction of the real size, and the first person to
      notice is a customer whose item will not scan.
- [ ] Every file says **USABLE**, and the row count matches the number read off the screen before
      exporting.

**Done when:** every file is USABLE. Not "most of them".

### Saturday afternoon — load into the rehearsal environment

- [ ] Load. **Never into production** — the software refuses a production target before it checks
      anything else, on every request, and that is hard rule #7 rather than a setting.
- [ ] Read the exception list. Expect one. A load that produces no exceptions at all on real data
      is not a clean load, it is a load that is not looking.

### Saturday evening — the first decision point

The owner reads the exception list with whoever ran the load.

**The question is not "is it perfect?"** It is: **is every exception either fixed, or accepted in
writing, by name, in your own words?** "Approved" and "as discussed" are refused as reasons,
because in two years that sentence is the only record that you understood what was being carried.

- [ ] **Go**: continue to Sunday.
- [ ] **Stop**: the old system comes off read-only on Sunday morning and trades as normal on
      Monday. We have lost a weekend and nothing else. This is not a failure; it is the plan
      working.

---

## Sunday

### Sunday morning — the stock count

- [ ] Count. It does **not** have to be a full count: the software plans a value-weighted one —
      the high-value lines counted in full, a thin sample from everything else — which covers about
      80% of the money in a fraction of the hours.
- [ ] Three things the count insists on, and each matters:
      - the counter **never sees the expected number** (shown "expected: 40", people write 40);
      - **whoever ran the extraction cannot choose which lines get checked** — not dishonesty; you
        pick the lines you are confident about, and that is what confidence does;
      - what the sample suggests about the uncounted rest is reported as an **estimate**, never
        added to the counted figure to make one confident-looking total.

### Sunday afternoon — the six checks against outside evidence

Each is against a record somebody **outside** the old system keeps. A domain checked only against
the system it came from is refused by name.

| Check | Against |
| --- | --- |
| Stock | the shelves you just counted |
| Supplier balances | their own statements of account |
| Sales | the bank statement, running **past** the period end |
| Tax | the GST returns already filed, with acknowledgement numbers |
| Books | the accounts the CA signed, plus the journals-only list |
| Loyalty | a sample of customers, drawn **before** anybody is told anything |

- [ ] The **verification report renders**. It will not render until all twelve areas have an
      answer — a report over some of them looks completely finished and is not.
- [ ] The CA reviews the opening balances remotely and says yes or names what is wrong.

### Sunday evening — dress rehearsal on the floor

- [ ] One lane, one hour, **real staff, real items, no customers**. Scan fifty things. Take a cash
      sale, a card sale, a return, a weighed item, an age-restricted item.
- [ ] **Pull the internet out** and do it again. Every lane must keep trading (P-01, hard rule #1).
- [ ] Plug it back in and watch the sales arrive. Nothing lost, nothing doubled.
- [ ] Shift-in-charge walks the Monday plan with the staff who will be on.

**Done when:** the shift-in-charge says they are happy to open on it. If they are not, that is a
Stop, and it outranks everybody's schedule.

---

## Monday

### 06:00 — the real decision

Everything up to this moment is reversible at the cost of one weekend. This is where that stops
being true.

The owner asks four questions, and every answer must be yes:

1. Is the verification report signed — by me and by the CA — and does it say what could not be
   proved?
2. Is every blocking exception either fixed, or accepted by me in writing, in my own words?
3. Did the dress rehearsal work with the internet unplugged?
4. Is the old system still there, still readable, and would we know how to go back today?

**Any no is a Stop.** The old system comes off read-only and trades today. Nothing has been lost.

### 07:00 — open

- [ ] Open on the new system.
- [ ] **Both systems are watched, neither is used twice.** The old one is read-only and stays that
      way.
- [ ] Somebody technical is **in the building**, not on call, until close.

### Through the day

- [ ] **Every hour**: check the sync backlog and the exception list. A backlog that is growing
      rather than draining is the first sign of trouble and it is visible on purpose (P-08).
- [ ] **Middle of the day**: the first day-close figures are compared against the same hour last
      Monday. Not to prove them right — to notice if they are wildly wrong.
- [ ] **At close**: full day-close, cash counted, and the day's takings reconciled against the card
      settlement when it lands.

---

## When to stop — decided now, not on the day

Stop and go back if **any** of these is true. No judgement calls at 2am.

| Stop condition | Why it is absolute |
| --- | --- |
| Any export file is not USABLE | We would be trading on a fraction of the shop and would find out from a customer |
| The verification report will not render | Some domain has no answer. A partial report reads as complete |
| A blocking exception is neither fixed nor accepted **in writing** | In two years that sentence is the only record that anybody understood it |
| The dress rehearsal fails with the internet unplugged | Offline-first is the product. Without it there is no product |
| The shift-in-charge is not happy to open on it | They are the ones who will be standing there |
| The old system is not still readable | "Go back" would be a thing we say rather than a thing we can do |
| The latest rehearsal's exception list is **longer** than the previous one | Something is getting worse and we do not yet know what |

Going back costs a weekend. Going forward on any of the above costs the shop's trading week and its
reputation with customers who could not be served.

---

## The first ninety days

- The old system stays **readable and read-only**. It is not switched off, uninstalled, or wiped.
- Nothing is deleted: no exception, no dead-letter item, no audit record (hard rule #6).
- The **acceptances list is reviewed monthly**. Anything carried on the old system's word alone was
  a decision taken under time pressure, and each one deserves a second look when there is no
  weekend running.

---

## Related

- `extraction-work-plan.md` — the weeks before: what to gather and in what order
- `legacy-self-extraction.md` — the reference: routes, evidence, and why each rule exists
- `backup-and-recovery.md` — restoring, and the fact that an untested backup is not a backup
- `../evidence/example-verification-report.md` — the page that gets signed, worked through
