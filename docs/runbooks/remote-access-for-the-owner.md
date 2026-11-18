# Remote access for the owner — step by step

_OB-840 · ADR-0035 · your decision of 18 November 2026: "1A, 2A, 3A, 4A, 5A"._

**What you get:** on your phone, anywhere, you open your own web address, sign in with your password and the code from an
authenticator app, and see **Today**, the **reports** and your **approvals** — and approve or reject. Each approval is
recorded in your name, exactly as in the shop, with a mark that it was done remotely.

**What you do not get from outside:** the till, software update, users and roles, device setup, price publishing.
Those stay in the shop.

**How it works, in one line:** the store computer dials out to a small server you rent in India; your phone talks to that
server; the server passes your request down the store computer's own line. Nothing on the store computer is opened to the
internet, and your sales data stays on the store computer.

**When it does not work:** whenever the shop's internet or the store computer is off. **Selling is never affected.**

Where each step is done is marked:
- **[YOUR PHONE / LAPTOP]** — a web browser;
- **[SERVER]** — the rented server, through its own web console or an ssh window;
- **[STORE PC]** — the store computer in the shop, signed in as your own Windows account;
- **[PHONE]** — your phone.

> **Never paste a password, a key or a code into a chat, an email or a message — to anyone, including me.** Nothing in
> this guide asks you to. The two codes you compare (the link code and the pairing code) are not secrets, but you still
> only type them between your own screens.

> **Do NOT use the demo server you already rent.** Real shop data and test data are kept apart (hard rule 7). The setup
> refuses to run on it.

---

## 1. Rent the server [YOUR PHONE / LAPTOP]

Choose one (both are fine; pick the one you find easier to pay):

| Choice | Where | Plan | About |
| --- | --- | --- | --- |
| **A. DigitalOcean** | Region **Bangalore (BLR1)** | "Basic Droplet", **2 GB RAM / 1 CPU**, **Ubuntu 24.04** | about US$12 a month |
| **B. AWS Lightsail** | Region **Mumbai (ap-south-1)** | Linux, **OS only → Ubuntu 24.04**, the **2 GB** plan | about US$12 a month |

**Check the price on the provider's own page before you pay** — prices change.

When it asks how you will log in, choose **password** (or the provider's browser console). Write down the server's
**public IP address** (four numbers like `203.0.113.25`).

## 2. Buy the domain [YOUR PHONE / LAPTOP]

Buy a domain from any registrar (for example GoDaddy, Namecheap, BigRock, or the cloud provider itself). A name for the
office is fine, for example `office.yourshop.in` (a sub-name of a domain you own) or `yourshopoffice.in`.

Tell me **only the name**. Never send the registrar's password.

## 3. Point the domain at the server — the "A record" [YOUR PHONE / LAPTOP]

In the registrar's **DNS** page, add one record:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| **A** | the name (`office`, or `@` for the whole domain) | the server's public IP from step 1 | 600 (or the default) |

Wait **10 minutes**.

## 4. Run the setup on the server [SERVER]

Open the server's console (DigitalOcean: the droplet → **Console**; Lightsail: the instance → **Connect using SSH**).
Type these three lines, pressing Enter after each. Replace the three parts in `< >`:

```
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/rchezhian81-prog/Hyper-Market-OS-ERP.git /opt/sre-relay-src
sudo bash /opt/sre-relay-src/infra/remote-access/setup-relay.sh --domain <your domain> --email <your email> --tenant <your shop's tenant id>
```

- **Your shop's tenant id:** at the store computer, open `http://127.0.0.1:8091/about/` — it is the line "Tenant id". It is
  a name, not a secret.
- The setup takes about 5–10 minutes. It installs what it needs, turns the firewall on, makes this server's own
  passwords (kept on the server only, never shown), and starts everything.
- At the end it shows a **LINK CODE** like `7K2M-QX9T-4HNP`. **Write it on paper.** It is not a secret.

If it says **REFUSED** or **NOT DONE**, it says why in plain words; do what it says, or send me a photo of the screen.

## 5. Make your own sign-in [SERVER]

Still in the server console:

```
sudo sre-relay add-owner --person <your id in the shop system> --login <a sign-in name of your choice>
```

- **Your id in the shop system:** the store computer's **Users & roles** page shows it next to your name (it is the
  staff ID you type with your PIN).
- **Sign-in name:** your own, for example `rajesh.sre`. A job name like "owner" or "admin" is refused (no shared logins).
- It shows a **one-time password**, once. **Write it on paper**; do not photograph it or send it. You will change it at
  your first sign-in.

## 6. Install the authenticator app [PHONE]

From the Play Store, install **Google Authenticator** or **Microsoft Authenticator** (both free). Nothing to set up yet.

## 7. Turn on the link at the store computer [STORE PC]

Do this when the shop is quiet (ideally after the day is closed). Open **Windows PowerShell as administrator** and type
(replace the two parts in `< >`):

```
cd "C:\Program Files\SRE Retail OS"
.\runtime\node\node.exe scripts\store-computer.mjs remote-access setup --host <your domain> --code <the LINK CODE from step 4>
```

- It checks the code against your server. If the code does not match, it **refuses** and changes nothing — check you
  typed the code from YOUR server and the right domain.
- It then shows a **PAIRING CODE** like `R4TB-9WQC`. Leave this window open.

Now, back at the **[SERVER]** console:

```
sudo sre-relay approve-link
```

Type the **pairing code** the store computer shows. It says **APPROVED**. Within a minute the store computer connects.

- If a till was open, the store computer says the remote door opens after the till service restarts. Then, after the
  day is closed, run the same `remote-access setup …` line again (or `… remote-access on`), or restart the computer.

## 8. Check from your phone, on mobile data [PHONE]

1. **Turn Wi-Fi off** on your phone (so you are truly outside the shop).
2. Open `https://<your domain>/` in Chrome.
3. Sign in with your sign-in name and the one-time password from step 5.
4. It asks you to choose **your own password** (at least 12 characters). Choose one only you know.
5. It shows a **QR code**. In the authenticator app: **+** → **Scan a QR code** → scan it. Type the 6-digit code the app
   shows.
6. **Today** opens. Check: the sales figure matches the store computer; open **Approvals** and **Reports**.
7. Try something not allowed, for example `https://<your domain>/pos/` — it must say **"This page is not reachable from
   outside the shop"**.
8. Tap **Sign out** in the menu.

Every later sign-in: your password, then the 6-digit code from the app.

---

## What to check, and how (in the shop)

| What | How |
| --- | --- |
| The link is on | Today's bottom line says **"Remote access: connected."** |
| The link is down | It says **"Remote access: not connected since <time>."** Check the shop's internet; the store computer dials again by itself. |
| The link is off | It says **"Remote access: turned off."** |
| Selling is unaffected | With the internet unplugged, ring a bill at the till as usual. |
| Your remote approvals are marked | In **Approvals**, a decision you made from outside shows it was made remotely. |

## Turning it off, or on again [STORE PC]

```
.\runtime\node\node.exe scripts\store-computer.mjs remote-access off
.\runtime\node\node.exe scripts\store-computer.mjs remote-access on
.\runtime\node\node.exe scripts\store-computer.mjs remote-access status
```

`off` stops the link and keeps it from starting with Windows. Nobody can reach the office pages from outside until `on`.

## If you lose your phone

At the **[SERVER]** console, ask me for the steps to remove the authenticator for your sign-in; meanwhile run
`remote-access off` at the store computer so nothing can reach the shop's pages from outside.

## On the server, later [SERVER]

- `sudo sre-relay status` — is everything running; is the store computer's line up.
- `sudo sre-relay update` — take the newest version (keeps your sign-in, the authenticator and the approved store computer).
- `sudo sre-relay code` — show the link code again.

## For the administrator (not the owner)

- The relay's files: `infra/remote-access/` (compose, Caddyfile, nginx front, sshd, link desk, setup, `sre-relay`).
  Its secrets: `/opt/sre-relay/.env` on the server, root-only, generated there.
- The identity server's admin console is **never** on the internet (Caddy answers 404 by name). Use `sre-relay` from the
  server console, or an ssh tunnel to the `idp` container, exactly as `docs/runbooks/identity-server.md` describes.
- The store computer's side: `scripts/lib/store-computer-remote.mjs`; its door: `edge/store-edge/src/remote-door.ts`; its
  log of every remote request: `remote-access.log` in the till's data folder (append-only; never delete it).
