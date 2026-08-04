# `packages/documents/`

Versioned templates and immutable issued documents — **M31-FR-01**.

The rule this package exists for is one sentence in the roadmap and one of the most
commonly broken things in retail software: **"a template change is a new version, never
overwriting issued documents."**

It gets broken because the wrong design is the obvious one. Store the template; render the
invoice from it whenever someone asks. Then in August the shop changes its address on the
invoice template — and **every invoice it has ever issued silently changes its address
too**. July's invoice now shows an address the shop did not have in July. The customer's
copy and the shop's copy no longer match. For a tax document that is not cosmetic: the two
copies are supposed to be the same document.

So an issued document is **frozen at issue**:

- It stores the **rendered content**, not a promise to re-render it.
- It records the **exact template version** it came from.
- `reproduceDocument` returns the **stored bytes** — never a fresh render from the current
  template.
- A template version any issued document depends on **can never be removed** (hard rule
  #6): the version is the record of what that layout meant, and "why does this invoice look
  like this?" is a question about the version, not the render.

Supporting rules:

- **`publishTemplateVersion` is the only way to change a template**, and it always creates
  a new number. There is no edit, no overwrite and no delete anywhere in the module — a
  test asserts that absence by scanning the exports.
- A template change needs **approval by someone other than its author** (§28) and a written
  change note: the invoice layout carries the shop's legal identity, tax numbers and terms.
- **Branding is per-tenant** and frozen into the version, so one tenant's rebrand cannot
  reach into another tenant's issued paperwork.
- `issueDocument` is **idempotent** — re-issuing under a newer template would produce a
  second, different copy of the same document, which is the subtle version of the same bug.
- `planDocumentRetention` **proposes**, never deletes. A legal hold beats a retention date,
  a statutory document (tax invoice, credit note, GRN, statement) is never proposed at all,
  and a document with no policy is kept — silence never means discard.

> Pure and deterministic: the clock is injected and rendering is a supplied function, so
> this module never depends on a formatter. Tested in
> `tests/unit/documents-templates.test.ts` (17) and proven end to end in
> `tests/integration/one-customer.test.ts` (Stage 14 gate). Part of the repository layout
> in `CLAUDE.md`.
