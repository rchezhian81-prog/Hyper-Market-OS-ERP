import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { recordingTransport } from '../../packages/notifications/src/index';
import { startRealCloud } from '../support/real-store';

/**
 * **Production's own wiring runs the owner's brief: `startApi` starts the brief worker for the shops the operator names,
 * and a due brief is queued and delivered with nobody calling anything (audit EA-07 · M29-FR-04 · A01 · D13).**
 *
 * The verifier found no test ran `startBriefWorker` as `services/api/src/main.ts` wires it. Here the REAL API assembly
 * (`startApi`, through `tests/support/real-store.ts`) boots over real PostgreSQL with `BRIEF_WORKER_TENANT_IDS` naming
 * the shop, a short worker interval, and the RECORDING message transport (no real provider is certified — SMS is R4,
 * OB-29). The owner sets the brief due at 00:00 shop time, a bill is taken today, and then — with no run route called,
 * no drain called — the brief worker puts the brief on the queue, the notification worker delivers it to the owner, and
 * the next tick acknowledges the day as sent. The brief has NO AI leg: it is composed from the governed figures alone
 * (no model call is on the audit and nothing is spent on AI), so there is no AI to fall back from.
 *
 * Synthetic data only (hard rule #7). Needs DATABASE_URL.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

const waitFor = async <T>(what: string, probe: () => Promise<T | undefined>, ms = 15_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== undefined) return got;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe.skipIf(!DATABASE_URL)('the brief worker runs inside the served API (EA-07)', () => {
  it('BRIEF_WORKER_TENANT_IDS set → a due brief is queued, delivered and acknowledged with no manual call; no AI in it', async () => {
    const T = randomUUID();
    const transport = recordingTransport();
    const cloud = await startRealCloud({
      databaseUrl: DATABASE_URL!, tenantId: T, owner: 'u-owner', packSigningKey: randomBytes(32).toString('hex'),
      env: { BRIEF_WORKER_TENANT_IDS: T },
      providers: { notificationTransport: transport, notificationWorkerIntervalMs: 150, briefWorkerIntervalMs: 150 },
    });
    try {
      expect(cloud.said.join('\n')).toMatch(/brief worker: briefing 1 shop\(s\)/);
      const ok = async (method: 'POST' | 'PUT', path: string, userId: string, body: unknown, key: string) => {
        const r = await cloud.request({ method, path, userId, idempotencyKey: key, body });
        expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
      };
      await cloud.grant('u-cash', 'cashier');
      await ok('PUT', '/v1/platform/setup/locale.time_zone', 'u-owner', { value: 'UTC' }, 'tz');
      const today = new Date().toISOString().slice(0, 10);
      await ok('POST', '/v1/sales', 'u-cash', {
        saleId: `S-${T.slice(0, 8)}`, receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'S1', cashierId: 'u-cash', tradingDay: today,
        committedAt: new Date().toISOString(), totalMinor: 123_400, currency: 'INR', packVersion: 1,
        lines: [{ productId: 'P-X', quantityMinor: 1, uom: 'ea', unitPriceMinor: 123_400, lineTotalMinor: 123_400 }],
        tenders: [{ kind: 'cash', amountMinor: 123_400 }],
      }, 'sale-1');
      // The owner's messaging budget (nothing is sent without one) and the brief's schedule: due at 00:00 shop time.
      await ok('POST', '/v1/notifications/budget', 'u-owner', { capMinor: 100_000, costMinorByChannel: { whatsapp: 50 } }, 'budget');
      await ok('POST', '/v1/reporting/brief-schedule', 'u-owner', { dueAt: [0, 0] }, 'schedule');

      // Nothing else is called. The brief worker queues it; the notification worker delivers it…
      const sent = await waitFor('the brief to reach the (recording) phone', async () => transport.sent.find((m) => m.messageId === `brief-${today}`));
      expect(sent.customerId).toBe('u-owner');
      expect(sent.text).toContain('₹1,234.00');
      // …and the next brief-worker tick acknowledges the day ONLY because the queue says delivered.
      const sentDays = await waitFor('the day to be acknowledged as sent', async () => {
        const s = ((await cloud.request({ method: 'GET', path: '/v1/reporting/brief-schedule', userId: 'u-owner' })).body as { schedule?: { sentDays?: string[] } }).schedule;
        return s?.sentDays?.includes(today) === true ? s.sentDays : undefined;
      });
      expect(sentDays).toEqual([today]);
      expect(transport.sent.filter((m) => m.messageId.startsWith('brief-'))).toHaveLength(1); // once, however many ticks
      // The worker said what it did, as the worker.
      expect(cloud.said.some((l) => l.includes('"briefWorker"') && l.includes('"outcome":"queued"'))).toBe(true);
      expect(cloud.said.some((l) => l.includes('"briefWorker"') && l.includes('"outcome":"acknowledged"'))).toBe(true);

      // NO AI leg: no model was called for it and nothing was spent on AI — the brief stands on the governed figures alone.
      const calls = (await cloud.request({ method: 'GET', path: '/v1/ai/model-calls', userId: 'u-owner' })).body as { count: number };
      expect(calls.count).toBe(0);
      const ai = (await cloud.request({ method: 'GET', path: '/v1/ai/budget', userId: 'u-owner' })).body as { spentMinor: number };
      expect(ai.spentMinor).toBe(0);
    } finally {
      await cloud.stop();
    }
  }, 60_000);

  it('without BRIEF_WORKER_TENANT_IDS no worker runs — nothing is briefed by itself, and the API says so by not starting it', async () => {
    const T = randomUUID();
    const cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: T, owner: 'u-owner', packSigningKey: randomBytes(32).toString('hex') });
    try {
      expect(cloud.said.join('\n')).not.toMatch(/brief worker: briefing/);
    } finally {
      await cloud.stop();
    }
  }, 60_000);
});
