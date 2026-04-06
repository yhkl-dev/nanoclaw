import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Agent, buildConnector } from 'undici';
import { google } from 'googleapis';
import { HttpsProxyAgent } from 'https-proxy-agent';

import {
  GROUPS_DIR,
  OLLAMA_ADMIN_TOOLS,
  OLLAMA_HTTP_ALLOW_PRIVATE,
  OLLAMA_HTTP_MAX_REDIRECTS,
  OLLAMA_HTTP_TIMEOUT_MS,
  OUTBOUND_HTTPS_PROXY,
  TAVILY_API_KEY,
  GITHUB_TOKEN,
  BARK_KEY,
  BARK_URL,
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

// ── Gmail helpers ─────────────────────────────────────────────────────────────

function createGmailClient() {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
  const tokensPath = path.join(credDir, 'credentials.json');
  if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
    throw new Error('Gmail credentials not found. Run /add-gmail to set up.');
  }
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
  const clientConfig = keys.installed || keys.web || keys;
  const auth = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    clientConfig.redirect_uris?.[0],
  );
  auth.setCredentials(tokens);
  if (OUTBOUND_HTTPS_PROXY) {
    const agent = new HttpsProxyAgent(OUTBOUND_HTTPS_PROXY);
    auth.transporter.defaults = { ...auth.transporter.defaults, agent };
  }
  auth.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
      Object.assign(current, newTokens);
      fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
    } catch {
      // non-fatal
    }
  });
  return google.gmail({ version: 'v1', auth });
}

async function executeGmailTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const gmail = createGmailClient();

  if (name === 'gmail_list') {
    const query =
      typeof args.query === 'string'
        ? args.query
        : 'is:unread category:primary';
    const maxResults =
      typeof args.max_results === 'number' ? args.max_results : 10;
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });
    const messages = list.data.messages ?? [];
    if (messages.length === 0) return JSON.stringify({ messages: [] });
    const details = await Promise.all(
      messages.slice(0, maxResults).map(async (m) => {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: m.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });
        const headers = msg.data.payload?.headers ?? [];
        const h = (name: string) =>
          headers.find((h) => h.name === name)?.value ?? '';
        return {
          id: m.id,
          from: h('From'),
          subject: h('Subject'),
          date: h('Date'),
          snippet: msg.data.snippet,
        };
      }),
    );
    return JSON.stringify({ messages: details });
  }

  if (name === 'gmail_read') {
    const id = String(args.id ?? '');
    if (!id) throw new Error('id is required');
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    const headers = msg.data.payload?.headers ?? [];
    const h = (n: string) => headers.find((h) => h.name === n)?.value ?? '';

    function extractBody(payload: typeof msg.data.payload): string {
      if (!payload) return '';
      if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return Buffer.from(payload.body.data, 'base64').toString('utf-8');
      }
      for (const part of payload.parts ?? []) {
        const text = extractBody(part);
        if (text) return text;
      }
      return '';
    }

    const body = extractBody(msg.data.payload);
    return JSON.stringify({
      id,
      from: h('From'),
      to: h('To'),
      subject: h('Subject'),
      date: h('Date'),
      body: body.slice(0, 8000),
    });
  }

  if (name === 'gmail_search') {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query) throw new Error('query is required');
    const maxResults =
      typeof args.max_results === 'number' ? args.max_results : 10;
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });
    const messages = list.data.messages ?? [];
    if (messages.length === 0) return JSON.stringify({ messages: [] });
    const details = await Promise.all(
      messages.map(async (m) => {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: m.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });
        const headers = msg.data.payload?.headers ?? [];
        const h = (name: string) =>
          headers.find((h) => h.name === name)?.value ?? '';
        return {
          id: m.id,
          from: h('From'),
          subject: h('Subject'),
          date: h('Date'),
          snippet: msg.data.snippet,
        };
      }),
    );
    return JSON.stringify({ messages: details });
  }

  if (name === 'gmail_send') {
    const to = String(args.to ?? '');
    const subject = String(args.subject ?? '');
    const body = String(args.body ?? '');
    if (!to || !subject || !body)
      throw new Error('to, subject, and body are required');
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const sent = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    return JSON.stringify({ ok: true, id: sent.data.id });
  }

  throw new Error(`Unknown Gmail tool: ${name}`);
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
            resolve(JSON.stringify({ error: err.message, stderr: errOut }));
          } else {
            resolve(
              JSON.stringify({
                stdout: out,
                stderr: errOut,
                exitCode: err?.code ?? 0,
              }),
            );
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
  if (toolCall.function.name.startsWith('gmail_')) {
    return executeGmailTool(
      toolCall.function.name,
      toolCall.function.arguments as Record<string, unknown>,
    );
  }
  if (toolCall.function.name.startsWith('calendar_')) {
    return executeCalendarTool(
      toolCall.function.name,
      toolCall.function.arguments as Record<string, unknown>,
    );
  }
  if (toolCall.function.name === 'tavily_search') {
    return executeTavilySearch(
      toolCall.function.arguments as Record<string, unknown>,
    );
  }
  if (toolCall.function.name === 'system_stats') {
    return executeSystemStats();
  }
  if (toolCall.function.name.startsWith('github_')) {
    return executeGithubTool(
      toolCall.function.name,
      toolCall.function.arguments as Record<string, unknown>,
    );
  }
  if (toolCall.function.name === 'bark_push') {
    return executeBarkPush(
      toolCall.function.arguments as Record<string, unknown>,
    );
  }
  if (toolCall.function.name === 'memory_write') {
    const { note, section } = toolCall.function.arguments as {
      note: string;
      section?: string;
    };
    if (!note || typeof note !== 'string') {
      return JSON.stringify({ error: 'note must be a non-empty string' });
    }
    const groupDir = path.join(GROUPS_DIR, context.groupFolder);
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    const timestamp = new Date().toISOString().slice(0, 10);
    const header = section
      ? `\n## ${section} (${timestamp})\n`
      : `\n<!-- ${timestamp} -->\n`;
    const entry = `${header}${note.trim()}\n`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.appendFileSync(claudeMdPath, entry, 'utf-8');
    logger.info(
      { group: context.groupFolder, section, chars: note.length },
      'memory_write: appended to CLAUDE.md',
    );
    return JSON.stringify({ ok: true, path: claudeMdPath });
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

function getGmailToolDefinitions(): OllamaToolDefinition[] {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    return [];
  }
  return [
    {
      type: 'function',
      function: {
        name: 'gmail_list',
        description:
          'List recent emails from Gmail. Returns sender, subject, date, and snippet for each message.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Gmail search query (e.g. "is:unread", "from:boss@example.com"). Defaults to "is:unread category:primary".',
            },
            max_results: {
              type: 'integer',
              description:
                'Maximum number of emails to return (default 10, max 20).',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gmail_read',
        description: 'Read the full content of a specific email by its ID.',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description:
                'The Gmail message ID (from gmail_list or gmail_search results).',
            },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gmail_search',
        description:
          'Search Gmail for emails matching a query. Returns sender, subject, date, and snippet.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Gmail search query string, e.g. "subject:invoice from:alice" or "after:2024/01/01 has:attachment".',
            },
            max_results: {
              type: 'integer',
              description: 'Maximum number of results to return (default 10).',
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gmail_send',
        description: 'Send an email via Gmail.',
        parameters: {
          type: 'object',
          properties: {
            to: {
              type: 'string',
              description: 'Recipient email address.',
            },
            subject: {
              type: 'string',
              description: 'Email subject line.',
            },
            body: {
              type: 'string',
              description: 'Plain-text email body.',
            },
          },
          required: ['to', 'subject', 'body'],
        },
      },
    },
  ];
}

function createCalendarClient() {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
  const tokensPath = path.join(credDir, 'credentials.json');
  if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
    throw new Error('Google credentials not found. Run /add-gmail to set up.');
  }
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
  if (!tokens.scope?.includes('calendar')) {
    throw new Error(
      'Google Calendar not authorized. Re-run OAuth with calendar scope.',
    );
  }
  const clientConfig = keys.installed || keys.web || keys;
  const auth = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    clientConfig.redirect_uris?.[0],
  );
  auth.setCredentials(tokens);
  if (OUTBOUND_HTTPS_PROXY) {
    const agent = new HttpsProxyAgent(OUTBOUND_HTTPS_PROXY);
    auth.transporter.defaults = { ...auth.transporter.defaults, agent };
  }
  auth.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
      Object.assign(current, newTokens);
      fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
    } catch {
      // non-fatal
    }
  });
  return google.calendar({ version: 'v3', auth });
}

async function executeCalendarTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const calendar = createCalendarClient();

  if (name === 'calendar_list') {
    const now = new Date();
    const timeMin =
      typeof args.time_min === 'string' ? args.time_min : now.toISOString();
    const daysAhead = typeof args.days === 'number' ? args.days : 7;
    const timeMax = new Date(
      now.getTime() + daysAhead * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults: 20,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = (res.data.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      location: e.location,
      description: e.description?.slice(0, 200),
    }));
    return JSON.stringify({ events });
  }

  if (name === 'calendar_create') {
    const summary = String(args.summary ?? '');
    const start = String(args.start ?? '');
    const end = String(args.end ?? start);
    if (!summary || !start) throw new Error('summary and start are required');
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description:
          typeof args.description === 'string' ? args.description : undefined,
        location: typeof args.location === 'string' ? args.location : undefined,
        start: isAllDay ? { date: start } : { dateTime: start },
        end: isAllDay ? { date: end } : { dateTime: end },
      },
    });
    return JSON.stringify({
      ok: true,
      id: event.data.id,
      link: event.data.htmlLink,
    });
  }

  if (name === 'calendar_delete') {
    const id = String(args.id ?? '');
    if (!id) throw new Error('id is required');
    await calendar.events.delete({ calendarId: 'primary', eventId: id });
    return JSON.stringify({ ok: true });
  }

  throw new Error(`Unknown Calendar tool: ${name}`);
}

// ── Tavily Search ──────────────────────────────────────────────────────────

async function executeTavilySearch(
  args: Record<string, unknown>,
): Promise<string> {
  if (!TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY not configured.');
  }
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query) throw new Error('query is required');
  const maxResults =
    typeof args.max_results === 'number' ? args.max_results : 5;
  const searchDepth = args.search_depth === 'advanced' ? 'advanced' : 'basic';
  const includeAnswer = args.include_answer !== false;

  const proxyOpts: RequestInit & { agent?: unknown } = {};
  if (OUTBOUND_HTTPS_PROXY) {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    proxyOpts.agent = new HttpsProxyAgent(OUTBOUND_HTTPS_PROXY);
  }

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results: Math.min(maxResults, 10),
      search_depth: searchDepth,
      include_answer: includeAnswer,
      include_raw_content: false,
    }),
    ...(proxyOpts as RequestInit),
  });

  if (!res.ok) {
    throw new Error(`Tavily API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    answer?: string;
    results?: { title: string; url: string; content: string; score: number }[];
  };

  const results = (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content?.slice(0, 400),
    score: r.score,
  }));

  return JSON.stringify({
    answer: data.answer,
    results,
    query,
  });
}

// ── System Stats ─────────────────────────────────────────────────────────────

async function executeSystemStats(): Promise<string> {
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const run = async (cmd: string, args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
      return stdout.trim();
    } catch {
      return '';
    }
  };

  const [cpuInfo, memInfo, diskInfo, uptimeInfo, tempInfo, loadInfo] =
    await Promise.all([
      run('cat', ['/proc/cpuinfo']),
      run('cat', ['/proc/meminfo']),
      run('df', [
        '-h',
        '--output=source,size,used,avail,pcent,target',
        '-x',
        'tmpfs',
        '-x',
        'devtmpfs',
      ]),
      run('cat', ['/proc/uptime']),
      run('cat', ['/sys/class/thermal/thermal_zone0/temp']),
      run('cat', ['/proc/loadavg']),
    ]);

  // Parse memory
  const memLines: Record<string, number> = {};
  for (const line of memInfo.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) memLines[m[1]] = parseInt(m[2]);
  }
  const totalMem = Math.round((memLines['MemTotal'] ?? 0) / 1024);
  const freeMem = Math.round(
    ((memLines['MemFree'] ?? 0) +
      (memLines['Buffers'] ?? 0) +
      (memLines['Cached'] ?? 0)) /
      1024,
  );
  const usedMem = totalMem - freeMem;

  // Parse CPU model
  const cpuModel =
    cpuInfo.match(/Hardware\s*:\s*(.+)/)?.[1] ||
    cpuInfo.match(/model name\s*:\s*(.+)/)?.[1] ||
    cpuInfo.match(/Processor\s*:\s*(.+)/)?.[1] ||
    'unknown';
  const cpuCores = (cpuInfo.match(/^processor/gm) ?? []).length;

  // Uptime
  const uptimeSec = parseFloat(uptimeInfo.split(' ')[0] ?? '0');
  const uptimeDays = Math.floor(uptimeSec / 86400);
  const uptimeHrs = Math.floor((uptimeSec % 86400) / 3600);
  const uptimeMins = Math.floor((uptimeSec % 3600) / 60);
  const uptimeStr = `${uptimeDays}d ${uptimeHrs}h ${uptimeMins}m`;

  // CPU temperature
  const tempRaw = parseInt(tempInfo || '0');
  const tempC =
    tempRaw > 1000 ? (tempRaw / 1000).toFixed(1) : tempRaw.toString();

  // Load average
  const [load1, load5, load15] = (loadInfo || '').split(' ');

  return JSON.stringify({
    cpu: {
      model: cpuModel.trim(),
      cores: cpuCores,
      load_1m: load1,
      load_5m: load5,
      load_15m: load15,
    },
    memory: {
      total_mb: totalMem,
      used_mb: usedMem,
      free_mb: freeMem,
      usage_pct: Math.round((usedMem / totalMem) * 100),
    },
    temperature_c: parseFloat(tempC),
    uptime: uptimeStr,
    disk: diskInfo,
    hostname: os.hostname(),
  });
}

function getSystemStatsToolDefinitions(): OllamaToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'system_stats',
        description:
          'Get system resource usage for this server: CPU model, core count, load average, memory usage, disk usage, CPU temperature, and uptime. Use when asked about server health, performance, or resources.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
  ];
}

// ── GitHub Notifications ──────────────────────────────────────────────────────

async function executeGithubTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const proxyOpts: RequestInit & { agent?: unknown } = {};
  if (OUTBOUND_HTTPS_PROXY) {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    proxyOpts.agent = new HttpsProxyAgent(OUTBOUND_HTTPS_PROXY);
  }

  const ghFetch = async (url: string): Promise<unknown> => {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(proxyOpts as RequestInit),
    });
    if (!res.ok)
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    return res.json();
  };

  if (toolName === 'github_notifications') {
    const all = (args.all as boolean) ?? false;
    const data = (await ghFetch(
      `https://api.github.com/notifications?all=${all}&per_page=20`,
    )) as Array<{
      id: string;
      reason: string;
      unread: boolean;
      updated_at: string;
      subject: { title: string; type: string; url: string };
      repository: { full_name: string };
    }>;
    return JSON.stringify(
      data.map((n) => ({
        id: n.id,
        repo: n.repository.full_name,
        type: n.subject.type,
        title: n.subject.title,
        reason: n.reason,
        unread: n.unread,
        updated_at: n.updated_at,
      })),
    );
  }

  if (toolName === 'github_search') {
    const query = args.query as string;
    const type = (args.type as string) ?? 'repositories';
    const url = `https://api.github.com/search/${type}?q=${encodeURIComponent(query)}&per_page=10`;
    const data = (await ghFetch(url)) as {
      total_count: number;
      items: Array<Record<string, unknown>>;
    };
    return JSON.stringify({
      total: data.total_count,
      items: data.items.slice(0, 10),
    });
  }

  throw new Error(`Unknown GitHub tool: ${toolName}`);
}

function getGithubToolDefinitions(): OllamaToolDefinition[] {
  if (!GITHUB_TOKEN) return [];
  return [
    {
      type: 'function',
      function: {
        name: 'github_notifications',
        description:
          'Fetch GitHub notifications (unread by default). Returns repo name, type (Issue/PR/Release), title, and reason (mention/review_requested/assign etc).',
        parameters: {
          type: 'object',
          properties: {
            all: {
              type: 'boolean',
              description:
                'If true, return all notifications including read ones. Default false (unread only).',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_search',
        description: 'Search GitHub for repositories, issues, or users.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'GitHub search query.' },
            type: {
              type: 'string',
              description:
                'Search type: "repositories", "issues", or "users". Default "repositories".',
            },
          },
          required: ['query'],
        },
      },
    },
  ];
}

// ── Bark Push Notifications ───────────────────────────────────────────────────

async function executeBarkPush(args: Record<string, unknown>): Promise<string> {
  const title = (args.title as string) ?? '通知';
  const body = args.body as string;
  const url = args.url as string | undefined;
  const sound = (args.sound as string) ?? 'default';
  const level = (args.level as string) ?? 'active';

  const proxyOpts: RequestInit & { agent?: unknown } = {};
  if (OUTBOUND_HTTPS_PROXY) {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    proxyOpts.agent = new HttpsProxyAgent(OUTBOUND_HTTPS_PROXY);
  }

  const endpoint = `${BARK_URL}/${BARK_KEY}`;
  const payload: Record<string, string> = { title, body, sound, level };
  if (url) payload['url'] = url;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...(proxyOpts as RequestInit),
  });

  if (!res.ok)
    throw new Error(`Bark push failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { code?: number; message?: string };
  return JSON.stringify({ ok: true, message: data.message ?? 'sent' });
}

function getBarkToolDefinitions(): OllamaToolDefinition[] {
  if (!BARK_KEY) return [];
  return [
    {
      type: 'function',
      function: {
        name: 'bark_push',
        description:
          "Send a push notification to the user's iPhone via Bark app. Use when the user asks to be notified on their phone, or when sending an important alert that should interrupt them. Only use when explicitly requested.",
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Notification title.' },
            body: { type: 'string', description: 'Notification body text.' },
            url: {
              type: 'string',
              description: 'Optional URL to open when tapped.',
            },
            sound: {
              type: 'string',
              description: 'Notification sound name (default "default").',
            },
            level: {
              type: 'string',
              description:
                '"active" (default), "timeSensitive" (bypasses focus), or "passive" (silent).',
            },
          },
          required: ['title', 'body'],
        },
      },
    },
  ];
}

function getTavilyToolDefinitions(): OllamaToolDefinition[] {
  if (!TAVILY_API_KEY) return [];
  return [
    {
      type: 'function',
      function: {
        name: 'tavily_search',
        description:
          'Search the web using Tavily — an AI-optimized search engine that returns accurate, up-to-date results with optional direct answers. Use this for current events, facts, research, product info, news, or any question requiring live web data. Prefer this over http_request for general web searches.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query.',
            },
            max_results: {
              type: 'integer',
              description: 'Number of results to return (default 5, max 10).',
            },
            search_depth: {
              type: 'string',
              description:
                '"basic" for fast results (default), "advanced" for deeper research with more sources.',
            },
            include_answer: {
              type: 'boolean',
              description:
                'Whether to include a direct AI-generated answer summary (default true).',
            },
          },
          required: ['query'],
        },
      },
    },
  ];
}

function getCalendarToolDefinitions(): OllamaToolDefinition[] {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  try {
    const tokensPath = path.join(credDir, 'credentials.json');
    if (!fs.existsSync(tokensPath)) return [];
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    if (!tokens.scope?.includes('calendar')) return [];
  } catch {
    return [];
  }
  return [
    {
      type: 'function',
      function: {
        name: 'calendar_list',
        description:
          'List upcoming Google Calendar events. Returns event title, start/end time, location.',
        parameters: {
          type: 'object',
          properties: {
            days: {
              type: 'integer',
              description: 'Number of days ahead to look (default 7).',
            },
            time_min: {
              type: 'string',
              description:
                'ISO 8601 start time (default: now). E.g. "2024-06-01T00:00:00+08:00".',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calendar_create',
        description: 'Create a new event in Google Calendar.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Event title.' },
            start: {
              type: 'string',
              description:
                'Start time in ISO 8601 (e.g. "2024-06-01T10:00:00+08:00") or date "2024-06-01" for all-day.',
            },
            end: {
              type: 'string',
              description:
                'End time (same format as start). Defaults to same as start.',
            },
            description: { type: 'string', description: 'Event description.' },
            location: { type: 'string', description: 'Event location.' },
          },
          required: ['summary', 'start'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calendar_delete',
        description: 'Delete an event from Google Calendar by its ID.',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Event ID from calendar_list results.',
            },
          },
          required: ['id'],
        },
      },
    },
  ];
}

/**
 * Keyword → intent groups for secondary intent detection during multi-intent messages.
 * Mirrors the classifier rules but is used only for tool-set expansion.
 */
const SECONDARY_INTENT_KEYWORDS: [string, string[]][] = [
  [
    'gmail_',
    [
      '发邮件',
      '发送邮件',
      '写邮件',
      '查邮件',
      '看邮件',
      '搜邮件',
      '邮件',
      'email',
    ],
  ],
  [
    'calendar_',
    ['创建日程', '新建日历', '添加事件', '查日历', '日程', 'calendar', 'event'],
  ],
  [
    'tavily_',
    [
      '搜索',
      '查询',
      '查一下',
      '了解一下',
      '新闻',
      '天气',
      '股价',
      'search',
      'news',
      'weather',
      'latest',
    ],
  ],
  [
    'browser_',
    [
      '打开网页',
      '访问网站',
      '浏览网页',
      '网址',
      'open url',
      'browse',
      'http://',
      'https://',
    ],
  ],
  [
    'system_stats',
    ['系统状态', 'cpu', '内存', '磁盘', '负载', 'system stats', 'memory usage'],
  ],
  ['bash_exec', ['执行命令', '跑一下', 'run command', 'execute']],
  ['read_file', ['读取文件', '查看文件', '打开文件', 'read file']],
  ['write_file', ['写文件', '写入文件', '更新文件', 'write file']],
  ['bark_push', ['提醒', '通知', '推送', 'notify', 'remind']],
  ['github_', ['github', 'pull request', 'pr', 'issue', '通知']],
];

/**
 * Intent → allowed tool name prefixes/groups.
 * null means no filtering (all tools allowed).
 * 'memory_write' is always included as baseline.
 */
const INTENT_ALLOWED_GROUPS: Record<string, string[] | null> = {
  // bark_push allowed for chat so model can send self-notifications/reminders
  chat: ['bark_push'],
  search_web: ['tavily_', 'http_request'],
  tavily_search: ['tavily_', 'http_request'],
  browse_web: ['browser_', 'http_request'],
  browser_open: ['browser_', 'http_request'],
  browser_snapshot: ['browser_', 'http_request'],
  browser_click: ['browser_', 'http_request'],
  browser_type: ['browser_', 'http_request'],
  browser_get_text: ['browser_', 'http_request'],
  browser_get_html: ['browser_', 'http_request'],
  browser_get_value: ['browser_', 'http_request'],
  browser_get_attr: ['browser_', 'http_request'],
  browser_get_count: ['browser_', 'http_request'],
  browser_get_title: ['browser_', 'http_request'],
  browser_get_url: ['browser_', 'http_request'],
  browser_close: ['browser_', 'http_request'],
  send_email: ['gmail_'],
  read_email: ['gmail_'],
  gmail_list: ['gmail_'],
  gmail_read: ['gmail_'],
  gmail_search: ['gmail_'],
  gmail_send: ['gmail_'],
  calendar_list: ['calendar_'],
  calendar_create: ['calendar_'],
  calendar_delete: ['calendar_'],
  system_stats: ['system_stats'],
  read_file: [
    'bash_exec',
    'read_file',
    'write_file',
    'list_dir',
    'search_files',
  ],
  write_file: [
    'bash_exec',
    'read_file',
    'write_file',
    'list_dir',
    'search_files',
  ],
  run_bash: [
    'bash_exec',
    'read_file',
    'write_file',
    'list_dir',
    'search_files',
  ],
  bash_exec: [
    'bash_exec',
    'read_file',
    'write_file',
    'list_dir',
    'search_files',
  ],
  search_files: [
    'bash_exec',
    'read_file',
    'write_file',
    'list_dir',
    'search_files',
  ],
  // unknown: reduced general-purpose set instead of all 37 tools
  unknown: [
    'http_request',
    'tavily_',
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_close',
    'system_stats',
    'bash_exec',
    'read_file',
    'write_file',
    'bark_push',
    'github_',
  ],
};

/**
 * Expand the allowed prefix set by scanning rawPrompt for secondary intents.
 * Handles compound messages like "查一下天气然后发邮件给老板".
 */
function expandAllowedForSecondaryIntents(
  primaryAllowed: string[],
  rawPrompt: string,
  primaryIntent: string,
): string[] {
  const m = rawPrompt.toLowerCase();
  const merged = new Set(primaryAllowed);
  for (const [prefix, keywords] of SECONDARY_INTENT_KEYWORDS) {
    // Skip prefixes already covered by the primary intent's allowed list
    if (
      primaryAllowed.some((p) => prefix.startsWith(p) || p.startsWith(prefix))
    )
      continue;
    if (keywords.some((k) => m.includes(k))) {
      merged.add(prefix);
      logger.debug(
        { primaryIntent, secondaryPrefix: prefix },
        '[intent] secondary intent detected — expanding tool set',
      );
    }
  }
  return [...merged];
}

function filterToolsByIntent(
  tools: OllamaToolDefinition[],
  intent: string | undefined,
  rawPrompt?: string,
): OllamaToolDefinition[] {
  if (!intent || !(intent in INTENT_ALLOWED_GROUPS)) return tools;

  const allowed = INTENT_ALLOWED_GROUPS[intent];
  if (allowed === null) return tools; // no filtering

  // Expand tool set for compound messages (e.g. search + email in one message)
  const effectiveAllowed =
    rawPrompt && allowed.length > 0
      ? expandAllowedForSecondaryIntents(allowed, rawPrompt, intent)
      : allowed;

  // memory_write is always included as baseline
  const filtered = tools.filter((t) => {
    const name = t.function.name;
    if (name === 'memory_write') return true;
    return effectiveAllowed.some(
      (prefix) => name.startsWith(prefix) || name === prefix,
    );
  });

  logger.info(
    {
      intent,
      toolsBefore: tools.length,
      toolsAfter: filtered.length,
      toolNames: filtered.map((t) => t.function.name),
    },
    '[intent] tool list filtered by intent',
  );
  return filtered;
}

export function getOllamaToolDefinitions(opts?: {
  isMain?: boolean;
  intent?: string;
  rawPrompt?: string;
}): OllamaToolDefinition[] {
  const adminTools: OllamaToolDefinition[] =
    OLLAMA_ADMIN_TOOLS && opts?.isMain
      ? [
          {
            type: 'function',
            function: {
              name: 'bash_exec',
              description:
                'Run bash command on host. Output truncated to 8000 chars.',
              parameters: {
                type: 'object',
                properties: {
                  command: { type: 'string' },
                },
                required: ['command'],
              },
            },
          },
          {
            type: 'function',
            function: {
              name: 'write_file',
              description: 'Write content to a file on host.',
              parameters: {
                type: 'object',
                properties: {
                  file_path: { type: 'string' },
                  content: { type: 'string' },
                },
                required: ['file_path', 'content'],
              },
            },
          },
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read file from host. Returns up to 12000 chars.',
              parameters: {
                type: 'object',
                properties: {
                  file_path: { type: 'string' },
                },
                required: ['file_path'],
              },
            },
          },
        ]
      : [];

  const allTools: OllamaToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'http_request',
        description: 'HTTP request. Use for APIs, JSON/XML/RSS, status checks.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL.' },
            method: {
              type: 'string',
              description: 'GET|POST|PUT|PATCH|DELETE|HEAD',
            },
            headers: { type: 'object' },
            body: { type: 'string' },
            max_chars: {
              type: 'integer',
              description: 'Max response chars. Default 12000.',
            },
          },
          required: ['url'],
        },
      },
    },
    ...getBrowserToolDefinitions(),
    ...adminTools,
    ...getGmailToolDefinitions(),
    ...getCalendarToolDefinitions(),
    ...getTavilyToolDefinitions(),
    ...getSystemStatsToolDefinitions(),
    ...getGithubToolDefinitions(),
    ...getBarkToolDefinitions(),
    {
      type: 'function',
      function: {
        name: 'memory_write',
        description: 'Persist a note to group memory for future conversations.',
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: 'Concise factual text.' },
            section: {
              type: 'string',
              description: 'Optional heading, e.g. "User preferences".',
            },
          },
          required: ['note'],
        },
      },
    },
  ];

  return filterToolsByIntent(allTools, opts?.intent, opts?.rawPrompt);
}

async function executeSingleToolCall(
  toolCall: OllamaToolCall,
  context: OllamaToolContext,
): Promise<OllamaExecutedToolCall> {
  const startedAt = Date.now();
  try {
    const result = await executeToolCall(toolCall, context);
    const durationMs = Date.now() - startedAt;
    return {
      toolCall,
      result: buildToolResultEnvelope({
        toolName: toolCall.function.name,
        rawResult: result,
        success: true,
        durationMs,
      }),
      success: true,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    return {
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
    };
  }
}

export async function executeOllamaToolCalls(
  toolCalls: OllamaToolCall[],
  context: OllamaToolContext,
): Promise<OllamaExecutedToolCall[]> {
  const browserCalls = toolCalls.filter((tc) =>
    tc.function.name.startsWith('browser_'),
  );
  const otherCalls = toolCalls.filter(
    (tc) => !tc.function.name.startsWith('browser_'),
  );

  // Non-browser tools are independent — run in parallel.
  const otherResults =
    otherCalls.length > 0
      ? await Promise.all(
          otherCalls.map((tc) => executeSingleToolCall(tc, context)),
        )
      : [];

  // Browser tools share state — run sequentially with failure short-circuit.
  const browserResults: OllamaExecutedToolCall[] = [];
  let browserToolFailed = false;
  for (const tc of browserCalls) {
    if (browserToolFailed) break;
    const result = await executeSingleToolCall(tc, context);
    browserResults.push(result);
    if (!result.success) browserToolFailed = true;
  }

  // Merge results preserving original tool call order.
  const resultMap = new Map<OllamaToolCall, OllamaExecutedToolCall>();
  for (const r of otherResults) resultMap.set(r.toolCall, r);
  for (const r of browserResults) resultMap.set(r.toolCall, r);
  return toolCalls
    .map((tc) => resultMap.get(tc))
    .filter((r): r is OllamaExecutedToolCall => r !== undefined);
}
