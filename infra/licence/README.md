# The seller's PUBLIC licence key (CR-01 step 5 · OI-10 · OB-710)

`licence-signing.pub` goes in this folder — the PUBLIC half of the owner's master licence key, made once on the owner's
own computer with `node scripts/licence-desk.mjs make-key` (see `docs/runbooks/licensing.md`). It is not a secret: every
store PC release carries it (`scripts/build-store-pc-release.mjs` copies it beside `release.json`) and checks each shop's
licence against it, offline.

**Never here:** the private key (`sre-licence-seller-key.pem`), its paper backup, its passphrase, or the register of issued
licences. Those live only on the owner's USB drive and in sealed envelopes in the safe. The guardrail
`tests/guardrails/the-seller-licence-key-never-enters-the-repository-or-a-sale.test.ts` fails if any of them appears.

Until this file is committed, releases carry no seller key and **licensing is not switched on** (nothing is limited). Once it
is committed, every release built after it asks every shop — the owner's own included — for a licence: so the owner issues
his own shop's **owner licence** the same day and loads it on the Licence screen (the shop keeps trading meanwhile; the
setup period is LICENCE_POLICY.setupDays).
