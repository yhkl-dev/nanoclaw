import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPaths = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('fs');
  const os = require('node:os') as typeof import('os');
  const path = require('node:path') as typeof import('path');
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-ollama-direct-'),
  );
  return {
    tmpRoot,
    dataDir: path.join(tmpRoot, 'data'),
    groupsDir: path.join(tmpRoot, 'groups'),
  };
});

const mockedConfigFlags = vi.hoisted(() => ({
  ollamaEnableHostScripts: false,
  ollamaHttpAllowPrivate: false,
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_TIMEOUT: 30_000,
  DATA_DIR: mockedPaths.dataDir,
  GROUPS_DIR: mockedPaths.groupsDir,
  get OLLAMA_ENABLE_HOST_SCRIPTS() {
    return mockedConfigFlags.ollamaEnableHostScripts;
  },
  OLLAMA_HOST: 'http://192.168.2.19:11434',
  get OLLAMA_HTTP_ALLOW_PRIVATE() {
    return mockedConfigFlags.ollamaHttpAllowPrivate;
  },
  OLLAMA_MODEL: 'qwen3-coder:30b',
}));

const mockStopContainer = vi.fn();
const mockEnsureContainerRuntimeRunning = vi.fn();
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  ensureContainerRuntimeRunning: () => mockEnsureContainerRuntimeRunning(),
  hostGatewayArgs: () => [],
  stopContainer: (...args: unknown[]) => mockStopContainer(...args),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const mockLookup = vi.fn();
vi.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
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
    mockedConfigFlags.ollamaEnableHostScripts = false;
    mockedConfigFlags.ollamaHttpAllowPrivate = false;
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
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
        content:
          '<messages><message sender="YangKai">你好</message></messages>',
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

  it('executes tool calls before returning final content', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'http_request',
                    arguments: { url: 'https://example.com', method: 'GET' },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://example.com/',
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Example Domain</title></html>',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: { role: 'assistant', content: 'Example Domain' },
          }),
      } as Response);

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const result = await runDirectOllamaAgent(group, {
      prompt: 'Fetch https://example.com and summarize it',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
    });

    expect(result.result).toBe('Example Domain');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstBody.tools?.[0]?.function?.name).toBe('http_request');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://example.com/');
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
    const secondChatBody = JSON.parse(
      String(fetchMock.mock.calls[2]?.[1]?.body),
    );
    expect(
      secondChatBody.messages.some(
        (message: { role: string; tool_name?: string }) =>
          message.role === 'tool' && message.tool_name === 'http_request',
      ),
    ).toBe(true);
  });

  it('retries validated HTTP addresses when the first connect attempt fails', async () => {
    const fetchMock = vi.mocked(fetch);
    mockLookup.mockResolvedValue([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'http_request',
                    arguments: { url: 'https://example.com', method: 'GET' },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      )
      .mockResolvedValueOnce({
        ok: true,
        url: 'https://example.com/',
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Example Domain</title></html>',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: { role: 'assistant', content: 'Example Domain' },
          }),
      } as Response);

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const result = await runDirectOllamaAgent(group, {
      prompt: 'Fetch https://example.com and summarize it',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
    });

    expect(result.result).toBe('Example Domain');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry non-idempotent HTTP requests across validated addresses', async () => {
    const fetchMock = vi.mocked(fetch);
    mockLookup.mockResolvedValue([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'http_request',
                    arguments: {
                      url: 'https://example.com',
                      method: 'POST',
                      body: { hello: 'world' },
                    },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockRejectedValueOnce(new Error('connect failed'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: { role: 'assistant', content: 'post failed once' },
          }),
      } as Response);

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const result = await runDirectOllamaAgent(group, {
      prompt: 'Post to https://example.com',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
    });

    expect(result.result).toBe('post failed once');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry GET requests on non-connect errors', async () => {
    const fetchMock = vi.mocked(fetch);
    mockLookup.mockResolvedValue([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'http_request',
                    arguments: { url: 'https://example.com', method: 'GET' },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockRejectedValueOnce(new Error('self signed certificate'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: { role: 'assistant', content: 'tls failed once' },
          }),
      } as Response);

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const result = await runDirectOllamaAgent(group, {
      prompt: 'Fetch https://example.com and summarize it',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
    });

    expect(result.result).toBe('tls failed once');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('executes browser tool calls before returning final content', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'browser_open',
                    arguments: {
                      url: 'https://www.weather.com/weather/today/l/CHXX0008:1:CH',
                    },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'browser_snapshot',
                    arguments: { compact: true },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: { role: 'assistant', content: '今天多云。' },
          }),
      } as Response);

    const execSteps: Array<{
      error?: Error;
      stdout?: string;
      stderr?: string;
    }> = [
      { error: new Error('missing container') },
      { stdout: 'container-id\n' },
      { stdout: '' },
      { stdout: 'https://www.weather.com/weather/today/l/CHXX0008:1:CH\n' },
      { stdout: 'Today Weather\n' },
      { stdout: 'true\n' },
      { stdout: '- heading "Today" [ref=e1]\n' },
    ];
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (
          error: Error | null,
          stdout?: string | Buffer,
          stderr?: string | Buffer,
        ) => void,
      ) => {
        const next = execSteps.shift();
        if (!next) {
          cb(new Error('unexpected execFile call'));
          return;
        }
        cb(next.error ?? null, next.stdout ?? '', next.stderr ?? '');
      },
    );

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const result = await runDirectOllamaAgent(group, {
      prompt: '查看今天的天气',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
    });

    expect(result.result).toBe('今天多云。');
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(
      firstBody.tools.some(
        (tool: { function: { name: string } }) =>
          tool.function.name === 'browser_open',
      ),
    ).toBe(true);
    const finalBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(
      finalBody.messages.some(
        (message: { role: string; tool_name?: string }) =>
          message.role === 'tool' && message.tool_name === 'browser_snapshot',
      ),
    ).toBe(true);
  });

  it('closes browser sidecars after scheduled tasks', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'browser_open',
                    arguments: { url: 'https://example.com' },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: { role: 'assistant', content: 'done' },
          }),
      } as Response);

    const execSteps: Array<{
      error?: Error;
      stdout?: string;
      stderr?: string;
    }> = [
      { error: new Error('missing container') },
      { stdout: 'container-id\n' },
      { stdout: '' },
      { stdout: 'https://example.com/\n' },
      { stdout: 'https://example.com/\n' },
      { stdout: 'Example Domain\n' },
    ];
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (
          error: Error | null,
          stdout?: string | Buffer,
          stderr?: string | Buffer,
        ) => void,
      ) => {
        const next = execSteps.shift();
        if (!next) {
          cb(new Error('unexpected execFile call'));
          return;
        }
        cb(next.error ?? null, next.stdout ?? '', next.stderr ?? '');
      },
    );

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const result = await runDirectOllamaAgent(group, {
      prompt: 'scheduled browser job',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
      isScheduledTask: true,
    });

    expect(result.result).toBe('done');
    expect(mockStopContainer).toHaveBeenCalledWith(
      expect.stringMatching(/^nanoclaw-browser-main-/),
    );
  });

  it('keeps shared-session browser sidecars alive for scheduled tasks', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          message: { role: 'assistant', content: 'done' },
        }),
    } as Response);

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const result = await runDirectOllamaAgent(group, {
      prompt: 'scheduled browser job',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
      isScheduledTask: true,
      sessionId: 'session-1',
    });

    expect(result.result).toBe('done');
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('blocks localhost HTTP tool targets by default', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'http_request',
                    arguments: { url: 'http://localhost:11434/api/tags' },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'blocked as expected',
            },
          }),
      } as Response);

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const result = await runDirectOllamaAgent(group, {
      prompt: 'Try to call localhost',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
    });

    expect(result.result).toBe('blocked as expected');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('blocks redirects from public URLs to localhost', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'http_request',
                    arguments: { url: 'https://example.com/redirect' },
                  },
                },
              ],
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: 'http://localhost:11434/api/tags' }),
        text: async () => '',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            message: { role: 'assistant', content: 'redirect blocked' },
          }),
      } as Response);

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    const result = await runDirectOllamaAgent(group, {
      prompt: 'Try the redirect',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
    });

    expect(result.result).toBe('redirect blocked');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects scheduled task scripts unless explicitly enabled', async () => {
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
    ).rejects.toThrow('OLLAMA_ENABLE_HOST_SCRIPTS=true');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns success with no output when scheduled script says wakeAgent=false', async () => {
    mockedConfigFlags.ollamaEnableHostScripts = true;

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, '{"wakeAgent":false}\n', '');
      },
    );

    const result = await runDirectOllamaAgent(group, {
      prompt: 'task prompt',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
      isScheduledTask: true,
      script: 'echo hello',
    });

    expect(result).toEqual({
      status: 'success',
      result: null,
      newSessionId: undefined,
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('runs scheduled task script data through Ollama when wakeAgent=true', async () => {
    mockedConfigFlags.ollamaEnableHostScripts = true;

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, '{"wakeAgent":true,"data":{"city":"Shanghai"}}\n', '');
      },
    );

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          message: { role: 'assistant', content: 'script ok' },
        }),
    } as Response);

    const result = await runDirectOllamaAgent(group, {
      prompt: 'Summarize the task output',
      chatJid: 'wecom:YangKai',
      groupFolder: 'main',
      isMain: true,
      isScheduledTask: true,
      script: 'echo hello',
    });

    expect(result.result).toBe('script ok');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages.at(-1)?.content).toContain('"city": "Shanghai"');
    expect(body.messages.at(-1)?.content).toContain(
      'Summarize the task output',
    );
  });

  it('surfaces scheduled task script failures', async () => {
    mockedConfigFlags.ollamaEnableHostScripts = true;

    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      isMain: true,
    };

    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, 'not-json\n', '');
      },
    );

    await expect(
      runDirectOllamaAgent(group, {
        prompt: 'task prompt',
        chatJid: 'wecom:YangKai',
        groupFolder: 'main',
        isMain: true,
        isScheduledTask: true,
        script: 'echo hello',
      }),
    ).rejects.toThrow('Task script output is not valid JSON');
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

  it('rejects mismatched group folders', async () => {
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
        groupFolder: 'other',
        isMain: true,
      }),
    ).rejects.toThrow('Direct Ollama group mismatch');
  });
});
