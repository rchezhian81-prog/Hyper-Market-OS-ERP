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
