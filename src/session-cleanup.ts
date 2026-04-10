import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-sessions.sh');

// Conversations and summaries older than 90 days are pruned.
const CONVERSATION_RETENTION_DAYS = 90;
// Messages in SQLite older than 180 days are deleted (they're never queried).
const MESSAGE_RETENTION_DAYS = 180;
// Draft skills not updated in 30 days are removed.
const DRAFT_SKILL_RETENTION_DAYS = 30;
// Memory files (lessons.md, notes.md, etc.) are truncated if they exceed this.
const MEMORY_MAX_BYTES = 50 * 1024; // 50 KB

function runSessionScript(): void {
  execFile('/bin/bash', [SCRIPT_PATH], { timeout: 60_000 }, (err, stdout) => {
    if (err) {
      logger.error({ err }, 'Session cleanup failed');
      return;
    }
    const summary = stdout.trim().split('\n').pop();
    if (summary) logger.info(summary);
  });
}

/**
 * Prune dated markdown files in a directory older than the cutoff date.
 * Files named YYYY-MM-DD-*.md or YYYY-MM.md are matched by date prefix.
 */
function pruneDatedMarkdownDir(
  dir: string,
  cutoff: Date,
  label: string,
): number {
  if (!fs.existsSync(dir)) return 0;

  let pruned = 0;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return 0;
  }

  const cutoffDateStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  for (const file of files) {
    // Match both YYYY-MM-DD-name.md and YYYY-MM.md
    const dateMatch = file.match(/^(\d{4}-\d{2}(?:-\d{2})?)/);
    if (!dateMatch) continue;

    const fileDateStr =
      dateMatch[1].length === 7
        ? dateMatch[1] + '-01' // YYYY-MM → YYYY-MM-01 for comparison
        : dateMatch[1]; // YYYY-MM-DD

    if (fileDateStr < cutoffDateStr) {
      try {
        fs.unlinkSync(path.join(dir, file));
        pruned++;
        logger.debug({ dir, file }, `[cleanup] deleted old ${label} file`);
      } catch {}
    }
  }

  return pruned;
}

/**
 * Prune conversation and summary archive files older than CONVERSATION_RETENTION_DAYS.
 * Also handles YYYY-MM.md files by removing old ## date sections within them.
 */
function pruneConversations(): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONVERSATION_RETENTION_DAYS);
  const cutoffMonth = cutoff.toISOString().slice(0, 7);

  let groupDirs: string[];
  try {
    groupDirs = fs.readdirSync(GROUPS_DIR).filter((d) => {
      try {
        return fs.statSync(path.join(GROUPS_DIR, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }

  let totalPruned = 0;

  for (const groupDir of groupDirs) {
    const groupPath = path.join(GROUPS_DIR, groupDir);

    // Prune dated summaries (YYYY-MM-DD-name.md) from group/summaries/
    totalPruned += pruneDatedMarkdownDir(
      path.join(groupPath, 'summaries'),
      cutoff,
      'summary',
    );

    // Prune conversations — YYYY-MM.md files with section-level pruning
    const convDir = path.join(groupPath, 'conversations');
    if (!fs.existsSync(convDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(convDir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const month = file.replace('.md', ''); // YYYY-MM
      if (month < cutoffMonth) {
        try {
          fs.unlinkSync(path.join(convDir, file));
          totalPruned++;
          logger.debug(
            { group: groupDir, file },
            '[cleanup] deleted old conversation file',
          );
        } catch {}
        continue;
      }

      // For the cutoff month itself, remove old entries within the file.
      const filePath = path.join(convDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const sections = content.split(/(?=\n## \d{4}-\d{2}-\d{2})/);
        const kept = sections.filter((s) => {
          const match = s.match(/## (\d{4}-\d{2}-\d{2})/);
          if (!match) return true;
          return new Date(match[1]) >= cutoff;
        });
        if (kept.length < sections.length) {
          const newContent = kept.join('');
          if (newContent.trim()) {
            fs.writeFileSync(filePath, newContent, 'utf-8');
          } else {
            fs.unlinkSync(filePath);
          }
          totalPruned += sections.length - kept.length;
        }
      } catch {}
    }
  }

  if (totalPruned > 0) {
    logger.info(
      { totalPruned },
      '[cleanup] pruned old conversation/summary entries',
    );
  }
}

/**
 * Delete draft skills (created-by: reflection, draft: true) not updated
 * in DRAFT_SKILL_RETENTION_DAYS from data/sessions/{folder}/.claude/skills/user/.
 */
function pruneStaleDraftSkills(): void {
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;

  const cutoffMs =
    Date.now() - DRAFT_SKILL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let totalPruned = 0;

  let sessionFolders: string[];
  try {
    sessionFolders = fs.readdirSync(sessionsDir);
  } catch {
    return;
  }

  for (const folder of sessionFolders) {
    const userSkillsDir = path.join(
      sessionsDir,
      folder,
      '.claude',
      'skills',
      'user',
    );
    if (!fs.existsSync(userSkillsDir)) continue;

    let skillDirs: string[];
    try {
      skillDirs = fs.readdirSync(userSkillsDir);
    } catch {
      continue;
    }

    for (const skillName of skillDirs) {
      const skillFile = path.join(userSkillsDir, skillName, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      try {
        const content = fs.readFileSync(skillFile, 'utf-8');
        // Only remove auto-generated drafts, not skills the agent intentionally saved
        if (
          !content.includes('draft: true') ||
          !content.includes('created-by: reflection')
        ) {
          continue;
        }

        const stat = fs.statSync(skillFile);
        if (stat.mtimeMs < cutoffMs) {
          fs.rmSync(path.join(userSkillsDir, skillName), {
            recursive: true,
            force: true,
          });
          totalPruned++;
          logger.debug(
            { folder, skill: skillName },
            '[cleanup] removed stale draft skill',
          );
        }
      } catch {}
    }
  }

  if (totalPruned > 0) {
    logger.info({ totalPruned }, '[cleanup] removed stale draft skills');
  }
}

/**
 * Delete messages from SQLite older than MESSAGE_RETENTION_DAYS.
 * These are never queried by the system; keeping them only wastes disk.
 */
function pruneOldMessages(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) return;

  try {
    const db = new Database(dbPath);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MESSAGE_RETENTION_DAYS);
    const cutoffTs = cutoff.toISOString();

    const result = db
      .prepare(`DELETE FROM messages WHERE timestamp < ?`)
      .run(cutoffTs);

    db.close();

    if (result.changes > 0) {
      logger.info(
        { deleted: result.changes, cutoff: cutoffTs },
        '[cleanup] pruned old messages',
      );
    }
  } catch (err) {
    logger.debug({ err }, '[cleanup] message pruning failed (non-fatal)');
  }
}

/**
 * Truncate oversized memory files to the most recent MEMORY_MAX_BYTES.
 * Keeps the tail of the file (newest entries) when truncating.
 */
function pruneMemoryFiles(): void {
  const MEMORY_FILES = ['lessons.md', 'notes.md', 'preferences.md', 'facts.md'];

  let groupDirs: string[];
  try {
    groupDirs = fs.readdirSync(GROUPS_DIR).filter((d) => {
      try {
        return fs.statSync(path.join(GROUPS_DIR, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }

  for (const groupDir of groupDirs) {
    const memDir = path.join(GROUPS_DIR, groupDir, 'memory');
    if (!fs.existsSync(memDir)) continue;

    for (const fileName of MEMORY_FILES) {
      const filePath = path.join(memDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      try {
        const stat = fs.statSync(filePath);
        if (stat.size <= MEMORY_MAX_BYTES) continue;

        // Keep the newest MEMORY_MAX_BYTES bytes (tail of the file)
        const content = fs.readFileSync(filePath, 'utf-8');
        const truncated = content.slice(-MEMORY_MAX_BYTES);
        // Find the first complete line so we don't cut mid-line
        const firstNewline = truncated.indexOf('\n');
        const clean =
          firstNewline >= 0 ? truncated.slice(firstNewline + 1) : truncated;
        fs.writeFileSync(filePath, clean, 'utf-8');
        logger.info(
          { group: groupDir, file: fileName, originalBytes: stat.size },
          '[cleanup] truncated oversized memory file',
        );
      } catch {}
    }
  }
}

function runCleanup(): void {
  runSessionScript();
  pruneConversations();
  pruneMemoryFiles();
  pruneStaleDraftSkills();
  pruneOldMessages();
}

export function startSessionCleanup(): void {
  // Run once at startup (delayed 30s to not compete with init)
  setTimeout(runCleanup, 30_000);
  // Then every 24 hours
  setInterval(runCleanup, CLEANUP_INTERVAL);
}
