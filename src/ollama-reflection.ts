import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, OLLAMA_HOST, OLLAMA_MODEL } from './config.js';
import { logger } from './logger.js';
import type { OllamaMessage } from './ollama-types.js';

const REFLECTION_TIMEOUT_MS = 20_000;

// Proactive reflection rate when no corrections detected (20% of sessions).
const PROACTIVE_REFLECTION_RATE = 0.2;

// Phrases that indicate the user is correcting the assistant.
const CORRECTION_SIGNALS = [
  '不对',
  '你错了',
  '错了',
  '搞错了',
  '重新来',
  '重来',
  '不是这样',
  '理解错了',
  '你理解错了',
  'wrong',
  'incorrect',
  "that's not",
  "that's wrong",
  'not right',
  'you misunderstood',
];

/**
 * Scan user messages for correction signals.
 */
export function detectCorrectionSignals(messages: OllamaMessage[]): boolean {
  return messages.some((m) => {
    if (m.role !== 'user') return false;
    const text = (typeof m.content === 'string' ? m.content : '').toLowerCase();
    return CORRECTION_SIGNALS.some((s) => text.includes(s));
  });
}

/**
 * Run a lightweight post-session reflection and persist any learnings to CLAUDE.md.
 * Designed to be called fire-and-forget (without await) after saveSessionMessages.
 */
export async function triggerSessionReflection(
  groupFolder: string,
  messages: OllamaMessage[],
  hadCorrections: boolean,
): Promise<void> {
  // Defer to the macrotask queue so the caller (runDirectOllamaAgent) fully
  // returns and its callers can run before we issue any network requests.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  // Only run when corrections occurred, or with 20% probability for proactive learning.
  if (!hadCorrections && Math.random() > PROACTIVE_REFLECTION_RATE) return;
  if (!OLLAMA_HOST || !OLLAMA_MODEL) return;
  // Need at least one user + one assistant exchange to reflect on.
  if (messages.filter((m) => m.role !== 'system').length < 2) return;

  // Use only recent messages to keep the reflection prompt short.
  const recent = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6);

  const conversationText = recent
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : '';
      const label = m.role === 'user' ? 'User' : 'Assistant';
      return `${label}: ${content.slice(0, 300)}`;
    })
    .join('\n');

  const purpose = hadCorrections
    ? 'The user corrected the assistant in this conversation. Focus on what went wrong and the correct approach.'
    : 'Review this conversation for any user preferences or environment details worth remembering.';

  const prompt = `${purpose}

Conversation:
${conversationText}

Write a brief memory note (under 80 words) covering:
- User preferences or habits discovered
- Mistakes made and the correct approach
- Environment details (paths, tools, configs) useful for future sessions

If there is nothing worth remembering, respond with exactly: nothing to note`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFLECTION_TIMEOUT_MS);

    let rawText = '';
    try {
      const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          messages: [{ role: 'user', content: prompt }],
          options: { num_predict: 200 },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      rawText = await response.text();
      if (!response.ok) throw new Error(`Ollama ${response.status}`);
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }

    const parsed = JSON.parse(rawText) as { message?: { content?: string } };
    const content = (parsed.message?.content ?? '').trim();

    if (!content || content.toLowerCase().includes('nothing to note')) {
      logger.debug({ group: groupFolder }, '[reflection] nothing to note');
      return;
    }

    const groupDir = path.join(GROUPS_DIR, groupFolder);
    fs.mkdirSync(groupDir, { recursive: true });
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    const timestamp = new Date().toISOString().slice(0, 10);
    const section = hadCorrections ? 'Lesson Learned' : 'Session Notes';
    const entry = `\n## ${section} (${timestamp})\n${content}\n`;
    fs.appendFileSync(claudeMdPath, entry, 'utf-8');

    logger.info(
      { group: groupFolder, section, chars: content.length },
      '[reflection] wrote session learnings to CLAUDE.md',
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    logger.debug(
      { err: isTimeout ? 'timeout' : String(err), group: groupFolder },
      '[reflection] reflection failed (non-fatal)',
    );
  }
}
