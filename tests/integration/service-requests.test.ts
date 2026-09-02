import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Platform service-request tracker — M33-FR-04 "service management", end to end (API-11).**
 *
 * An internal ticket about the platform is raised, assigned to a person, worked, and resolved (with a
 * resolution note). Durable + append-only; open requests surface first; a platform administrator may run the
 * whole loop (it is admin work, not a business transaction). Writes gated platform.service.manage; reads
 * platform.service.read.
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const raise = (h: ReturnType<typeof apiHarness>, u: string, id: string, key: string, over: Record<string, unknown> = {}) =>
  h.request({ method: 'POST', path: '/v1/platform/service-requests', userId: u, tenantId: TENANT, idempotencyKey: key,
    body: { requestId: id, title: `${id} title`, detail: 'till 3 will not register', category: 'device', priority: 'high', ...over } });
const assign = (h: ReturnType<typeof apiHarness>, u: string, id: string, to: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/platform/service-requests/${id}/assign`, userId: u, tenantId: TENANT, idempotencyKey: key, body: { assignedTo: to } });
const setStatus = (h: ReturnType<typeof apiHarness>, u: string, id: string, status: string, key: string, note?: string) =>
  h.request({ method: 'POST', path: `/v1/platform/service-requests/${id}/status`, userId: u, tenantId: TENANT, idempotencyKey: key, body: { status, ...(note !== undefined ? { note } : {}) } });
const list = (h: ReturnType<typeof apiHarness>, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/service-requests', userId: u, tenantId: TENANT });
const read = (h: ReturnType<typeof apiHarness>, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/platform/service-requests/${id}`, userId: u, tenantId: TENANT });

describe('platform service requests (M33-FR-04)', () => {
  it('raises, assigns, works and resolves a request through its lifecycle', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');

    expect((await raise(h, 'u-owner', 'sr1', 'r-1')).status).toBe(201);
    expect((await read(h, 'u-owner', 'sr1')).body).toMatchObject({ request: { status: 'open', needsAttention: true } });

    expect((await assign(h, 'u-owner', 'sr1', 'u-eng', 'a-1')).status).toBe(200);
    expect((await read(h, 'u-owner', 'sr1')).body).toMatchObject({ request: { assignedTo: 'u-eng', status: 'in_progress' } });

    // Resolving needs a note.
    expect((await setStatus(h, 'u-owner', 'sr1', 'resolved', 's-noteless')).status).toBe(400);
    expect((await setStatus(h, 'u-owner', 'sr1', 'resolved', 's-1', 'replaced the lane cable')).status).toBe(200);
    const resolved = (await read(h, 'u-owner', 'sr1')).body as { request: { status: string; resolution: string; needsAttention: boolean } };
    expect(resolved.request).toMatchObject({ status: 'resolved', resolution: 'replaced the lane cable', needsAttention: false });
    expect((await list(h, 'u-owner')).body).toMatchObject({ open: 0 });
  });

  it('lists the open requests first, with a count', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await raise(h, 'u-owner', 'done', 'r-1');
    await setStatus(h, 'u-owner', 'done', 'closed', 's-1');
    await raise(h, 'u-owner', 'open', 'r-2');

    const body = (await list(h, 'u-owner')).body as { requests: { requestId: string; needsAttention: boolean }[]; open: number };
    expect(body.open).toBe(1);
    expect(body.requests[0]).toMatchObject({ requestId: 'open', needsAttention: true }); // open one first
  });

  it('refuses a duplicate id, an unknown status, and acting on a request nobody raised', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await raise(h, 'u-owner', 'sr1', 'r-1');

    const dup = await raise(h, 'u-owner', 'sr1', 'r-2');
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe('service_request_exists');

    const badStatus = await setStatus(h, 'u-owner', 'sr1', 'pondering', 's-bad');
    expect(badStatus.status).toBe(400);
    expect(codeOf(badStatus)).toBe('unknown_status');

    expect((await assign(h, 'u-owner', 'ghost', 'u-eng', 'a-x')).status).toBe(404);
    expect((await read(h, 'u-owner', 'ghost')).status).toBe(404);
  });

  it('a platform administrator may run the whole loop; a user with no role is refused', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    await h.provisionRole(TENANT, 'u-admin', 'platform_admin');

    expect((await raise(h, 'u-admin', 'sr1', 'r-1')).status).toBe(201);
    expect((await assign(h, 'u-admin', 'sr1', 'u-eng', 'a-1')).status).toBe(200);
    expect((await setStatus(h, 'u-admin', 'sr1', 'resolved', 's-1', 'done')).status).toBe(200);
    expect((await list(h, 'u-admin')).status).toBe(200);

    expect((await raise(h, 'u-nobody', 'sr9', 'r-9')).status).toBe(403);
    expect((await list(h, 'u-nobody')).status).toBe(403);
  });
});
