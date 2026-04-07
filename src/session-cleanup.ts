import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-sessions.sh');

// Conversations older than 90 days are pruned from YYYY-MM.md files.
const CONVERSATION_RETENTION_DAYS = 90;
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
 * Prune conversation archive files: remove ## date sections older than
 * CONVERSATION_RETENTION_DAYS, then delete empty files.
 */
function pruneConversations(): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONVERSATION_RETENTION_DAYS);
  // YYYY-MM cutoff string for filename filtering
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
    const convDir = path.join(GROUPS_DIR, groupDir, 'conversations');
    if (!fs.existsSync(convDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(convDir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const month = file.replace('.md', ''); // YYYY-MM
      // If the entire file is older than cutoff month, delete it
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
      // Entries are delimited by \n## YYYY-MM-DD HH:MM
      const filePath = path.join(convDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const sections = content.split(/(?=\n## \d{4}-\d{2}-\d{2})/);
        const kept = sections.filter((s) => {
          const match = s.match(/## (\d{4}-\d{2}-\d{2})/);
          if (!match) return true; // keep header/preamble
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
    logger.info({ totalPruned }, '[cleanup] pruned old conversation entries');
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
}

export function startSessionCleanup(): void {
  // Run once at startup (delayed 30s to not compete with init)
  setTimeout(runCleanup, 30_000);
  // Then every 24 hours
  setInterval(runCleanup, CLEANUP_INTERVAL);
}
