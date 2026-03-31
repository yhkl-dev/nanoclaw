import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ANTHROPIC_MODEL',
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CREDENTIAL_PROXY_PORT',
  'MODEL_BACKEND',
  'OLLAMA_ADMIN_TOOLS',
  'OLLAMA_ENABLE_HOST_SCRIPTS',
  'OLLAMA_HOST',
  'OLLAMA_HTTP_ALLOW_PRIVATE',
  'OLLAMA_MODEL',
  'TZ',
  'WECOM_BOT_ID',
  'WECOM_BOT_SECRET',
  'WECOM_WS_URL',
]);

export const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || envConfig.ANTHROPIC_MODEL;
export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const MODEL_BACKEND =
  process.env.MODEL_BACKEND || envConfig.MODEL_BACKEND || 'claude';
export const OLLAMA_ADMIN_TOOLS =
  (process.env.OLLAMA_ADMIN_TOOLS || envConfig.OLLAMA_ADMIN_TOOLS) === 'true';
export const OLLAMA_ENABLE_HOST_SCRIPTS =
  (process.env.OLLAMA_ENABLE_HOST_SCRIPTS ||
    envConfig.OLLAMA_ENABLE_HOST_SCRIPTS) === 'true';
export const OLLAMA_HOST = process.env.OLLAMA_HOST || envConfig.OLLAMA_HOST;
export const OLLAMA_HTTP_ALLOW_PRIVATE =
  (process.env.OLLAMA_HTTP_ALLOW_PRIVATE ||
    envConfig.OLLAMA_HTTP_ALLOW_PRIVATE) === 'true';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || envConfig.OLLAMA_MODEL;
export const WECOM_BOT_ID = process.env.WECOM_BOT_ID || envConfig.WECOM_BOT_ID;
export const WECOM_BOT_SECRET =
  process.env.WECOM_BOT_SECRET || envConfig.WECOM_BOT_SECRET;
export const WECOM_WS_URL = process.env.WECOM_WS_URL || envConfig.WECOM_WS_URL;
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT ||
    envConfig.CREDENTIAL_PROXY_PORT ||
    '3001',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
