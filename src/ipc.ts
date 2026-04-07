import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { execFile } from 'child_process';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  PROJECT_ROOT,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  applyPendingEdits,
  clearPendingEdits,
  formatPendingEditsSummary,
  loadPendingEdits,
  recordPendingEdit,
} from './pending-edits.js';
import { RegisteredGroup } from './types.js';

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

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
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

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For propose_edit / apply_edit
    filePath?: string;
    description?: string;
    newContent?: string;
    // Multi-file propose_edit
    files?: Array<{
      filePath: string;
      newContent: string;
      description?: string;
    }>;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'propose_edit': {
      // Only the main group can propose code edits.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized propose_edit attempt blocked',
        );
        break;
      }

      // Build a normalized list of files to propose (supports single or multi-file).
      const filesToPropose: Array<{
        filePath: string;
        newContent: string;
        description: string;
      }> = [];

      if (data.files && data.files.length > 0) {
        for (const f of data.files) {
          if (!f.filePath || !f.newContent) {
            logger.warn(
              { sourceGroup, file: f.filePath },
              'propose_edit: skipping entry missing filePath or newContent',
            );
            continue;
          }
          filesToPropose.push({
            filePath: f.filePath,
            newContent: f.newContent,
            description: f.description ?? '',
          });
        }
      } else if (data.filePath && data.newContent) {
        filesToPropose.push({
          filePath: data.filePath,
          newContent: data.newContent,
          description: data.description ?? '',
        });
      } else {
        logger.warn(
          { sourceGroup },
          'propose_edit missing filePath/newContent or files array',
        );
        break;
      }

      if (filesToPropose.length === 0) break;

      const sections: string[] = [];
      let lastId = '';
      for (const f of filesToPropose) {
        const { id, diff, isNewFile } = recordPendingEdit(
          sourceGroup,
          f.filePath,
          f.description,
          f.newContent,
        );
        lastId = id;
        const header = isNewFile
          ? `New file: ${f.filePath}`
          : `Changes to ${f.filePath}:\n\`\`\`diff\n${diff.slice(0, 2000)}\n\`\`\``;
        sections.push(`${header}\nDescription: ${f.description || '(none)'}`);
      }

      const msg =
        `[Code change proposed — ${filesToPropose.length} file(s), last ID: ${lastId}]\n\n` +
        sections.join('\n\n---\n\n') +
        `\n\nReply "apply edits" to apply and build, or "reject edits" to discard.`;
      logger.info(
        { sourceGroup, files: filesToPropose.map((f) => f.filePath), lastId },
        'propose_edit recorded, notifying main group',
      );
      await deps.notifyMainGroup(msg);
      break;
    }

    case 'apply_edit':
      // Only the main group can apply edits.
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized apply_edit attempt blocked');
        break;
      }
      {
        const pending = loadPendingEdits(sourceGroup);
        if (pending.length === 0) {
          await deps.notifyMainGroup('No pending edits to apply.');
          break;
        }
        const result = await applyPendingEdits(sourceGroup);
        if (!result.buildSuccess) {
          const msg =
            `Build check failed — edits reverted.\n\n` +
            `\`\`\`\n${result.buildOutput.slice(0, 2000)}\n\`\`\``;
          await deps.notifyMainGroup(msg);
          break;
        }
        // Type-check passed; run the full build to emit JS.
        await new Promise<void>((resolve) => {
          execFile(
            'npm',
            ['run', 'build'],
            { cwd: PROJECT_ROOT, timeout: 120_000 },
            (err, stdout, stderr) => {
              if (err) {
                const out = (stderr || stdout || String(err)).slice(0, 2000);
                deps
                  .notifyMainGroup(
                    `Full build failed — dist/ not updated.\n\`\`\`\n${out}\n\`\`\``,
                  )
                  .catch(() => {});
              } else {
                const applied = result.applied.join(', ');
                deps
                  .notifyMainGroup(
                    `Edits applied and built successfully.\nFiles: ${applied}\n\nRestart the service to load the new code.`,
                  )
                  .catch(() => {});
              }
              resolve();
            },
          );
        });
        logger.info(
          { sourceGroup, applied: result.applied },
          'apply_edit completed',
        );
      }
      break;

    case 'reject_edit':
      // Only the main group can reject edits.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized reject_edit attempt blocked',
        );
        break;
      }
      {
        const pending = loadPendingEdits(sourceGroup);
        if (pending.length === 0) {
          await deps.notifyMainGroup('No pending edits to reject.');
          break;
        }
        clearPendingEdits(sourceGroup);
        logger.info({ sourceGroup }, 'reject_edit: pending edits cleared');
        await deps.notifyMainGroup(
          `Pending edits discarded (${pending.length} file(s)).`,
        );
      }
      break;

    case 'apply_and_restart':
      // Apply pending edits, build, and restart in one step. Main group only.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized apply_and_restart attempt blocked',
        );
        break;
      }
      {
        const pending = loadPendingEdits(sourceGroup);
        if (pending.length === 0) {
          await deps.notifyMainGroup('No pending edits to apply.');
          break;
        }
        const applyResult = await applyPendingEdits(sourceGroup);
        if (!applyResult.buildSuccess) {
          await deps.notifyMainGroup(
            `Typecheck failed — edits reverted.\n\`\`\`\n${applyResult.buildOutput.slice(0, 2000)}\n\`\`\``,
          );
          break;
        }
        // Full build
        const buildOk = await new Promise<boolean>((resolve) => {
          execFile(
            'npm',
            ['run', 'build'],
            { cwd: PROJECT_ROOT, timeout: 120_000 },
            (err, stdout, stderr) => {
              if (err) {
                const out = (stderr || stdout || String(err)).slice(0, 2000);
                deps
                  .notifyMainGroup(
                    `Build failed — dist/ not updated.\n\`\`\`\n${out}\n\`\`\``,
                  )
                  .catch(() => {});
                resolve(false);
              } else {
                resolve(true);
              }
            },
          );
        });
        if (!buildOk) break;
        // Restart
        const isMacAR = process.platform === 'darwin';
        const restartCmd = isMacAR
          ? [
              'launchctl',
              'kickstart',
              '-k',
              `gui/${process.getuid!()}/com.nanoclaw`,
            ]
          : ['systemctl', '--user', 'restart', 'nanoclaw'];
        const applied = applyResult.applied.join(', ');
        logger.info(
          { sourceGroup, applied },
          'apply_and_restart: build ok, restarting',
        );
        await deps.notifyMainGroup(
          `Edits applied (${applied}), build succeeded. Restarting…`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        execFile(
          restartCmd[0],
          restartCmd.slice(1),
          { timeout: 15_000 },
          (err) => {
            if (err) logger.error({ err }, 'apply_and_restart: restart failed');
          },
        );
      }
      break;

    case 'ping':
      // Health check — main group only.
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized ping attempt blocked');
        break;
      }
      {
        const uptimeSec = Math.floor(process.uptime());
        const h = Math.floor(uptimeSec / 3600);
        const m = Math.floor((uptimeSec % 3600) / 60);
        const s = uptimeSec % 60;
        const uptimeStr = `${h}h ${m}m ${s}s`;
        let version = 'unknown';
        try {
          const pkg = JSON.parse(
            fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
          ) as { version: string };
          version = pkg.version;
        } catch {}
        await deps.notifyMainGroup(
          `pong\nversion: ${version}\nuptime: ${uptimeStr}\ntime: ${new Date().toISOString()}`,
        );
      }
      break;

    case 'restart_service':
      // Only the main group can restart the service.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized restart_service attempt blocked',
        );
        break;
      }
      {
        const isMac = process.platform === 'darwin';
        const cmd = isMac
          ? [
              'launchctl',
              'kickstart',
              '-k',
              `gui/${process.getuid!()}/com.nanoclaw`,
            ]
          : ['systemctl', '--user', 'restart', 'nanoclaw'];
        logger.info({ sourceGroup, cmd }, 'restart_service: restarting');
        await deps.notifyMainGroup('Restarting service…');
        // Small delay so the message is delivered before the process exits.
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        execFile(cmd[0], cmd.slice(1), { timeout: 15_000 }, (err) => {
          if (err) {
            logger.error({ err }, 'restart_service: restart command failed');
          }
        });
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
