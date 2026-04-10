/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    script: z.string().optional().describe('Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    script: z.string().optional().describe('New script for the task. Set to empty string to remove the script.'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Henry")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'save_skill',
  `Save a reusable skill to your personal skills library. Skills are Markdown files that teach you how to handle recurring tasks or workflows.

Use this when:
- You just solved a complex multi-step problem and want to remember the approach
- The user taught you a preferred workflow or process
- You completed a task with a pattern worth reusing (e.g. "how to deploy this project", "how to query this API")

Saved skills persist across sessions and are automatically loaded. They appear under the "user" skill category.
To update an existing skill, save with the same name — it will be overwritten.`,
  {
    name: z.string().describe('Short skill name using lowercase-with-hyphens (e.g. "deploy-backend", "query-clickhouse"). This becomes the skill directory name.'),
    description: z.string().describe('One-line description of what this skill does, shown in the skills index.'),
    content: z.string().describe('The skill body in Markdown. Describe the workflow, steps, commands, and context clearly so future sessions can follow it.'),
    allowed_tools: z.array(z.string()).optional().describe('Tools this skill uses (e.g. ["Bash", "Read", "Write"]). Defaults to common tools if omitted.'),
    draft: z.boolean().optional().describe('Mark as draft if the skill needs review before relying on it (default: false).'),
  },
  async (args) => {
    // Sanitize name: lowercase, hyphens only, no path traversal
    const safeName = args.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    if (!safeName) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid skill name. Use lowercase letters, numbers, and hyphens.' }],
        isError: true,
      };
    }

    const skillDir = `/home/node/.claude/skills/user/${safeName}`;
    const skillFile = `${skillDir}/SKILL.md`;

    try {
      fs.mkdirSync(skillDir, { recursive: true });

      const tools = args.allowed_tools ?? ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
      const toolsYaml = JSON.stringify(tools);
      const draftLine = args.draft ? '\ndraft: true' : '';
      const frontmatter = `---\nname: ${safeName}\ndescription: ${args.description}${draftLine}\nallowed-tools: ${toolsYaml}\ncreated-by: agent\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n`;

      fs.writeFileSync(skillFile, frontmatter + args.content);

      const status = args.draft ? ' (saved as draft — review before relying on it)' : '';
      return {
        content: [{
          type: 'text' as const,
          text: `Skill "${safeName}" saved to skills/user/${safeName}/SKILL.md${status}.\n\nYou can invoke it in future sessions with /${safeName}.`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to save skill: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'search_conversations',
  `Search through archived past conversations and session summaries to recall previous discussions, decisions, or shared information.

Searches three sources:
- Archived conversations (/workspace/group/conversations/*.md)
- Structured summaries (/workspace/group/summaries/*.md)
- Claude Code session index (session titles and first prompts)

Use this when the user refers to something discussed previously, asks "do you remember...", or when context from a past session would be helpful.`,
  {
    query: z.string().describe('Keywords or phrases to search for in past conversations'),
    max_results: z.number().optional().describe('Maximum number of results to return (default: 5)'),
  },
  async (args) => {
    const maxResults = args.max_results ?? 5;
    const terms = args.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (terms.length === 0) {
      return { content: [{ type: 'text' as const, text: 'Please provide search terms.' }] };
    }

    interface SearchResult {
      source: string;
      file: string;
      excerpt: string;
      score: number;
    }
    const results: SearchResult[] = [];

    // Search markdown archives: conversations/ and summaries/
    const searchDirs = [
      '/workspace/group/conversations',
      '/workspace/group/summaries',
    ];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const dirLabel = dir.endsWith('summaries') ? 'summary' : 'conversation';

      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse(); // most recent first

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          const lower = content.toLowerCase();
          const score = terms.filter((t) => lower.includes(t)).length;
          if (score === 0) continue;

          // Collect lines around each match (up to 3 snippets)
          const lines = content.split('\n');
          const snippets: string[] = [];
          for (let i = 0; i < lines.length && snippets.length < 3; i++) {
            if (terms.some((t) => lines[i].toLowerCase().includes(t))) {
              const start = Math.max(0, i - 1);
              const end = Math.min(lines.length - 1, i + 3);
              snippets.push(lines.slice(start, end + 1).join('\n'));
            }
          }

          results.push({
            source: dirLabel,
            file,
            excerpt: snippets.join('\n...\n'),
            score,
          });
        } catch {
          // skip unreadable files
        }
      }
    }

    // Search Claude Code sessions-index.json files
    const claudeProjectsBase = '/home/node/.claude/projects';
    if (fs.existsSync(claudeProjectsBase)) {
      for (const projectDir of fs.readdirSync(claudeProjectsBase)) {
        const indexPath = path.join(claudeProjectsBase, projectDir, 'sessions-index.json');
        if (!fs.existsSync(indexPath)) continue;
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
            entries?: Array<{ sessionId: string; summary?: string; firstPrompt?: string }>;
          };
          for (const entry of index.entries ?? []) {
            const text = [entry.summary, entry.firstPrompt].filter(Boolean).join(' ');
            const lower = text.toLowerCase();
            const score = terms.filter((t) => lower.includes(t)).length;
            if (score === 0) continue;
            results.push({
              source: 'session',
              file: `session:${entry.sessionId.slice(0, 8)}`,
              excerpt: [entry.summary && `Summary: ${entry.summary}`, entry.firstPrompt && `First message: ${entry.firstPrompt.slice(0, 300)}`]
                .filter(Boolean)
                .join('\n'),
              score,
            });
          }
        } catch {
          // skip malformed index
        }
      }
    }

    if (results.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No past conversations found matching: "${args.query}"\n\nConversation archives are created automatically when context is compacted. If this is a new setup, there may not be any archives yet.`,
        }],
      };
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, maxResults);

    const output = top
      .map((r) => `### [${r.source}] ${r.file}\n${r.excerpt}`)
      .join('\n\n---\n\n');

    return {
      content: [{
        type: 'text' as const,
        text: `Found ${results.length} match(es) for "${args.query}" (showing top ${top.length}):\n\n${output}`,
      }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
