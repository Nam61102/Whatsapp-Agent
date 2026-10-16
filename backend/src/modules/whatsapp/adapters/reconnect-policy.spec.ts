import { isTerminalClose, reconnectDelayMs, RECONNECT_MAX_MS } from './reconnect-policy';

describe('reconnectDelayMs', () => {
  it('backs off exponentially from 2 seconds', () => {
    expect(reconnectDelayMs(0, false)).toBe(2000);
    expect(reconnectDelayMs(1, false)).toBe(4000);
    expect(reconnectDelayMs(2, false)).toBe(8000);
  });

  it('never waits longer than the cap, so retries never stop', () => {
    expect(reconnectDelayMs(20, false)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelayMs(1000, false)).toBe(RECONNECT_MAX_MS);
  });

  it('retries restart-required closes almost immediately', () => {
    expect(reconnectDelayMs(5, true)).toBe(100);
  });
});

describe('isTerminalClose', () => {
  it('treats logout and takeover as terminal', () => {
    expect(isTerminalClose(401, true)).toBe(true);
    expect(isTerminalClose(440, true)).toBe(true);
    expect(isTerminalClose(403, true)).toBe(true);
  });

  it('treats network drops on a linked session as recoverable', () => {
    expect(isTerminalClose(undefined, true)).toBe(false);
    expect(isTerminalClose(408, true)).toBe(false);
    expect(isTerminalClose(428, true)).toBe(false);
    expect(isTerminalClose(500, true)).toBe(false);
  });

  it('stops when the account was never linked', () => {
    expect(isTerminalClose(undefined, false)).toBe(true);
  });
});
