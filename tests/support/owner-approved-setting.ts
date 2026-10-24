// OB-336 (owner, 23 Oct 2026): the time zone, the till's offline loyalty spend cap and the bulk-publish threshold join the
// trading-day cut-off and the currency as HIGH-IMPACT settings — the owner approves each change, and never his own. A test
// that sets one up drives it the way the shop does: the IT administrator (platform_admin, who may set the shop up) asks
// for exactly this answer, the OWNER approves it in his own session, and the administrator saves it naming the approval.

import { randomUUID } from 'node:crypto';
import { actionDetails } from '../../services/identity/src/approval-requests';
import type { ApiHarness } from './api-harness';
import type { HttpResponse } from '../../services/kernel/src/index';

type Reply = { readonly status: number; readonly body: unknown };
type Send<R extends Reply = Reply> = (method: 'POST' | 'PUT', path: string, userId: string, body: unknown, key: string) => Promise<R>;

/** The administrator who asks (holds `platform.setup.write`, never `platform.config.approve`). */
export const SETUP_ASKER = 'u-setup-it';

async function asTwoPeople<R extends Reply>(send: Send<R>, key: string, body: Record<string, unknown>, owner: string, maker: string): Promise<R> {
  const ask = await send('POST', '/v1/approvals/requests', maker, {
    kind: 'config_change', subjectRef: `setting:${key}`, details: actionDetails(body, { key }), valueMinor: null,
    summary: `Set ${key}`, reason: 'store setup (synthetic test)',
  }, `ask-${key}-${randomUUID()}`);
  if (ask.status !== 201) throw new Error(`${maker} could not ask to set ${key}: ${ask.status} ${JSON.stringify(ask.body)}`);
  const requestId = (ask.body as { requestId: string }).requestId;
  const ok = await send('POST', `/v1/approvals/requests/${requestId}/decide`, owner, { decision: 'approved', reason: 'checked' }, `decide-${requestId}`);
  if (ok.status !== 201) throw new Error(`${owner} could not approve ${key}: ${ok.status} ${JSON.stringify(ok.body)}`);
  return send('PUT', `/v1/platform/setup/${key}`, maker, { ...body, approvalId: requestId }, `set-${key}-${randomUUID()}`);
}

/** On the API harness: the administrator is provisioned, asks; the owner approves; the administrator saves. */
export async function ownerApprovedSetting(h: ApiHarness, tenantId: string, key: string, body: Record<string, unknown>, owner = 'u-owner', maker = SETUP_ASKER): Promise<HttpResponse> {
  await h.provisionRole(tenantId, maker, 'platform_admin');
  return asTwoPeople((method, path, userId, b, k) => h.request({ method, path, userId, tenantId, idempotencyKey: k, body: b }), key, body, owner, maker);
}

/**
 * The second person on a SERVED head office. There the IT administrator comes only from the operator's bootstrap (an owner
 * may never grant platform administration — the escalation guard), so the test's shop asks through a CO-OWNER granted by
 * two people (the HR requester asks, the owner approves); the owner still approves the setting, never his own.
 */
export const CO_OWNER = 'u-co-owner';
const granted = new WeakSet<object>();
export async function ownerApprovedSettingOn(
  cloud: { request(r: { method: 'POST' | 'PUT'; path: string; userId: string; body?: unknown; idempotencyKey?: string }): Promise<Reply>; grant(userId: string, roleId: string): Promise<void> },
  key: string, body: Record<string, unknown>, owner: string, maker = CO_OWNER,
): Promise<Reply> {
  if (!granted.has(cloud)) { await cloud.grant(maker, 'owner'); granted.add(cloud); }
  return asTwoPeople((method, path, userId, b, k) => cloud.request({ method, path, userId, body: b, idempotencyKey: k }), key, body, owner, maker);
}

/** Through any sender (the caller has already given `maker` the platform_admin role): ask, the owner approves, save. */
export const ownerApprovedSettingBy = <R extends Reply>(send: Send<R>, key: string, body: Record<string, unknown>, owner: string, maker = SETUP_ASKER): Promise<R> =>
  asTwoPeople(send, key, body, owner, maker);
