// The self-checkout lane's composition root (R8-3 · D04-FR-06 · OB-316 · hard rule #1).
//
// The lane IS a till: importing the till's own composition root boots the till's tested engine exactly as the staffed
// till does — the box's signed catalogue, its lane, its scales, its legal gates, its receipt numbers, its card attempts
// and its sale path to the disk — and attaches it as `window.posSession`. This file then puts the self-checkout rules on
// top of it (`self-checkout-lane.ts`) and attaches the result as `window.selfCheckout`, which `web/app.js` draws.
//
// Nothing here talks to head office. Every call goes to this lane's own store computer on loopback, as the till's do.

import { attachShopDay } from '../../../packages/calendar/src/shop-day'; // OB-607
import '../../pos/src/browser-entry';
import { laneBase, lanePortFrom, DEFAULT_LANE_PORT } from '../../pos/src/browser-entry';
import { posRolloutOf } from '../../pos/src/lane-rollout';
import { CatalogueCache, type CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import { createSelfCheckoutLane, SELF_CHECKOUT_SWITCH, type SelfCheckoutLane, type SelfCheckoutWatch, type TillEngine } from './self-checkout-lane';

/** The header the till's store computer reads the signed-in colleague's session from (as the till sends it). */
const OPERATOR_HEADER = 'x-sre-operator';

interface LaneWindow {
  posSession?: TillEngine & { readonly operatorToken?: () => string | undefined };
  posLane?: { readonly rollout?: unknown; readonly mirrorPilot?: { readonly on: boolean }; readonly realTrading?: { readonly on: boolean } };
  posCatalogue?: CatalogueSnapshot;
  laneWriteBase?: string;
  /** The owner's self-checkout watch numbers, from the store pack — absent when not set (P-08). */
  selfCheckoutWatch?: SelfCheckoutWatch;
  selfCheckout?: SelfCheckoutLane;
  /** Why this lane is not a self-checkout lane, when it is not (the switch, from the signed pack). */
  selfCheckoutSwitch?: { readonly on: boolean; readonly why: string | null };
}

const w = (globalThis as { window?: LaneWindow }).window;
if (w !== undefined && w.posSession !== undefined) {
  const till = w.posSession;
  const rollout = posRolloutOf(w.posLane?.rollout);
  const switchOn = rollout.isOn(SELF_CHECKOUT_SWITCH);
  const why = switchOn ? null : rollout.why ?? `the rollout switch "${SELF_CHECKOUT_SWITCH}" is not on for this lane`;
  const port = lanePortFrom(w.laneWriteBase) ?? DEFAULT_LANE_PORT;
  const lookup = w.posCatalogue === undefined ? undefined : new CatalogueCache(w.posCatalogue);
  w.selfCheckoutSwitch = { on: switchOn, why };
  w.selfCheckout = createSelfCheckoutLane(till, {
    switchOn, switchWhy: why,
    mirrorPilot: w.posLane?.mirrorPilot?.on === true,
    realTrading: w.posLane?.realTrading?.on === true,
    ...(w.selfCheckoutWatch === undefined ? {} : { watch: w.selfCheckoutWatch }),
    ...(lookup === undefined ? {} : { lookup }),
    now: () => new Date().toISOString(),
    // The basket's evidence goes to THIS lane's store computer, under the colleague's own session, as a void does.
    recordBasket: async (body) => {
      const token = till.operatorToken?.();
      const response = await fetch(`${laneBase(port)}/lane/till-activity`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { [OPERATOR_HEADER]: token }) }, body: JSON.stringify(body),
      });
      const r = await response.json() as { recorded?: unknown; laneMessage?: unknown };
      return { recorded: r.recorded === true, laneMessage: typeof r.laneMessage === 'string' ? r.laneMessage : '' };
    },
  });
}

// OB-607: this page's shop's day as `window.sreShopDay` — the dates AND times of day it shows are the shop's clock, in the
// zone the store computer served from its signed pack (`window.shopTimeZone`; no network call), never this device's.
attachShopDay((globalThis as { window?: unknown }).window);
