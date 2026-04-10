import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

import { processTaskIpc } from './ipc-task-handlers.js';

// Re-export processTaskIpc for callers that import from ipc.ts
export { processTaskIpc } from './ipc-task-handlers.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  notifyMainGroup: (text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Track in-flight processing to avoid concurrent runs
  let processing = false;
  let pendingRun = false;

  const processIpcFiles = async () => {
    if (processing) {
      pendingRun = true;
      return;
    }
    processing = true;
    pendingRun = false;

    try {
      await runIpcScan(ipcBaseDir, deps);
    } finally {
      processing = false;
      // If a watch event arrived while we were processing, run again immediately
      if (pendingRun) {
        pendingRun = false;
        setImmediate(processIpcFiles);
      }
    }
  };

  // Debounce helper: coalesce rapid watch events (rename + change for same file)
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleProcess = () => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      processIpcFiles().catch((err) =>
        logger.error({ err }, 'IPC process error'),
      );
    }, 50);
  };

  // fs.watch on the IPC base directory (recursive covers new group subdirs)
  const startWatcher = () => {
    try {
      const watcher = fs.watch(ipcBaseDir, { recursive: true }, () => {
        scheduleProcess();
      });
      watcher.on('error', (err) => {
        logger.warn({ err }, 'IPC fs.watch error, restarting watcher');
        watcher.close();
        setTimeout(startWatcher, 1000);
      });
      logger.debug('IPC fs.watch active');
    } catch (err) {
      logger.warn({ err }, 'IPC fs.watch failed, falling back to poll-only');
    }
  };
  startWatcher();

  // Fallback poll: catches any events fs.watch may miss (bind-mount edge cases)
  const FALLBACK_INTERVAL_MS = 10_000;
  setInterval(() => {
    processIpcFiles().catch((err) =>
      logger.error({ err }, 'IPC fallback poll error'),
    );
  }, FALLBACK_INTERVAL_MS);

  // Initial scan on startup
  processIpcFiles().catch((err) =>
    logger.error({ err }, 'IPC initial scan error'),
  );
  logger.info('IPC watcher started (fs.watch + 10s fallback)');
}

async function runIpcScan(ipcBaseDir: string, deps: IpcDeps): Promise<void> {
  // Scan all group IPC directories (identity determined by directory)
  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
      const stat = fs.statSync(path.join(ipcBaseDir, f));
      return stat.isDirectory() && f !== 'errors';
    });
  } catch (err) {
    logger.error({ err }, 'Error reading IPC base directory');
    return;
  }

  const registeredGroups = deps.registeredGroups();

  // Build folder→isMain lookup from registered groups
  const folderIsMain = new Map<string, boolean>();
  for (const group of Object.values(registeredGroups)) {
    if (group.isMain) folderIsMain.set(group.folder, true);
  }

  for (const sourceGroup of groupFolders) {
    const isMain = folderIsMain.get(sourceGroup) === true;
    const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
    const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

    // Process messages from this group's IPC directory
    try {
      if (fs.existsSync(messagesDir)) {
        const messageFiles = fs
          .readdirSync(messagesDir)
          .filter((f) => f.endsWith('.json'));
        for (const file of messageFiles) {
          const filePath = path.join(messagesDir, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (data.type === 'message' && data.chatJid && data.text) {
              // Authorization: verify this group can send to this chatJid
              const targetGroup = registeredGroups[data.chatJid];
              if (
                isMain ||
                (targetGroup && targetGroup.folder === sourceGroup)
              ) {
                await deps.sendMessage(data.chatJid, data.text);
                logger.info(
                  { chatJid: data.chatJid, sourceGroup },
                  'IPC message sent',
                );
              } else {
                logger.warn(
                  { chatJid: data.chatJid, sourceGroup },
                  'Unauthorized IPC message attempt blocked',
                );
              }
            }
            fs.unlinkSync(filePath);
          } catch (err) {
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC message',
            );
            const errorDir = path.join(ipcBaseDir, 'errors');
            fs.mkdirSync(errorDir, { recursive: true });
            fs.renameSync(
              filePath,
              path.join(errorDir, `${sourceGroup}-${file}`),
            );
          }
        }
      }
    } catch (err) {
      logger.error(
        { err, sourceGroup },
        'Error reading IPC messages directory',
      );
    }

    // Process tasks from this group's IPC directory
    try {
      if (fs.existsSync(tasksDir)) {
        const taskFiles = fs
          .readdirSync(tasksDir)
          .filter((f) => f.endsWith('.json'));
        for (const file of taskFiles) {
          const filePath = path.join(tasksDir, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            // Pass source group identity to processTaskIpc for authorization
            await processTaskIpc(data, sourceGroup, isMain, deps);
            fs.unlinkSync(filePath);
          } catch (err) {
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC task',
            );
            const errorDir = path.join(ipcBaseDir, 'errors');
            fs.mkdirSync(errorDir, { recursive: true });
            fs.renameSync(
              filePath,
              path.join(errorDir, `${sourceGroup}-${file}`),
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
    }
  }
}
