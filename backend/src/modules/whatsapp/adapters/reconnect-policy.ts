export const RECONNECT_BASE_MS = 2000;
export const RECONNECT_MAX_MS = 60000;

/** Delay before reconnect attempt number `attempt` (0-based). Doubles, capped at one minute. */
export function reconnectDelayMs(attempt: number, immediate: boolean): number {
  if (immediate) return 100;
  return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS);
}

/** A close is terminal only when WhatsApp logged the session out or another device took it. */
export function isTerminalClose(statusCode: number | undefined, isRegistered: boolean): boolean {
  const loggedOut = statusCode === 401 || statusCode === 403;
  const takenOver = statusCode === 440;
  return loggedOut || takenOver || !isRegistered;
}
