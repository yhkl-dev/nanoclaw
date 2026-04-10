/**
 * Post-session reflection and conversation archiving for Claude container runs.
 * After each successful agent session:
 *  1. Always archives a compact conversation entry to conversations/YYYY-MM.md.
 *  2. Optionally calls Haiku to extract learnings into memory/ files.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const REFLECTION_TIMEOUT_MS = 20_000;
const PROACTIVE_REFLECTION_RATE = 0.2;
const SKILL_DRAFT_RATE = 0.05; // 5% proactive, 100% on corrections if pattern found

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
 * Ask Haiku whether the conversation contains a reusable workflow pattern
 * worth saving as a skill draft. If yes, write it to the group's user skills dir.
 */
async function detectAndSaveSkillDraft(
  groupFolder: string,
  cleanPrompt: string,
  cleanResult: string,
  apiKey: string,
): Promise<void> {
  const skillPrompt = `Analyze this conversation and decide if it contains a REUSABLE workflow or procedure that should be saved as a skill for future sessions.

A skill is worth saving when:
- The user asked for a multi-step process that will recur (e.g. "how to deploy X", "the workflow for Y")
- A complex task was solved with a repeatable procedure
- The user explicitly taught a preferred approach

Do NOT save a skill for: one-off answers, simple lookups, casual chat, or trivial single-step tasks.

User messages (excerpt):
${cleanPrompt}

Assistant response (excerpt):
${cleanResult}

If a skill IS worth saving, respond with valid JSON (no markdown):
{"save": true, "name": "short-hyphenated-name", "description": "one line description", "content": "## Overview\\nWhat this skill does\\n\\n## Steps\\n1. ..."}

If NOT worth saving, respond with exactly:
{"save": false}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFLECTION_TIMEOUT_MS);
    let raw = '';
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
          max_tokens: 600,
          messages: [{ role: 'user', content: skillPrompt }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        content: Array<{ type: string; text: string }>;
      };
      raw = (data.content?.[0]?.text ?? '').trim();
    } catch {
      clearTimeout(timer);
      return;
    }

    let parsed: {
      save: boolean;
      name?: string;
      description?: string;
      content?: string;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // not valid JSON, skip
    }

    if (!parsed.save || !parsed.name || !parsed.content) return;

    const safeName = parsed.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    if (!safeName) return;

    const skillDir = path.join(
      DATA_DIR,
      'sessions',
      groupFolder,
      '.claude',
      'skills',
      'user',
      safeName,
    );
    const skillFile = path.join(skillDir, 'SKILL.md');

    // Don't overwrite an existing non-draft skill the agent intentionally saved
    if (fs.existsSync(skillFile)) {
      const existing = fs.readFileSync(skillFile, 'utf-8');
      if (!existing.includes('draft: true')) return;
    }

    fs.mkdirSync(skillDir, { recursive: true });
    const description =
      parsed.description ?? `Auto-detected skill from session`;
    const frontmatter = `---\nname: ${safeName}\ndescription: ${description}\ndraft: true\ncreated-by: reflection\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n`;
    fs.writeFileSync(skillFile, frontmatter + parsed.content);

    logger.info(
      { group: groupFolder, skill: safeName },
      '[reflection] wrote skill draft to user skills',
    );
  } catch (err) {
    logger.debug(
      { err, group: groupFolder },
      '[reflection] skill detection failed (non-fatal)',
    );
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

  // Skill draft detection: check if the session contains a reusable workflow.
  // Runs when corrections happened or at a low random rate.
  // Uses a larger excerpt than the memory note for better skill detection accuracy.
  if (hadCorrections || Math.random() < SKILL_DRAFT_RATE) {
    const skillPromptExcerpt = prompt
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);
    const skillResultExcerpt = result
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);
    detectAndSaveSkillDraft(
      groupFolder,
      skillPromptExcerpt,
      skillResultExcerpt,
      apiKey,
    ).catch(() => {});
  }
}
