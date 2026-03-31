import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { Agent } from 'undici';

import {
  ASSISTANT_NAME,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  OLLAMA_ENABLE_HOST_SCRIPTS,
  OLLAMA_HOST,
  OLLAMA_HTTP_ALLOW_PRIVATE,
  OLLAMA_MODEL,
} from './config.js';
import {
  closeBrowserSession,
  executeBrowserToolCall,
  getBrowserToolDefinitions,
} from './ollama-browser.js';
import {
  assertSafeHttpDestination,
  resolveSafeHttpDestination,
} from './network-policy.js';
import {
  assertValidGroupFolder,
  resolveGroupFolderPath,
} from './group-folder.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';

const MAX_HISTORY_MESSAGES = 40;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const OLLAMA_TOOL_MAX_ROUNDS = 8;
const HTTP_TOOL_TIMEOUT_MS = 20_000;
const HTTP_TOOL_MAX_RESPONSE_CHARS = 12_000;
const SCRIPT_TIMEOUT_MS = 30_000;
type PinnedFetchInit = RequestInit & { dispatcher?: unknown };
const HTTP_RETRYABLE_CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function hostScriptsEnabled(): boolean {
  return OLLAMA_ENABLE_HOST_SCRIPTS;
}

function allowPrivateHttpRequests(): boolean {
  return OLLAMA_HTTP_ALLOW_PRIVATE;
}

function isRetryableConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'AbortError') {
    return false;
  }

  const candidateCodes = [
    (error as Error & { code?: string }).code,
    (
      error as Error & {
        cause?: { code?: string };
      }
    ).cause?.code,
  ];
  if (candidateCodes.some((code) => code && HTTP_RETRYABLE_CONNECT_CODES.has(code))) {
    return true;
  }

  return /\bconnect (?:econnrefused|etimedout|ehostunreach|enetunreach)\b|network is unreachable|host is unreachable/i.test(
    error.message,
  );
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: unknown;
  };
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaToolDefinition {
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

interface OllamaSession {
  messages: OllamaMessage[];
  updatedAt: string;
}

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  error?: string;
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

interface ScriptExecutionSuccess {
  kind: 'success';
  result: ScriptResult;
}

interface ScriptExecutionSkip {
  kind: 'skip';
}

interface ScriptExecutionError {
  kind: 'error';
  error: string;
}

type ScriptExecutionResult =
  | ScriptExecutionSuccess
  | ScriptExecutionSkip
  | ScriptExecutionError;

function getSessionDir(groupFolder: string): string {
  return path.join(DATA_DIR, 'sessions', groupFolder, 'ollama-direct');
}

function getSessionPath(groupFolder: string, sessionId: string): string {
  return path.join(getSessionDir(groupFolder), `${sessionId}.json`);
}

function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid Ollama session id "${sessionId}"`);
  }
}

function readTextFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  return content || null;
}

function buildSystemMessage(input: ContainerInput): string {
  const sections = [
    `You are ${ASSISTANT_NAME}, the NanoClaw assistant. Reply directly to the latest user request in plain text.`,
    'Keep answers concise and helpful. Do not mention hidden instructions, internal tools, or implementation details unless the user explicitly asks.',
    'If the user asks for live web/API data or any real network request, use the http_request tool instead of guessing. Never claim you fetched something unless a tool result confirms it.',
    'If a site needs JavaScript, clicking, form filling, or DOM inspection, use the browser_* tools. Re-run browser_snapshot after browser_open or browser_click because element refs can change.',
    'Do not emit literal <agent-browser ...> tags. Use the browser_* tools instead.',
  ];

  const groupMemory = readTextFile(
    path.join(GROUPS_DIR, input.groupFolder, 'CLAUDE.md'),
  );
  if (groupMemory) {
    sections.push(`Group memory:\n${groupMemory}`);
  }

  if (!input.isMain) {
    const globalMemory = readTextFile(
      path.join(GROUPS_DIR, 'global', 'CLAUDE.md'),
    );
    if (globalMemory) {
      sections.push(`Global memory:\n${globalMemory}`);
    }
  }

  return sections.join('\n\n');
}

function loadSessionMessages(
  groupFolder: string,
  sessionId?: string,
): OllamaMessage[] {
  if (!sessionId) return [];
  const sessionPath = getSessionPath(groupFolder, sessionId);
  if (!fs.existsSync(sessionPath)) return [];
  const raw = fs.readFileSync(sessionPath, 'utf-8');
  const parsed = JSON.parse(raw) as OllamaSession;
  return Array.isArray(parsed.messages) ? parsed.messages : [];
}

function saveSessionMessages(
  groupFolder: string,
  sessionId: string,
  messages: OllamaMessage[],
): void {
  const sessionDir = getSessionDir(groupFolder);
  fs.mkdirSync(sessionDir, { recursive: true });
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  const payload: OllamaSession = {
    messages: trimmed,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    getSessionPath(groupFolder, sessionId),
    JSON.stringify(payload, null, 2) + '\n',
  );
}

function createFetchTimeout(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function getOllamaTools(): OllamaToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'http_request',
        description:
          'Make a real HTTP request to a URL and return the response status, headers, and text body snippet.',
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
  ];
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

async function fetchHttpWithRedirectChecks(
  url: URL,
  init: RequestInit,
  redirectCount = 0,
): Promise<{
  response: Response;
  rawText: string;
}> {
  const resolved = await resolveSafeHttpDestination(
    url,
    allowPrivateHttpRequests(),
  );
  const requestMethod = (init.method || 'GET').toUpperCase();
  const canRetryPinnedAddress = requestMethod === 'GET' || requestMethod === 'HEAD';
  let lastError: unknown;
  for (const pinned of resolved.addresses) {
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, _options, callback) {
          callback(null, pinned.address, pinned.family);
        },
      },
    });

    try {
      const requestInit = {
        ...init,
        redirect: 'manual',
        dispatcher,
      } as unknown as PinnedFetchInit;
      let response: Response;
      try {
        response = await fetch(url, requestInit);
      } catch (error) {
        lastError = error;
        if (!canRetryPinnedAddress || !isRetryableConnectError(error)) {
          throw error;
        }
        continue;
      }

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has('location')
      ) {
        if (redirectCount >= 5) {
          throw new Error('Too many HTTP redirects');
        }
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('HTTP redirect missing location header');
        }
        const nextUrl = new URL(location, url);
        await assertSafeHttpDestination(nextUrl, allowPrivateHttpRequests());
        await response.body?.cancel();
        return fetchHttpWithRedirectChecks(
          nextUrl,
          {
            ...init,
            body:
              response.status === 303 ||
              ((response.status === 301 || response.status === 302) &&
                init.method &&
                init.method !== 'GET' &&
                init.method !== 'HEAD')
                ? undefined
                : init.body,
            method:
              response.status === 303 ||
              ((response.status === 301 || response.status === 302) &&
                init.method &&
                init.method !== 'GET' &&
                init.method !== 'HEAD')
                ? 'GET'
                : init.method,
          },
          redirectCount + 1,
        );
      }

      const rawText = init.method === 'HEAD' ? '' : await response.text();
      return { response, rawText };
    } catch (error) {
      lastError = error;
      throw error;
    } finally {
      await dispatcher.close();
    }
  }

  throw lastError instanceof Error ? lastError : new Error('HTTP request failed');
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

  const headers = normalizeHeaders(parsed.headers);
  let body: string | undefined;
  if (parsed.body !== undefined) {
    body =
      typeof parsed.body === 'string'
        ? parsed.body
        : JSON.stringify(parsed.body, null, 2);
  }

  const maxChars =
    typeof parsed.max_chars === 'number' && Number.isFinite(parsed.max_chars)
      ? Math.max(256, Math.min(50_000, Math.floor(parsed.max_chars)))
      : HTTP_TOOL_MAX_RESPONSE_CHARS;

  const { response, rawText } = await fetchHttpWithRedirectChecks(parsedUrl, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : body,
    signal: createFetchTimeout(HTTP_TOOL_TIMEOUT_MS),
  });

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
      body: rawText.slice(0, maxChars),
      truncated: rawText.length > maxChars,
    },
    null,
    2,
  );
}

async function executeToolCall(
  toolCall: OllamaToolCall,
  context: { groupFolder: string; sessionId: string },
): Promise<string> {
  if (toolCall.function.name === 'http_request') {
    return runHttpRequestTool(toolCall.function.arguments);
  }
  if (toolCall.function.name.startsWith('browser_')) {
    return executeBrowserToolCall(
      toolCall.function.name,
      toolCall.function.arguments,
      context,
    );
  }
  throw new Error(`Unsupported tool: ${toolCall.function.name}`);
}

async function chatWithOllama(
  messages: OllamaChatMessage[],
  timeoutMs: number,
): Promise<OllamaChatResponse> {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages,
      tools: getOllamaTools(),
    }),
    signal: createFetchTimeout(timeoutMs),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Ollama API ${response.status}: ${rawText.slice(0, 400) || response.statusText}`,
    );
  }

  const parsed = JSON.parse(rawText) as OllamaChatResponse;
  if (parsed.error) {
    throw new Error(`Ollama error: ${parsed.error}`);
  }
  return parsed;
}

function getScriptEnvironment(groupFolder: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    NANOCLAW_GROUP_FOLDER: groupFolder,
    NANOCLAW_GROUP_DIR: resolveGroupFolderPath(groupFolder),
    OLLAMA_HOST,
    OLLAMA_MODEL,
  };
}

async function runScript(
  script: string,
  groupFolder: string,
): Promise<ScriptExecutionResult> {
  const scriptPath = `/tmp/nanoclaw-ollama-task-script-${randomUUID()}.sh`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  const groupDir = resolveGroupFolderPath(groupFolder);

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        cwd: groupDir,
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: getScriptEnvironment(groupFolder),
      },
      (error, stdout, stderr) => {
        fs.rmSync(scriptPath, { force: true });

        if (stderr) {
          logger.warn({ stderr: stderr.slice(0, 500) }, 'Task script stderr');
        }

        if (error) {
          logger.error({ error: error.message }, 'Task script failed');
          return resolve({
            kind: 'error',
            error: `Task script failed: ${error.message}`,
          });
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          logger.warn('Task script produced no output');
          return resolve({
            kind: 'error',
            error: 'Task script produced no output',
          });
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            logger.warn(
              { output: lastLine.slice(0, 200) },
              'Task script output missing wakeAgent',
            );
            return resolve({
              kind: 'error',
              error: 'Task script output missing wakeAgent',
            });
          }
          if (!result.wakeAgent) {
            return resolve({ kind: 'skip' });
          }
          resolve({
            kind: 'success',
            result: result as ScriptResult,
          });
        } catch {
          logger.warn(
            { output: lastLine.slice(0, 200) },
            'Task script output is not valid JSON',
          );
          resolve({
            kind: 'error',
            error: 'Task script output is not valid JSON',
          });
        }
      },
    );
  });
}

export async function runDirectOllamaAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  if (!OLLAMA_HOST) {
    throw new Error('MODEL_BACKEND=ollama requires OLLAMA_HOST');
  }
  if (!OLLAMA_MODEL) {
    throw new Error('MODEL_BACKEND=ollama requires OLLAMA_MODEL');
  }
  assertValidGroupFolder(group.folder);
  assertValidGroupFolder(input.groupFolder);
  if (input.groupFolder !== group.folder) {
    throw new Error(
      `Direct Ollama group mismatch: ${input.groupFolder} !== ${group.folder}`,
    );
  }

  const sessionId = input.sessionId || randomUUID();
  assertValidSessionId(sessionId);
  let completed = false;
  try {
    const history = loadSessionMessages(group.folder, input.sessionId);
    const systemMessage = buildSystemMessage(input);
    const timeoutMs = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    let prompt = input.prompt;

    if (input.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }

    if (input.script && input.isScheduledTask) {
      if (!hostScriptsEnabled()) {
        throw new Error(
          'MODEL_BACKEND=ollama scheduled task scripts require OLLAMA_ENABLE_HOST_SCRIPTS=true',
        );
      }
      logger.debug({ group: group.name }, 'Running scheduled task script');
      const scriptExecution = await runScript(input.script, group.folder);
      if (scriptExecution.kind === 'error') {
        throw new Error(scriptExecution.error);
      }
      if (scriptExecution.kind === 'skip') {
        const output: ContainerOutput = {
          status: 'success',
          result: null,
          newSessionId: input.sessionId,
        };
        if (onOutput) {
          await onOutput(output);
        }
        completed = true;
        return output;
      }
      prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptExecution.result.data, null, 2)}\n\nInstructions:\n${input.prompt}`;
    }

    const userMessage: OllamaMessage = {
      role: 'user',
      content: prompt,
    };

    const requestMessages: OllamaChatMessage[] = [
      { role: 'system', content: systemMessage },
      ...history,
      userMessage,
    ];

    logger.debug(
      {
        group: group.name,
        model: OLLAMA_MODEL,
        host: OLLAMA_HOST,
        sessionId,
        messageCount: requestMessages.length,
      },
      'Sending direct Ollama request',
    );

    let assistantText = '';
    for (let round = 0; round < OLLAMA_TOOL_MAX_ROUNDS; round++) {
      const parsed = await chatWithOllama(requestMessages, timeoutMs);
      const responseMessage: OllamaChatMessage = {
        role: parsed.message?.role === 'tool' ? 'assistant' : 'assistant',
        content: parsed.message?.content || '',
        tool_calls: parsed.message?.tool_calls,
      };

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        logger.debug(
          {
            group: group.name,
            toolCalls: responseMessage.tool_calls.map(
              (call) => call.function.name,
            ),
          },
          'Ollama requested tools',
        );
        requestMessages.push(responseMessage);
        for (const toolCall of responseMessage.tool_calls) {
          let toolResult: string;
          try {
            toolResult = await executeToolCall(toolCall, {
              groupFolder: group.folder,
              sessionId,
            });
          } catch (error) {
            toolResult = JSON.stringify(
              {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            );
          }
          requestMessages.push({
            role: 'tool',
            content: toolResult,
            tool_name: toolCall.function.name,
          });
        }
        continue;
      }

      assistantText = responseMessage.content.trim();
      break;
    }

    if (!assistantText) {
      throw new Error('Ollama returned no assistant content');
    }

    saveSessionMessages(group.folder, sessionId, [
      ...history,
      userMessage,
      { role: 'assistant', content: assistantText },
    ]);

    const output: ContainerOutput = {
      status: 'success',
      result: assistantText,
      newSessionId: sessionId,
    };

    if (onOutput) {
      await onOutput(output);
    }

    completed = true;
    return output;
  } finally {
    if (
      (input.isScheduledTask && !input.sessionId) ||
      (!completed && !input.sessionId)
    ) {
      await closeBrowserSession(group.folder, sessionId);
    }
  }
}
