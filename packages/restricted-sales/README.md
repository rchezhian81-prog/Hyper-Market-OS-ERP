# `packages/restricted-sales/`

The till-side "cannot-sell" gates. Pure and deterministic — the basket lines go in, the verdict
comes out, and the till commits nothing until it is allowed; the attributes come from the offline
price pack, so both gates work with the internet down (hard rule #1).

- **`restricted-sales.ts` — roadmap v2.1 B14** (COTPA 2003 s.6 & s.7): a tobacco line demands
  age-18 confirmation and refuses a below-pack quantity (no loose single-stick sale). Unlocked by
  the owner's ratified decision (11 Aug 2026) that tobacco is stocked.
- **`single-use-plastic.ts` — roadmap v2.1 B19** (Plastic Waste Management Rules): a banned
  single-use-plastic SKU cannot be sold; a *plastic* carry bag must be at least 120 µm thick; and
  a carry bag must be a separate priced line (never given free).
