import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecuteBrowserToolCall = vi.fn();
const mockGetBrowserToolDefinitions = vi.fn(() => [
  {
    type: 'function' as const,
    function: {
      name: 'browser_open',
      description: 'Open a page',
      parameters: { type: 'object' as const, properties: {} },
    },
  },
]);

vi.mock('./config.js', () => ({
  OLLAMA_HTTP_ALLOW_PRIVATE: false,
  OLLAMA_HTTP_MAX_REDIRECTS: 5,
  OLLAMA_HTTP_TIMEOUT_MS: 20_000,
  OLLAMA_ADMIN_TOOLS: false,
  OUTBOUND_HTTPS_PROXY: undefined,
  TAVILY_API_KEY: undefined,
  GITHUB_TOKEN: undefined,
  BARK_KEY: undefined,
  BARK_URL: 'https://api.day.app',
}));

vi.mock('./ollama-browser.js', () => ({
  executeBrowserToolCall: (...args: unknown[]) =>
    mockExecuteBrowserToolCall(...args),
  getBrowserToolDefinitions: () => mockGetBrowserToolDefinitions(),
}));

vi.mock('./network-policy.js', () => ({
  assertSafeHttpDestination: vi.fn(async () => {}),
  resolveSafeHttpDestination: vi.fn(async (url: URL) => ({
    hostname: url.hostname,
    addresses: [{ address: '93.184.216.34', family: 4 }],
  })),
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
  executeOllamaToolCalls,
  getOllamaToolDefinitions,
  resetOllamaToolRuntimeState,
} from './ollama-tool-runtime.js';
import { logger } from './logger.js';

describe('ollama tool runtime', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    mockExecuteBrowserToolCall.mockReset();
    mockGetBrowserToolDefinitions.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetOllamaToolRuntimeState();
  });

  it('combines http_request with browser tool definitions', () => {
    const tools = getOllamaToolDefinitions();

    expect(tools[0]?.function.name).toBe('http_request');
    expect(tools.some((tool) => tool.function.name === 'browser_open')).toBe(
      true,
    );
  });

  it('skips later browser tools after a browser failure but still runs http_request', async () => {
    mockExecuteBrowserToolCall
      .mockRejectedValueOnce(new Error('browser failed'))
      .mockResolvedValueOnce('should not run');

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://example.com/',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: undefined,
      text: async () => '',
    } as unknown as Response);

    const results = await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'browser_open',
            arguments: { url: 'https://a.com' },
          },
        },
        {
          function: { name: 'browser_snapshot', arguments: {} },
        },
        {
          function: {
            name: 'http_request',
            arguments: { url: 'https://example.com', method: 'GET' },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(mockExecuteBrowserToolCall).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results[0]?.toolCall.function.name).toBe('browser_open');
    expect(results[0]?.success).toBe(false);
    expect(JSON.parse(results[0]!.result)).toMatchObject({
      ok: false,
      tool_name: 'browser_open',
      tool_kind: 'browser',
      error: { message: 'browser failed' },
    });
    expect(results[1]?.toolCall.function.name).toBe('http_request');
    expect(results[1]?.success).toBe(true);
    expect(JSON.parse(results[1]!.result)).toMatchObject({
      ok: true,
      tool_name: 'http_request',
      tool_kind: 'http',
      format: 'json',
      data: {
        status: 200,
        url: 'https://example.com/',
      },
    });
  });

  it('wraps browser text output in a text envelope', async () => {
    mockExecuteBrowserToolCall.mockResolvedValueOnce(
      '- heading "Example Domain" [ref=e1]\n',
    );

    const results = await executeOllamaToolCalls(
      [
        {
          function: { name: 'browser_snapshot', arguments: { compact: true } },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0]!.result)).toMatchObject({
      ok: true,
      tool_name: 'browser_snapshot',
      tool_kind: 'browser',
      format: 'text',
      data: {
        text: '- heading "Example Domain" [ref=e1]\n',
      },
    });
  });

  it('applies default headers and adds JSON response summaries', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ weather: 'sunny', tempC: 26 }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );

    const results = await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'http_request',
            arguments: {
              url: 'https://example.com/api/weather',
              method: 'GET',
            },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          'user-agent': 'NanoClaw/1.0 http_request',
          accept: expect.stringContaining('application/json'),
          'accept-language': 'en-US,en;q=0.9',
        }),
      }),
    );
    expect(JSON.parse(results[0]!.result)).toMatchObject({
      ok: true,
      data: {
        status: 200,
        content_type: 'application/json; charset=utf-8',
        summary: {
          kind: 'json',
          top_level: 'object',
          keys: ['weather', 'tempC'],
        },
        request: {
          attempts: 1,
          retry_count: 0,
          final_address: '93.184.216.34',
        },
      },
    });
  });

  it('preserves explicit header overrides and defaults JSON content-type for object bodies', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );

    await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'http_request',
            arguments: {
              url: 'https://example.com/items',
              method: 'POST',
              headers: {
                'User-Agent': 'CustomAgent/1.0',
                Accept: 'text/plain',
              },
              body: { hello: 'world' },
            },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'CustomAgent/1.0',
          Accept: 'text/plain',
          'content-type': 'application/json; charset=utf-8',
        }),
      }),
    );
  });

  it('retries idempotent retryable upstream statuses with backoff hints', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response('busy', {
          status: 503,
          headers: { 'retry-after': '0', 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );

    const results = await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'http_request',
            arguments: { url: 'https://example.com/status', method: 'GET' },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(results[0]!.result)).toMatchObject({
      ok: true,
      data: {
        request: {
          attempts: 2,
          retry_count: 1,
        },
      },
    });
  });

  it('retries PUT requests on retryable upstream statuses', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response('busy', {
          status: 503,
          headers: { 'retry-after': '0', 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('updated', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );

    const results = await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'http_request',
            arguments: {
              url: 'https://example.com/items/1',
              method: 'PUT',
              body: { enabled: true },
            },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(results[0]!.result)).toMatchObject({
      ok: true,
      data: {
        request: {
          attempts: 2,
          retry_count: 1,
        },
      },
    });
  });

  it('adds structured failure details for http_request errors', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    );

    const results = await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'http_request',
            arguments: { url: 'https://example.com/status', method: 'GET' },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(results[0]?.success).toBe(false);
    expect(JSON.parse(results[0]!.result)).toMatchObject({
      ok: false,
      error: {
        message: 'connect ECONNREFUSED',
        code: 'ECONNREFUSED',
        category: 'connect',
        details: {
          attempts: 1,
          attempted_addresses: ['93.184.216.34'],
        },
      },
    });
  });

  it('decodes response bodies using quoted declared charsets when supported', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset="windows-1252"' },
      }),
    );

    const results = await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'http_request',
            arguments: { url: 'https://example.com/text', method: 'GET' },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(JSON.parse(results[0]!.result)).toMatchObject({
      ok: true,
      data: {
        body: 'café',
        summary: {
          kind: 'text',
          text_snippet: 'café',
        },
      },
    });
  });

  it('strips sensitive headers on cross-origin redirects', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { location: 'https://other.example/landing' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );

    await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'http_request',
            arguments: {
              url: 'https://example.com/start',
              method: 'GET',
              headers: {
                Authorization: 'Bearer secret',
                Cookie: 'sid=123',
                'X-API-Key': 'topsecret',
                Accept: 'text/plain',
              },
            },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    const [, redirectedInit] = fetchMock.mock.calls[1]!;
    const redirectedHeaders = new Headers(
      (redirectedInit as RequestInit).headers as
        | Headers
        | Record<string, string>
        | Array<[string, string]>,
    );
    expect(redirectedHeaders.get('authorization')).toBeNull();
    expect(redirectedHeaders.get('cookie')).toBeNull();
    expect(redirectedHeaders.get('x-api-key')).toBeNull();
    expect(redirectedHeaders.get('accept')).toBe('text/plain');
  });

  it('logs only sanitized http_request telemetry', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );

    await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'http_request',
            arguments: {
              url: 'https://example.com/private?token=secret',
              method: 'POST',
              headers: { Authorization: 'Bearer secret' },
              body: { secret: 'value' },
            },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'http_request',
        method: 'POST',
        url_host: 'example.com',
        url_path: '/private',
        status: 200,
        attempts: 1,
      }),
      'http_request tool executed',
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.anything(),
      }),
      expect.anything(),
    );
  });

  it('adds HTML response summaries with title and text snippets', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        '<html><head><title>Weather report</title><meta name="description" content="Current conditions"></head><body><h1>Sunny</h1><p>Warm and clear.</p></body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      ),
    );

    const results = await executeOllamaToolCalls(
      [
        {
          function: {
            name: 'http_request',
            arguments: { url: 'https://example.com/weather', method: 'GET' },
          },
        },
      ],
      { groupFolder: 'main', sessionId: 'session-1' },
    );

    expect(JSON.parse(results[0]!.result)).toMatchObject({
      ok: true,
      data: {
        summary: {
          kind: 'html',
          title: 'Weather report',
          description: 'Current conditions',
          text_snippet: 'Weather report Sunny Warm and clear.',
        },
      },
    });
  });
});
