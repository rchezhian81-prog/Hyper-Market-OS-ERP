# To-be processes — the target workflows (WF-01 to WF-20)

The target design for each of the twenty roadmap workflows: the role at each step
and where an approval is required. One section per workflow.

> The twenty workflows are defined in `docs/roadmap/roadmap-v2.0.docx` §26 and
> listed below. This file holds their **to-be design** — the role at each step and
> where approval is required — filled in Stage 1 once the as-is picture is captured.

## Template for each workflow

```
### WF-## — [workflow name from roadmap]
Trigger:        [what starts it]
Roles:          [who is involved]
Steps:          1. [role] does [step]
                2. [role] does [step]  → APPROVAL: [who], threshold [value]
                ...
Approvals:      [each approval point, who, and the limit]
Offline:        [what must still work with no internet — per §31]
Audit events:   [what is recorded: who/what/when/before/after]
Exceptions:     [what becomes a visible exception, never silent]
Acceptance:     [observable criteria a non-programmer can verify]
```

| WF | Name | Domains (roadmap §26) | Status |
| --- | --- | --- | --- |
| WF-01 | Product onboarding | M03, M04, M05, M30 | To design in Stage 1 |
| WF-02 | Supplier onboarding | M06, M24, M34 | To design in Stage 1 |
| WF-03 | Purchase planning | M06, M09, A02 | To design in Stage 1 |
| WF-04 | Receiving | M07, M08, M10 | To design in Stage 1 |
| WF-05 | Supplier invoice | M07, M23, M30 | To design in Stage 1 |
| WF-06 | Replenishment | M04, M09, M25 | To design in Stage 1 |
| WF-07 | Stock transfer | M08, M09 | To design in Stage 1 |
| WF-08 | Stock count | M08, M09, M23 | To design in Stage 1 |
| WF-09 | Expiry/recall | M10, M15, M28 | To design in Stage 1 |
| WF-10 | POS sale | M05, M12, M14 | To design in Stage 1 |
| WF-11 | POS return | M13, M14, M23 | To design in Stage 1 |
| WF-12 | Day close | M14, M23, M29 | To design in Stage 1 |
| WF-13 | Customer order | M16–M20 | To design in Stage 1 |
| WF-14 | Fulfilment | M18, M19 | To design in Stage 1 |
| WF-15 | Delivery | M19, M23 | To design in Stage 1 |
| WF-16 | Online cancellation/return | M18, M20, M21, M23 | To design in Stage 1 |
| WF-17 | Customer service | M21, M29 | To design in Stage 1 |
| WF-18 | Finance close | M23, M29 | To design in Stage 1 |
| WF-19 | Migration/cutover | MG-01–MG-12 | To design in Stage 1 |
| WF-20 | Release/incident | M33, M35, AID | To design in Stage 1 |
