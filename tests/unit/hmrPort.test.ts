import net from 'net';
import {hmrPortFor, isPortFree, resolveHmrPort} from '../../src/vite-config';

// Each app needs its own HMR websocket port: they all used to share Vite's
// default 24678, so two dev servers at once collided. The port is derived from
// the dev port, which comes from `process.env.PORT` and is therefore untrusted.

describe('hmrPortFor', () => {
  test('the default dev port keeps Vite’s default HMR port', () => {
    expect(hmrPortFor(4040)).toBe(24678);
  });

  test('a neighbouring dev port gives a neighbouring HMR port', () => {
    expect(hmrPortFor(4041)).toBe(24679);
    expect(hmrPortFor(4039)).toBe(24677);
  });

  test('distinct dev ports always give distinct HMR ports', () => {
    const ports = [4040, 4041, 4042, 8080].map(hmrPortFor);
    expect(new Set(ports).size).toBe(ports.length);
  });

  test('a PORT env string is parsed and stays in range', () => {
    const port = hmrPortFor('8080');
    expect(port).toBe(24678 + (8080 - 4040));
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
  });

  test('a non-numeric PORT falls back to the dev port default', () => {
    expect(hmrPortFor('abc')).toBe(24678);
    expect(hmrPortFor(NaN)).toBe(24678);
    expect(hmrPortFor(undefined)).toBe(24678);
    expect(hmrPortFor('')).toBe(24678);
  });

  test('out-of-range and non-integer dev ports fall back to the default', () => {
    expect(hmrPortFor(0)).toBe(24678);
    expect(hmrPortFor(-1)).toBe(24678);
    expect(hmrPortFor(70000)).toBe(24678);
    expect(hmrPortFor(4040.5)).toBe(24678);
    expect(hmrPortFor(Infinity)).toBe(24678);
  });

  test('a derivation past the TCP ceiling is clamped', () => {
    // 60000 would derive 80638.
    expect(hmrPortFor(60000)).toBe(65535);
  });

  test('every valid dev port derives a bindable HMR port', () => {
    for (const devPort of [1, 80, 1024, 4040, 40897, 65535]) {
      const port = hmrPortFor(devPort);
      expect(port).toBeGreaterThanOrEqual(1024);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });
});

// The derived port keeps linked apps on distinct dev ports apart, but not an
// app from another process — or a second checkout of the same app — that
// already holds it. Vite serves the configured port to the browser, so picking
// a free one at config time is enough for the client to follow.
describe('resolveHmrPort', () => {
  // Every case uses its own dev port: chosen ports are remembered per process.
  const taken = (...ports: number[]) => async (port: number) => !ports.includes(port);

  test('the derived port when it is free, silently', async () => {
    const log = jest.fn();
    expect(await resolveHmrPort({devPort: 5001, env: {}, isFree: taken(), log})).toBe(hmrPortFor(5001));
    expect(log).not.toHaveBeenCalled();
  });

  test('the next free port when the derived one is taken, and says so', async () => {
    const derived = hmrPortFor(5002);
    const log = jest.fn();
    const port = await resolveHmrPort({devPort: 5002, env: {}, isFree: taken(derived, derived + 1), log});
    expect(port).toBe(derived + 2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`HMR port ${derived} is in use; using ${derived + 2}`));
  });

  test('a config reload in the same process keeps the port it chose, though it now looks taken', async () => {
    const derived = hmrPortFor(5003);
    const first = await resolveHmrPort({devPort: 5003, env: {}, isFree: taken(derived), log: () => {}});
    // Our own server now holds `first`.
    const again = await resolveHmrPort({devPort: 5003, env: {}, isFree: taken(derived, first), log: () => {}});
    expect(again).toBe(first);
  });

  test('LINKED_HMR_PORT wins without probing', async () => {
    const isFree = jest.fn(async () => false);
    expect(await resolveHmrPort({devPort: 5004, env: {LINKED_HMR_PORT: '30123'}, isFree})).toBe(30123);
    expect(isFree).not.toHaveBeenCalled();
  });

  test('an invalid LINKED_HMR_PORT is ignored with a message', async () => {
    const log = jest.fn();
    const port = await resolveHmrPort({devPort: 5005, env: {LINKED_HMR_PORT: 'abc'}, isFree: taken(), log});
    expect(port).toBe(hmrPortFor(5005));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ignoring LINKED_HMR_PORT=abc'));
  });

  test('nothing free in range falls back to the derived port, for Vite to report', async () => {
    expect(await resolveHmrPort({devPort: 5006, env: {}, isFree: async () => false, log: () => {}})).toBe(hmrPortFor(5006));
  });

  test('with real sockets: a listening port is taken and gets skipped', async () => {
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(0, r));
    const held = (holder.address() as net.AddressInfo).port;
    try {
      expect(await isPortFree(held)).toBe(false);
      // A dev port whose derived HMR port is exactly the held one.
      const devPort = held - 24678 + 4040;
      const port = await resolveHmrPort({devPort, env: {}, log: () => {}});
      expect(port).not.toBe(held);
      expect(await isPortFree(port)).toBe(true);
    } finally {
      holder.close();
    }
  });
});
