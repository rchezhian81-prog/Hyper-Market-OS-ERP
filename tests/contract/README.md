# `tests/contract/`

Versioned API and event contracts — **P-06** (open and portable), **§30.2** (events are the
integration backbone), **§31.1** (idempotency), **API-01…13**.

**A contract is only a contract if breaking it fails somewhere.** `docs/api/catalogue.md` states
the conventions — versioned, idempotent, additive within a major, no card data — and until now
those were sentences in a document.

The test that earns its place here is **backward compatibility**, because the store edge and the
cloud are *different deployments on different upgrade cycles*: a till that has been offline for
three days is running Tuesday's code, and its sales must still arrive. A contract that only works
when both sides are the same version is not a contract, it is a coincidence. So a v1 envelope is
written out literally — not constructed by today's code — and read back with today's code; and an
envelope carrying a field this version has never heard of is carried rather than rejected.

Also proven here:

- **Money stays integer minor units and a currency on the wire** (§29.1). The single most
  consequential detail in the product: a float on the wire is how 41200 becomes 41199.999999 in
  somebody's ledger, and nothing downstream ever sees it happen.
- **UTC timestamps only.** A local-time stamp from a till in one timezone and a server in another
  cannot be ordered against each other.
- **The catalogue and the code agree** on the named event types. When they disagree, the
  integration written against the document is the one that breaks.
- **Idempotency**: a replay returns the *first* answer; the same key with a different body is a
  conflict, not a retry; an unkeyed write is refused, because the catalogue says the key is
  mandatory. Body digests ignore key order, so a re-serialised retry is still a retry.
- **Webhook signatures** are unambiguous across field boundaries — the forgery a naive
  concatenation allows, where `deliveryId "ab" + event "c"` signs the same bytes as
  `deliveryId "a" + event "bc"` and an attacker moves the boundary without the key. The timestamp
  is inside the signature, so a valid one cannot be replayed later, and the envelope carries only
  a vault reference, never key material (hard rule #4).

> Part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
