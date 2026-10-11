// D14 / M32 test support: a recording partner transport (with its own DNS view, for the round-10 SSRF guard) and the
// round-10 maker-checker for a partner subscription, driven the way two people drive it over the real API.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { HttpRequest } from '../../services/kernel/src/index';
import type { OutboundTransport } from '../../services/platform/src/outbound-webhooks';
import { actionDetails } from '../../services/identity/src/approval-requests';

export type Raw = (method: HttpRequest['method'], path: string, user: string, body?: unknown, key?: string, query?: Record<string, string>) => Promise<{ status: number; body: unknown }>;

interface Sent { url: string; headers: Record<string, string>; body: string; address?: string }
/** A synthetic public address, built at run time (no real host's address in the repo). */
export const PUBLIC_ADDRESS = [11, 22, 33, 44].join('.');
export function recordingPartner(): OutboundTransport & { sent: Sent[]; answers: (number | null)[]; dns: Map<string, string[]> } {
  const sent: Sent[] = []; const answers: (number | null)[] = [];
  // The partner's DNS as the transport sees it — every partner host on a public address unless a test changes it.
  const dns = new Map<string, string[]>();
  return {
    name: 'recording-partner', sent, answers, dns,
    resolve: async (host) => dns.get(host) ?? [PUBLIC_ADDRESS],
    send: async (m) => { sent.push({ url: m.url, headers: { ...m.headers }, body: m.body, ...(m.address === undefined ? {} : { address: m.address }) }); const a = answers.length > 0 ? answers.shift()! : 200; return { status: a }; },
  };
}

/** Round 10: the maker asks for exactly this subscription, another person with setup rights approves; the body names it. */
export async function approvedSubscription(raw: Raw, maker: string, checker: string, subscriptionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const asked = await raw('POST', '/v1/approvals/requests', maker, { kind: 'partner_webhook_subscription', subjectRef: subscriptionId, details: actionDetails(body, { subscriptionId }), valueMinor: null, summary: `partner subscription ${subscriptionId}`, reason: 'synthetic test' }, `ask-${randomUUID()}`);
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  const requestId = (asked.body as { requestId: string }).requestId;
  const decided = await raw('POST', `/v1/approvals/requests/${requestId}/decide`, checker, { decision: 'approved', reason: 'checked the partner and the events' }, `decide-${randomUUID()}`);
  expect(decided.status, JSON.stringify(decided.body)).toBe(201);
  return { ...body, approvalId: requestId };
}
