# ADR 0030 — The store computer's shop-network door speaks TLS only, under a signing authority the store computer makes for itself and each device trusts once, at enrolment

- **Status:** Accepted (owner decision OB-422, 27 October 2026, in writing: "encrypt it: the store computer makes its own
  certificate at install; each device trusts it once at enrolment; plain http on the shop network is refused"). Extended
  by owner decisions OB-424 (the seal reaches a new handheld by a QR code on the store PC's own screen) and OB-425
  (self-checkout and the price kiosk stay on their own PC's loopback), both 27 October 2026.
- **Date:** 27 October 2026
- **Context:** The device socket (ADR-0019 §1, `edge/store-edge/src/device-server.ts`) is the store computer's one door on
  the shop network. The warehouse, picker and driver handhelds hand their work through it, and since ADR-0028 the queue
  till takes card and UPI sales through it (`queue-pos-door.ts`). It spoke plain HTTP: the device cookie, the phone
  holder's session and every hand-over were readable by anything that could read the staff wifi's traffic. ADR-0019 and
  ADR-0028 recorded that as a known limit, held only by an operator control (a staff-only WPA2/WPA3 network, OA-16).
  A shop has no public DNS name for its store computer and must keep trading with no internet (P-01), so a certificate
  from a public authority is not possible; and a self-signed certificate each device has to "click through" teaches
  staff to accept any warning, which is worse than nothing. The till's own sale path (the lane socket) and the screens
  are on the PC's loopback and never cross the shop network (ADR-0004, hard rule #1).

## Decision

1. **The door speaks TLS only.** The device socket is an https server (TLS 1.2 or newer, ECDSA P-256) behind a small
   front on the same port that reads the first byte of each connection: a TLS handshake goes to the https server; any
   other bytes are plain text and are answered with `426 Upgrade Required` and a refusal in words (English and Tamil),
   then closed — nothing in the request is read, nothing is served, no cookie is set. There is no plain-http device
   socket at all, on loopback or on the shop network. Its cookies (`sre_device`, `sre_operator`) are now `Secure`.
2. **The store computer is its own small signing authority** (`device-certificates.ts`, `device-tls.ts`). At install
   (`till:install --device-port … --device-host …` runs the built edge's `device-authority` command) — or at the first
   start of a store computer installed before this — it makes an EC P-256 key pair and a ten-year authority certificate
   for it. Its private key is written owner-only into `EDGE_DEVICE_TLS_DIR` (default `<EDGE_DATA_DIR>-device-tls`,
   BESIDE the till's data folder, never inside it) and never leaves that folder: never in the repository, a log, a boot
   line, a backup bundle or a reply. The backup refuses to run if the folder is ever named inside the data folder.
3. **The authority may vouch for the shop only.** Its certificate carries critical name constraints: `localhost` and
   the private and loopback IPv4 ranges (10/8, 172.16/12, 192.168/16, 127/8). A certificate it signed for any other
   name or address is refused by the device's own TLS check, so a stolen store-computer key cannot be used to listen in
   on a handheld's other traffic. The door is only opened on loopback or a private shop address; a public address or a
   host name in `EDGE_DEVICE_HOST` keeps the door shut and the boot log says why.
4. **The door's certificate is the box's to renew.** It is signed by the authority for `localhost` and the door's
   address, for 90 days. The box checks it at every start and every six hours while it runs and renews it when fewer
   than 30 days are left, when it does not cover the address the door is opened on, or when its key and certificate do
   not belong together. The renewed certificate is put in place without closing the door. Because devices trust the
   AUTHORITY, every enrolled device keeps working through a renewal with nothing done to it. Every creation and renewal
   is appended (fsync'd, fingerprints and dates only) to `device-tls-history.log` in the folder.
5. **Each device trusts the authority once, at enrolment.** The person setting a handheld up installs the PUBLIC
   `authority.crt` on it as a trusted certificate authority and checks the fingerprint the store computer showed at
   install (and in its boot log) before trusting it. From then on the browser checks the door's certificate itself; no
   warning is ever clicked through. How the authority file reaches the device is decided by OB-424 (below).
6. **Never repaired silently.** An authority that is there but broken — one half missing, a key that is not its
   certificate's, past its end — is never replaced or "repaired" by the box: that would silently change what every
   handheld trusts. The door stays shut, the till keeps selling on its loopback (hard rule #1), and the boot log and the
   store computer's doctor say what to do. Replacing the authority is a deliberate act, followed by re-enrolling every
   handheld.
7. **The loopback stays as it is.** The lane socket (the till's sale path) and the screens server stay plain http on
   the PC's own loopback: no sale ever waits on a TLS handshake or a certificate (hard rule #1).

## Decision OB-424 — the seal reaches a new handheld from the store PC's own screen

- **Owner decision OB-424, 27 October 2026, in writing:** the seal (the authority certificate) reaches a new handheld by a
  QR code on the store PC's own screen; staff compare the code by eye; the manual cable copy stays as the fallback.
- **Where:** a "Handheld seal" page, `/handheld-seal/`, on the store PC's own **screens server** — plain http on the PC's
  loopback only (ADR-0004), the same socket as the manager's screens (`edge/store-edge/src/handheld-seal.ts`, wired in
  `screen-server.ts` and `main.ts`). It is **not** on the shop-network door: the door does not serve it (a device that
  trusts the door gets no page and no file from it, and plain http is refused with 426, as for every path), and **no new listener** was opened for it. With
  the office PIN on (`EDGE_OFFICE_SIGN_IN=pin`) the page is for a person signed in to the office screens.
- **What it shows — public material only, never a key:**
  1. `authority.crt` as a download (`/handheld-seal/authority.crt`, `application/x-x509-ca-cert`, DER). DER is the form
     Android's *Install a certificate → CA certificate* takes (PEM is also accepted; DER is the one every Android, iOS and
     Windows installer reads). It is the cable / file-share copy — the fallback that stays.
  2. A QR code **that carries the certificate itself** (its PEM text: 839 characters, a version-20 symbol at level L, 97
     modules a side, drawn by the product's own encoder `packages/receipt/src/qr-code.ts` — no new dependency).
  3. The short code staff compare by eye: the first four and the last four pairs of the certificate's SHA-256
     fingerprint (`AB:12:CD:34 … 9F:00:11:22`), with the full fingerprint beside it — the same fingerprint Android shows
     in the installed certificate's details, so staff find the code at its start and end.
- **Why the QR carries the certificate and not an address.** A phone that does not yet trust the door cannot fetch
  anything from this PC: the screens are loopback-only (a phone cannot reach them), and the door is exactly what it
  cannot trust yet (and must never be told to click through a warning). A QR of an address would point nowhere the phone
  can reach — or would need a new shop-network listener, which OB-424 rules out. A QR of the certificate needs no network
  at all: the lit screen is the channel, and the code compared by eye proves the phone holds what this box's door
  presents. Considered and not chosen: a QR of the fingerprint only (it delivers nothing to install); a QR of a
  `data:` URL (Chrome does not open a `data:` address typed or scanned at the top level, so it cannot be relied on).
- **Honest limit of the QR on a stock phone.** Android's own camera reads the QR as *text*. To install it the phone
  needs a QR app that saves what it reads as a file (`authority.crt`) — or the file comes by cable. The page says both,
  in English and Tamil. Not yet tried on the shop's own handheld model (see Known limits in the in-store install runbook).
- **Never a made-up seal.** The page reads the authority from the RUNNING door, re-checks it (exactly one certificate,
  no key in the text, an authority, its own SHA-256 equal to the door's), and otherwise says in plain words, English and
  Tamil, why there is no seal: no handheld door on this box; the door shut (with the box's own reason — a missing key, a
  public host); still starting; or a seal that does not agree with itself. It then shows no QR, no code and no download.
- **Proof:** `tests/unit/ob424-the-handheld-seal-panel.test.ts` (the panel's data, the QR read back by a separate reader
  `tests/support/qr-reader.ts`), `tests/integration/ob424-the-store-pcs-own-screen-hands-a-handheld-the-seal.test.ts`
  (the real box: the download is the issuer in the door's own chain; a device trusting only what it took from the screen
  opens the door; no private key anywhere; the door does not serve it; no door / broken lock says so; office PIN), and
  `tests/e2e/ob424-the-handheld-seal-on-the-store-pcs-screen.e2e.ts` (a real browser sees the QR, the code and the link,
  and downloads `authority.crt`).

## §19-substitution impact

Not a §19 substitution (the same Node process and containers; Node's built-in `crypto`/`tls` only — no new dependency).
Recorded on the six axes because the owner asked for them:

- **Offline:** nothing needs the internet — the authority, the certificate and its renewal are all made on the box; a
  handheld checks the certificate against the authority it already holds. The till's sale path is untouched.
- **Support:** one extra step when a handheld is set up (trust the authority file, compare the fingerprint). Renewal is
  automatic. The doctor shows the lock's state (FIX when missing, near its end, readable by others or inside the data
  folder; NEEDS-YOU a year before the authority ends). Losing the folder (a new PC, a disk failure) means a new authority
  and re-enrolling every handheld — the price of the key never leaving the box.
- **Security:** the cookies, the phone holder's session and every hand-over and handheld sale now cross the wifi
  encrypted and authenticated; plain http is refused; the authority is name-constrained to the shop; private keys are
  owner-only and outside every backup. The staff-only wifi (OA-16) stays as defence in depth, no longer the only control.
- **Cost:** none — no certificate is bought; the store computer is its own authority.
- **Portability:** standard X.509 / PEM files and TLS 1.2+; any browser or OS that can install a CA certificate works.
- **Maintainability:** a small hand-written DER encoder (Node cannot write certificates), checked in the tests by Node's
  own `X509Certificate` and by OpenSSL, including OpenSSL refusing a certificate signed outside the name constraints.

## What this decision does NOT do

- **It does not put the seal on the shop network.** OB-424 hands it over from the PC's own screen (above); the door
  still serves nothing to a device that has not trusted it, and the manual cable copy and fingerprint check stay as the
  fallback.
- **The self-checkout lane and the price kiosk are not on the shop network** (owner decision OB-425, 27 October 2026):
  each runs on a PC that is its own store computer, served by its own loopback screens server
  (`self-checkout-screens.ts`), so nothing of theirs goes over the shop wifi and their serving is unchanged; putting
  either on a separate wifi device would be a new door and a new owner decision.
- **Replacing the authority itself** (after ten years, or after a lost or broken folder) is a deliberate act with
  re-enrolment; the box warns a year ahead and never does it alone.

## Consequences

- ADR-0019's "No TLS on the shop-network leg yet" and ADR-0028's plaintext consequence fall away; both are amended to
  point here.
- Every browser test of a handheld, the queue till and the shop floor now runs over https and trusts exactly that box's
  authority's key (Chromium `--ignore-certificate-errors-spki-list=<the authority's key pin>`), never "ignore errors".
- A handheld on https gets a secure context, so its service worker and offline caching work on the shop network too.
- A store computer whose lock cannot be made or read opens no handheld door — the handhelds keep their queued work on
  the phone (ADR-0019) until it is fixed; the till sells regardless.

## Reconsider-when

- The shop gets a real DNS name and a reachable ACME authority (the box could then hold a public certificate).
- Head office issues per-store authorities (a second store; devices shared between stores — ADR-0019's own trigger).
- A handheld model whose installer cannot take the certificate from a QR app or a cable copy (OB-424 may need another
  route, e.g. head office carrying the authority with the enrolment code).
