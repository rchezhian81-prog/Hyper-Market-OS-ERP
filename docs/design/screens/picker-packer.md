# Screen spec — Picker / Packer (Stage 3)

- **Surface:** Picker/Packer (§27) · **Modules:** M19, M18, D09 · **Design bar:** assigned work on a handheld, offline; every pick is a scan; a substitution is controlled and visible, never silent.

> Built on `../design-system.md`. Runs on a **low-spec Android handheld** — large,
> glove-friendly targets, offline-first.

## Screens & states (§27 Picker/Packer row)
My waves / assigned work · Pick list · Item scan & substitution ·
Weighed final price · Quality check · Packing (cold-chain/tamper) ·
Dispatch manifest. All handle the §27.1 states.

## Pick → substitute → pack (M19 / D09)
- Assigned wave/single picking: **scan bin → scan item → confirm**; a short-pick opens a
  **controlled substitution** flow tied to the customer-approval rule (A04) — never the
  picker's silent choice.
- Weighed items capture the **final price** at pick (D09); a quality check precedes pack.
- Packing records temperature/cold-chain and tamper-evidence; a dispatch manifest is
  generated for the driver.
- **Interaction budget (≤3):** pick a line (≤3: scan bin → scan item → confirm) ·
  record a substitution (≤3) · flag a quality fail (≤2).

## Offline / state (§31 picking row)
- Assigned work is **cached offline**; scans, quality results and proof **queue** and sync;
  **location and PII are minimized** on the device; conflicts surface as exceptions on sync.

## Acceptance (QG-02)
- A picker completes an assigned wave with no network.
- A substitution cannot commit without the customer-approval rule.
- Weighed final price and cold-chain evidence are captured.
- The dispatch manifest matches exactly what was packed.

## Measured (Stage G slice 4)
Counted in a real browser at a handheld's size (`tests/e2e/the-handhelds-meet-the-spec.e2e.ts`): pick a line **3**
(the bin label scanned from the list is step 1 — the scan chooses the line — then the item, then one tap on the
asked-for quantity) · record a substitution **3** (Substitute on the item panel → scan the swap → scan the customer's
reference) · flag a quality fail **2** (Problem on the item panel → the reason). **Listed exception:** a bin whose
label cannot be read is started by a tap on the line, then the three steps — **4**.

## Sync — where each piece of work is (SP-3c-i, 1 Oct 2026)

The handheld is served by the store computer's **device socket** (ADR-0019): it enrols once with head office's one-time
code and is sent back to this screen. Every line outcome and the crate's pack are queued on the device first, handed to
the store computer after each accepted action and every ten seconds, and relayed by it to head office's wave register
(`/v1/fulfilment/waves/:waveId/lines/:lineId/synced`, `/v1/fulfilment/waves/:waveId/packed/synced`). Below the lines,
**Sent from this handheld** lists each piece of work with one of the five shared state words — *saved here · retrying ·
with the store computer · posted · refused* (with the reason) — and the badge counts them by state. The device's own
"saved" is never shown as "sent": only the store computer's word says head office has it (P-08). Head office re-verifies
the picker and the packer from their own grants and compares the pack with the line outcomes it holds; a disagreement is
recorded and said, never silently accepted. Nothing on this screen moves stock.
