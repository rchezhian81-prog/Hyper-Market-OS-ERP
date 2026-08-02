# `infra/`

Infrastructure as code: environments, deployment and CI/CD. The machines are defined in files, not by hand.

- **Design:** `../docs/architecture/infrastructure.md` (topology, cost model to the
  ₹20,000/month D3 ceiling, environments, delivery pipeline, portability).
- **Decision:** `../docs/adr/0002-hosting-and-deployment.md` (hosting approach — Proposed,
  pending owner commercial validation of a vendor against real quotes).

> The IaC modules (network, database, compute, storage, secrets), environment definitions
> (dev/test/staging/prod), and edge-provisioning scripts are implemented here **from Stage
> 5** — reviewed manually (AID-07), deployed only through the signed pipeline (AID-08).
> Part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
