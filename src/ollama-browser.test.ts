import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPaths = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('fs');
  const os = require('node:os') as typeof import('os');
  const path = require('node:path') as typeof import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-browser-'));
  return {
    tmpRoot,
    dataDir: path.join(tmpRoot, 'data'),
  };
});

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  DATA_DIR: mockedPaths.dataDir,
  OLLAMA_HTTP_ALLOW_PRIVATE: false,
}));

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const mockEnsureContainerRuntimeRunning = vi.fn();
const mockStopContainer = vi.fn();
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  ensureContainerRuntimeRunning: () => mockEnsureContainerRuntimeRunning(),
  hostGatewayArgs: () => [],
  stopContainer: (...args: unknown[]) => mockStopContainer(...args),
}));

const mockLookup = vi.fn();
vi.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  executeBrowserToolCall,
  getBrowserToolDefinitions,
} from './ollama-browser.js';

describe('ollama browser tools', () => {
  beforeEach(() => {
    fs.rmSync(mockedPaths.tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(mockedPaths.dataDir, { recursive: true });
    vi.clearAllMocks();
    mockLookup.mockResolvedValue([{ address: '104.16.0.0', family: 4 }]);
  });

  it('starts a sidecar and opens a page', async () => {
    let inspectCalls = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (
          error: Error | null,
          stdout?: string | Buffer,
          stderr?: string | Buffer,
        ) => void,
      ) => {
        if (args[0] === 'inspect') {
          inspectCalls += 1;
          if (inspectCalls === 1) return cb(new Error('missing'));
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open')
          return cb(null, '', '');
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'https://example.com/\n', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'title'
        ) {
          return cb(null, 'Example Domain\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const result = await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(JSON.parse(result)).toEqual({
      ok: true,
      url: 'https://example.com/',
      title: 'Example Domain',
    });
    expect(mockEnsureContainerRuntimeRunning).toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run', '--cap-add=NET_ADMIN', '--user', 'root']),
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        expect.stringContaining(
          'ip6tables -A OUTPUT -d ::ffff:0:0/96 -j REJECT',
        ),
      ]),
      expect.any(Object),
      expect.any(Function),
    );
    const runCall = mockExecFile.mock.calls.find(
      (call) => (call[1] as string[])[0] === 'run',
    );
    expect(runCall).toBeTruthy();
    expect((runCall?.[1] as string[]).at(-1)).not.toContain('then;');
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'exec',
        '-u',
        'node',
        'nanoclaw-browser-main-session-1',
        'agent-browser',
      ]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('reuses an existing sidecar for snapshot', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (
          error: Error | null,
          stdout?: string | Buffer,
          stderr?: string | Buffer,
        ) => void,
      ) => {
        if (args[0] === 'inspect') return cb(null, 'true\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'https://example.com/\n', '');
        }
        if (args[0] === 'exec' && args.at(-1) === '-c') {
          return cb(null, '- heading "Example Domain" [ref=e1]\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const result = await executeBrowserToolCall(
      'browser_snapshot',
      { compact: true },
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(result).toContain('Example Domain');
    expect(mockExecFile).toHaveBeenCalledTimes(4);
  });

  it('blocks localhost opens by default', async () => {
    await expect(
      executeBrowserToolCall(
        'browser_open',
        { url: 'http://localhost:3000' },
        { groupFolder: 'main', sessionId: 'session-1' },
      ),
    ).rejects.toThrow('Blocked private HTTP destination');
  });

  it('closes the sidecar if the browser lands on a private URL', async () => {
    let inspectCalls = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (
          error: Error | null,
          stdout?: string | Buffer,
          stderr?: string | Buffer,
        ) => void,
      ) => {
        if (args[0] === 'inspect') {
          inspectCalls += 1;
          if (inspectCalls === 1) return cb(new Error('missing'));
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open')
          return cb(null, '', '');
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'http://localhost:3000/\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await expect(
      executeBrowserToolCall(
        'browser_open',
        { url: 'https://example.com' },
        { groupFolder: 'main', sessionId: 'session-1' },
      ),
    ).rejects.toThrow('Blocked private HTTP destination');
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-browser-main-session-1',
    );
  });

  it('closes the sidecar if browser_fill triggers navigation to a private URL', async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (
          error: Error | null,
          stdout?: string | Buffer,
          stderr?: string | Buffer,
        ) => void,
      ) => {
        if (args[0] === 'inspect') return cb(null, 'true\n', '');
        if (args[0] === 'exec' && args.at(-3) === 'fill')
          return cb(null, '', '');
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'http://localhost:3000/\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await expect(
      executeBrowserToolCall(
        'browser_fill',
        { target: 'search', text: 'hello' },
        { groupFolder: 'main', sessionId: 'session-1' },
      ),
    ).rejects.toThrow('Blocked private HTTP destination');
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-browser-main-session-1',
    );
  });

  it('closes the browser sidecar', async () => {
    const result = await executeBrowserToolCall(
      'browser_close',
      {},
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(JSON.parse(result).ok).toBe(true);
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-browser-main-session-1',
    );
  });

  it('waits for the sidecar readiness sentinel before first use', async () => {
    let inspectCalls = 0;
    let readyChecks = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (
          error: Error | null,
          stdout?: string | Buffer,
          stderr?: string | Buffer,
        ) => void,
      ) => {
        if (args[0] === 'inspect') {
          inspectCalls += 1;
          if (inspectCalls === 1) return cb(new Error('missing'));
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          readyChecks += 1;
          if (readyChecks === 1) return cb(new Error('not ready yet'));
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'https://example.com/\n', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'title'
        ) {
          return cb(null, 'Example Domain\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const result = await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(JSON.parse(result).title).toBe('Example Domain');
    expect(readyChecks).toBe(2);
  });

  it('exposes browser tools to Ollama', async () => {
    const names = getBrowserToolDefinitions().map((tool) => tool.function.name);
    expect(names).toContain('browser_open');
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_close');
  });
});
