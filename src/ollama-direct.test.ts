import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPaths = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('fs');
  const os = require('node:os') as typeof import('os');
  const path = require('node:path') as typeof import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ollama-direct-'));
  return {
    tmpRoot,
    dataDir: path.join(tmpRoot, 'data'),
    groupsDir: path.join(tmpRoot, 'groups'),
  };
});

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  CONTAINER_TIMEOUT: 30_000,
  DATA_DIR: mockedPaths.dataDir,
  GROUPS_DIR: mockedPaths.groupsDir,
  OLLAMA_HOST: 'http://192.168.2.19:11434',
  OLLAMA_MODEL: 'qwen3-coder:30b',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { runDirectOllamaAgent } from './ollama-direct.js';
import type { RegisteredGroup } from './types.js';

describe('runDirectOllamaAgent', () => {
  beforeEach(() => {
    fs.rmSync(mockedPaths.tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(mockedPaths.groupsDir, 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(mockedPaths.groupsDir, 'main', 'CLAUDE.md'),
      'You are helping from the main group.',
    );
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('calls Ollama chat and persists session history', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          message: { role: 'assistant', content: '你好，我在。' },
        }),
    } as Response);

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const onOutput = vi.fn(async () => {});
    const result = await runDirectOllamaAgent(
      group,
      {
        prompt: '<messages><message sender="YangKai">你好</message></messages>',
        chatJid: 'wecom:YangKai',
        groupFolder: 'main',
        isMain: true,
      },
      onOutput,
    );

    expect(result.status).toBe('success');
    expect(result.result).toBe('你好，我在。');
    expect(result.newSessionId).toBeTruthy();
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: '你好，我在。' }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://192.168.2.19:11434/api/chat');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('qwen3-coder:30b');
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('Andy');
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: '<messages><message sender="YangKai">你好</message></messages>',
    });

    const sessionPath = path.join(
      mockedPaths.dataDir,
      'sessions',
      'main',
      'ollama-direct',
      `${result.newSessionId}.json`,
    );
    const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    expect(saved.messages).toEqual([
      {
        role: 'user',
        content: '<messages><message sender="YangKai">你好</message></messages>',
      },
      { role: 'assistant', content: '你好，我在。' },
    ]);
  });

  it('reuses prior session history on follow-up turns', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          message: { role: 'assistant', content: '继续说。' },
        }),
    } as Response);

    const sessionDir = path.join(
      mockedPaths.dataDir,
      'sessions',
      'main',
      'ollama-direct',
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'session-1.json'),
      JSON.stringify({
        messages: [
          { role: 'user', content: '第一句' },
          { role: 'assistant', content: '第一句回复' },
        ],
      }),
    );

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    await runDirectOllamaAgent(group, {
      prompt: '第二句',
      sessionId: 'session-1',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body.messages.slice(-3)).toEqual([
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '第一句回复' },
      { role: 'user', content: '第二句' },
    ]);
  });

  it('rejects scheduled task scripts explicitly', async () => {
    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    await expect(
      runDirectOllamaAgent(group, {
        prompt: 'task prompt',
        chatJid: 'wecom:YangKai',
        groupFolder: 'main',
        isMain: true,
        isScheduledTask: true,
        script: 'echo hello',
      }),
    ).rejects.toThrow(
      'MODEL_BACKEND=ollama does not support scheduled task scripts',
    );
  });

  it('rejects unsafe session ids', async () => {
    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    await expect(
      runDirectOllamaAgent(group, {
        prompt: 'hello',
        sessionId: '../escape',
        chatJid: 'wecom:YangKai',
        groupFolder: 'main',
        isMain: true,
      }),
    ).rejects.toThrow('Invalid Ollama session id');
  });
});
