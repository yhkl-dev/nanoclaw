import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import {
  ASSISTANT_NAME,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  OLLAMA_HOST,
  OLLAMA_MODEL,
} from './config.js';
import { assertValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';

const MAX_HISTORY_MESSAGES = 40;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaSession {
  messages: OllamaMessage[];
  updatedAt: string;
}

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
  };
  error?: string;
}

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
  ];

  const groupMemory = readTextFile(path.join(GROUPS_DIR, input.groupFolder, 'CLAUDE.md'));
  if (groupMemory) {
    sections.push(`Group memory:\n${groupMemory}`);
  }

  if (!input.isMain) {
    const globalMemory = readTextFile(path.join(GROUPS_DIR, 'global', 'CLAUDE.md'));
    if (globalMemory) {
      sections.push(`Global memory:\n${globalMemory}`);
    }
  }

  return sections.join('\n\n');
}

function loadSessionMessages(groupFolder: string, sessionId?: string): OllamaMessage[] {
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
  if (input.isScheduledTask && input.script) {
    throw new Error(
      'MODEL_BACKEND=ollama does not support scheduled task scripts',
    );
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
  const history = loadSessionMessages(group.folder, input.sessionId);
  const systemMessage = buildSystemMessage(input);
  const timeoutMs = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const userMessage: OllamaMessage = {
    role: 'user',
    content: input.prompt,
  };

  const requestMessages: OllamaMessage[] = [
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

  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: requestMessages,
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

  const assistantText = parsed.message?.content?.trim();
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

  return output;
}
