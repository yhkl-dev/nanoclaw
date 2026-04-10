import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import { execFile } from 'child_process';

import { PROJECT_ROOT, TIMEZONE } from './config.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  applyPendingEdits,
  clearPendingEdits,
  loadPendingEdits,
  recordPendingEdit,
} from './pending-edits.js';
import { RegisteredGroup } from './types.js';
import { IpcDeps } from './ipc.js';

export interface TaskIpcData {
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
}

export async function processTaskIpc(
  data: TaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      handleScheduleTask(data, sourceGroup, isMain, registeredGroups, deps);
      break;

    case 'pause_task':
      handleSimpleTaskAction(
        data,
        sourceGroup,
        isMain,
        deps,
        'paused',
        'paused',
      );
      break;

    case 'resume_task':
      handleSimpleTaskAction(
        data,
        sourceGroup,
        isMain,
        deps,
        'active',
        'resumed',
      );
      break;

    case 'cancel_task':
      handleCancelTask(data, sourceGroup, isMain, deps);
      break;

    case 'update_task':
      handleUpdateTask(data, sourceGroup, isMain, deps);
      break;

    case 'refresh_groups':
      await handleRefreshGroups(sourceGroup, isMain, registeredGroups, deps);
      break;

    case 'register_group':
      handleRegisterGroup(data, sourceGroup, isMain, registeredGroups, deps);
      break;

    case 'propose_edit':
      await handleProposeEdit(data, sourceGroup, isMain, deps);
      break;

    case 'apply_edit':
      await handleApplyEdit(sourceGroup, isMain, deps);
      break;

    case 'reject_edit':
      await handleRejectEdit(sourceGroup, isMain, deps);
      break;

    case 'apply_and_restart':
      await handleApplyAndRestart(sourceGroup, isMain, deps);
      break;

    case 'ping':
      await handlePing(sourceGroup, isMain, deps);
      break;

    case 'restart_service':
      await handleRestartService(sourceGroup, isMain, deps);
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

// --- Individual handlers ---

function handleScheduleTask(
  data: TaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): void {
  if (
    !data.prompt ||
    !data.schedule_type ||
    !data.schedule_value ||
    !data.targetJid
  )
    return;

  const targetJid = data.targetJid;
  const targetGroupEntry = registeredGroups[targetJid];
  if (!targetGroupEntry) {
    logger.warn(
      { targetJid },
      'Cannot schedule task: target group not registered',
    );
    return;
  }

  const targetFolder = targetGroupEntry.folder;
  if (!isMain && targetFolder !== sourceGroup) {
    logger.warn(
      { sourceGroup, targetFolder },
      'Unauthorized schedule_task attempt blocked',
    );
    return;
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
      return;
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(data.schedule_value, 10);
    if (isNaN(ms) || ms <= 0) {
      logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
      return;
    }
    nextRun = new Date(Date.now() + ms).toISOString();
  } else if (scheduleType === 'once') {
    const date = new Date(data.schedule_value);
    if (isNaN(date.getTime())) {
      logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
      return;
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

function handleSimpleTaskAction(
  data: TaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  newStatus: 'active' | 'paused' | 'completed',
  actionLabel: string,
): void {
  if (!data.taskId) return;
  const task = getTaskById(data.taskId);
  if (task && (isMain || task.group_folder === sourceGroup)) {
    updateTask(data.taskId, { status: newStatus });
    logger.info(
      { taskId: data.taskId, sourceGroup },
      `Task ${actionLabel} via IPC`,
    );
    deps.onTasksChanged();
  } else {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      `Unauthorized task ${actionLabel} attempt`,
    );
  }
}

function handleCancelTask(
  data: TaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  if (!data.taskId) return;
  const task = getTaskById(data.taskId);
  if (task && (isMain || task.group_folder === sourceGroup)) {
    deleteTask(data.taskId);
    logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
    deps.onTasksChanged();
  } else {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Unauthorized task cancel attempt',
    );
  }
}

function handleUpdateTask(
  data: TaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  if (!data.taskId) return;
  const task = getTaskById(data.taskId);
  if (!task) {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Task not found for update',
    );
    return;
  }
  if (!isMain && task.group_folder !== sourceGroup) {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Unauthorized task update attempt',
    );
    return;
  }

  const updates: Parameters<typeof updateTask>[1] = {};
  if (data.prompt !== undefined) updates.prompt = data.prompt;
  if (data.script !== undefined) updates.script = data.script || null;
  if (data.schedule_type !== undefined)
    updates.schedule_type = data.schedule_type as 'cron' | 'interval' | 'once';
  if (data.schedule_value !== undefined)
    updates.schedule_value = data.schedule_value;

  if (data.schedule_type || data.schedule_value) {
    const updatedTask = { ...task, ...updates };
    if (updatedTask.schedule_type === 'cron') {
      try {
        const interval = CronExpressionParser.parse(
          updatedTask.schedule_value,
          {
            tz: TIMEZONE,
          },
        );
        updates.next_run = interval.next().toISOString();
      } catch {
        logger.warn(
          { taskId: data.taskId, value: updatedTask.schedule_value },
          'Invalid cron in task update',
        );
        return;
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

async function handleRefreshGroups(
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
    return;
  }
  logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
  await deps.syncGroups(true);
  const availableGroups = deps.getAvailableGroups();
  deps.writeGroupsSnapshot(
    sourceGroup,
    true,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );
}

function handleRegisterGroup(
  data: TaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): void {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
    return;
  }
  if (!data.jid || !data.name || !data.folder || !data.trigger) {
    logger.warn(
      { data },
      'Invalid register_group request - missing required fields',
    );
    return;
  }
  if (!isValidGroupFolder(data.folder)) {
    logger.warn(
      { sourceGroup, folder: data.folder },
      'Invalid register_group request - unsafe folder name',
    );
    return;
  }
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
}

async function handleProposeEdit(
  data: TaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized propose_edit attempt blocked');
    return;
  }

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
    return;
  }

  if (filesToPropose.length === 0) return;

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
}

async function handleApplyEdit(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized apply_edit attempt blocked');
    return;
  }
  const pending = loadPendingEdits(sourceGroup);
  if (pending.length === 0) {
    await deps.notifyMainGroup('No pending edits to apply.');
    return;
  }
  const result = await applyPendingEdits(sourceGroup);
  if (!result.buildSuccess) {
    await deps.notifyMainGroup(
      `Build check failed — edits reverted.\n\n\`\`\`\n${result.buildOutput.slice(0, 2000)}\n\`\`\``,
    );
    return;
  }
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
            .catch((e) =>
              logger.warn({ err: e }, 'Failed to notify build failure'),
            );
        } else {
          const applied = result.applied.join(', ');
          deps
            .notifyMainGroup(
              `Edits applied and built successfully.\nFiles: ${applied}\n\nRestart the service to load the new code.`,
            )
            .catch((e) =>
              logger.warn({ err: e }, 'Failed to notify build success'),
            );
        }
        resolve();
      },
    );
  });
  logger.info({ sourceGroup, applied: result.applied }, 'apply_edit completed');
}

async function handleRejectEdit(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized reject_edit attempt blocked');
    return;
  }
  const pending = loadPendingEdits(sourceGroup);
  if (pending.length === 0) {
    await deps.notifyMainGroup('No pending edits to reject.');
    return;
  }
  clearPendingEdits(sourceGroup);
  logger.info({ sourceGroup }, 'reject_edit: pending edits cleared');
  await deps.notifyMainGroup(
    `Pending edits discarded (${pending.length} file(s)).`,
  );
}

async function handleApplyAndRestart(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'Unauthorized apply_and_restart attempt blocked',
    );
    return;
  }
  const pending = loadPendingEdits(sourceGroup);
  if (pending.length === 0) {
    await deps.notifyMainGroup('No pending edits to apply.');
    return;
  }
  const applyResult = await applyPendingEdits(sourceGroup);
  if (!applyResult.buildSuccess) {
    await deps.notifyMainGroup(
      `Typecheck failed — edits reverted.\n\`\`\`\n${applyResult.buildOutput.slice(0, 2000)}\n\`\`\``,
    );
    return;
  }
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
            .catch((e) =>
              logger.warn({ err: e }, 'Failed to notify build failure'),
            );
          resolve(false);
        } else {
          resolve(true);
        }
      },
    );
  });
  if (!buildOk) return;

  const restartCmd = buildRestartCommand();
  const applied = applyResult.applied.join(', ');
  logger.info(
    { sourceGroup, applied },
    'apply_and_restart: build ok, restarting',
  );
  await deps.notifyMainGroup(
    `Edits applied (${applied}), build succeeded. Restarting…`,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  execFile(restartCmd[0], restartCmd.slice(1), { timeout: 15_000 }, (err) => {
    if (err) logger.error({ err }, 'apply_and_restart: restart failed');
  });
}

async function handlePing(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized ping attempt blocked');
    return;
  }
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

async function handleRestartService(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'Unauthorized restart_service attempt blocked',
    );
    return;
  }
  const cmd = buildRestartCommand();
  logger.info({ sourceGroup, cmd }, 'restart_service: restarting');
  await deps.notifyMainGroup('Restarting service…');
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  execFile(cmd[0], cmd.slice(1), { timeout: 15_000 }, (err) => {
    if (err) logger.error({ err }, 'restart_service: restart command failed');
  });
}

function buildRestartCommand(): string[] {
  return process.platform === 'darwin'
    ? ['launchctl', 'kickstart', '-k', `gui/${process.getuid!()}/com.nanoclaw`]
    : ['systemctl', '--user', 'restart', 'nanoclaw'];
}
