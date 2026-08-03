# `infra/`

Infrastructure as code: environments, deployment and CI/CD. The machines are defined in files, not by hand.

- **Design:** `../docs/architecture/infrastructure.md` (topology, cost model to the
  ₹20,000/month D3 ceiling, environments, delivery pipeline, portability).
- **Decision:** `../docs/adr/0002-hosting-and-deployment.md` (hosting approach — Proposed,
  pending owner commercial validation of a vendor against real quotes).

## `compose/` — the pilot / store-edge stack (built)

One command brings the whole system up on **one machine**: PostgreSQL, the schema migrations,
and the app shells served over HTTP.

```
cd infra/compose && cp .env.example .env    # then set a real password in .env
docker compose up -d
```

Deliberately **vendor-neutral** — it runs on a shop back-office PC, a laptop, or any cloud VM,
so standing up a pilot **does not pre-empt the cloud-vendor decision** (ADR-0002 item 4 stays
open); the same containers are what the managed cloud tier runs later. The database port is
bound to **localhost only**, and every secret comes from `.env`, which is git-ignored — no
credential is ever committed (hard rule #4). The `migrate` service is **one-shot and
idempotent**, so it is safe to run on every deploy.

**Plain-English walkthrough for the owner or the second custodian:**
`../docs/runbooks/pilot-deployment.md` — including how to **prove the offline promise** by
pulling the network cable mid-sale.

> The cloud IaC modules (network, managed database, compute, storage, secrets) and the
> dev/test/staging/prod environment definitions land once the vendor is chosen — reviewed
> manually (AID-07), deployed only through the signed pipeline (AID-08).
> Part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
