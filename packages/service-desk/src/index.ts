// Public surface of @sre/service-desk — CRM and the service desk (M21).
//
//   • `campaigns.ts`     (M21-FR-01/02) — consent checked PER RECIPIENT at the send, the
//     excluded count always reported, channel and purpose as separate permissions, a
//     promotion refused inside a transactional message, journeys with a quiet period,
//     and attribution measured against a control group.
//   • `service-cases.ts` (M21-FR-03/04) — compensation as a financial action needing a
//     second signature, AI that DRAFTS while a named human sends, an SLA clock that
//     pauses while the shop waits on the customer, and CSAT reported with its response
//     rate.
//
// Nothing here sends anything: it decides who may be sent to and what a human may then
// commit (hard rule #5).

export * from './campaigns';
export * from './service-cases';
