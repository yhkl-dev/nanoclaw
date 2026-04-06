import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const FAILURE_FILE = '.tool-failures.json';
// Write a CLAUDE.md warning after this many consecutive failures.
const FAILURE_THRESHOLD = 3;
// Discard failure records older than this many days.
const FAILURE_EXPIRY_DAYS = 7;

interface FailureRecord {
  count: number;
  lastError: string;
  lastSeen: string;
  notedInMemory: boolean;
}

type FailureStore = Record<string, FailureRecord>;

function getFailurePath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, FAILURE_FILE);
}

function loadFailures(groupFolder: string): FailureStore {
  const p = getFailurePath(groupFolder);
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as FailureStore;
    const cutoff = Date.now() - FAILURE_EXPIRY_DAYS * 86_400_000;
    return Object.fromEntries(
      Object.entries(raw).filter(
        ([, r]) => new Date(r.lastSeen).getTime() > cutoff,
      ),
    );
  } catch {
    return {};
  }
}

function saveFailures(groupFolder: string, store: FailureStore): void {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    getFailurePath(groupFolder),
    JSON.stringify(store, null, 2) + '\n',
  );
}

/**
 * Record a tool failure. Writes a CLAUDE.md warning the first time the failure
 * count reaches FAILURE_THRESHOLD for a given tool in this group.
 */
export function recordToolFailure(
  groupFolder: string,
  toolName: string,
  errorMessage: string,
): void {
  try {
    const store = loadFailures(groupFolder);
    const prev = store[toolName] ?? {
      count: 0,
      lastError: '',
      lastSeen: '',
      notedInMemory: false,
    };
    const updated: FailureRecord = {
      count: prev.count + 1,
      lastError: errorMessage.slice(0, 200),
      lastSeen: new Date().toISOString().slice(0, 10),
      notedInMemory: prev.notedInMemory,
    };
    store[toolName] = updated;
    saveFailures(groupFolder, store);

    logger.debug(
      { group: groupFolder, tool: toolName, count: updated.count },
      '[failure-tracker] recorded tool failure',
    );

    // Write a CLAUDE.md note the first time threshold is crossed.
    if (updated.count >= FAILURE_THRESHOLD && !prev.notedInMemory) {
      const claudeMdPath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
      const timestamp = new Date().toISOString().slice(0, 10);
      const note =
        `\n## Tool Warning (${timestamp})\n` +
        `${toolName} has failed ${updated.count} times recently. ` +
        `Last error: ${updated.lastError}. ` +
        `Consider an alternative approach or verify the tool's prerequisites.\n`;
      fs.appendFileSync(claudeMdPath, note, 'utf-8');

      store[toolName]!.notedInMemory = true;
      saveFailures(groupFolder, store);

      logger.info(
        { group: groupFolder, tool: toolName, count: updated.count },
        '[failure-tracker] wrote tool failure warning to CLAUDE.md',
      );
    }
  } catch (err) {
    // Non-critical — never block the main flow.
    logger.debug({ err }, '[failure-tracker] error recording failure');
  }
}

/**
 * Reset failure count on success so the model isn't warned about stale issues.
 */
export function resetToolFailure(groupFolder: string, toolName: string): void {
  try {
    const store = loadFailures(groupFolder);
    if (toolName in store) {
      delete store[toolName];
      saveFailures(groupFolder, store);
    }
  } catch {
    // non-critical
  }
}
