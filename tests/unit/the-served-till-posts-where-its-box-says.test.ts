import { describe, it, expect } from 'vitest';
import { DEFAULT_LANE_PORT, lanePortFrom } from '../../apps/pos/src/browser-entry';

/**
 * **Round 4 · the served till posts to the lane socket of the box that served it.**
 *
 * The box tells every screen where its lane socket is (`window.laneWriteBase`, `http://127.0.0.1:<port>`). The till's
 * badge already followed it, but its sales, refunds, cash and sign-in went to the built-in 8090 whatever the box said — so
 * a till installed with another `--lane-port`, or a test box on a free port, posted to the wrong place. Now the till takes
 * the port from the box, and keeps 8090 when the box says nothing it can use. Nothing else on the sale path changed.
 */

describe('lanePortFrom: the port the box that served the till names', () => {
  it('reads the port from this PC\'s loopback address, as the box injects it', () => {
    expect(lanePortFrom('http://127.0.0.1:8090')).toBe(8090);
    expect(lanePortFrom('http://127.0.0.1:41873')).toBe(41_873);
    expect(lanePortFrom(' http://127.0.0.1:9000 ')).toBe(9000);
  });

  it('anything else is not a port: the till keeps its default (8090), never a guess', () => {
    expect(DEFAULT_LANE_PORT).toBe(8090);
    for (const v of [undefined, null, 8090, '', '/store-lane', 'http://192.168.1.5:8090', 'https://127.0.0.1:8090', 'http://localhost:8090', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://127.0.0.1:8090/lane']) {
      expect(lanePortFrom(v), String(v)).toBeUndefined();
    }
  });
});
