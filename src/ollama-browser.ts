import { execFile } from 'child_process';

import { CONTAINER_IMAGE, OLLAMA_HTTP_ALLOW_PRIVATE } from './config.js';
import { assertSafeHttpDestination } from './network-policy.js';
import {
  CONTAINER_RUNTIME_BIN,
  ensureContainerRuntimeRunning,
  hostGatewayArgs,
  stopContainer,
} from './container-runtime.js';
import { assertValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';

const BROWSER_TOOL_TIMEOUT_MS = 60_000;
const BROWSER_TOOL_MAX_OUTPUT_CHARS = 12_000;
const BROWSER_CONTAINER_PREFIX = 'nanoclaw-browser';
const BROWSER_READY_FILE = '/tmp/nanoclaw-browser-ready';
const BROWSER_READY_TIMEOUT_MS = 10_000;
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

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

interface BrowserToolContext {
  groupFolder: string;
  sessionId: string;
}

function browserContainerName(groupFolder: string, sessionId: string): string {
  return `${BROWSER_CONTAINER_PREFIX}-${groupFolder}-${sessionId}`.toLowerCase();
}

function truncate(text: string): string {
  return text.slice(0, BROWSER_TOOL_MAX_OUTPUT_CHARS);
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
          logger.debug({ stderr: truncate(String(stderr)) }, 'Browser docker stderr');
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

async function inspectContainerRunning(containerName: string): Promise<boolean> {
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
  const lines = ['set -eu'];
  if (!OLLAMA_HTTP_ALLOW_PRIVATE) {
    lines.push(
      'iptables -I OUTPUT -d 127.0.0.11 -p udp --dport 53 -j ACCEPT',
      'iptables -I OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j ACCEPT',
      ...BLOCKED_BROWSER_IPV4_CIDRS.map(
        (cidr) => `iptables -A OUTPUT -d ${cidr} -j REJECT`,
      ),
      'if command -v ip6tables >/dev/null 2>&1; then',
      ...BLOCKED_BROWSER_IPV6_CIDRS.map(
        (cidr) => `  ip6tables -A OUTPUT -d ${cidr} -j REJECT`,
      ),
      'fi',
    );
  }
  lines.push(`touch ${BROWSER_READY_FILE}`, 'while true; do sleep 3600; done');
  return lines.join('; ');
}

async function waitForBrowserContainerReady(containerName: string): Promise<void> {
  const deadline = Date.now() + BROWSER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await inspectContainerRunning(containerName))) {
      throw new Error(`Browser sidecar exited before becoming ready: ${containerName}`);
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

async function ensureBrowserContainer(
  groupFolder: string,
  sessionId: string,
): Promise<string> {
  assertValidGroupFolder(groupFolder);
  ensureContainerRuntimeRunning();

  const containerName = browserContainerName(groupFolder, sessionId);
  if (await inspectContainerRunning(containerName)) {
    return containerName;
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
    ...(OLLAMA_HTTP_ALLOW_PRIVATE ? [] : ['--cap-add=NET_ADMIN', '--user', 'root']),
    ...hostGatewayArgs(),
    '--entrypoint',
    'sh',
    CONTAINER_IMAGE,
    '-lc',
    buildBrowserContainerCommand(),
  ];

  await dockerExec(runArgs);
  await waitForBrowserContainerReady(containerName);
  return containerName;
}

async function runBrowserCommand(
  groupFolder: string,
  sessionId: string,
  browserArgs: string[],
): Promise<string> {
  const containerName = await ensureBrowserContainer(groupFolder, sessionId);
  return dockerExec([
    'exec',
    '-u',
    'node',
    containerName,
    'agent-browser',
    ...browserArgs,
  ]);
}

async function getCurrentBrowserUrl(
  groupFolder: string,
  sessionId: string,
): Promise<string> {
  const output = await runBrowserCommand(groupFolder, sessionId, ['get', 'url']);
  return output.trim();
}

export async function closeBrowserSession(
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  const containerName = browserContainerName(groupFolder, sessionId);
  try {
    stopContainer(containerName);
  } catch {
    // already gone
  }
}

async function assertActiveBrowserUrlSafe(
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  const currentUrl = await getCurrentBrowserUrl(groupFolder, sessionId);
  if (!currentUrl) {
    return;
  }
  try {
    await assertSafeHttpDestination(
      new URL(currentUrl),
      OLLAMA_HTTP_ALLOW_PRIVATE,
    );
  } catch (error) {
    await closeBrowserSession(groupFolder, sessionId);
    throw error;
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
  await runBrowserCommand(ctx.groupFolder, ctx.sessionId, ['open', url.toString()]);
  await assertActiveBrowserUrlSafe(ctx.groupFolder, ctx.sessionId);
  const pageUrl = await runBrowserCommand(ctx.groupFolder, ctx.sessionId, [
    'get',
    'url',
  ]);
  const title = await runBrowserCommand(ctx.groupFolder, ctx.sessionId, [
    'get',
    'title',
  ]);
  return JSON.stringify(
    {
      ok: true,
      url: pageUrl.trim(),
      title: title.trim(),
    },
    null,
    2,
  );
}

async function handleBrowserSnapshot(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  await assertActiveBrowserUrlSafe(ctx.groupFolder, ctx.sessionId);
  const browserArgs = ['snapshot'];
  if (args.interactive_only === true) browserArgs.push('-i');
  if (args.compact === true) browserArgs.push('-c');
  if (typeof args.depth === 'number' && Number.isFinite(args.depth)) {
    browserArgs.push('-d', String(Math.max(1, Math.floor(args.depth))));
  }
  if (typeof args.scope === 'string' && args.scope) {
    browserArgs.push('-s', args.scope);
  }
  const output = await runBrowserCommand(ctx.groupFolder, ctx.sessionId, browserArgs);
  return truncate(output);
}

async function handleBrowserClick(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const target = requireString(args, 'target');
  await runBrowserCommand(ctx.groupFolder, ctx.sessionId, ['click', target]);
  await assertActiveBrowserUrlSafe(ctx.groupFolder, ctx.sessionId);
  return JSON.stringify({ ok: true, target }, null, 2);
}

async function handleBrowserFill(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const target = requireString(args, 'target');
  const text = requireString(args, 'text');
  await runBrowserCommand(ctx.groupFolder, ctx.sessionId, ['fill', target, text]);
  await assertActiveBrowserUrlSafe(ctx.groupFolder, ctx.sessionId);
  return JSON.stringify({ ok: true, target }, null, 2);
}

async function handleBrowserPress(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  const key = requireString(args, 'key');
  await runBrowserCommand(ctx.groupFolder, ctx.sessionId, ['press', key]);
  await assertActiveBrowserUrlSafe(ctx.groupFolder, ctx.sessionId);
  return JSON.stringify({ ok: true, key }, null, 2);
}

async function handleBrowserWait(
  ctx: BrowserToolContext,
  rawArgs: unknown,
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
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
  const output = await runBrowserCommand(ctx.groupFolder, ctx.sessionId, browserArgs);
  await assertActiveBrowserUrlSafe(ctx.groupFolder, ctx.sessionId);
  return truncate(output || 'ok');
}

async function handleBrowserGet(
  ctx: BrowserToolContext,
  rawArgs: unknown,
  field: 'text' | 'title' | 'url',
): Promise<string> {
  const args = parseObjectArgs(rawArgs);
  await assertActiveBrowserUrlSafe(ctx.groupFolder, ctx.sessionId);
  const browserArgs = ['get', field];
  if (field === 'text') {
    browserArgs.push(requireString(args, 'target'));
  }
  const output = await runBrowserCommand(ctx.groupFolder, ctx.sessionId, browserArgs);
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
          'Open a web page in a sandboxed browser session for the current chat session.',
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
          'Read the current browser page accessibility tree or interactive elements.',
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
        name: 'browser_press',
        description: 'Press a keyboard key in the current browser page.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Key name, for example Enter.' },
          },
          required: ['key'],
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
              description: 'Load state like load, domcontentloaded, or networkidle.',
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
        description: 'Close the sandboxed browser session for the current chat session.',
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
  switch (toolName) {
    case 'browser_open':
      return handleBrowserOpen(ctx, rawArgs);
    case 'browser_snapshot':
      return handleBrowserSnapshot(ctx, rawArgs);
    case 'browser_click':
      return handleBrowserClick(ctx, rawArgs);
    case 'browser_fill':
      return handleBrowserFill(ctx, rawArgs);
    case 'browser_press':
      return handleBrowserPress(ctx, rawArgs);
    case 'browser_wait':
      return handleBrowserWait(ctx, rawArgs);
    case 'browser_get_text':
      return handleBrowserGet(ctx, rawArgs, 'text');
    case 'browser_get_title':
      return handleBrowserGet(ctx, rawArgs, 'title');
    case 'browser_get_url':
      return handleBrowserGet(ctx, rawArgs, 'url');
    case 'browser_close':
      return handleBrowserClose(ctx, rawArgs);
    default:
      throw new Error(`Unsupported browser tool: ${toolName}`);
  }
}
