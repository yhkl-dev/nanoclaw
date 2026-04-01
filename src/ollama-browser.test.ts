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
  resetOllamaBrowserTransientState,
} from './ollama-browser.js';

describe('ollama browser tools', () => {
  beforeEach(() => {
    fs.rmSync(mockedPaths.tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(mockedPaths.dataDir, { recursive: true });
    vi.clearAllMocks();
    resetOllamaBrowserTransientState();
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
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      'export PATH="$PATH:/usr/sbin:/sbin"',
    );
    expect((runCall?.[1] as string[]).at(-1)).not.toContain('then;');
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      'command -v iptables >/dev/null 2>&1 || { echo "iptables is required for browser network sandbox" >&2; exit 1; }',
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      'iptables -I OUTPUT -o lo -j ACCEPT',
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      'ip6tables -I OUTPUT -o lo -j ACCEPT',
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      "dns_servers=$(awk '/^nameserver / {print $2}' /etc/resolv.conf)",
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      '[ -n "$dns_servers" ] || { echo "No DNS resolvers found in /etc/resolv.conf" >&2; exit 1; }',
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      'for dns_server in $dns_servers; do',
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      'iptables -I OUTPUT -d "$dns_server" -p udp --dport 53 -j ACCEPT',
    );
    expect((runCall?.[1] as string[]).at(-1)).not.toContain(
      'iptables -I OUTPUT -d 127.0.0.11 -p udp --dport 53 -j ACCEPT',
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      'command -v ip6tables >/dev/null 2>&1 || { echo "ip6tables is required for browser network sandbox" >&2; exit 1; }',
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      "tail -n +1 -F '/tmp/nanoclaw-browser-trace.log' &",
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      'chmod 666 /tmp/nanoclaw-browser-trace.log',
    );
    expect((runCall?.[1] as string[]).at(-1)).toContain(
      'chown node:node /tmp/nanoclaw-browser-trace.log',
    );
    const startupScript = String((runCall?.[1] as string[]).at(-1));
    expect(
      startupScript.indexOf('touch /tmp/nanoclaw-browser-ready'),
    ).toBeGreaterThan(
      startupScript.indexOf('chown node:node /tmp/nanoclaw-browser-trace.log'),
    );
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
    const openCall = mockExecFile.mock.calls.find((call) => {
      const args = call[1] as string[];
      return args[0] === 'exec' && args.at(-2) === 'open';
    });
    expect(openCall).toBeTruthy();
    expect(openCall?.[1]).toEqual(
      expect.arrayContaining(['sh', '-lc', 'sh', 'agent-browser']),
    );
    expect(String((openCall?.[1] as string[])[6])).toContain(
      '/tmp/nanoclaw-browser-trace.log',
    );
  });

  it('fails closed by requiring iptables and ip6tables for the browser sandbox', async () => {
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
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-iptables-guard' },
    );

    const runCall = mockExecFile.mock.calls.find(
      (call) => (call[1] as string[])[0] === 'run',
    );
    expect(runCall).toBeTruthy();
    const startupScript = String((runCall?.[1] as string[]).at(-1));
    expect(startupScript).toContain(
      'command -v iptables >/dev/null 2>&1 || { echo "iptables is required for browser network sandbox" >&2; exit 1; }',
    );
    expect(startupScript).toContain(
      'command -v ip6tables >/dev/null 2>&1 || { echo "ip6tables is required for browser network sandbox" >&2; exit 1; }',
    );
    expect(startupScript).toContain('iptables -I OUTPUT -o lo -j ACCEPT');
    expect(startupScript).toContain('ip6tables -I OUTPUT -o lo -j ACCEPT');
    expect(startupScript).toContain(
      "dns_servers=$(awk '/^nameserver / {print $2}' /etc/resolv.conf)",
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
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const result = await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(JSON.parse(result).url).toBe('https://example.com/');
    expect(readyChecks).toBe(2);
  });

  it('rebuilds the sidecar and retries after a recoverable browser busy error', async () => {
    let inspectCalls = 0;
    let getUrlCalls = 0;
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
          if (inspectCalls === 1 || inspectCalls === 4) {
            return cb(new Error('missing'));
          }
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
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
          getUrlCalls += 1;
          if (getUrlCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'https://example.com/\n', '');
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
    });
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-browser-main-session-1',
    );
    expect(getUrlCalls).toBe(3);
  });

  it('falls back to HTML fetch when browser_open hits a recoverable navigation timeout', async () => {
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
        if (args[0] === 'run' && args.includes('-d')) {
          return cb(null, 'container-id\n', '');
        }
        if (args[0] === 'run') {
          return cb(
            null,
            [
              '__NANOCLAW_URL__=https://example.com/',
              '__NANOCLAW_CONTENT_TYPE__=text/html',
              '__NANOCLAW_BROWSER_BODY__',
              '<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>Hello world</p></body></html>',
            ].join('\n'),
            '',
          );
        }
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(
            Object.assign(new Error('CDP command timed out: Page.navigate'), {
              stderr: 'CDP command timed out: Page.navigate',
            }),
          );
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const result = await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-html-fallback' },
    );

    expect(JSON.parse(result)).toEqual({
      ok: true,
      url: 'https://example.com/',
      degraded: true,
      title: 'Example Domain',
    });
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-browser-main-session-html-fallback',
    );
  });

  it('falls back to the Hacker News API when HN HTML fetch is unreachable', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/v0/topstories.json')) {
        return new Response(JSON.stringify([101, 102]));
      }
      if (url.endsWith('/v0/item/101.json')) {
        return new Response(
          JSON.stringify({
            id: 101,
            title: 'First HN Story',
            url: 'https://example.com/first',
            by: 'alice',
            score: 123,
          }),
        );
      }
      if (url.endsWith('/v0/item/102.json')) {
        return new Response(
          JSON.stringify({
            id: 102,
            title: 'Second HN Story',
            url: 'https://example.com/second',
            by: 'bob',
            score: 99,
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    let inspectCalls = 0;
    let openCompleted = false;
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
          if (!openCompleted) {
            if (inspectCalls === 1) return cb(new Error('missing'));
            return cb(null, 'true\n', '');
          }
          return cb(new Error('missing'));
        }
        if (args[0] === 'run' && args.includes('-d')) {
          return cb(null, 'container-id\n', '');
        }
        if (args[0] === 'run') {
          return cb(
            Object.assign(
              new Error(
                'curl: (28) Connection timed out after 20002 milliseconds',
              ),
              {
                stderr:
                  'curl: (28) Connection timed out after 20002 milliseconds',
                code: 28,
              },
            ),
          );
        }
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(
            Object.assign(new Error('CDP command timed out: Page.navigate'), {
              stderr: 'CDP command timed out: Page.navigate',
            }),
          );
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    try {
      const result = await executeBrowserToolCall(
        'browser_open',
        { url: 'https://news.ycombinator.com' },
        { groupFolder: 'main', sessionId: 'session-hn-api-fallback' },
      );
      openCompleted = true;
      const snapshot = await executeBrowserToolCall(
        'browser_snapshot',
        {},
        { groupFolder: 'main', sessionId: 'session-hn-api-fallback' },
      );

      expect(JSON.parse(result)).toEqual({
        ok: true,
        url: 'https://news.ycombinator.com/',
        degraded: true,
        title: 'Hacker News',
      });
      expect(snapshot).toContain('[browser hacker news api fallback]');
      expect(snapshot).toContain('First HN Story');
      expect(snapshot).toContain('Second HN Story');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('uses the remembered URL HTML fallback for snapshot when no sidecar is running', async () => {
    let inspectCalls = 0;
    let openCompleted = false;
    let fallbackRuns = 0;
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
          if (!openCompleted) {
            if (inspectCalls === 1) {
              return cb(new Error('missing'));
            }
            return cb(null, 'true\n', '');
          }
          if (inspectCalls >= 3) {
            return cb(new Error('missing'));
          }
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run' && args.includes('-d')) {
          return cb(null, 'container-id\n', '');
        }
        if (args[0] === 'run') {
          fallbackRuns += 1;
          return cb(
            null,
            [
              '__NANOCLAW_URL__=https://example.com/',
              '__NANOCLAW_CONTENT_TYPE__=text/html',
              '__NANOCLAW_BROWSER_BODY__',
              `<html><head><title>Example Domain ${fallbackRuns}</title></head><body><a href="/news">News</a><p>Hello world</p></body></html>`,
            ].join('\n'),
            '',
          );
        }
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(
            Object.assign(new Error('CDP command timed out: Page.navigate'), {
              stderr: 'CDP command timed out: Page.navigate',
            }),
          );
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-fallback-snapshot' },
    );
    openCompleted = true;
    const result = await executeBrowserToolCall(
      'browser_snapshot',
      {},
      { groupFolder: 'main', sessionId: 'session-fallback-snapshot' },
    );

    expect(result).toContain('[browser html fallback]');
    expect(result).toContain('Title: Example Domain 2');
    expect(result).toContain('Links:');
  });

  it('uses persisted lastUrl for snapshot fallback after process restart', async () => {
    const recoveryDir = path.join(
      mockedPaths.dataDir,
      'sessions',
      'main',
      'ollama-browser',
    );
    fs.mkdirSync(recoveryDir, { recursive: true });
    fs.writeFileSync(
      path.join(recoveryDir, 'session-persisted-last-url.recovery.json'),
      JSON.stringify({
        refsLost: true,
        historyLost: true,
        lastUrl: 'https://example.com/',
      }) + '\n',
    );
    resetOllamaBrowserTransientState();

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
        if (args[0] === 'inspect') return cb(new Error('missing'));
        if (args[0] === 'run') {
          return cb(
            null,
            [
              '__NANOCLAW_URL__=https://example.com/',
              '__NANOCLAW_CONTENT_TYPE__=text/html',
              '__NANOCLAW_BROWSER_BODY__',
              '<html><head><title>Example Domain</title></head><body>Hello restart</body></html>',
            ].join('\n'),
            '',
          );
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const result = await executeBrowserToolCall(
      'browser_snapshot',
      {},
      { groupFolder: 'main', sessionId: 'session-persisted-last-url' },
    );

    expect(result).toContain('[browser html fallback]');
    expect(result).toContain('URL: https://example.com/');
    expect(result).toContain('Title: Example Domain');
    expect(result).toContain('Hello restart');
  });

  it('requires a fresh snapshot before ref actions after a prior transparent recovery', async () => {
    let inspectCalls = 0;
    let titleCalls = 0;
    let clickCalls = 0;
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
          if (inspectCalls === 2) {
            return cb(new Error('missing'));
          }
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run' && args.includes('-d')) {
          return cb(null, 'container-id\n', '');
        }
        if (args[0] === 'run') {
          return cb(
            null,
            [
              '__NANOCLAW_URL__=https://example.com/',
              '__NANOCLAW_CONTENT_TYPE__=text/html',
              '__NANOCLAW_BROWSER_BODY__',
              '<html><head><title>Example Domain</title></head><body><button>Open</button></body></html>',
            ].join('\n'),
            '',
          );
        }
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'title'
        ) {
          titleCalls += 1;
          if (titleCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'Example Domain\n', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'click') {
          clickCalls += 1;
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'https://example.com/after-click\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    expect(
      await executeBrowserToolCall(
        'browser_get_title',
        {},
        { groupFolder: 'main', sessionId: 'session-restore-before-click' },
      ),
    ).toBe('Example Domain');

    await expect(
      executeBrowserToolCall(
        'browser_click',
        { target: '@e1' },
        { groupFolder: 'main', sessionId: 'session-restore-before-click' },
      ),
    ).rejects.toThrow('Re-run browser_snapshot before using element refs');

    expect(clickCalls).toBe(0);
  });

  it('requires a fresh snapshot before interactive actions after a degraded open restores the URL', async () => {
    let inspectCalls = 0;
    const openTargets: string[] = [];
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
          if (inspectCalls === 1 || inspectCalls === 3) {
            return cb(new Error('missing'));
          }
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run' && args.includes('-d')) {
          return cb(null, 'container-id\n', '');
        }
        if (args[0] === 'run') {
          return cb(
            null,
            [
              '__NANOCLAW_URL__=https://example.com/',
              '__NANOCLAW_CONTENT_TYPE__=text/html',
              '__NANOCLAW_BROWSER_BODY__',
              '<html><head><title>Example Domain</title></head><body><button>Open</button></body></html>',
            ].join('\n'),
            '',
          );
        }
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          openTargets.push(String(args.at(-1)));
          return cb(
            Object.assign(new Error('CDP command timed out: Page.navigate'), {
              stderr: 'CDP command timed out: Page.navigate',
            }),
          );
        }
        if (args[0] === 'exec' && args.at(-2) === 'click') {
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'https://example.com/after-click\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-restore-before-click' },
    );

    await expect(
      executeBrowserToolCall(
        'browser_click',
        { target: '@e1' },
        { groupFolder: 'main', sessionId: 'session-restore-before-click' },
      ),
    ).rejects.toThrow('Re-run browser_snapshot before using element refs');
    expect(openTargets.at(-1)).toBe('https://example.com/');
  });

  it('allows selector-based click after a fresh-sidecar restore', async () => {
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
          if (inspectCalls === 1 || inspectCalls === 3) {
            return cb(new Error('missing'));
          }
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run' && args.includes('-d')) {
          return cb(null, 'container-id\n', '');
        }
        if (args[0] === 'run') {
          return cb(
            null,
            [
              '__NANOCLAW_URL__=https://example.com/',
              '__NANOCLAW_CONTENT_TYPE__=text/html',
              '__NANOCLAW_BROWSER_BODY__',
              '<html><head><title>Example Domain</title></head><body><button id="next">Next</button></body></html>',
            ].join('\n'),
            '',
          );
        }
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(
            Object.assign(new Error('CDP command timed out: Page.navigate'), {
              stderr: 'CDP command timed out: Page.navigate',
            }),
          );
        }
        if (args[0] === 'exec' && args.at(-2) === 'click') {
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'https://example.com/next\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-selector-after-restore' },
    );

    expect(
      JSON.parse(
        await executeBrowserToolCall(
          'browser_click',
          { target: '#next' },
          { groupFolder: 'main', sessionId: 'session-selector-after-restore' },
        ),
      ),
    ).toEqual({
      ok: true,
      target: '#next',
      url: 'https://example.com/next',
    });
  });

  it('validates the restored landing URL before running selector actions', async () => {
    const inspectResponses: Array<Error | string> = [
      new Error('missing'),
      'true\n',
      'true\n',
      new Error('missing'),
    ];
    let clickCalls = 0;
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
          const next = inspectResponses.shift();
          if (next instanceof Error) {
            return cb(next);
          }
          return cb(null, next ?? 'true\n', '');
        }
        if (args[0] === 'run' && args.includes('-d')) {
          return cb(null, 'container-id\n', '');
        }
        if (args[0] === 'run') {
          return cb(
            null,
            [
              '__NANOCLAW_URL__=https://example.com/',
              '__NANOCLAW_CONTENT_TYPE__=text/html',
              '__NANOCLAW_BROWSER_BODY__',
              '<html><head><title>Example Domain</title></head><body><button id="next">Next</button></body></html>',
            ].join('\n'),
            '',
          );
        }
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(
            Object.assign(new Error('CDP command timed out: Page.navigate'), {
              stderr: 'CDP command timed out: Page.navigate',
            }),
          );
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'http://127.0.0.1/private\n', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'click') {
          clickCalls += 1;
          return cb(null, '', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-validate-before-click' },
    );

    await expect(
      executeBrowserToolCall(
        'browser_click',
        { target: '#next' },
        { groupFolder: 'main', sessionId: 'session-validate-before-click' },
      ),
    ).rejects.toThrow();

    expect(clickCalls).toBe(0);
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-browser-main-session-validate-before-click',
    );
  });

  it('persists recovery state when browser_press restores a fresh sidecar', async () => {
    const inspectResponses: Array<Error | string> = [
      new Error('missing'),
      'true\n',
      'true\n',
      new Error('missing'),
      'true\n',
    ];
    const recoveryPath = path.join(
      mockedPaths.dataDir,
      'sessions',
      'main',
      'ollama-browser',
      'session-restore-get-title.recovery.json',
    );
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
          const next = inspectResponses.shift();
          if (next instanceof Error) {
            return cb(next);
          }
          return cb(null, next ?? 'true\n', '');
        }
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'press') {
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'https://example.com/\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await executeBrowserToolCall(
      'browser_open',
      { url: 'https://example.com' },
      { groupFolder: 'main', sessionId: 'session-restore-get-title' },
    );

    expect(
      JSON.parse(
        await executeBrowserToolCall(
          'browser_press',
          { key: 'Enter' },
          { groupFolder: 'main', sessionId: 'session-restore-get-title' },
        ),
      ),
    ).toEqual({
      ok: true,
      key: 'Enter',
      url: 'https://example.com/',
    });

    expect(JSON.parse(fs.readFileSync(recoveryPath, 'utf-8'))).toEqual({
      refsLost: true,
      historyLost: true,
      lastUrl: 'https://example.com/',
    });
  });

  it('blocks browser_back after a prior transparent session recovery lost history', async () => {
    let getTitleCalls = 0;
    let backCalls = 0;
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
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
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
          getTitleCalls += 1;
          if (getTitleCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'Example Domain\n', '');
        }
        if (args[0] === 'exec' && args.at(-1) === 'back') {
          backCalls += 1;
          return cb(null, '', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    expect(
      await executeBrowserToolCall(
        'browser_get_title',
        {},
        { groupFolder: 'main', sessionId: 'session-history-loss' },
      ),
    ).toBe('Example Domain');

    await expect(
      executeBrowserToolCall(
        'browser_back',
        {},
        { groupFolder: 'main', sessionId: 'session-history-loss' },
      ),
    ).rejects.toThrow('Browser history was lost');
    expect(backCalls).toBe(0);
  });

  it('keeps lost history blocked when restore preflight only lands on a redirected URL', async () => {
    let getTitleCalls = 0;
    let backCalls = 0;
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
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
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
          return cb(null, 'https://example.com/home\n', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'title'
        ) {
          getTitleCalls += 1;
          if (getTitleCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'Example Domain\n', '');
        }
        if (args[0] === 'exec' && args.at(-1) === 'back') {
          backCalls += 1;
          return cb(null, '', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    expect(
      await executeBrowserToolCall(
        'browser_get_title',
        {},
        { groupFolder: 'main', sessionId: 'session-history-redirected-restore' },
      ),
    ).toBe('Example Domain');

    await expect(
      executeBrowserToolCall(
        'browser_back',
        {},
        { groupFolder: 'main', sessionId: 'session-history-redirected-restore' },
      ),
    ).rejects.toThrow('Browser history was lost');

    expect(backCalls).toBe(0);
  });

  it('persists stale ref guards across process restarts while reusing the sidecar', async () => {
    let getTitleCalls = 0;
    let clickCalls = 0;
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
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
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
          getTitleCalls += 1;
          if (getTitleCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'Example Domain\n', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'click') {
          clickCalls += 1;
          return cb(null, '', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    expect(
      await executeBrowserToolCall(
        'browser_get_title',
        {},
        { groupFolder: 'main', sessionId: 'session-restart-ref-loss' },
      ),
    ).toBe('Example Domain');

    resetOllamaBrowserTransientState();

    await expect(
      executeBrowserToolCall(
        'browser_click',
        { target: '@e1' },
        { groupFolder: 'main', sessionId: 'session-restart-ref-loss' },
      ),
    ).rejects.toThrow('Re-run browser_snapshot before using element refs');

    expect(clickCalls).toBe(0);
  });

  it('persists lost history guards across process restarts while reusing the sidecar', async () => {
    let getTitleCalls = 0;
    let backCalls = 0;
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
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
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
          getTitleCalls += 1;
          if (getTitleCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'Example Domain\n', '');
        }
        if (args[0] === 'exec' && args.at(-1) === 'back') {
          backCalls += 1;
          return cb(null, '', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    expect(
      await executeBrowserToolCall(
        'browser_get_title',
        {},
        { groupFolder: 'main', sessionId: 'session-restart-history-loss' },
      ),
    ).toBe('Example Domain');

    resetOllamaBrowserTransientState();

    await expect(
      executeBrowserToolCall(
        'browser_back',
        {},
        { groupFolder: 'main', sessionId: 'session-restart-history-loss' },
      ),
    ).rejects.toThrow(
      'Browser history was lost when the browser session restarted',
    );

    expect(backCalls).toBe(0);
  });

  it('clears lost history after a successful post-recovery navigation', async () => {
    let getTitleCalls = 0;
    let clickCalls = 0;
    let backCalls = 0;
    let currentUrl = 'https://example.com/';
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
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
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
          return cb(null, `${currentUrl}\n`, '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'title'
        ) {
          getTitleCalls += 1;
          if (getTitleCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'Example Domain\n', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'click') {
          clickCalls += 1;
          currentUrl = 'https://example.com/next';
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-1) === 'back') {
          backCalls += 1;
          currentUrl = 'https://example.com/';
          return cb(null, '', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    expect(
      await executeBrowserToolCall(
        'browser_get_title',
        {},
        { groupFolder: 'main', sessionId: 'session-history-restored-by-nav' },
      ),
    ).toBe('Example Domain');

    expect(
      JSON.parse(
        await executeBrowserToolCall(
          'browser_click',
          { target: '#next' },
          { groupFolder: 'main', sessionId: 'session-history-restored-by-nav' },
        ),
      ),
    ).toEqual({
      ok: true,
      target: '#next',
      url: 'https://example.com/next',
    });

    expect(
      JSON.parse(
        await executeBrowserToolCall(
          'browser_back',
          {},
          { groupFolder: 'main', sessionId: 'session-history-restored-by-nav' },
        ),
      ),
    ).toEqual({
      ok: true,
      action: 'back',
      url: 'https://example.com/',
    });

    expect(clickCalls).toBe(1);
    expect(backCalls).toBe(1);
  });

  it('clears lost history when browser_get_url observes a new post-recovery URL', async () => {
    let getTitleCalls = 0;
    let backCalls = 0;
    let currentUrl = 'https://example.com/';
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
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
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
          return cb(null, `${currentUrl}\n`, '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'title'
        ) {
          getTitleCalls += 1;
          if (getTitleCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'Example Domain\n', '');
        }
        if (args[0] === 'exec' && args.at(-1) === 'back') {
          backCalls += 1;
          currentUrl = 'https://example.com/';
          return cb(null, '', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    expect(
      await executeBrowserToolCall(
        'browser_get_title',
        {},
        {
          groupFolder: 'main',
          sessionId: 'session-history-cleared-by-get-url',
        },
      ),
    ).toBe('Example Domain');

    currentUrl = 'https://example.com/redirected';

    expect(
      await executeBrowserToolCall(
        'browser_get_url',
        {},
        {
          groupFolder: 'main',
          sessionId: 'session-history-cleared-by-get-url',
        },
      ),
    ).toBe('https://example.com/redirected');

    expect(
      JSON.parse(
        await executeBrowserToolCall(
          'browser_back',
          {},
          {
            groupFolder: 'main',
            sessionId: 'session-history-cleared-by-get-url',
          },
        ),
      ),
    ).toEqual({
      ok: true,
      action: 'back',
      url: 'https://example.com/',
    });

    expect(backCalls).toBe(1);
  });

  it('ignores corrupted persisted recovery state files', async () => {
    const recoveryDir = path.join(
      mockedPaths.dataDir,
      'sessions',
      'main',
      'ollama-browser',
    );
    const recoveryPath = path.join(
      recoveryDir,
      'session-corrupt.recovery.json',
    );
    fs.mkdirSync(recoveryDir, { recursive: true });
    fs.writeFileSync(recoveryPath, '{"refsLost":');

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
        if (args[0] === 'exec' && args.at(-2) === 'click') {
          return cb(null, '', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const result = await executeBrowserToolCall(
      'browser_click',
      { target: '#cta' },
      { groupFolder: 'main', sessionId: 'session-corrupt' },
    );

    expect(JSON.parse(result)).toEqual({
      ok: true,
      target: '#cta',
      url: 'https://example.com/',
    });
    expect(fs.existsSync(recoveryPath)).toBe(false);
  });

  it('does not persist a recovery file for healthy snapshots', async () => {
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
        if (args[0] === 'exec' && args.at(-1) === 'snapshot') {
          return cb(null, 'snapshot output\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    expect(
      await executeBrowserToolCall(
        'browser_snapshot',
        {},
        { groupFolder: 'main', sessionId: 'session-clean-snapshot' },
      ),
    ).toBe('snapshot output');

    expect(
      fs.existsSync(
        path.join(
          mockedPaths.dataDir,
          'sessions',
          'main',
          'ollama-browser',
          'session-clean-snapshot.recovery.json',
        ),
      ),
    ).toBe(false);
  });

  it('rebuilds using the live sidecar url when in-memory recovery state is empty', async () => {
    let inspectCalls = 0;
    let getUrlCalls = 0;
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
          if (inspectCalls === 2) {
            return cb(new Error('missing'));
          }
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
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
          getUrlCalls += 1;
          if (getUrlCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
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
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-browser-main-session-1',
    );
    expect(getUrlCalls).toBe(3);
  });

  it('prefers the live sidecar url over a stale remembered url during recoverable rebuilds', async () => {
    let inspectCalls = 0;
    let getUrlCalls = 0;
    const reopenedUrls: string[] = [];
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
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          reopenedUrls.push(String(args.at(-1)));
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          getUrlCalls += 1;
          if (getUrlCalls === 1)
            return cb(null, 'https://stale.example.com/\n', '');
          if (getUrlCalls === 2) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'https://live.example.com/\n', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'title'
        ) {
          return cb(null, 'Live Page\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await executeBrowserToolCall(
      'browser_open',
      { url: 'https://stale.example.com' },
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    const result = await executeBrowserToolCall(
      'browser_get_title',
      {},
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(result).toBe('Live Page');
    expect(reopenedUrls.at(-1)).toBe('https://live.example.com/');
  });

  it('does not auto-recover stateful actions when follow-up URL validation fails recoverably', async () => {
    let getUrlCalls = 0;
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
        if (args[0] === 'exec' && args.at(-2) === 'click') {
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          getUrlCalls += 1;
          return cb(
            Object.assign(
              new Error(
                'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
              ),
              {
                stderr:
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
              },
            ),
          );
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await expect(
      executeBrowserToolCall(
        'browser_click',
        { target: '@e1' },
        { groupFolder: 'main', sessionId: 'session-1' },
      ),
    ).rejects.toThrow('daemon may be busy or unresponsive');
    expect(getUrlCalls).toBe(1);
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('does not auto-recover a stateful action when the action command itself fails recoverably', async () => {
    let clickCalls = 0;
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
        if (args[0] === 'exec' && args.at(-2) === 'click') {
          clickCalls += 1;
          return cb(
            Object.assign(
              new Error(
                'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
              ),
              {
                stderr:
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
              },
            ),
          );
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await expect(
      executeBrowserToolCall(
        'browser_click',
        { target: '@e1' },
        { groupFolder: 'main', sessionId: 'session-1' },
      ),
    ).rejects.toThrow('daemon may be busy or unresponsive');
    expect(clickCalls).toBe(1);
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('does not auto-recover browser_wait when the wait command fails recoverably', async () => {
    let waitCalls = 0;
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
        if (args[0] === 'exec' && args.at(-1) === '1000') {
          waitCalls += 1;
          return cb(
            Object.assign(
              new Error(
                'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
              ),
              {
                stderr:
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
              },
            ),
          );
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await expect(
      executeBrowserToolCall(
        'browser_wait',
        { ms: 1000 },
        { groupFolder: 'main', sessionId: 'session-1' },
      ),
    ).rejects.toThrow('daemon may be busy or unresponsive');
    expect(waitCalls).toBe(1);
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('rebuilds and retries browser_snapshot when the snapshot command fails recoverably', async () => {
    let inspectCalls = 0;
    let getUrlCalls = 0;
    let snapshotCalls = 0;
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
          if (inspectCalls === 2) {
            return cb(new Error('missing'));
          }
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          getUrlCalls += 1;
          return cb(null, 'https://example.com/\n', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(null, '', '');
        }
        if (args[0] === 'exec' && args.at(-1) === '-c') {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
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
    expect(snapshotCalls).toBe(2);
    expect(getUrlCalls).toBeGreaterThanOrEqual(1);
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-browser-main-session-1',
    );
  });

  it('reacquires the recovered sidecar before running snapshot after preflight recovery', async () => {
    let inspectCalls = 0;
    let getUrlCalls = 0;
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
          if (inspectCalls === 2) {
            return cb(new Error('missing'));
          }
          return cb(null, 'true\n', '');
        }
        if (args[0] === 'run') return cb(null, 'container-id\n', '');
        if (
          args[0] === 'exec' &&
          args.at(-1) === 'test -f /tmp/nanoclaw-browser-ready'
        ) {
          return cb(null, '', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          getUrlCalls += 1;
          if (getUrlCalls === 1) {
            return cb(
              Object.assign(
                new Error(
                  'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                ),
                {
                  stderr:
                    'Could not configure browser: Failed to read: Resource temporarily unavailable (os error 11) (after 5 retries - daemon may be busy or unresponsive)',
                },
              ),
            );
          }
          return cb(null, 'https://example.com/\n', '');
        }
        if (args[0] === 'exec' && args.at(-2) === 'open') {
          return cb(null, '', '');
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
    expect(inspectCalls).toBe(4);
  });

  it('exposes browser tools to Ollama', async () => {
    const names = getBrowserToolDefinitions().map((tool) => tool.function.name);
    expect(names).toContain('browser_open');
    expect(names).toContain('browser_back');
    expect(names).toContain('browser_scroll');
    expect(names).toContain('browser_get_attr');
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_close');
  });

  it('supports navigation recovery and richer getters', async () => {
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
        if (args[0] === 'exec' && args.at(-1) === 'back')
          return cb(null, '', '');
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'https://example.com/back\n', '');
        }
        if (
          args[0] === 'exec' &&
          args.at(-4) === 'get' &&
          args.at(-3) === 'attr'
        ) {
          return cb(null, 'https://example.com/docs\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const backResult = await executeBrowserToolCall(
      'browser_back',
      {},
      { groupFolder: 'main', sessionId: 'session-1' },
    );
    const attrResult = await executeBrowserToolCall(
      'browser_get_attr',
      { target: '@e1', attribute: 'href' },
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(JSON.parse(backResult)).toEqual({
      ok: true,
      action: 'back',
      url: 'https://example.com/back',
    });
    expect(attrResult).toBe('https://example.com/docs');
  });

  it('allows non-http history entries like about:blank after navigation', async () => {
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
        if (args[0] === 'exec' && args.at(-1) === 'back')
          return cb(null, '', '');
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'about:blank\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const backResult = await executeBrowserToolCall(
      'browser_back',
      {},
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(JSON.parse(backResult)).toEqual({
      ok: true,
      action: 'back',
      url: 'about:blank',
    });
  });

  it('blocks unsupported non-http schemes like file URLs', async () => {
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
          return cb(null, 'file:///tmp/secret.txt\n', '');
        }
        if (args[0] === 'exec' && args.at(-1) === '-c') {
          return cb(null, '- heading "Local file"\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    await expect(
      executeBrowserToolCall(
        'browser_snapshot',
        { compact: true },
        { groupFolder: 'main', sessionId: 'session-1' },
      ),
    ).rejects.toThrow('Blocked unsupported browser URL scheme: file:');
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-browser-main-session-1',
    );
  });

  it('supports scroll and select interactions', async () => {
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
        if (args[0] === 'exec' && args.at(-3) === 'scroll')
          return cb(null, '', '');
        if (args[0] === 'exec' && args.at(-3) === 'select')
          return cb(null, '', '');
        if (
          args[0] === 'exec' &&
          args.at(-2) === 'get' &&
          args.at(-1) === 'url'
        ) {
          return cb(null, 'https://example.com/form\n', '');
        }
        return cb(new Error(`unexpected exec: ${args.join(' ')}`));
      },
    );

    const scrollResult = await executeBrowserToolCall(
      'browser_scroll',
      { direction: 'down', amount: 600 },
      { groupFolder: 'main', sessionId: 'session-1' },
    );
    const selectResult = await executeBrowserToolCall(
      'browser_select',
      { target: '@e2', value: 'shanghai' },
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(JSON.parse(scrollResult)).toEqual({
      ok: true,
      direction: 'down',
      amount: 600,
      url: 'https://example.com/form',
    });
    expect(JSON.parse(selectResult)).toEqual({
      ok: true,
      target: '@e2',
      value: 'shanghai',
      url: 'https://example.com/form',
    });
  });
});
