import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Agent, buildConnector } from 'undici';

import {
  OLLAMA_ADMIN_TOOLS,
  OLLAMA_HTTP_ALLOW_PRIVATE,
  OLLAMA_HTTP_MAX_REDIRECTS,
  OLLAMA_HTTP_TIMEOUT_MS,
} from './config.js';
import {
  executeBrowserToolCall,
  getBrowserToolDefinitions,
} from './ollama-browser.js';
import {
  assertSafeHttpDestination,
  resolveSafeHttpDestination,
} from './network-policy.js';
import { logger } from './logger.js';
import type {
  OllamaToolCall,
  OllamaToolDefinition,
  OllamaToolResultEnvelope,
} from './ollama-types.js';

const HTTP_TOOL_MAX_RESPONSE_CHARS = 12_000;
const HTTP_TOOL_MAX_DOWNLOAD_BYTES = HTTP_TOOL_MAX_RESPONSE_CHARS * 4;
const DNS_CACHE_TTL_MS = 60_000;
const AGENT_POOL_TTL_MS = 60_000;
const HTTP_TOOL_TIMEOUT_MS = OLLAMA_HTTP_TIMEOUT_MS;
const HTTP_TOOL_MAX_IDEMPOTENT_RETRIES = 2;
const HTTP_TOOL_RETRY_BASE_DELAY_MS = 250;
const HTTP_TOOL_DEFAULT_USER_AGENT = 'NanoClaw/1.0 http_request';
const HTTP_TOOL_DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

type HttpFailureCategory =
  | 'connect'
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'redirect'
  | 'upstream'
  | 'request'
  | 'decode';

interface HttpAttemptTelemetry {
  address: string;
  family: number;
  outcome: 'connect_error' | 'response' | 'retryable_status';
  error_code?: string;
  status?: number;
}

interface HttpRequestTelemetry {
  method: string;
  timeout_ms: number;
  redirect_count: number;
  max_redirects: number;
  resolved_addresses: Array<{ address: string; family: number }>;
  attempts: number;
  retry_count: number;
  attempted_addresses: string[];
  final_address?: string;
  attempt_events: HttpAttemptTelemetry[];
}

interface HttpFetchSuccess {
  response: Response;
  rawText: string;
  truncated: boolean;
  telemetry: HttpRequestTelemetry;
}

interface HttpErrorDetails {
  category: HttpFailureCategory;
  code?: string;
  details?: Record<string, unknown>;
}

class HttpToolError extends Error {
  readonly category: HttpFailureCategory;
  readonly code?: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, params: HttpErrorDetails) {
    super(message);
    this.name = 'HttpToolError';
    this.category = params.category;
    this.code = params.code;
    this.details = params.details || {};
  }
}

interface DnsCacheEntry {
  addresses: Array<{ address: string; family: number }>;
  expiresAt: number;
}

interface AgentPoolEntry {
  agent: Agent;
  expiresAt: number;
}

export interface OllamaToolContext {
  groupFolder: string;
  sessionId: string;
  isMain?: boolean;
  projectRoot?: string;
}

const BASH_EXEC_TIMEOUT_MS = 60_000;

export interface OllamaExecutedToolCall {
  toolCall: OllamaToolCall;
  result: string;
  success: boolean;
  durationMs: number;
}

function getToolKind(toolName: string): 'http' | 'browser' {
  return toolName === 'http_request' ? 'http' : 'browser';
}

function parseStructuredToolPayload(raw: string): {
  format: 'json' | 'text';
  data: unknown;
} {
  try {
    return {
      format: 'json',
      data: JSON.parse(raw),
    };
  } catch {
    return {
      format: 'text',
      data: { text: raw },
    };
  }
}

function buildToolResultEnvelope(params: {
  toolName: string;
  rawResult?: string;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
  errorCode?: string;
  errorCategory?: string;
  errorDetails?: Record<string, unknown>;
}): string {
  const envelope: OllamaToolResultEnvelope = {
    ok: params.success,
    tool_name: params.toolName,
    tool_kind: getToolKind(params.toolName),
    format: 'text',
    duration_ms: params.durationMs,
  };

  if (params.success) {
    const payload = parseStructuredToolPayload(params.rawResult ?? '');
    envelope.format = payload.format;
    envelope.data = payload.data;
  } else {
    envelope.error = {
      message: params.errorMessage || 'Unknown tool error',
      ...(params.errorCode ? { code: params.errorCode } : {}),
      ...(params.errorCategory ? { category: params.errorCategory } : {}),
      ...(params.errorDetails ? { details: params.errorDetails } : {}),
    };
  }

  return JSON.stringify(envelope, null, 2);
}

const dnsCache = new Map<string, DnsCacheEntry>();
const agentPool = new Map<string, AgentPoolEntry>();

function getPooledAgent(
  hostname: string,
  address: string,
  family: number,
): Agent {
  const key = `${hostname}\0${address}:${family}`;
  const now = Date.now();
  const entry = agentPool.get(key);
  if (entry && entry.expiresAt > now) {
    return entry.agent;
  }
  if (entry) {
    void entry.agent.close();
    agentPool.delete(key);
  }
  const connector = buildConnector({
    timeout: HTTP_TOOL_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelay: 30_000,
  });
  const agent = new Agent({
    connect(options, callback) {
      connector(
        {
          ...options,
          hostname: address,
          host: address,
          servername: options.servername ?? hostname,
        },
        callback,
      );
    },
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });
  agentPool.set(key, { agent, expiresAt: now + AGENT_POOL_TTL_MS });
  return agent;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

function inferDefaultAccept(url: URL): string {
  if (
    /\/api(?:\/|$)/i.test(url.pathname) ||
    /\.(json|xml|rss)(?:$|\?)/i.test(url.pathname)
  ) {
    return 'application/json, application/xml;q=0.9, text/plain;q=0.8, */*;q=0.5';
  }
  return 'text/html, application/json;q=0.9, text/plain;q=0.8, */*;q=0.5';
}

function applyDefaultHeaders(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  originalBody: unknown,
): Record<string, string> {
  const merged = { ...headers };
  if (!hasHeader(merged, 'user-agent')) {
    merged['user-agent'] = HTTP_TOOL_DEFAULT_USER_AGENT;
  }
  if (!hasHeader(merged, 'accept')) {
    merged.accept = inferDefaultAccept(url);
  }
  if (!hasHeader(merged, 'accept-language')) {
    merged['accept-language'] = HTTP_TOOL_DEFAULT_ACCEPT_LANGUAGE;
  }
  if (
    body !== undefined &&
    typeof originalBody !== 'string' &&
    !hasHeader(merged, 'content-type') &&
    !['GET', 'HEAD'].includes(method)
  ) {
    merged['content-type'] = 'application/json; charset=utf-8';
  }
  return merged;
}

function parseCharset(contentType: string | null): string | undefined {
  if (!contentType) {
    return undefined;
  }
  const match = contentType.match(/charset=([^;]+)/i);
  const raw = match?.[1]?.trim();
  if (!raw) {
    return undefined;
  }
  return raw.replace(/^['"]|['"]$/g, '');
}

function decodeBodyBuffer(buffer: Buffer, contentType: string | null): string {
  const charset = parseCharset(contentType);
  if (charset) {
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch {
      // Fall through to UTF-8.
    }
  }
  return new TextDecoder().decode(buffer);
}

function compactText(value: string, maxChars: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function summarizeJsonBody(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      kind: 'json',
      top_level: 'array',
      item_count: value.length,
      sample_types: value
        .slice(0, 5)
        .map((item) =>
          Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item,
        ),
    };
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return {
      kind: 'json',
      top_level: 'object',
      key_count: keys.length,
      keys: keys.slice(0, 20),
    };
  }
  return {
    kind: 'json',
    top_level: value === null ? 'null' : typeof value,
    preview: compactText(JSON.stringify(value), 240),
  };
}

function summarizeHtmlBody(body: string): Record<string, unknown> {
  const title = body
    .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim();
  const description = body
    .match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    )?.[1]
    ?.trim();
  const text = compactText(
    body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
    280,
  );
  return {
    kind: 'html',
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(text ? { text_snippet: text } : {}),
  };
}

function summarizeTextBody(body: string): Record<string, unknown> {
  return {
    kind: 'text',
    text_snippet: compactText(body, 280),
  };
}

function summarizeResponseBody(
  method: string,
  contentType: string | null,
  body: string,
): Record<string, unknown> {
  if (method === 'HEAD') {
    return { kind: 'head' };
  }
  const normalizedContentType = contentType?.toLowerCase() || '';
  if (
    normalizedContentType.includes('application/json') ||
    normalizedContentType.includes('+json')
  ) {
    try {
      return summarizeJsonBody(JSON.parse(body));
    } catch {
      return {
        kind: 'json',
        parse_error: true,
        text_snippet: compactText(body, 280),
      };
    }
  }
  if (normalizedContentType.includes('text/html')) {
    return summarizeHtmlBody(body);
  }
  return summarizeTextBody(body);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableResponseStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function computeRetryDelayMs(retryCount: number, response?: Response): number {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 5_000);
    }
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp)) {
      return Math.min(Math.max(0, timestamp - Date.now()), 5_000);
    }
  }
  return Math.min(HTTP_TOOL_RETRY_BASE_DELAY_MS * 2 ** retryCount, 2_000);
}

function getErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return (
    (error as { code?: string }).code ||
    (error as { cause?: { code?: string } }).cause?.code
  );
}

function classifyHttpError(error: unknown): HttpFailureCategory {
  if (!(error instanceof Error)) {
    return 'request';
  }
  const code = getErrorCode(error);
  const message = error.message.toLowerCase();
  if (
    code === 'ABORT_ERR' ||
    message.includes('aborted') ||
    message.includes('timeout')
  ) {
    return 'timeout';
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    /\bdns\b|not found/i.test(error.message)
  ) {
    return 'dns';
  }
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    /certificate|tls|ssl/i.test(error.message)
  ) {
    return 'tls';
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return 'connect';
  }
  if (/redirect/i.test(error.message)) {
    return 'redirect';
  }
  return 'request';
}

function buildHttpToolError(
  message: string,
  params: {
    error?: unknown;
    category?: HttpFailureCategory;
    telemetry: HttpRequestTelemetry;
    status?: number;
    location?: string | null;
  },
): HttpToolError {
  return new HttpToolError(message, {
    category:
      params.category ||
      (params.error ? classifyHttpError(params.error) : 'request'),
    code: getErrorCode(params.error),
    details: {
      ...params.telemetry,
      ...(params.status ? { status: params.status } : {}),
      ...(params.location ? { location: params.location } : {}),
    },
  });
}

async function resolveSafeHttpDestinationCached(
  url: URL,
  allowPrivate: boolean,
): Promise<{
  hostname: string;
  addresses: Array<{ address: string; family: number }>;
}> {
  const cacheKey = `${url.hostname}\0${allowPrivate ? '1' : '0'}`;
  const now = Date.now();
  const hit = dnsCache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return { hostname: url.hostname, addresses: hit.addresses };
  }
  const resolved = await resolveSafeHttpDestination(url, allowPrivate);
  dnsCache.set(cacheKey, {
    addresses: resolved.addresses,
    expiresAt: now + DNS_CACHE_TTL_MS,
  });
  return resolved;
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: '', truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel('response body limit reached');
        break;
      }

      if (value.length <= remaining) {
        chunks.push(value);
        total += value.length;
        continue;
      }

      chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel('response body limit reached');
      break;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: decodeBodyBuffer(
      Buffer.concat(chunks.map(Buffer.from)),
      response.headers.get('content-type'),
    ),
    truncated,
  };
}

function allowPrivateHttpRequests(): boolean {
  return OLLAMA_HTTP_ALLOW_PRIVATE;
}

function isRetryableConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidateCodes = [
    (error as { code?: string }).code,
    (error as { cause?: { code?: string } }).cause?.code,
  ];
  const retryableCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
  ]);
  if (candidateCodes.some((code) => code && retryableCodes.has(code))) {
    return true;
  }

  return /\bconnect (?:econnrefused|econnreset|etimedout|ehostunreach|enetunreach)\b|network is unreachable|host is unreachable/i.test(
    error.message,
  );
}

function createFetchTimeout(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Tool arguments must be an object');
  }
  return raw as Record<string, unknown>;
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('headers must be an object');
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key] = value;
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      result[key] = String(value);
    } else {
      throw new Error(`Invalid header value for ${key}`);
    }
  }
  return result;
}

const REDIRECT_SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
]);

function stripSensitiveHeaders(
  headers:
    | Headers
    | Record<string, string | readonly string[]>
    | string[][]
    | undefined,
  options?: { dropBodyHeaders?: boolean },
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const normalized = new Headers(headers);
  for (const [key, value] of normalized.entries()) {
    const lowerKey = key.toLowerCase();
    if (REDIRECT_SENSITIVE_HEADERS.has(lowerKey)) {
      continue;
    }
    if (
      options?.dropBodyHeaders &&
      (lowerKey === 'content-type' || lowerKey === 'content-length')
    ) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function isIdempotentRetryMethod(method: string): boolean {
  return ['GET', 'HEAD', 'PUT', 'DELETE'].includes(method);
}

function getSafeUrlForLogs(rawUrl: string): {
  url_host?: string;
  url_path?: string;
} {
  try {
    const url = new URL(rawUrl);
    return {
      url_host: url.host,
      url_path: url.pathname || '/',
    };
  } catch {
    return {};
  }
}

function buildHttpRequestLogContext(args: unknown): Record<string, unknown> {
  try {
    const parsed = parseToolArguments(args);
    const method =
      typeof parsed.method === 'string' ? parsed.method.toUpperCase() : 'GET';
    const url = typeof parsed.url === 'string' ? parsed.url : undefined;
    return {
      method,
      ...(url ? getSafeUrlForLogs(url) : {}),
    };
  } catch {
    return {};
  }
}

function buildHttpToolLogDetails(
  details: HttpRequestTelemetry | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!details || typeof details !== 'object') {
    return {};
  }
  return {
    attempts: details.attempts,
    retry_count: details.retry_count,
    redirect_count: details.redirect_count,
    timeout_ms: details.timeout_ms,
    final_address: details.final_address,
    attempted_address_count: Array.isArray(details.attempted_addresses)
      ? details.attempted_addresses.length
      : undefined,
  };
}

async function fetchHttpWithRedirectChecks(
  url: URL,
  init: RequestInit,
  redirectCount = 0,
  retryCount = 0,
): Promise<HttpFetchSuccess> {
  const resolved = await resolveSafeHttpDestinationCached(
    url,
    allowPrivateHttpRequests(),
  );
  const requestMethod = (init.method || 'GET').toUpperCase();
  const canRetryPinnedAddress = isIdempotentRetryMethod(requestMethod);
  let lastError: unknown;
  const attemptedAddresses: string[] = [];
  const attemptEvents: HttpAttemptTelemetry[] = [];
  const attemptQueue = [...resolved.addresses];
  while (attemptQueue.length > 0) {
    const pinned = attemptQueue.shift()!;
    attemptedAddresses.push(pinned.address);
    const dispatcher = getPooledAgent(
      resolved.hostname,
      pinned.address,
      pinned.family,
    );

    try {
      const requestInit = {
        ...init,
        redirect: 'manual',
        dispatcher,
      } as RequestInit & { dispatcher: Agent };
      let response: Response;
      try {
        response = await fetch(url, requestInit);
      } catch (error) {
        lastError = error;
        attemptEvents.push({
          address: pinned.address,
          family: pinned.family,
          outcome: 'connect_error',
          ...(getErrorCode(error) ? { error_code: getErrorCode(error) } : {}),
        });
        if (!canRetryPinnedAddress || !isRetryableConnectError(error)) {
          throw buildHttpToolError(
            error instanceof Error ? error.message : String(error),
            {
              error,
              telemetry: {
                method: requestMethod,
                timeout_ms: HTTP_TOOL_TIMEOUT_MS,
                redirect_count: redirectCount,
                max_redirects: OLLAMA_HTTP_MAX_REDIRECTS,
                resolved_addresses: resolved.addresses,
                attempts: attemptedAddresses.length,
                retry_count: retryCount,
                attempted_addresses: attemptedAddresses,
                final_address: pinned.address,
                attempt_events: attemptEvents,
              },
            },
          );
        }
        continue;
      }

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has('location')
      ) {
        if (redirectCount >= OLLAMA_HTTP_MAX_REDIRECTS) {
          throw buildHttpToolError('Too many HTTP redirects', {
            category: 'redirect',
            telemetry: {
              method: requestMethod,
              timeout_ms: HTTP_TOOL_TIMEOUT_MS,
              redirect_count: redirectCount,
              max_redirects: OLLAMA_HTTP_MAX_REDIRECTS,
              resolved_addresses: resolved.addresses,
              attempts: attemptedAddresses.length,
              retry_count: retryCount,
              attempted_addresses: attemptedAddresses,
              final_address: pinned.address,
              attempt_events: attemptEvents,
            },
          });
        }
        const location = response.headers.get('location');
        if (!location) {
          throw buildHttpToolError('HTTP redirect missing location header', {
            category: 'redirect',
            telemetry: {
              method: requestMethod,
              timeout_ms: HTTP_TOOL_TIMEOUT_MS,
              redirect_count: redirectCount,
              max_redirects: OLLAMA_HTTP_MAX_REDIRECTS,
              resolved_addresses: resolved.addresses,
              attempts: attemptedAddresses.length,
              retry_count: retryCount,
              attempted_addresses: attemptedAddresses,
              final_address: pinned.address,
              attempt_events: attemptEvents,
            },
            status: response.status,
          });
        }
        const nextUrl = new URL(location, url);
        await assertSafeHttpDestination(nextUrl, allowPrivateHttpRequests());
        await response.body?.cancel();
        return fetchHttpWithRedirectChecks(
          nextUrl,
          (() => {
            const redirectsToGet = Boolean(
              response.status === 303 ||
              ((response.status === 301 || response.status === 302) &&
                init.method &&
                init.method !== 'GET' &&
                init.method !== 'HEAD'),
            );
            const nextMethod = redirectsToGet ? 'GET' : init.method;
            const sameOrigin = nextUrl.origin === url.origin;
            return {
              ...init,
              body: redirectsToGet ? undefined : init.body,
              method: nextMethod,
              headers: sameOrigin
                ? init.headers
                : stripSensitiveHeaders(init.headers, {
                    dropBodyHeaders: redirectsToGet,
                  }),
            };
          })(),
          redirectCount + 1,
          retryCount,
        );
      }

      if (
        canRetryPinnedAddress &&
        isRetryableResponseStatus(response.status) &&
        retryCount < HTTP_TOOL_MAX_IDEMPOTENT_RETRIES
      ) {
        attemptEvents.push({
          address: pinned.address,
          family: pinned.family,
          outcome: 'retryable_status',
          status: response.status,
        });
        await response.body?.cancel();
        await sleep(computeRetryDelayMs(retryCount, response));
        attemptQueue.push(pinned);
        retryCount += 1;
        continue;
      }

      attemptEvents.push({
        address: pinned.address,
        family: pinned.family,
        outcome: 'response',
        status: response.status,
      });

      const maxChars =
        typeof (init as { __nanoclawMaxChars?: unknown }).__nanoclawMaxChars ===
          'number' &&
        Number.isFinite(
          (init as { __nanoclawMaxChars?: number }).__nanoclawMaxChars,
        )
          ? Math.max(
              HTTP_TOOL_MAX_RESPONSE_CHARS,
              Math.floor(
                (init as { __nanoclawMaxChars?: number }).__nanoclawMaxChars!,
              ),
            )
          : HTTP_TOOL_MAX_RESPONSE_CHARS;
      const maxDownloadBytes = Math.max(
        HTTP_TOOL_MAX_DOWNLOAD_BYTES,
        maxChars * 4,
      );
      const bodyRead =
        init.method === 'HEAD'
          ? { text: '', truncated: false }
          : await readBodyWithLimit(response, maxDownloadBytes);
      return {
        response,
        rawText: bodyRead.text,
        truncated: bodyRead.truncated,
        telemetry: {
          method: requestMethod,
          timeout_ms: HTTP_TOOL_TIMEOUT_MS,
          redirect_count: redirectCount,
          max_redirects: OLLAMA_HTTP_MAX_REDIRECTS,
          resolved_addresses: resolved.addresses,
          attempts: attemptedAddresses.length,
          retry_count: retryCount,
          attempted_addresses: attemptedAddresses,
          final_address: pinned.address,
          attempt_events: attemptEvents,
        },
      };
    } catch (error) {
      lastError = error;
      throw error;
    }
  }

  throw buildHttpToolError(
    lastError instanceof Error ? lastError.message : 'HTTP request failed',
    {
      error: lastError,
      telemetry: {
        method: requestMethod,
        timeout_ms: HTTP_TOOL_TIMEOUT_MS,
        redirect_count: redirectCount,
        max_redirects: OLLAMA_HTTP_MAX_REDIRECTS,
        resolved_addresses: resolved.addresses,
        attempts: attemptedAddresses.length,
        retry_count: retryCount,
        attempted_addresses: attemptedAddresses,
        attempt_events: attemptEvents,
      },
    },
  );
}

async function runHttpRequestTool(args: unknown): Promise<string> {
  const parsed = parseToolArguments(args);
  const url = parsed.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('http_request requires an http or https url');
  }
  const parsedUrl = new URL(url);
  await assertSafeHttpDestination(parsedUrl, allowPrivateHttpRequests());

  const method =
    typeof parsed.method === 'string' ? parsed.method.toUpperCase() : 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
    throw new Error(`Unsupported HTTP method: ${method}`);
  }

  const rawBody = parsed.body;
  let body: string | undefined;
  if (rawBody !== undefined) {
    body =
      typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody, null, 2);
  }
  const headers = applyDefaultHeaders(
    parsedUrl,
    method,
    normalizeHeaders(parsed.headers),
    body,
    rawBody,
  );

  const maxChars =
    typeof parsed.max_chars === 'number' && Number.isFinite(parsed.max_chars)
      ? Math.max(256, Math.min(50_000, Math.floor(parsed.max_chars)))
      : HTTP_TOOL_MAX_RESPONSE_CHARS;

  const { response, rawText, truncated, telemetry } =
    await fetchHttpWithRedirectChecks(parsedUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      signal: createFetchTimeout(HTTP_TOOL_TIMEOUT_MS),
      __nanoclawMaxChars: maxChars,
    } as RequestInit & { __nanoclawMaxChars: number });

  const responseHeaders: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    responseHeaders[key] = value;
  }

  return JSON.stringify(
    {
      ok: response.ok,
      status: response.status,
      status_text: response.statusText,
      url: response.url,
      headers: responseHeaders,
      content_type: response.headers.get('content-type'),
      body: rawText.slice(0, maxChars),
      truncated: truncated || rawText.length > maxChars,
      summary: summarizeResponseBody(
        method,
        response.headers.get('content-type'),
        rawText,
      ),
      request: telemetry,
    },
    null,
    2,
  );
}

async function executeToolCall(
  toolCall: OllamaToolCall,
  context: OllamaToolContext,
): Promise<string> {
  if (toolCall.function.name === 'http_request') {
    const logContext = buildHttpRequestLogContext(toolCall.function.arguments);
    try {
      const result = await runHttpRequestTool(toolCall.function.arguments);
      const parsedResult = JSON.parse(result) as {
        status?: number;
        request?: HttpRequestTelemetry;
      };
      logger.warn(
        {
          tool: 'http_request',
          ...logContext,
          status: parsedResult.status,
          ...buildHttpToolLogDetails(parsedResult.request),
        },
        'http_request tool executed',
      );
      return result;
    } catch (err) {
      logger.warn(
        {
          tool: 'http_request',
          ...logContext,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof HttpToolError
            ? {
                category: err.category,
                code: err.code,
                ...buildHttpToolLogDetails(err.details),
              }
            : {}),
        },
        'http_request tool FAILED',
      );
      throw err;
    }
  }
  if (toolCall.function.name.startsWith('browser_')) {
    return executeBrowserToolCall(
      toolCall.function.name,
      toolCall.function.arguments,
      context,
    );
  }
  if (
    toolCall.function.name === 'bash_exec' &&
    OLLAMA_ADMIN_TOOLS &&
    context.isMain
  ) {
    const { command } = toolCall.function.arguments as { command: string };
    const cwd = context.projectRoot ?? process.cwd();
    return new Promise((resolve) => {
      execFile(
        'bash',
        ['-c', command],
        { cwd, timeout: BASH_EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024 },
        (err, stdout, stderr) => {
          const out = stdout.slice(0, 8000);
          const errOut = stderr.slice(0, 2000);
          if (err && !stdout) {
            resolve(
              JSON.stringify({ error: err.message, stderr: errOut }),
            );
          } else {
            resolve(JSON.stringify({ stdout: out, stderr: errOut, exitCode: err?.code ?? 0 }));
          }
        },
      );
    });
  }
  if (
    toolCall.function.name === 'write_file' &&
    OLLAMA_ADMIN_TOOLS &&
    context.isMain
  ) {
    const { file_path, content } = toolCall.function.arguments as {
      file_path: string;
      content: string;
    };
    const resolved = path.isAbsolute(file_path)
      ? file_path
      : path.join(context.projectRoot ?? process.cwd(), file_path);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    return JSON.stringify({ ok: true, path: resolved });
  }
  if (
    toolCall.function.name === 'read_file' &&
    OLLAMA_ADMIN_TOOLS &&
    context.isMain
  ) {
    const { file_path } = toolCall.function.arguments as { file_path: string };
    const resolved = path.isAbsolute(file_path)
      ? file_path
      : path.join(context.projectRoot ?? process.cwd(), file_path);
    const content = fs.readFileSync(resolved, 'utf-8');
    return JSON.stringify({ content: content.slice(0, 12000) });
  }
  throw new Error(`Unsupported tool: ${toolCall.function.name}`);
}

export function resetOllamaToolRuntimeState(): void {
  dnsCache.clear();
  for (const entry of agentPool.values()) {
    void entry.agent.close();
  }
  agentPool.clear();
}

export function getOllamaToolDefinitions(opts?: {
  isMain?: boolean;
}): OllamaToolDefinition[] {
  const adminTools: OllamaToolDefinition[] =
    OLLAMA_ADMIN_TOOLS && opts?.isMain
      ? [
          {
            type: 'function',
            function: {
              name: 'bash_exec',
              description:
                'Run a bash command on the host. Working directory is the NanoClaw project root. Use for editing source files, running npm run build, restarting the service, or any shell task. Output is truncated to 8000 chars.',
              parameters: {
                type: 'object',
                properties: {
                  command: {
                    type: 'string',
                    description: 'The bash command to run.',
                  },
                },
                required: ['command'],
              },
            },
          },
          {
            type: 'function',
            function: {
              name: 'write_file',
              description:
                'Write content to a file on the host. Use absolute paths or paths relative to the project root.',
              parameters: {
                type: 'object',
                properties: {
                  file_path: {
                    type: 'string',
                    description: 'Absolute or project-relative file path.',
                  },
                  content: {
                    type: 'string',
                    description: 'Full file content to write.',
                  },
                },
                required: ['file_path', 'content'],
              },
            },
          },
          {
            type: 'function',
            function: {
              name: 'read_file',
              description:
                'Read a file from the host filesystem. Returns up to 12000 chars.',
              parameters: {
                type: 'object',
                properties: {
                  file_path: {
                    type: 'string',
                    description: 'Absolute or project-relative file path.',
                  },
                },
                required: ['file_path'],
              },
            },
          },
        ]
      : [];

  return [
    {
      type: 'function',
      function: {
        name: 'http_request',
        description:
          'Make a real HTTP request to a URL and return the response status, headers, and text body snippet. Prefer this for APIs, JSON/XML/RSS feeds, status checks, raw headers, or static fetches where a browser is unnecessary.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The full http or https URL to request.',
            },
            method: {
              type: 'string',
              description:
                'HTTP method. One of GET, POST, PUT, PATCH, DELETE, or HEAD. Defaults to GET.',
            },
            headers: {
              type: 'object',
              description: 'Optional request headers as string values.',
            },
            body: {
              type: 'string',
              description:
                'Optional request body for POST/PUT/PATCH/DELETE requests.',
            },
            max_chars: {
              type: 'integer',
              description:
                'Maximum number of response body characters to return. Defaults to 12000.',
            },
          },
          required: ['url'],
        },
      },
    },
    ...getBrowserToolDefinitions(),
    ...adminTools,
  ];
}

export async function executeOllamaToolCalls(
  toolCalls: OllamaToolCall[],
  context: OllamaToolContext,
): Promise<OllamaExecutedToolCall[]> {
  const results: OllamaExecutedToolCall[] = [];
  let browserToolFailed = false;
  for (const toolCall of toolCalls) {
    if (browserToolFailed && toolCall.function.name.startsWith('browser_')) {
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await executeToolCall(toolCall, context);
      const durationMs = Date.now() - startedAt;
      results.push({
        toolCall,
        result: buildToolResultEnvelope({
          toolName: toolCall.function.name,
          rawResult: result,
          success: true,
          durationMs,
        }),
        success: true,
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      results.push({
        toolCall,
        result: buildToolResultEnvelope({
          toolName: toolCall.function.name,
          success: false,
          durationMs,
          errorMessage: error instanceof Error ? error.message : String(error),
          ...(error instanceof HttpToolError
            ? {
                errorCode: error.code,
                errorCategory: error.category,
                errorDetails: error.details,
              }
            : {}),
        }),
        success: false,
        durationMs,
      });
      if (toolCall.function.name.startsWith('browser_')) {
        browserToolFailed = true;
      }
    }
  }
  return results;
}
