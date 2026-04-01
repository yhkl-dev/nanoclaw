import { describe, expect, it } from 'vitest';

import { isMissingClaudeSessionError } from './session-recovery.js';

describe('container agent runner session recovery', () => {
  it('detects missing Claude session errors', () => {
    expect(
      isMissingClaudeSessionError(
        new Error(
          'Claude Code returned an error result: No conversation found with session ID: 46511c8f-a6cd-4007-a773-24a8add68f6f',
        ),
      ),
    ).toBe(true);
  });

  it('ignores unrelated Claude errors', () => {
    expect(
      isMissingClaudeSessionError(
        new Error('Claude Code returned an error result: permission denied'),
      ),
    ).toBe(false);
  });
});
