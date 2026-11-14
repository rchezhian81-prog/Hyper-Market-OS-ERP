# Licensing — selling SRE Retail OS to other shops (CR-01 step 5 · OI-10 · M33-FR-04 · OB-710)

_For the owner (the seller). Plain words. Decisions OB-710 (licensing, decided), OB-714 (code-signing certificate before
the first sale, decided), OB-750 – OB-752 (warning and grace, reduced mode, a new shop's setup period — **open**)._

## How it works, in one paragraph

You hold one **master key**. It lives on your own USB drive and on a sealed sheet of paper in the safe — never on a shop's
PC, never in the code, never in an e-mail. With it you make a **licence file** for each shop: it names the shop's tenant id,
its name, its GSTIN, how many tills and stores, which modules, and the last day. Every copy of the program carries only the
**public** half of your key, and checks the licence with it **without the internet**. A licence that was forged, edited
(even one letter) or copied from another shop is refused and the screen says which. When a licence ends, the shop is
warned, then has a grace period, then goes into reduced mode — but the till **always** sells and the shop can **always** see
and export its own records. Renewal is a new licence file loaded on the Licence screen: no code, no reinstall.

## What you need

- Your own computer (not a shop's PC), with Node.js 22 installed (one installer from nodejs.org), and a copy of this
  project's `scripts` folder — Claude will give you a ZIP with exactly what is needed when you are ready.
- A USB drive that stays in the office safe.
- Paper, a pen, and two envelopes.

## Step 1 — make the master key (once, about 10 minutes)

1. Put the USB drive in your computer. Say it is drive `E:`.
2. Open PowerShell in the folder with the scripts and type:
   `node scripts\licence-desk.mjs make-key --folder E:\SRE-licence-key`
3. It asks for a **passphrase** twice — at least 12 characters (a short sentence you will remember is good). Nothing you
   type is shown. **Write the passphrase by hand on a sheet of paper** and put it in envelope 1. Seal it.
4. It says `KEY MADE — key id …` and writes three files on the USB drive:
   - `sre-licence-seller-key.pem` — the master key, locked with your passphrase. Leave it only on this USB drive.
   - `licence-signing.pub` — the **public** key. Not a secret. Send it to Claude (or attach it in the chat): it is committed
     at `infra/licence/licence-signing.pub` through a pull request, and every release built after that carries it.
   - `PAPER-BACKUP-<key id>.txt` — **print it**, put the printout in envelope 2, seal it, then delete the file.
5. Both envelopes go in the safe. Anyone with both could make licences in your name; with only one, nobody can.

The tool refuses to make the key inside a code folder (so it can never be committed by mistake) and refuses on a shop's PC.

## Step 2 — your own shop's owner licence (the same day the public key is committed)

Once releases carry the public key, every shop needs a licence — yours too. Your shop keeps trading meanwhile (the setup
period, OB-752). On your own computer:

`node scripts\licence-desk.mjs issue --key E:\SRE-licence-key\sre-licence-seller-key.pem --owner --tenant <your tenant id> --shop "SRE Hyper Market" --gstin <your GSTIN> --tills <number> --stores 1 --modules all --out E:\licences`

Your tenant id is on the store PC: Office → About (or the Licence screen). It asks for your passphrase. It writes
`E:\licences\licence-sre-hyper-market-LIC-….json`. Then on the store PC: **Office → About → Licence → choose the file →
type your PIN → Load the licence**. The screen turns green: *Owner's licence — no end date*.

## Step 3 — a new shop you sell to

1. The new shop runs `SRE-Setup.exe`. At the end, the setup screens show **The licence** with its tenant id and a button
   **Save the licence request**. They send you that small file (WhatsApp or e-mail is fine — it holds names only).
2. You issue its licence from the request:
   `node scripts\licence-desk.mjs issue --key E:\SRE-licence-key\sre-licence-seller-key.pem --request <their request file> --tills 3 --stores 1 --modules all --expires 2027-11-30 --out E:\licences`
3. Send them the licence file. They load it on the last setup screen, or later at Office → About → Licence (the owner of
   that shop, with his own PIN). Every licence you issue is also listed in `issued-licences.log` beside your key.
4. Before the first sale to another shop: buy the code-signing certificate (OB-714), and have your CA and lawyer prepare
   the licence agreement, GST on software sales and the data-protection terms (OB-710).

## Renewal

Issue a new licence for the same tenant id with a later end date; the shop loads it on the Licence screen. The old one is
kept in the shop's licence history; an older licence can never replace a newer one.

## What the shop sees as the end date comes near (proposed — OB-750 – OB-752, waiting for your choice)

| When | What happens | Till sells? | View and export? |
|---|---|---|---|
| More than 30 days before the end | Licensed (green) | Yes | Yes |
| The last 30 days | An amber notice on every office page and the owner's phone | Yes | Yes |
| Up to 30 days after the end (grace) | Amber notice: "ended — grace period, N days left" | Yes | Yes |
| After the grace (reduced mode) | Red notice; **no new software version** can be installed until a licence is loaded | **Yes** | **Yes** |
| A new shop before its licence arrives | The same 30-day setup period, then reduced mode | Yes | Yes |

Reduced mode starts at the start of a shop day, never in the middle of one, and ends the moment a licence is loaded.

## Check a licence file yourself

`node scripts\licence-desk.mjs show <licence file> --public-key E:\SRE-licence-key\licence-signing.pub` — says what it
names and `SIGNATURE CHECKS`, or that it was forged or edited.

On the store PC (administrator): `store-computer licence` (its standing), `store-computer licence --load <file>`,
`store-computer licence --request` (writes the request to send you).

## If the key is lost or leaked

- **Lost USB drive, paper safe:** type the numbered lines of the paper backup into a text file (each line ends with a
  4-character check; a typing slip is named by its line) and run
  `node scripts\licence-desk.mjs restore-key --from <that file> --folder <new folder on a new USB drive>`.
  It still needs your passphrase (envelope 1).
- **Leaked (someone else has the key and the passphrase):** tell Claude the same day. A new key pair is made (step 1), its
  public key is committed, and a release is published. Every shop then needs a new licence from the new key (issue them
  from your `issued-licences.log`); licences signed with the old key stop working after that update. Record it as a
  security incident.

## Honest limits

A licence checked on a PC the buyer controls stops honest mistakes and casual copying, and makes misuse a clear breach of
the licence agreement; it cannot stop a determined technician who edits the program itself. The agreement your lawyer
prepares is what protects you there. The licence never holds a secret, and the shop's data is always its own.
