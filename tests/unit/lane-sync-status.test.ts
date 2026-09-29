import { describe, it, expect } from 'vitest';
import { laneSyncStatus, type QueueHealth } from '../../edge/store-edge/src/sync-status';

/**
 * **The box's account of its link to head office — the fact behind every screen's sync badge (Stage G slice 2 ·
 * design system §1 rule 4 · P-08).**
 *
 * The till's badge used to say "Online · Unsent: 0" from a state nothing ever set. This is the computation that
 * replaces the constant: pure, fed from what the box already records (each queue's health, the last catalogue
 * pull's verdict, the last time head office answered), and honest in every state — including the three where
 * the answer is "I cannot say": still starting, no cloud configured, not checked yet.
 */

const NOW = '2026-09-29T10:30:00.000Z';
const q = (unsentCount = 0, deadLetterCount = 0, lastSuccessAt: string | null = null): QueueHealth => ({ unsentCount, deadLetterCount, lastSuccessAt });

describe('the five states, each said plainly', () => {
  it('starting: the queues exist, the agents do not — never a guess', () => {
    const s = laneSyncStatus({ configured: 'starting', queues: [q(2)], lastPackStatus: undefined, lastContactAt: null, now: NOW });
    expect(s.cloud).toBe('starting');
    expect(s.unsent).toBe(2);
    expect(s.staffMessage).toMatch(/still starting/);
  });

  it('not configured: a standalone lane says so, and says what is held', () => {
    const s = laneSyncStatus({ configured: false, queues: [q(3), q(1)], lastPackStatus: undefined, lastContactAt: null, now: NOW });
    expect(s.cloud).toBe('not_configured');
    expect(s.unsent).toBe(4);
    expect(s.lastSentAt).toBeNull();
    expect(s.staffMessage).toMatch(/No head office link is set up.*4 item\(s\) are saved on this box and will go only when a link is set up/);
  });

  it('unknown: configured, but no pass has run yet — nothing to say either way', () => {
    const s = laneSyncStatus({ configured: true, queues: [q()], lastPackStatus: undefined, lastContactAt: null, now: NOW });
    expect(s.cloud).toBe('unknown');
    expect(s.staffMessage).toMatch(/not been checked yet/);
  });

  it('online: the last pull reached head office, whatever it brought back', () => {
    for (const status of ['updated', 'kept', 'none_published'] as const) {
      const s = laneSyncStatus({ configured: true, queues: [q()], lastPackStatus: status, lastContactAt: NOW, now: NOW });
      expect(s.cloud, status).toBe('online');
      expect(s.staffMessage).toBe('Everything has reached head office.');
    }
  });

  it('online is also what a successful send proves, even before any pull has run', () => {
    const s = laneSyncStatus({ configured: true, queues: [q(0, 0, '2026-09-29T10:29:00.000Z')], lastPackStatus: undefined, lastContactAt: null, now: NOW });
    expect(s.cloud).toBe('online');
    expect(s.lastSentAt).toBe('2026-09-29T10:29:00.000Z');
    expect(s.lastContactAt).toBe('2026-09-29T10:29:00.000Z');
  });

  it('offline: the last pull failed — selling continues, the queue holds, and the last contact is kept', () => {
    const s = laneSyncStatus({ configured: true, queues: [q(5, 0, '2026-09-29T08:00:00.000Z')], lastPackStatus: 'offline', lastContactAt: '2026-09-29T09:15:00.000Z', now: NOW });
    expect(s.cloud).toBe('offline');
    expect(s.unsent).toBe(5);
    expect(s.lastContactAt).toBe('2026-09-29T09:15:00.000Z');
    expect(s.staffMessage).toMatch(/could not be reached.*5 item\(s\) are saved on this box and will go when the line is back.*Last contact 2026-09-29T09:15:00.000Z/);
  });

  it('offline from birth says it has never been reached, rather than inventing a time', () => {
    const s = laneSyncStatus({ configured: true, queues: [q(1)], lastPackStatus: 'offline', lastContactAt: null, now: NOW });
    expect(s.lastContactAt).toBeNull();
    expect(s.staffMessage).toMatch(/never been reached from this box/);
  });
});

describe('the numbers are sums over every queue, and the times are the latest', () => {
  it('adds unsent and dead letters across sales, refunds, completions, day closes and partner lines', () => {
    const s = laneSyncStatus({ configured: true, queues: [q(1, 1), q(2), q(0, 2), q(3), q(0)], lastPackStatus: 'kept', lastContactAt: NOW, now: NOW });
    expect(s.unsent).toBe(6);
    expect(s.deadLettered).toBe(3);
    expect(s.staffMessage).toMatch(/^3 item\(s\) head office refused are waiting for a person/);
  });

  it('lastSentAt is the newest success across queues; lastContactAt is the newer of that and the pull', () => {
    const s = laneSyncStatus({
      configured: true,
      queues: [q(0, 0, '2026-09-29T09:00:00.000Z'), q(0, 0, '2026-09-29T10:10:00.000Z'), q(0, 0, null)],
      lastPackStatus: 'none_published', lastContactAt: '2026-09-29T10:20:00.000Z', now: NOW,
    });
    expect(s.lastSentAt).toBe('2026-09-29T10:10:00.000Z');
    expect(s.lastContactAt).toBe('2026-09-29T10:20:00.000Z');
    expect(s.now).toBe(NOW);
  });
});
