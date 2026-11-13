import { describe, it, expect } from 'vitest';
import { openShiftsAnswer, readUpdateProgress, updatePage, type UpdateCheckView } from '../../edge/store-edge/src/update-page';
import { PROGRESS_KIND } from '../../scripts/lib/store-pc-updater.mjs';

/**
 * **CR-01 step 3d · OI-05 · OB-718 · P-08: the Software update page shows what the updater is doing.**
 *
 *   The updater (scripts/lib/store-pc-updater.mjs, a Windows task) writes its latest word to status\update-progress.json:
 *   updating · updated · not started (and why) · put back by itself · NOT put back (red, call for help). The page shows it,
 *   in English and Tamil. While a request waits for the updater, or an update runs, there is no button to press again.
 *   With no updater set up on this PC (no status\updater.json), the page says so. The updater's one question before it
 *   stops anything — which tills are open — is answered with till ids only.
 */

const READY: UpdateCheckView = { checkedAt: '2026-11-12T03:00:00.000Z', running: '1.0.2005', state: 'available', latest: '1.0.2012', said: 'ready', tag: 'store-pc-v1.0.2012', commit: 'a'.repeat(40), sha256: 'b'.repeat(64) };
const view = { check: READY, isOwner: true, displayName: 'Owner', openShifts: [], updaterPending: false };
const progress = (state: string, said = 'words') => readUpdateProgress(JSON.stringify({ kind: PROGRESS_KIND, at: '2026-11-12T04:10:00.000Z', updateId: 'x', version: '1.0.2012', from: '1.0.2005', requestedBy: 'owner-01', state, said }));

describe('the updater\'s latest word, on the page', () => {
  it.each([
    ['updated', 'Updated: 1.0.2012', 'green'],
    ['working', 'Updating now: 1.0.2012', 'amber'],
    ['refused', 'The update was not started: 1.0.2012', 'amber'],
    ['rolled-back', 'the old version was put back by itself', 'amber'],
    ['rollback-failed', 'THE UPDATE FAILED AND THE OLD VERSION COULD NOT BE PUT BACK — call for help now', 'red'],
  ])('%s', (state, words, tone) => {
    const html = updatePage({ ...view, progress: progress(state, 'what the updater said') });
    expect(html).toContain(words);
    expect(html).toMatch(new RegExp(`<h2 class="${tone}" id="progress">`));
    expect(html).toContain('what the updater said');
    expect(html).toMatch(/id="progress">[^<]*<span lang="ta">/);
  });

  it('while an update runs, or a request waits, there is no button to press again', () => {
    expect(updatePage({ ...view, progress: progress('working') })).not.toContain('id="update-button"');
    const waiting = updatePage({ ...view, waitingSince: '2026-11-12T04:00:00.000Z' });
    expect(waiting).toContain('An update was asked for at 2026-11-12T04:00:00.000Z; the store computer starts it within 5 minutes.');
    expect(waiting).not.toContain('id="update-button"');
  });

  it('after an update ended (any way), the owner may ask again when a version is ready', () => {
    expect(updatePage({ ...view, progress: progress('rolled-back') })).toContain('id="update-button"');
  });

  it('the updater set up: the button says what happens next; not set up: the page says so, in red', () => {
    expect(updatePage(view)).toContain('id="updater-note"');
    expect(updatePage(view)).toContain('puts the old version back by itself if anything fails');
    const pending = updatePage({ ...view, updaterPending: true });
    expect(pending).toMatch(/<p class="warn" id="updater-pending">The updater is not set up on this PC/);
  });

  it('escapes what the updater said; anything unreadable is "nothing to show", never a made-up state', () => {
    expect(updatePage({ ...view, progress: progress('updated', '<img src=x onerror=alert(1)>') })).not.toContain('<img');
    expect(readUpdateProgress('not json')).toBeUndefined();
    expect(readUpdateProgress(JSON.stringify({ kind: PROGRESS_KIND, at: 'x', version: '1', said: 's', state: 'finished-ish' }))).toBeUndefined();
    expect(readUpdateProgress(undefined)).toBeUndefined();
  });
});

describe('the updater\'s question: which tills are open (OB-718)', () => {
  it('till ids only — no person, no time, no money', () => {
    const a = openShiftsAnswer([{ tillId: 'lane-1', custodian: 'u-cash', openedAt: '2026-11-12T03:30:00.000Z' }]);
    expect(a).toEqual({ kind: 'sre-open-shifts-v1', open: [{ tillId: 'lane-1' }] });
    expect(openShiftsAnswer([])).toEqual({ kind: 'sre-open-shifts-v1', open: [] });
  });
});
