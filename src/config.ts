import os from 'os';
import path from 'path';

import {
  DEFAULT_ASSISTANT_NAME,
  LEGACY_ASSISTANT_NAMES,
} from './assistant-name.js';
import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ANTHROPIC_MODEL',
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CONTAINER_HTTP_PROXY',
  'CREDENTIAL_PROXY_PORT',
  'BARK_KEY',
  'BARK_URL',
  'GITHUB_TOKEN',
  'HTTPS_PROXY',
  'NO_PROXY',
  'TAVILY_API_KEY',
  'MODEL_BACKEND',
  'OLLAMA_ADMIN_TOOLS',
  'OLLAMA_ENABLE_HOST_SCRIPTS',
  'OLLAMA_HOST',
  'OLLAMA_HTTP_ALLOW_PRIVATE',
  'OLLAMA_HTTP_MAX_REDIRECTS',
  'OLLAMA_HTTP_TIMEOUT_MS',
  'OLLAMA_MODEL',
  'OLLAMA_MODEL_ROUTES',
  'OLLAMA_SESSION_RECENT_MESSAGES',
  'OLLAMA_SESSION_SUMMARY_MAX_CHARS',
  'OLLAMA_THINK',
  'RSS_POLL_INTERVAL_MS',
  'TZ',
  'WECOM_BOT_ID',
  'WECOM_BOT_SECRET',
  'WECOM_WS_URL',
]);

export const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || envConfig.ANTHROPIC_MODEL;
function normalizeAssistantName(name?: string): string | undefined {
  if (!name) return undefined;
  return LEGACY_ASSISTANT_NAMES.includes(name) ? DEFAULT_ASSISTANT_NAME : name;
}

const processAssistantName = normalizeAssistantName(process.env.ASSISTANT_NAME);
const fileAssistantName = normalizeAssistantName(envConfig.ASSISTANT_NAME);

export const ASSISTANT_NAME =
  (processAssistantName === DEFAULT_ASSISTANT_NAME && fileAssistantName) ||
  processAssistantName ||
  fileAssistantName ||
  DEFAULT_ASSISTANT_NAME;
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
export const OLLAMA_HTTP_MAX_REDIRECTS = Math.max(
  0,
  parseInt(
    process.env.OLLAMA_HTTP_MAX_REDIRECTS ||
      envConfig.OLLAMA_HTTP_MAX_REDIRECTS ||
      '5',
    10,
  ) || 5,
);
export const OLLAMA_HTTP_TIMEOUT_MS = Math.max(
  1_000,
  parseInt(
    process.env.OLLAMA_HTTP_TIMEOUT_MS ||
      envConfig.OLLAMA_HTTP_TIMEOUT_MS ||
      '20000',
    10,
  ) || 20_000,
);
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || envConfig.OLLAMA_MODEL;
export const OLLAMA_SESSION_RECENT_MESSAGES = Math.max(
  2,
  parseInt(
    process.env.OLLAMA_SESSION_RECENT_MESSAGES ||
      envConfig.OLLAMA_SESSION_RECENT_MESSAGES ||
      '12',
    10,
  ) || 12,
);
export const OLLAMA_SESSION_SUMMARY_MAX_CHARS = Math.max(
  256,
  parseInt(
    process.env.OLLAMA_SESSION_SUMMARY_MAX_CHARS ||
      envConfig.OLLAMA_SESSION_SUMMARY_MAX_CHARS ||
      '2000',
    10,
  ) || 2000,
);
// OLLAMA_THINK: set to 'true' to enable extended thinking for qwen3-style models.
// Defaults to false because thinking mode makes tool calling unreliable.
export const OLLAMA_THINK =
  (process.env.OLLAMA_THINK || envConfig.OLLAMA_THINK) === 'true';
export const WECOM_BOT_ID = process.env.WECOM_BOT_ID || envConfig.WECOM_BOT_ID;
export const WECOM_BOT_SECRET =
  process.env.WECOM_BOT_SECRET || envConfig.WECOM_BOT_SECRET;
export const WECOM_WS_URL = process.env.WECOM_WS_URL || envConfig.WECOM_WS_URL;
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
export const PROJECT_ROOT = process.cwd();
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
export const CONTAINER_HTTP_PROXY =
  process.env.CONTAINER_HTTP_PROXY || envConfig.CONTAINER_HTTP_PROXY || '';
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

// Outbound proxy for Google APIs and other external HTTPS calls.
export const OUTBOUND_HTTPS_PROXY: string | undefined =
  process.env.HTTPS_PROXY || envConfig.HTTPS_PROXY || undefined;
export const OUTBOUND_NO_PROXY: string | undefined =
  process.env.NO_PROXY || envConfig.NO_PROXY || undefined;

export const TAVILY_API_KEY: string | undefined =
  process.env.TAVILY_API_KEY || envConfig.TAVILY_API_KEY || undefined;
export const GITHUB_TOKEN: string | undefined =
  process.env.GITHUB_TOKEN || envConfig.GITHUB_TOKEN || undefined;
export const BARK_KEY: string | undefined =
  process.env.BARK_KEY || envConfig.BARK_KEY || undefined;
export const BARK_URL: string =
  process.env.BARK_URL || envConfig.BARK_URL || 'https://api.day.app';

// RSS feed aggregator poll interval (default: 30 minutes)
export const RSS_POLL_INTERVAL_MS = Math.max(
  60_000,
  parseInt(
    process.env.RSS_POLL_INTERVAL_MS ||
      envConfig.RSS_POLL_INTERVAL_MS ||
      '1800000',
    10,
  ) || 1_800_000,
);

// Ollama multi-model routing rules.
// Format: "keyword1:model1,keyword2:model2"
// Keywords are matched case-insensitively against the full prompt.
// First match wins; falls back to OLLAMA_MODEL if no rule matches.
export const OLLAMA_MODEL_ROUTES: string | undefined =
  process.env.OLLAMA_MODEL_ROUTES ||
  envConfig.OLLAMA_MODEL_ROUTES ||
  undefined;
