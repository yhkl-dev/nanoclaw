import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ASSISTANT_NAME normalization', () => {
  const originalCwd = process.cwd();
  const originalAssistantName = process.env.ASSISTANT_NAME;
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-config-test-'));
    process.chdir(tmpDir);
    delete process.env.ASSISTANT_NAME;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalAssistantName === undefined) {
      delete process.env.ASSISTANT_NAME;
    } else {
      process.env.ASSISTANT_NAME = originalAssistantName;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('normalizes legacy Andy env values to Henry', async () => {
    process.env.ASSISTANT_NAME = 'Andy';

    const { ASSISTANT_NAME } = await import('./config.js');

    expect(ASSISTANT_NAME).toBe('Henry');
  });

  it('prefers .env when launchd injects the default Henry override', async () => {
    process.env.ASSISTANT_NAME = 'Henry';
    fs.writeFileSync(path.join(tmpDir, '.env'), 'ASSISTANT_NAME="Nova"\n');

    const { ASSISTANT_NAME } = await import('./config.js');

    expect(ASSISTANT_NAME).toBe('Nova');
  });
});
