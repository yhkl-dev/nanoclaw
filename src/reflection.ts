/**
 * Post-session reflection and conversation archiving for Claude container runs.
 * After each successful agent session:
 *  1. Always archives a compact conversation entry to conversations/YYYY-MM.md.
 *  2. Optionally calls Haiku to extract learnings into memory/ files.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const REFLECTION_TIMEOUT_MS = 20_000;
const PROACTIVE_REFLECTION_RATE = 0.2;

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
 * Scan the formatted prompt string for correction signals from the user.
 */
export function detectCorrectionSignals(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return CORRECTION_SIGNALS.some((s) => lower.includes(s.toLowerCase()));
}

/**
 * Append a compact conversation entry to conversations/YYYY-MM.md.
 * Always runs — not subject to the proactive reflection rate.
 */
function archiveConversation(
  groupFolder: string,
  prompt: string,
  result: string,
): void {
  try {
    const convDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });

    const now = new Date();
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const datetime = now.toISOString().slice(0, 16).replace('T', ' '); // YYYY-MM-DD HH:MM

    const promptExcerpt = prompt
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    const resultExcerpt = result
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);

    const entry =
      `\n## ${datetime}\n` +
      `**User:** ${promptExcerpt}\n\n` +
      `**Agent:** ${resultExcerpt}\n`;

    const filePath = path.join(convDir, `${month}.md`);
    fs.appendFileSync(filePath, entry, 'utf-8');
    logger.debug(
      { group: groupFolder, file: `${month}.md` },
      '[archive] conversation logged',
    );
  } catch (err) {
    logger.debug({ err, group: groupFolder }, '[archive] failed (non-fatal)');
  }
}

/**
 * Fire-and-forget post-session reflection using Haiku 4.5.
 * Always archives the conversation, then optionally writes a memory note.
 *
 * Call without await after a successful container run:
 *   triggerSessionReflection(...).catch(() => {});
 */
export async function triggerSessionReflection(
  groupFolder: string,
  prompt: string,
  result: string,
  hadCorrections: boolean,
): Promise<void> {
  // Defer so the caller returns first.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  // Always archive the conversation regardless of reflection rate.
  archiveConversation(groupFolder, prompt, result);

  if (!hadCorrections && Math.random() > PROACTIVE_REFLECTION_RATE) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.debug(
      { group: groupFolder },
      '[reflection] no ANTHROPIC_API_KEY, skipping',
    );
    return;
  }

  // Strip XML/tags for a readable excerpt.
  const cleanPrompt = prompt
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
  const cleanResult = result
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  const purpose = hadCorrections
    ? 'The user corrected the assistant in this conversation. Focus on what went wrong and the correct approach.'
    : 'Review this conversation for any user preferences or environment details worth remembering.';

  const reflectionPrompt = `${purpose}

User messages (excerpt):
${cleanPrompt}

Assistant response (excerpt):
${cleanResult}

Write a brief memory note (under 80 words) covering:
- User preferences or habits discovered
- Mistakes made and the correct approach
- Environment details (paths, tools, configs) useful for future sessions

If there is nothing worth remembering, respond with exactly: nothing to note`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFLECTION_TIMEOUT_MS);

    let content = '';
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: reflectionPrompt }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`Anthropic API ${resp.status}`);
      const data = (await resp.json()) as {
        content: Array<{ type: string; text: string }>;
      };
      content = (data.content?.[0]?.text ?? '').trim();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }

    if (!content || content.toLowerCase().includes('nothing to note')) {
      logger.debug({ group: groupFolder }, '[reflection] nothing to note');
      return;
    }

    const memoryDir = path.join(GROUPS_DIR, groupFolder, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    // Corrections go to lessons.md; proactive observations go to notes.md
    const fileName = hadCorrections ? 'lessons.md' : 'notes.md';
    const filePath = path.join(memoryDir, fileName);
    const timestamp = new Date().toISOString().slice(0, 10);
    const entry = `\n## ${timestamp}\n${content}\n`;
    fs.appendFileSync(filePath, entry, 'utf-8');

    logger.info(
      { group: groupFolder, file: fileName, chars: content.length },
      '[reflection] wrote session learnings to memory/',
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    logger.debug(
      { err: isTimeout ? 'timeout' : String(err), group: groupFolder },
      '[reflection] failed (non-fatal)',
    );
  }
}
