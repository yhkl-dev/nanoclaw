import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  ANTHROPIC_MODEL: undefined,
  CONTAINER_HTTP_PROXY: 'http://192.168.2.2:7890',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  MODEL_BACKEND: 'claude',
  OLLAMA_ADMIN_TOOLS: false,
  OLLAMA_HOST: undefined,
  OLLAMA_HTTP_MAX_REDIRECTS: 5,
  OLLAMA_HTTP_TIMEOUT_MS: 20_000,
  OLLAMA_MODEL: undefined,
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
      rmSync: vi.fn(),
    },
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: vi.fn(() => '/tmp/test-home'),
    },
    homedir: vi.fn(() => '/tmp/test-home'),
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  normalizeOllamaHostForContainer,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Henry',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

describe('normalizeOllamaHostForContainer', () => {
  it('rewrites localhost to host.docker.internal', () => {
    expect(normalizeOllamaHostForContainer('http://localhost:11434')).toBe(
      'http://host.docker.internal:11434',
    );
    expect(normalizeOllamaHostForContainer('http://127.0.0.1:11434')).toBe(
      'http://host.docker.internal:11434',
    );
  });

  it('keeps non-loopback hosts unchanged', () => {
    expect(normalizeOllamaHostForContainer('http://192.168.2.19:11434')).toBe(
      'http://192.168.2.19:11434',
    );
  });
});

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => false,
    } as fs.Stats);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('bypasses the proxy for the host credential proxy address', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const { spawn } = await import('child_process');
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        '-e',
        'HTTP_PROXY=http://192.168.2.2:7890',
        '-e',
        'NO_PROXY=host.docker.internal,127.0.0.1,localhost,::1',
        '-e',
        'no_proxy=host.docker.internal,127.0.0.1,localhost,::1',
      ]),
      expect.any(Object),
    );
  });

  it('syncs everything-claude-code skills and agents into per-group claude dir', async () => {
    vi.mocked(fs.existsSync).mockImplementation((target) => {
      const filePath = String(target);
      return (
        filePath === '/tmp/nanoclaw-test-groups/test-group' ||
        filePath ===
          '/Users/yangkai/Documents/github.com/nanoclaw/container/skills' ||
        filePath ===
          '/Users/yangkai/Documents/github.com/nanoclaw/container/agent-runner/src' ||
        filePath ===
          '/tmp/test-home/.claude/plugins/marketplaces/everything-claude-code/skills' ||
        filePath ===
          '/tmp/test-home/.claude/plugins/marketplaces/everything-claude-code/agents' ||
        filePath ===
          '/tmp/nanoclaw-test-data/sessions/test-group/agent-runner-src'
      );
    });
    vi.mocked(fs.readdirSync).mockImplementation((target) => {
      const dirPath = String(target);
      if (
        dirPath ===
        '/Users/yangkai/Documents/github.com/nanoclaw/container/skills'
      ) {
        return ['status'] as unknown as ReturnType<typeof fs.readdirSync>;
      }
      if (
        dirPath ===
        '/tmp/test-home/.claude/plugins/marketplaces/everything-claude-code/skills'
      ) {
        return ['api-design'] as unknown as ReturnType<typeof fs.readdirSync>;
      }
      if (
        dirPath ===
        '/tmp/test-home/.claude/plugins/marketplaces/everything-claude-code/agents'
      ) {
        return ['architect.md'] as unknown as ReturnType<typeof fs.readdirSync>;
      }
      if (
        dirPath ===
        '/Users/yangkai/Documents/github.com/nanoclaw/container/agent-runner/src'
      ) {
        return [
          'index.ts',
          'session-recovery.ts',
          'session-recovery.test.ts',
        ] as unknown as ReturnType<typeof fs.readdirSync>;
      }
      if (
        dirPath ===
        '/tmp/nanoclaw-test-data/sessions/test-group/agent-runner-src'
      ) {
        return [
          'index.ts',
          'session-recovery.ts',
          'session-recovery.test.ts',
        ] as unknown as ReturnType<typeof fs.readdirSync>;
      }
      return [] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    vi.mocked(fs.statSync).mockImplementation(
      (target) =>
        ({
          isDirectory: () =>
            !String(target).endsWith('.md') && !String(target).endsWith('.ts'),
        }) as fs.Stats,
    );

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(vi.mocked(fs.cpSync)).toHaveBeenCalledWith(
      '/Users/yangkai/Documents/github.com/nanoclaw/container/skills/status',
      '/tmp/nanoclaw-test-data/sessions/test-group/.claude/skills/status',
      { recursive: true },
    );
    expect(vi.mocked(fs.cpSync)).toHaveBeenCalledWith(
      '/tmp/test-home/.claude/plugins/marketplaces/everything-claude-code/skills/api-design',
      '/tmp/nanoclaw-test-data/sessions/test-group/.claude/skills/api-design',
      { recursive: true },
    );
    expect(vi.mocked(fs.cpSync)).toHaveBeenCalledWith(
      '/tmp/test-home/.claude/plugins/marketplaces/everything-claude-code/agents/architect.md',
      '/tmp/nanoclaw-test-data/sessions/test-group/.claude/agents/architect.md',
      { recursive: true },
    );
    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(
      '/tmp/nanoclaw-test-data/sessions/test-group/agent-runner-src/session-recovery.test.ts',
      { force: true },
    );
  });
});
