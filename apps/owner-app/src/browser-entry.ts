// Browser entry — the bundler's input for the owner app. It exposes the tested
// brief builder as `window.ownerBrief`, which `web/app.js` calls with whatever data
// the phone last received. The brief is pure, so the screen renders identically
// offline, with the AI narrative off, and for every viewer.

import { buildBrief, type BuildBriefInput, type OwnerBrief } from './brief';

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface OwnerWindow {
  ownerBrief?: (input: BuildBriefInput) => OwnerBrief;
  /** The last-synced payload the phone holds (§31: last-synced data only). */
  ownerData?: BuildBriefInput;
}

const browserWindow = (globalThis as { window?: OwnerWindow }).window;
if (browserWindow !== undefined) {
  browserWindow.ownerBrief = buildBrief;
}

export { buildBrief };
