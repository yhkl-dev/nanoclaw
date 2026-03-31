import { describe, expect, it } from 'vitest';

import { assertSafeHttpDestination } from './network-policy.js';

describe('assertSafeHttpDestination', () => {
  it('blocks reserved benchmark IPv4 ranges', async () => {
    await expect(
      assertSafeHttpDestination(new URL('http://198.18.0.1/test'), false),
    ).rejects.toThrow('Blocked private HTTP destination');
  });

  it('allows public IPv6 literal URLs', async () => {
    await expect(
      assertSafeHttpDestination(
        new URL('https://[2606:4700:4700::1111]/dns-query'),
        false,
      ),
    ).resolves.toBeUndefined();
  });

  it('blocks IPv4-mapped IPv6 loopback and private addresses', async () => {
    await expect(
      assertSafeHttpDestination(new URL('http://[::ffff:127.0.0.1]/'), false),
    ).rejects.toThrow('Blocked private HTTP destination');

    await expect(
      assertSafeHttpDestination(
        new URL('http://[::ffff:192.168.1.10]/'),
        false,
      ),
    ).rejects.toThrow('Blocked private HTTP destination');
  });
});
