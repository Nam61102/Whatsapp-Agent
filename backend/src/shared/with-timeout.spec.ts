import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('returns the result when the call finishes in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 100, 'x')).resolves.toBe(7);
  });
  it('rejects with a clear message when the call stalls', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'Fetching groups')).rejects.toThrow('Fetching groups timed out after 0s');
  });
  it('passes through the original error', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100, 'x')).rejects.toThrow('boom');
  });
});
