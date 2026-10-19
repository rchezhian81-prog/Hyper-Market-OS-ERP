// A pay run as head office records it (ADR-0024 · 2b-vi-b-2): the maker drafts and submits under their OWN sign-in, a
// different person approves and locks under theirs — the bank file and the journal then read THAT record, never a
// history sent in the request. Payroll is owner-gated (`payroll.statutory.read`), so the two people are two owners.

import type { ApiHarness } from './api-harness';

/**
 * OB-228: the owner switches pay release ON (with a written reason) — approve, lock and the bank file are refused
 * outright until he does. `owner` must hold the owner role.
 */
export async function switchPayReleaseOn(h: ApiHarness, tenantId: string, owner: string, on = true): Promise<void> {
  const res = await h.request({ method: 'POST', path: '/v1/hr/payroll/release-switch', userId: owner, tenantId, idempotencyKey: `release-${on}-${Math.random()}`, body: { on, reason: `test: pay release ${on ? 'on' : 'off'} (synthetic)` } });
  if (res.status !== 201) throw new Error(`switching pay release ${on ? 'on' : 'off'} refused: ${res.status} ${JSON.stringify(res.body)}`);
}

export type PayRunStage = 'drafted' | 'submitted' | 'approved' | 'locked';

/** Record pay run `payRunId` up to `stage`, maker `maker`, checker `checker`; fails loudly when a step is refused. */
export async function recordedPayRun(
  h: ApiHarness, tenantId: string, payRunId: string,
  opts: { maker: string; checker: string; stage?: PayRunStage; payPeriod?: string; netTotalMinor?: number; employeeCount?: number },
): Promise<void> {
  const stage = opts.stage ?? 'locked';
  const step = async (userId: string, body: Record<string, unknown>, key: string): Promise<void> => {
    const res = await h.request({ method: 'POST', path: `/v1/hr/payroll/pay-run/${payRunId}/append`, userId, tenantId, idempotencyKey: `${payRunId}-${key}`, body });
    if (res.status >= 400) throw new Error(`pay run ${payRunId} ${key} refused: ${res.status} ${JSON.stringify(res.body)}`);
  };
  await step(opts.maker, {
    action: 'draft', payPeriod: opts.payPeriod ?? '2026-08',
    ...(opts.netTotalMinor === undefined ? {} : { netTotalMinor: opts.netTotalMinor }),
    ...(opts.employeeCount === undefined ? {} : { employeeCount: opts.employeeCount }),
  }, 'draft');
  if (stage === 'drafted') return;
  await step(opts.maker, { action: 'submit' }, 'submit');
  if (stage === 'submitted') return;
  await switchPayReleaseOn(h, tenantId, opts.checker); // OB-228: the owner's switch first (the checker is an owner)
  await step(opts.checker, { action: 'approve' }, 'approve');
  if (stage === 'approved') return;
  await step(opts.checker, { action: 'lock' }, 'lock');
}
