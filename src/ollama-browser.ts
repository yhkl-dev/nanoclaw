import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  DATA_DIR,
  OLLAMA_HTTP_ALLOW_PRIVATE,
} from './config.js';
import { assertSafeHttpDestination } from './network-policy.js';
import {
  CONTAINER_RUNTIME_BIN,
  ensureContainerRuntimeRunning,
  hostGatewayArgs,
  stopContainer,
} from './container-runtime.js';
import { assertValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type { OllamaToolDefinition } from './ollama-types.js';

const BROWSER_TOOL_TIMEOUT_MS = 60_000;
const BROWSER_TOOL_MAX_OUTPUT_CHARS = 12_000;
const BROWSER_CONTAINER_PREFIX = 'nanoclaw-browser';
const BROWSER_READY_FILE = '/tmp/nanoclaw-browser-ready';
const BROWSER_TRACE_FILE = '/tmp/nanoclaw-browser-trace.log';
const BROWSER_READY_TIMEOUT_MS = 10_000;
const BROWSER_FALLBACK_CURL_TIMEOUT_SECONDS = 20;
const BROWSER_FALLBACK_BODY_MARKER = '__NANOCLAW_BROWSER_BODY__';
const HN_FALLBACK_STORY_LIMIT = 10;
const HN_FALLBACK_TIMEOUT_MS = 10_000;
const browserSessionQueues = new Map<string, Promise<void>>();
const browserSessionLastUrls = new Map<string, string>();
const browserSessionRecoveryState = new Map<
  string,
  { refsLost: boolean; historyLost: boolean }
>();
const BLOCKED_BROWSER_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '198.18.0.0/15',
];
const BLOCKED_BROWSER_IPV6_CIDRS = [
  '::1/128',
  '::ffff:0:0/96',
  'fc00::/7',
  'fe80::/10',
];

interface BrowserToolContext {
  groupFolder: string;
  sessionId: string;
}

interface BrowserContainerState {
  containerName: string;
  reused: boolean;
  startupMs: number;
  lookupMs: number;
}

interface BrowserHtmlFallbackResult {
  url: string;
  title?: string;
  snapshot: string;
}

interface HackerNewsItem {
  id: number;
  title?: string;
  url?: string;
  by?: string;
  score?: number;
}

export function resetOllamaBrowserTransientState(): void {
  browserSessionQueues.clear();
  browserSessionLastUrls.clear();
  browserSessionRecoveryState.clear();
}

function summarizeBrowserCommand(browserArgs: string[]): {
  action: string;
  target?: string;
} {
  const [action = 'unknown', target] = browserArgs;
  if (
    action === 'open' ||
    action === 'fill' ||
    action === 'type' ||
    action === 'keyboard' ||
    action === 'wait'
  ) {
    return { action };
  }
  return target ? { action, target } : { action };
}

function sanitizeTraceValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildBrowserTracePrefix(
  event: string,
  commandSummary: { action: string; target?: string },
): string {
  const parts = [event, `action=${sanitizeTraceValue(commandSummary.action)}`];
  if (commandSummary.target) {
    parts.push(`target=${sanitizeTraceValue(commandSummary.target)}`);
  }
  return parts.join(' | ');
}

function buildTracedBrowserExecScript(commandSummary: {
  action: string;
  target?: string;
}): string {
  const startPrefix = buildBrowserTracePrefix('browser_start', commandSummary);
  const finishPrefix = buildBrowserTracePrefix(
    'browser_finish',
    commandSummary,
  );
  return [
    `log_file=${shellQuote(BROWSER_TRACE_FILE)}`,
    `printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${shellQuote(startPrefix)} >> "$log_file"`,
    '"$@"',
    'status=$?',
    `printf '%s %s | status=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${shellQuote(finishPrefix)} "$status" >> "$log_file"`,
    'exit "$status"',
  ].join('\n');
}

function browserContainerName(groupFolder: string, sessionId: string): string {
  return `${BROWSER_CONTAINER_PREFIX}-${groupFolder}-${sessionId}`.toLowerCase();
}

function truncate(text: string): string {
  return text.slice(0, BROWSER_TOOL_MAX_OUTPUT_CHARS);
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractHtmlTitle(body: string): string | undefined {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const normalized = title ? compactWhitespace(title) : '';
  return normalized || undefined;
}

function stripHtmlToText(body: string): string {
  return compactWhitespace(
    body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function buildFallbackSnapshotFromHtml(url: string, body: string): string {
  const title = extractHtmlTitle(body);
  const textSnippet = stripHtmlToText(body).slice(0, 4_000);
  const links: string[] = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(body)) && links.length < 12) {
    const href = compactWhitespace(decodeHtmlEntities(match[1] || ''));
    const label = compactWhitespace(
      decodeHtmlEntities((match[2] || '').replace(/<[^>]+>/g, ' ')),
    );
    if (!href || !label) {
      continue;
    }
    links.push(`- ${label.slice(0, 160)} -> ${href.slice(0, 300)}`);
  }

  const lines = [
    '[browser html fallback]',
    `URL: ${url}`,
    ...(title ? [`Title: ${title}`] : []),
    ...(textSnippet ? [`Text: ${textSnippet}`] : []),
    ...(links.length > 0 ? ['Links:', ...links] : []),
  ];
  return truncate(lines.join('\n'));
}

function buildBlankPageSnapshot(url = 'about:blank'): string {
  return `[browser blank page]\nURL: ${url}`;
}

function isElementRefTarget(value: string): boolean {
  return /^@/.test(value.trim());
}

function isHackerNewsFrontPage(url: URL): boolean {
  return (
    url.hostname === 'news.ycombinator.com' &&
    (url.pathname === '/' || url.pathname === '/news')
  );
}

function appendBrowserNetworkSandbox(lines: string[]): void {
  lines.push(
    'command -v iptables >/dev/null 2>&1 || { echo "iptables is required for browser network sandbox" >&2; exit 1; }',
    'command -v ip6tables >/dev/null 2>&1 || { echo "ip6tables is required for browser network sandbox" >&2; exit 1; }',
    'iptables -I OUTPUT -o lo -j ACCEPT',
    'ip6tables -I OUTPUT -o lo -j ACCEPT',
    "dns_servers=$(awk '/^nameserver / {print $2}' /etc/resolv.conf)",
    '[ -n "$dns_servers" ] || { echo "No DNS resolvers found in /etc/resolv.conf" >&2; exit 1; }',
    [
      'for dns_server in $dns_servers; do',
      '  case "$dns_server" in',
      '    *:*)',
      '      ip6tables -I OUTPUT -d "$dns_server" -p udp --dport 53 -j ACCEPT',
      '      ip6tables -I OUTPUT -d "$dns_server" -p tcp --dport 53 -j ACCEPT',
      '      ;;',
      '    *)',
      '      iptables -I OUTPUT -d "$dns_server" -p udp --dport 53 -j ACCEPT',
      '      iptables -I OUTPUT -d "$dns_server" -p tcp --dport 53 -j ACCEPT',
      '      ;;',
      '  esac',
      'done',
    ].join('\n'),
    ...BLOCKED_BROWSER_IPV4_CIDRS.map(
      (cidr) => `iptables -A OUTPUT -d ${cidr} -j REJECT`,
    ),
    ...BLOCKED_BROWSER_IPV6_CIDRS.map(
      (cidr) => `ip6tables -A OUTPUT -d ${cidr} -j REJECT`,
    ),
  );
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

async function fetchJsonFromUrl(url: URL): Promise<unknown> {
  await assertSafeHttpDestination(url, OLLAMA_HTTP_ALLOW_PRIVATE);
  const response = await fetch(url, {
    headers: {
      'user-agent': 'NanoClaw/1.0 browser_hn_fallback',
      accept: 'application/json',
    },
    signal: createTimeoutSignal(HN_FALLBACK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url.toString()}`);
  }
  return response.json();
}

async function runHackerNewsApiFallback(
  pageUrl: URL,
): Promise<BrowserHtmlFallbackResult | undefined> {
  if (!isHackerNewsFrontPage(pageUrl)) {
    return undefined;
  }
  const topStoriesUrl = new URL(
    'https://hacker-news.firebaseio.com/v0/topstories.json',
  );
  const topStories = await fetchJsonFromUrl(topStoriesUrl);
  if (!Array.isArray(topStories)) {
    throw new Error('Hacker News topstories response was not an array');
  }
  const itemIds = topStories
    .filter((value): value is number => typeof value === 'number')
    .slice(0, HN_FALLBACK_STORY_LIMIT);
  const items = await Promise.all(
    itemIds.map(async (id) => {
      const itemUrl = new URL(
        `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
      );
      const item = await fetchJsonFromUrl(itemUrl);
      return item as HackerNewsItem;
    }),
  );
  const lines = [
    '[browser hacker news api fallback]',
    'URL: https://news.ycombinator.com/',
    'Title: Hacker News',
    'Top stories:',
    ...items.map((item, index) => {
      const title = compactWhitespace(item.title || `Story ${item.id}`);
      const href = compactWhitespace(
        item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      );
      const author = compactWhitespace(item.by || 'unknown');
      const score =
        typeof item.score === 'number' ? ` | score=${item.score}` : '';
      return `- ${index + 1}. ${title} -> ${href} | by=${author}${score}`;
    }),
  ];
  return {
    url: 'https://news.ycombinator.com/',
    title: 'Hacker News',
    snapshot: truncate(lines.join('\n')),
  };
}

function browserSessionKey(ctx: BrowserToolContext): string {
  return `${ctx.groupFolder}:${ctx.sessionId}`;
}

function browserSessionKeyFromIds(
  groupFolder: string,
  sessionId: string,
): string {
  return `${groupFolder}:${sessionId}`;
}

function getBrowserRecoveryStateDir(groupFolder: string): string {
  assertValidGroupFolder(groupFolder);
  return path.join(DATA_DIR, 'sessions', groupFolder, 'ollama-browser');
}

function getBrowserRecoveryStatePath(
  groupFolder: string,
  sessionId: string,
): string {
  return path.join(
    getBrowserRecoveryStateDir(groupFolder),
    `${sessionId}.recovery.json`,
  );
}

interface PersistedBrowserRecoveryState {
  refsLost: boolean;
  historyLost: boolean;
  lastUrl?: string;
}

function isValidBrowserRecoveryState(
  value: unknown,
): value is PersistedBrowserRecoveryState {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { refsLost?: unknown }).refsLost === 'boolean' &&
    typeof (value as { historyLost?: unknown }).historyLost === 'boolean' &&
    (typeof (value as { lastUrl?: unknown }).lastUrl === 'undefined' ||
      typeof (value as { lastUrl?: unknown }).lastUrl === 'string')
  );
}

function persistBrowserRecoveryState(
  groupFolder: string,
  sessionId: string,
  state: { refsLost: boolean; historyLost: boolean },
): void {
  const stateDir = getBrowserRecoveryStateDir(groupFolder);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    getBrowserRecoveryStatePath(groupFolder, sessionId),
    JSON.stringify({
      ...state,
      ...(getRememberedBrowserUrl(groupFolder, sessionId)
        ? { lastUrl: getRememberedBrowserUrl(groupFolder, sessionId) }
        : {}),
    }) + '\n',
  );
}

function saveBrowserRecoveryState(
  groupFolder: string,
  sessionId: string,
  state: { refsLost: boolean; historyLost: boolean },
): void {
  const sessionKey = browserSessionKeyFromIds(groupFolder, sessionId);
  if (!state.refsLost && !state.historyLost) {
    browserSessionRecoveryState.delete(sessionKey);
    clearPersistedBrowserRecoveryState(groupFolder, sessionId);
    return;
  }
  browserSessionRecoveryState.set(sessionKey, state);
  persistBrowserRecoveryState(groupFolder, sessionId, state);
}

function loadPersistedBrowserRecoveryState(
  groupFolder: string,
  sessionId: string,
): PersistedBrowserRecoveryState {
  const statePath = getBrowserRecoveryStatePath(groupFolder, sessionId);
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      logger.warn(
        { groupFolder, sessionId, statePath },
        'Ignoring unreadable persisted browser recovery state',
      );
      fs.unlinkSync(statePath);
      return { refsLost: false, historyLost: false };
    }
    if (!isValidBrowserRecoveryState(parsed)) {
      logger.warn(
        { groupFolder, sessionId, statePath },
        'Ignoring invalid persisted browser recovery state',
      );
      fs.unlinkSync(statePath);
      return { refsLost: false, historyLost: false };
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { refsLost: false, historyLost: false };
    }
    throw error;
  }
}

function clearPersistedBrowserRecoveryState(
  groupFolder: string,
  sessionId: string,
): void {
  try {
    fs.unlinkSync(getBrowserRecoveryStatePath(groupFolder, sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      throw error;
    }
  }
}

function getBrowserSessionRecoveryState(
  groupFolder: string,
  sessionId: string,
): { refsLost: boolean; historyLost: boolean } {
  const sessionKey = browserSessionKeyFromIds(groupFolder, sessionId);
  const cached = browserSessionRecoveryState.get(sessionKey);
  if (cached) {
    return cached;
  }
  const persisted = loadPersistedBrowserRecoveryState(groupFolder, sessionId);
  if (persisted.lastUrl) {
    browserSessionLastUrls.set(sessionKey, persisted.lastUrl);
  }
  if (persisted.refsLost || persisted.historyLost) {
    browserSessionRecoveryState.set(sessionKey, persisted);
  }
  return persisted;
}

function markBrowserSessionRecovered(
  groupFolder: string,
  sessionId: string,
): void {
  saveBrowserRecoveryState(groupFolder, sessionId, {
    refsLost: true,
    historyLost: true,
  });
}

function clearBrowserRefLoss(groupFolder: string, sessionId: string): void {
  const current = getBrowserSessionRecoveryState(groupFolder, sessionId);
  saveBrowserRecoveryState(groupFolder, sessionId, {
    refsLost: false,
    historyLost: current.historyLost,
  });
}

function clearBrowserHistoryLoss(groupFolder: string, sessionId: string): void {
  const current = getBrowserSessionRecoveryState(groupFolder, sessionId);
  saveBrowserRecoveryState(groupFolder, sessionId, {
    refsLost: current.refsLost,
    historyLost: false,
  });
}

function clearBrowserRecoveryState(
  groupFolder: string,
  sessionId: string,
): void {
  browserSessionRecoveryState.delete(
    browserSessionKeyFromIds(groupFolder, sessionId),
  );
  clearPersistedBrowserRecoveryState(groupFolder, sessionId);
}

function rememberBrowserUrl(
  groupFolder: string,
  sessionId: string,
  url: string,
): void {
  if (!url) {
    return;
  }
  const sessionKey = browserSessionKeyFromIds(groupFolder, sessionId);
  browserSessionLastUrls.set(sessionKey, url);
  const current = browserSessionRecoveryState.get(sessionKey);
  if (current && (current.refsLost || current.historyLost)) {
    persistBrowserRecoveryState(groupFolder, sessionId, current);
  }
}

function forgetBrowserUrl(groupFolder: string, sessionId: string): void {
  browserSessionLastUrls.delete(
    browserSessionKeyFromIds(groupFolder, sessionId),
  );
  clearBrowserRecoveryState(groupFolder, sessionId);
}

function getRememberedBrowserUrl(
  groupFolder: string,
  sessionId: string,
): string | undefined {
  const sessionKey = browserSessionKeyFromIds(groupFolder, sessionId);
  const cached = browserSessionLastUrls.get(sessionKey);
  if (cached) {
    return cached;
  }
  const persisted = loadPersistedBrowserRecoveryState(groupFolder, sessionId);
  if (persisted.lastUrl) {
    browserSessionLastUrls.set(sessionKey, persisted.lastUrl);
    if (persisted.refsLost || persisted.historyLost) {
      browserSessionRecoveryState.set(sessionKey, persisted);
    }
    return persisted.lastUrl;
  }
  return undefined;
}

function parseObjectArgs(raw: unknown): Record<string, unknown> {
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

async function dockerExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      args,
      {
        timeout: BROWSER_TOOL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          logger.debug(
            { stderr: truncate(String(stderr)) },
            'Browser docker stderr',
          );
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout ?? '').trim());
      },
    );
  });
}

function buildBrowserHtmlFallbackCommand(): string {
  const lines = [
    'set -eu',
    'export PATH="$PATH:/usr/sbin:/sbin"',
    'url="$1"',
    'body_file=/tmp/nanoclaw-browser-body.html',
    'meta_file=/tmp/nanoclaw-browser-meta.txt',
  ];
  if (!OLLAMA_HTTP_ALLOW_PRIVATE) {
    appendBrowserNetworkSandbox(lines);
  }
  lines.push(
    [
      'curl',
      '--location',
      '--compressed',
      '--silent',
      '--show-error',
      `--max-time ${BROWSER_FALLBACK_CURL_TIMEOUT_SECONDS}`,
      '--user-agent "NanoClaw/1.0 browser_html_fallback"',
      '--header "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"',
      '--header "Accept-Language: en-US,en;q=0.9"',
      '--output "$body_file"',
      '--write-out "__NANOCLAW_URL__=%{url_effective}\\n__NANOCLAW_CONTENT_TYPE__=%{content_type}\\n"',
      '"$url" > "$meta_file"',
    ].join(' '),
    'cat "$meta_file"',
    `printf '${BROWSER_FALLBACK_BODY_MARKER}\\n'`,
    'head -c 200000 "$body_file"',
  );
  return lines.join('\n');
}

function parseBrowserHtmlFallbackOutput(output: string): {
  url: string;
  contentType?: string;
  body: string;
} {
  const marker = `${BROWSER_FALLBACK_BODY_MARKER}\n`;
  const markerIndex = output.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('Browser HTML fallback output missing body marker');
  }
  const meta = output.slice(0, markerIndex);
  const body = output.slice(markerIndex + marker.length);
  const resolvedUrl = meta.match(/^__NANOCLAW_URL__=(.+)$/m)?.[1]?.trim() || '';
  if (!resolvedUrl) {
    throw new Error('Browser HTML fallback output missing resolved URL');
  }
  const contentType = meta
    .match(/^__NANOCLAW_CONTENT_TYPE__=(.+)$/m)?.[1]
    ?.trim();
  return {
    url: resolvedUrl,
    ...(contentType ? { contentType } : {}),
    body,
  };
}

async function runBrowserHtmlFallback(
  url: URL,
): Promise<BrowserHtmlFallbackResult> {
  ensureContainerRuntimeRunning();
  const output = await dockerExec([
    'run',
    '--rm',
    ...(OLLAMA_HTTP_ALLOW_PRIVATE
      ? []
      : ['--cap-add=NET_ADMIN', '--user', 'root']),
    ...hostGatewayArgs(),
    '--entrypoint',
    'sh',
    CONTAINER_IMAGE,
    '-lc',
    buildBrowserHtmlFallbackCommand(),
    'sh',
    url.toString(),
  ]);
  const parsed = parseBrowserHtmlFallbackOutput(output);
  const finalUrl = new URL(parsed.url);
  await assertSafeHttpDestination(finalUrl, OLLAMA_HTTP_ALLOW_PRIVATE);
  return {
    url: finalUrl.toString(),
    title: extractHtmlTitle(parsed.body),
    snapshot: buildFallbackSnapshotFromHtml(finalUrl.toString(), parsed.body),
  };
}

async function runBrowserReadFallback(
  url: URL,
): Promise<BrowserHtmlFallbackResult> {
  try {
    return await runBrowserHtmlFallback(url);
  } catch (error) {
    const hnFallback = await runHackerNewsApiFallback(url);
    if (!hnFallback) {
      throw error;
    }
    return hnFallback;
  }
}

function getExecErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const extraParts = [
    error.message,
    typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr?: string }).stderr
      : '',
    typeof (error as { stdout?: unknown }).stdout === 'string'
      ? (error as { stdout?: string }).stdout
      : '',
  ].filter(Boolean);
  return extraParts.join('\n');
}

function isRecoverableBrowserCommandError(error: unknown): boolean {
  const details = getExecErrorDetails(error).toLowerCase();
  if (
    details.includes('daemon may be busy or unresponsive') ||
    details.includes('resource temporarily unavailable') ||
    details.includes('could not configure browser')
  ) {
    return true;
  }
  if (details.includes('timed out') || details.includes('timeout')) {
    return true;
  }
  if (
    error &&
    typeof error === 'object' &&
    ((error as { code?: string }).code === 'ETIMEDOUT' ||
      (error as { killed?: boolean }).killed === true)
  ) {
    return true;
  }
  return false;
}

async function inspectContainerRunning(
  containerName: string,
): Promise<boolean> {
  try {
    const output = await dockerExec([
      'inspect',
      '-f',
      '{{.State.Running}}',
      containerName,
    ]);
    return output === 'true';
  } catch {
    return false;
  }
}

function buildBrowserContainerCommand(): string {
  const lines = ['set -eu', 'export PATH="$PATH:/usr/sbin:/sbin"'];
  if (!OLLAMA_HTTP_ALLOW_PRIVATE) {
    appendBrowserNetworkSandbox(lines);
  }
  lines.push(
    `touch ${BROWSER_TRACE_FILE}`,
    `chmod 666 ${BROWSER_TRACE_FILE}`,
    [
      `printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
      shellQuote('sidecar_ready'),
      `>> ${shellQuote(BROWSER_TRACE_FILE)}`,
    ].join(' '),
    'chown node:node /tmp/nanoclaw-browser-trace.log',
    `tail -n +1 -F ${shellQuote(BROWSER_TRACE_FILE)} &`,
    `touch ${BROWSER_READY_FILE}`,
    'while true; do sleep 3600; done',
  );
  return lines.join('\n');
}

async function waitForBrowserContainerReady(
  containerName: string,
): Promise<void> {
  const deadline = Date.now() + BROWSER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await inspectContainerRunning(containerName))) {
      throw new Error(
        `Browser sidecar exited before becoming ready: ${containerName}`,
      );
    }
    try {
      await dockerExec([
        'exec',
        containerName,
        'sh',
        '-lc',
        `test -f ${BROWSER_READY_FILE}`,
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Browser sidecar did not become ready: ${containerName}`);
}

async function restoreBrowserSessionIfPossible(
  containerState: BrowserContainerState,
  browserArgs: string[],
  rememberedUrl?: string,
): Promise<void> {
  const action = browserArgs[0];
  if (action === 'open' || action === 'close') {
    return;
  }
  if (!rememberedUrl) {
    return;
  }
  if (/^https?:\/\//i.test(rememberedUrl)) {
    await assertSafeHttpDestination(
      new URL(rememberedUrl),
      OLLAMA_HTTP_ALLOW_PRIVATE,
    );
  }
  await dockerExec([
    'exec',
    '-u',
    'node',
    containerState.containerName,
    'agent-browser',
    'open',
    rememberedUrl,
  ]);
}

async function restoreRememberedBrowserUrl(
  groupFolder: string,
  sessionId: string,
  containerState: BrowserContainerState,
): Promise<boolean> {
  const rememberedUrl = getRememberedBrowserUrl(groupFolder, sessionId);
  if (!rememberedUrl) {
    return false;
  }
  await restoreBrowserSessionIfPossible(
    containerState,
    ['snapshot'],
    rememberedUrl,
  );
  markBrowserSessionRecovered(groupFolder, sessionId);
  return true;
}

async function restoreBrowserLandingPageIfNeeded(
  groupFolder: string,
  sessionId: string,
  containerState: BrowserContainerState,
): Promise<void> {
  const restored = await restoreRememberedBrowserUrl(
    groupFolder,
    sessionId,
    containerState,
  );
  if (!restored) {
    return;
  }
  await getValidatedCurrentBrowserUrl(
    groupFolder,
    sessionId,
    containerState,
    false,
    { preserveHistoryLoss: true },
  );
}

async function tryReadLiveBrowserUrl(
  containerState: BrowserContainerState,
): Promise<string | undefined> {
  try {
    const output = await dockerExec([
      'exec',
      '-u',
      'node',
      containerState.containerName,
      'agent-browser',
      'get',
      'url',
    ]);
    const trimmed = output.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

async function ensureBrowserContainer(
  groupFolder: string,
  sessionId: string,
): Promise<BrowserContainerState> {
  assertValidGroupFolder(groupFolder);
  ensureContainerRuntimeRunning();

  const containerName = browserContainerName(groupFolder, sessionId);
  const startedAt = Date.now();
  if (await inspectContainerRunning(containerName)) {
    return {
      containerName,
      reused: true,
      startupMs: 0,
      lookupMs: Date.now() - startedAt,
    };
  }

  try {
    stopContainer(containerName);
  } catch {
    // ignore missing container
  }

  const runArgs = [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    ...(OLLAMA_HTTP_ALLOW_PRIVATE
      ? []
      : ['--cap-add=NET_ADMIN', '--user', 'root']),
    ...hostGatewayArgs(),
    '--entrypoint',
    'sh',
    CONTAINER_IMAGE,
    '-lc',
    buildBrowserContainerCommand(),
  ];

  await dockerExec(runArgs);
  await waitForBrowserContainerReady(containerName);
  const startupMs = Date.now() - startedAt;
  logger.info(
    {
      groupFolder,
      sessionId,
      containerName,
      reused: false,
      startupMs,
    },
    'Browser sidecar ready',
  );
  return {
    containerName,
    reused: false,
    startupMs,
    lookupMs: 0,
  };
}

async function ensureInteractiveBrowserContainer(
  groupFolder: string,
  sessionId: string,
): Promise<BrowserContainerState> {
  return ensureBrowserContainer(groupFolder, sessionId);
}

async function maybeRunBrowserHtmlFallback(
  groupFolder: string,
  sessionId: string,
  url: URL,
  error: unknown,
): Promise<BrowserHtmlFallbackResult | undefined> {
  if (!isRecoverableBrowserCommandError(error)) {
    return undefined;
  }
  await closeBrowserSession(groupFolder, sessionId);
  logger.warn(
    {
      groupFolder,
      sessionId,
      url: url.toString(),
      error: getExecErrorDetails(error).slice(0, 400),
    },
    'Browser command failed recoverably; using HTML fallback',
  );
  let fallback: BrowserHtmlFallbackResult;
  try {
    fallback = await runBrowserHtmlFallback(url);
  } catch (fallbackError) {
    const hnFallback = await runHackerNewsApiFallback(url);
    if (!hnFallback) {
      throw fallbackError;
    }
    logger.warn(
      {
        groupFolder,
        sessionId,
        url: url.toString(),
        error: getExecErrorDetails(fallbackError).slice(0, 400),
      },
      'HTML fallback failed; using Hacker News API fallback',
    );
    fallback = hnFallback;
  }
  rememberBrowserUrl(groupFolder, sessionId, fallback.url);
  markBrowserSessionRecovered(groupFolder, sessionId);
  return fallback;
}

async function runBrowserCommand(
  groupFolder: string,
  sessionId: string,
  browserArgs: string[],
  containerState?: BrowserContainerState,
  allowRecovery = false,
): Promise<string> {
  const activeContainerState =
    containerState ?? (await ensureBrowserContainer(groupFolder, sessionId));
  const startedAt = Date.now();
  const commandSummary = summarizeBrowserCommand(browserArgs);
  let success = false;
  try {
    const output = await dockerExec([
      'exec',
      '-u',
      'node',
      activeContainerState.containerName,
      'sh',
      '-lc',
      buildTracedBrowserExecScript(commandSummary),
      'sh',
      'agent-browser',
      ...browserArgs,
    ]);
    success = true;
    return output;
  } catch (error) {
    if (allowRecovery && isRecoverableBrowserCommandError(error)) {
      const liveUrl = await tryReadLiveBrowserUrl(activeContainerState);
      let rememberedUrl =
        liveUrl || getRememberedBrowserUrl(groupFolder, sessionId);
      logger.warn(
        {
          groupFolder,
          sessionId,
          containerName: activeContainerState.containerName,
          ...commandSummary,
          error: getExecErrorDetails(error).slice(0, 400),
        },
        'Browser command hit recoverable error; rebuilding sidecar',
      );
      await closeBrowserSession(groupFolder, sessionId);
      if (rememberedUrl) {
        rememberBrowserUrl(groupFolder, sessionId, rememberedUrl);
      }
      const recoveredState = await ensureBrowserContainer(
        groupFolder,
        sessionId,
      );
      await restoreBrowserSessionIfPossible(
        recoveredState,
        browserArgs,
        rememberedUrl,
      );
      markBrowserSessionRecovered(groupFolder, sessionId);
      return runBrowserCommand(
        groupFolder,
        sessionId,
        browserArgs,
        recoveredState,
        false,
      );
    }
    throw error;
  } finally {
    logger.info(
      {
        groupFolder,
        sessionId,
        containerName: activeContainerState.containerName,
        ...commandSummary,
        success,
        durationMs: Date.now() - startedAt,
        sidecarReused: activeContainerState.reused,
        sidecarLookupMs: activeContainerState.lookupMs,
        ...(activeContainerState.reused
          ? {}
          : { sidecarStartupMs: activeContainerState.startupMs }),
      },
      'Browser command finished',
    );
  }
}

async function getCurrentBrowserUrl(
  groupFolder: string,
  sessionId: string,
  containerState?: BrowserContainerState,
  allowRecovery = true,
): Promise<string> {
  const output = await runBrowserCommand(
    groupFolder,
    sessionId,
    ['get', 'url'],
    containerState,
    allowRecovery,
  );
  return output.trim();
}

export async function closeBrowserSession(
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  const containerName = browserContainerName(groupFolder, sessionId);
  forgetBrowserUrl(groupFolder, sessionId);
  try {
    stopContainer(containerName);
  } catch {
    // already gone
  }
}

async function assertBrowserUrlSafe(
  groupFolder: string,
  sessionId: string,
  currentUrl: string,
): Promise<void> {
  if (!currentUrl) {
    return;
  }
  try {
    const parsedUrl = new URL(currentUrl);
    if (
      parsedUrl.protocol === 'about:' &&
      currentUrl.trim() === 'about:blank'
    ) {
      return;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(
        `Blocked unsupported browser URL scheme: ${parsedUrl.protocol}`,
      );
    }
    await assertSafeHttpDestination(parsedUrl, OLLAMA_HTTP_ALLOW_PRIVATE);
  } catch (error) {
    await closeBrowserSession(groupFolder, sessionId);
    throw error;
  }
}

async function getValidatedCurrentBrowserUrl(
  groupFolder: string,
  sessionId: string,
  containerState?: BrowserContainerState,
  allowRecovery = true,
  options?: { preserveHistoryLoss?: boolean },
): Promise<string> {
  const previousRememberedUrl = getRememberedBrowserUrl(groupFolder, sessionId);
  const currentUrl = await getCurrentBrowserUrl(
    groupFolder,
    sessionId,
    containerState,
    allowRecovery,
  );
  await assertBrowserUrlSafe(groupFolder, sessionId, currentUrl);
  const trimmedUrl = currentUrl.trim();
  if (
    options?.preserveHistoryLoss !== true &&
    previousRememberedUrl &&
    previousRememberedUrl !== trimmedUrl &&
    getBrowserSessionRecoveryState(groupFolder, sessionId).historyLost
  ) {
    clearBrowserHistoryLoss(groupFolder, sessionId);
  }
  rememberBrowserUrl(groupFolder, sessionId, trimmedUrl);
  return trimmedUrl;
}

async function withSerializedBrowserSession<T>(
  ctx: BrowserToolContext,
  task: () => Promise<T>,
): Promise<T> {
  const key = browserSessionKey(ctx);
  const previous = browserSessionQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  browserSessionQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (browserSessionQueues.get(key) === tail) {
      browserSessionQueues.delete(key);
    }
  }
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  message = `${key} is required`,
): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

async function handleBrowserOpen(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const url = new URL(requireString(args, 'url'));
  await assertSafeHttpDestination(url, OLLAMA_HTTP_ALLOW_PRIVATE);
  try {
    const containerState = await ensureBrowserContainer(
      ctx.groupFolder,
      ctx.sessionId,
    );
    await runBrowserCommand(
      ctx.groupFolder,
      ctx.sessionId,
      ['open', url.toString()],
      containerState,
      true,
    );
    rememberBrowserUrl(ctx.groupFolder, ctx.sessionId, url.toString());
    const activeContainerState = await ensureBrowserContainer(
      ctx.groupFolder,
      ctx.sessionId,
    );
    const pageUrl = await getValidatedCurrentBrowserUrl(
      ctx.groupFolder,
      ctx.sessionId,
      activeContainerState,
    );
    clearBrowserRecoveryState(ctx.groupFolder, ctx.sessionId);
    return JSON.stringify(
      {
        ok: true,
        url: pageUrl,
      },
      null,
      2,
    );
  } catch (error) {
    const fallback = await maybeRunBrowserHtmlFallback(
      ctx.groupFolder,
      ctx.sessionId,
      url,
      error,
    );
    if (!fallback) {
      throw error;
    }
    return JSON.stringify(
      {
        ok: true,
        url: fallback.url,
        degraded: true,
        title: fallback.title,
      },
      null,
      2,
    );
  }
}

async function handleBrowserSnapshot(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const rememberedUrl = getRememberedBrowserUrl(ctx.groupFolder, ctx.sessionId);
  const containerName = browserContainerName(ctx.groupFolder, ctx.sessionId);
  if (rememberedUrl && !(await inspectContainerRunning(containerName))) {
    if (rememberedUrl === 'about:blank') {
      return buildBlankPageSnapshot();
    }
    const fallback = await runBrowserReadFallback(new URL(rememberedUrl));
    rememberBrowserUrl(ctx.groupFolder, ctx.sessionId, fallback.url);
    return fallback.snapshot;
  }
  const containerState = await ensureBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
  );
  const activeContainerState = await ensureBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  const browserArgs = ['snapshot'];
  if (args.interactive_only === true) browserArgs.push('-i');
  if (args.compact === true) browserArgs.push('-c');
  if (typeof args.depth === 'number' && Number.isFinite(args.depth)) {
    browserArgs.push('-d', String(Math.max(1, Math.floor(args.depth))));
  }
  if (typeof args.scope === 'string' && args.scope) {
    browserArgs.push('-s', args.scope);
  }
  const output = await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    browserArgs,
    activeContainerState,
    true,
  );
  clearBrowserRefLoss(ctx.groupFolder, ctx.sessionId);
  return truncate(output);
}

async function handleBrowserActionWithTarget(
  ctx: BrowserToolContext,
  rawArgs: unknown,
  action: 'click' | 'hover' | 'check' | 'uncheck',
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const target = requireString(args, 'target');
  if (
    getBrowserSessionRecoveryState(ctx.groupFolder, ctx.sessionId).refsLost &&
    isElementRefTarget(target)
  ) {
    throw new Error(
      'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
    );
  }
  const containerState = await ensureInteractiveBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  if (!containerState.reused) {
    await restoreBrowserLandingPageIfNeeded(
      ctx.groupFolder,
      ctx.sessionId,
      containerState,
    );
    if (isElementRefTarget(target)) {
      throw new Error(
        'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
      );
    }
  }
  await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    [action, target],
    containerState,
  );
  const url = await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
    false,
  );
  return JSON.stringify({ ok: true, target, url }, null, 2);
}

async function handleBrowserClick(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  return handleBrowserActionWithTarget(ctx, rawArgs, 'click');
}

async function handleBrowserTextEntry(
  ctx: BrowserToolContext,
  rawArgs: unknown,
  action: 'fill' | 'type',
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const target = requireString(args, 'target');
  const text = requireString(args, 'text');
  if (
    getBrowserSessionRecoveryState(ctx.groupFolder, ctx.sessionId).refsLost &&
    isElementRefTarget(target)
  ) {
    throw new Error(
      'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
    );
  }
  const containerState = await ensureInteractiveBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  if (!containerState.reused) {
    await restoreBrowserLandingPageIfNeeded(
      ctx.groupFolder,
      ctx.sessionId,
      containerState,
    );
    if (isElementRefTarget(target)) {
      throw new Error(
        'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
      );
    }
  }
  await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    [action, target, text],
    containerState,
  );
  const url = await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
    false,
  );
  return JSON.stringify({ ok: true, target, url }, null, 2);
}

async function handleBrowserFill(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  return handleBrowserTextEntry(ctx, rawArgs, 'fill');
}

async function handleBrowserType(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  return handleBrowserTextEntry(ctx, rawArgs, 'type');
}

async function handleBrowserPress(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const key = requireString(args, 'key');
  const containerState = await ensureInteractiveBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  if (!containerState.reused) {
    await restoreBrowserLandingPageIfNeeded(
      ctx.groupFolder,
      ctx.sessionId,
      containerState,
    );
  }
  await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    ['press', key],
    containerState,
  );
  const url = await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
    false,
  );
  return JSON.stringify({ ok: true, key, url }, null, 2);
}

async function handleBrowserWait(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  if (
    getBrowserSessionRecoveryState(ctx.groupFolder, ctx.sessionId).refsLost &&
    typeof args.target === 'string' &&
    isElementRefTarget(args.target)
  ) {
    throw new Error(
      'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
    );
  }
  const containerState = await ensureInteractiveBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  if (!containerState.reused) {
    await restoreBrowserLandingPageIfNeeded(
      ctx.groupFolder,
      ctx.sessionId,
      containerState,
    );
    if (typeof args.target === 'string' && isElementRefTarget(args.target)) {
      throw new Error(
        'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
      );
    }
  }
  const browserArgs = ['wait'];
  if (typeof args.target === 'string' && args.target) {
    browserArgs.push(args.target);
  } else if (typeof args.text === 'string' && args.text) {
    browserArgs.push('--text', args.text);
  } else if (typeof args.url_pattern === 'string' && args.url_pattern) {
    browserArgs.push('--url', args.url_pattern);
  } else if (typeof args.load === 'string' && args.load) {
    browserArgs.push('--load', args.load);
  } else if (typeof args.ms === 'number' && Number.isFinite(args.ms)) {
    browserArgs.push(String(Math.max(0, Math.floor(args.ms))));
  } else {
    throw new Error(
      'browser_wait requires one of target, text, url_pattern, load, or ms',
    );
  }
  const output = await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    browserArgs,
    containerState,
    false,
  );
  const url = await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
    false,
  );
  return JSON.stringify(
    { ok: true, output: truncate(output || 'ok'), url },
    null,
    2,
  );
}

async function handleBrowserGet(
  ctx: BrowserToolContext,
  rawArgs: unknown,
  field: 'text' | 'title' | 'url' | 'html' | 'value' | 'count',
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const rememberedUrl = getRememberedBrowserUrl(ctx.groupFolder, ctx.sessionId);
  const containerName = browserContainerName(ctx.groupFolder, ctx.sessionId);
  if (
    rememberedUrl &&
    !(await inspectContainerRunning(containerName)) &&
    (field === 'title' || field === 'url')
  ) {
    if (rememberedUrl === 'about:blank') {
      return field === 'url' ? rememberedUrl : '';
    }
    if (field === 'url') {
      return rememberedUrl;
    }
    const fallback = await runBrowserReadFallback(new URL(rememberedUrl));
    rememberBrowserUrl(ctx.groupFolder, ctx.sessionId, fallback.url);
    return fallback.title || '';
  }
  if (
    getBrowserSessionRecoveryState(ctx.groupFolder, ctx.sessionId).refsLost &&
    (field === 'text' || field === 'html' || field === 'value') &&
    typeof args.target === 'string' &&
    isElementRefTarget(args.target)
  ) {
    throw new Error(
      'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
    );
  }
  const containerState = await ensureBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  if (!containerState.reused) {
    await restoreBrowserLandingPageIfNeeded(
      ctx.groupFolder,
      ctx.sessionId,
      containerState,
    );
    if (
      (field === 'text' || field === 'html' || field === 'value') &&
      typeof args.target === 'string' &&
      isElementRefTarget(args.target)
    ) {
      throw new Error(
        'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
      );
    }
  }
  await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
  );
  const activeContainerState = await ensureBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  const browserArgs = ['get', field];
  if (field === 'text' || field === 'html' || field === 'value') {
    browserArgs.push(requireString(args, 'target'));
  }
  if (field === 'count') {
    browserArgs.push(requireString(args, 'selector'));
  }
  const output = await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    browserArgs,
    activeContainerState,
    field === 'title' || field === 'url' || field === 'count',
  );
  return truncate(output);
}

async function handleBrowserNavigation(
  ctx: BrowserToolContext,
  action: 'back' | 'forward' | 'reload',
): Promise<string> {
  if (
    getBrowserSessionRecoveryState(ctx.groupFolder, ctx.sessionId)
      .historyLost &&
    action !== 'reload'
  ) {
    throw new Error(
      'Browser history was lost when the browser session restarted. Re-open or navigate again before using browser_back or browser_forward.',
    );
  }
  const containerState = await ensureInteractiveBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  if (!containerState.reused) {
    if (action === 'reload') {
      await restoreBrowserLandingPageIfNeeded(
        ctx.groupFolder,
        ctx.sessionId,
        containerState,
      );
    } else {
      throw new Error(
        'Browser history was lost when the browser session restarted. Re-open or navigate again before using browser_back or browser_forward.',
      );
    }
  }
  await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    [action],
    containerState,
  );
  const url = await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
    false,
  );
  return JSON.stringify({ ok: true, action, url }, null, 2);
}

async function handleBrowserSelect(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const target = requireString(args, 'target');
  const value = requireString(args, 'value');
  if (
    getBrowserSessionRecoveryState(ctx.groupFolder, ctx.sessionId).refsLost &&
    isElementRefTarget(target)
  ) {
    throw new Error(
      'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
    );
  }
  const containerState = await ensureInteractiveBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  if (!containerState.reused) {
    await restoreBrowserLandingPageIfNeeded(
      ctx.groupFolder,
      ctx.sessionId,
      containerState,
    );
    if (isElementRefTarget(target)) {
      throw new Error(
        'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
      );
    }
  }
  await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    ['select', target, value],
    containerState,
  );
  const url = await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
    false,
  );
  return JSON.stringify({ ok: true, target, value, url }, null, 2);
}

async function handleBrowserScroll(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const direction = requireString(args, 'direction');
  if (!['up', 'down', 'left', 'right'].includes(direction)) {
    throw new Error('direction must be one of up, down, left, or right');
  }
  const amount =
    typeof args.amount === 'number' && Number.isFinite(args.amount)
      ? Math.max(1, Math.floor(args.amount))
      : 500;
  const containerState = await ensureInteractiveBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  if (!containerState.reused) {
    await restoreBrowserLandingPageIfNeeded(
      ctx.groupFolder,
      ctx.sessionId,
      containerState,
    );
  }
  await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    ['scroll', direction, String(amount)],
    containerState,
  );
  const url = await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
    false,
  );
  return JSON.stringify({ ok: true, direction, amount, url }, null, 2);
}

async function handleBrowserGetAttr(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const target = requireString(args, 'target');
  const attribute = requireString(args, 'attribute');
  if (
    getBrowserSessionRecoveryState(ctx.groupFolder, ctx.sessionId).refsLost &&
    isElementRefTarget(target)
  ) {
    throw new Error(
      'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
    );
  }
  const containerState = await ensureInteractiveBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  if (!containerState.reused) {
    await restoreBrowserLandingPageIfNeeded(
      ctx.groupFolder,
      ctx.sessionId,
      containerState,
    );
    if (isElementRefTarget(target)) {
      throw new Error(
        'Browser session was restored from the remembered URL. Re-run browser_snapshot before using element refs.',
      );
    }
  }
  await getValidatedCurrentBrowserUrl(
    ctx.groupFolder,
    ctx.sessionId,
    containerState,
  );
  const activeContainerState = await ensureBrowserContainer(
    ctx.groupFolder,
    ctx.sessionId,
  );
  const output = await runBrowserCommand(
    ctx.groupFolder,
    ctx.sessionId,
    ['get', 'attr', target, attribute],
    activeContainerState,
    false,
  );
  return truncate(output);
}

async function handleBrowserClose(
  ctx: BrowserToolContext,
  _rawArgs: unknown,
): Promise<string> {
  const containerName = browserContainerName(ctx.groupFolder, ctx.sessionId);
  await closeBrowserSession(ctx.groupFolder, ctx.sessionId);
  return JSON.stringify({ ok: true, container: containerName }, null, 2);
}

export function getBrowserToolDefinitions(): OllamaToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'browser_open',
        description:
          'Open a real website page in a sandboxed browser session. Prefer this for webpages, articles, homepages, news lists, or any page content that may need DOM reading or JavaScript.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The full http or https URL.' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description:
          'Read the current browser page accessibility tree or interactive elements. Prefer this after browser_open when you need titles, headlines, links, posts, buttons, or other page content.',
        parameters: {
          type: 'object',
          properties: {
            interactive_only: {
              type: 'boolean',
              description: 'When true, only return interactive elements.',
            },
            compact: {
              type: 'boolean',
              description: 'When true, use compact snapshot output.',
            },
            depth: {
              type: 'integer',
              description: 'Optional maximum snapshot depth.',
            },
            scope: {
              type: 'string',
              description: 'Optional CSS selector to scope the snapshot.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_back',
        description: 'Navigate back in browser history.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_forward',
        description: 'Navigate forward in browser history.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_reload',
        description: 'Reload the current browser page.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_click',
        description: 'Click an element by agent-browser ref such as @e1.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_fill',
        description: 'Fill an input element by ref with the provided text.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
            text: { type: 'string', description: 'Text to fill.' },
          },
          required: ['target', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_type',
        description:
          'Type text into an element by ref without clearing existing content.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
            text: { type: 'string', description: 'Text to type.' },
          },
          required: ['target', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_press',
        description: 'Press a keyboard key in the current browser page.',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Key name, for example Enter.',
            },
          },
          required: ['key'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_hover',
        description: 'Hover an element by ref.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_select',
        description: 'Select a dropdown option by ref and option value.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
            value: { type: 'string', description: 'Option value to select.' },
          },
          required: ['target', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_check',
        description: 'Check a checkbox or similar control by ref.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_uncheck',
        description: 'Uncheck a checkbox or similar control by ref.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_scroll',
        description: 'Scroll the page in a direction by a number of pixels.',
        parameters: {
          type: 'object',
          properties: {
            direction: {
              type: 'string',
              description: 'One of up, down, left, or right.',
            },
            amount: {
              type: 'integer',
              description: 'Optional pixels to scroll. Defaults to 500.',
            },
          },
          required: ['direction'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_wait',
        description:
          'Wait for the page to update by element ref, text, URL pattern, load state, or milliseconds.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
            text: { type: 'string', description: 'Text to wait for.' },
            url_pattern: {
              type: 'string',
              description: 'URL glob pattern such as **/dashboard.',
            },
            load: {
              type: 'string',
              description:
                'Load state like load, domcontentloaded, or networkidle.',
            },
            ms: { type: 'integer', description: 'Milliseconds to wait.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_text',
        description: 'Get text from an element by ref.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_html',
        description: 'Get inner HTML from an element by ref.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_value',
        description: 'Get the current value from an input element by ref.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_attr',
        description: 'Get an attribute value from an element by ref.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Element ref like @e1.' },
            attribute: {
              type: 'string',
              description: 'Attribute name such as href or aria-label.',
            },
          },
          required: ['target', 'attribute'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_count',
        description: 'Count elements matching a CSS selector.',
        parameters: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector to count, such as .item.',
            },
          },
          required: ['selector'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_title',
        description: 'Get the current browser page title.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_url',
        description: 'Get the current browser page URL.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_close',
        description:
          'Close the sandboxed browser session for the current chat session.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}

export async function executeBrowserToolCall(
  toolName: string,
  rawArgs: unknown,
  ctx: BrowserToolContext,
): Promise<string> {
  return withSerializedBrowserSession(ctx, async () => {
    switch (toolName) {
      case 'browser_open':
        return handleBrowserOpen(ctx, rawArgs);
      case 'browser_back':
        return handleBrowserNavigation(ctx, 'back');
      case 'browser_forward':
        return handleBrowserNavigation(ctx, 'forward');
      case 'browser_reload':
        return handleBrowserNavigation(ctx, 'reload');
      case 'browser_snapshot':
        return handleBrowserSnapshot(ctx, rawArgs);
      case 'browser_click':
        return handleBrowserClick(ctx, rawArgs);
      case 'browser_fill':
        return handleBrowserFill(ctx, rawArgs);
      case 'browser_type':
        return handleBrowserType(ctx, rawArgs);
      case 'browser_press':
        return handleBrowserPress(ctx, rawArgs);
      case 'browser_hover':
        return handleBrowserActionWithTarget(ctx, rawArgs, 'hover');
      case 'browser_select':
        return handleBrowserSelect(ctx, rawArgs);
      case 'browser_check':
        return handleBrowserActionWithTarget(ctx, rawArgs, 'check');
      case 'browser_uncheck':
        return handleBrowserActionWithTarget(ctx, rawArgs, 'uncheck');
      case 'browser_scroll':
        return handleBrowserScroll(ctx, rawArgs);
      case 'browser_wait':
        return handleBrowserWait(ctx, rawArgs);
      case 'browser_get_text':
        return handleBrowserGet(ctx, rawArgs, 'text');
      case 'browser_get_html':
        return handleBrowserGet(ctx, rawArgs, 'html');
      case 'browser_get_value':
        return handleBrowserGet(ctx, rawArgs, 'value');
      case 'browser_get_attr':
        return handleBrowserGetAttr(ctx, rawArgs);
      case 'browser_get_count':
        return handleBrowserGet(ctx, rawArgs, 'count');
      case 'browser_get_title':
        return handleBrowserGet(ctx, rawArgs, 'title');
      case 'browser_get_url':
        return handleBrowserGet(ctx, rawArgs, 'url');
      case 'browser_close':
        return handleBrowserClose(ctx, rawArgs);
      default:
        throw new Error(`Unsupported browser tool: ${toolName}`);
    }
  });
}
