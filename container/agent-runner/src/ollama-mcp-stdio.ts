/**
 * Ollama MCP Server for NanoClaw
 * Exposes local Ollama models as tools for the container agent.
 */

import fs from 'fs';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const OLLAMA_ADMIN_TOOLS = process.env.OLLAMA_ADMIN_TOOLS === 'true';
const OLLAMA_STATUS_FILE = '/workspace/ipc/ollama_status.json';
const OLLAMA_DEFAULT_TIMEOUT_MS = 30_000;
const OLLAMA_GENERATE_TIMEOUT_MS = 10 * 60_000;
const OLLAMA_PULL_TIMEOUT_MS = 30 * 60_000;

function log(msg: string): void {
  console.error(`[OLLAMA] ${msg}`);
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${OLLAMA_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(OLLAMA_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, OLLAMA_STATUS_FILE);
  } catch {
    // Best-effort status reporting only.
  }
}

async function ollamaFetch(
  apiPath: string,
  options?: RequestInit,
  timeoutMs = OLLAMA_DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${OLLAMA_HOST}${apiPath}`, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const server = new McpServer({
  name: 'ollama',
  version: '1.0.0',
});

server.tool(
  'ollama_list_models',
  'List all locally installed Ollama models. Use this before calling ollama_generate.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing available models');
    try {
      const res = await ollamaFetch('/api/tags');
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `Ollama API error: ${res.status} ${res.statusText}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        models?: Array<{ name: string; size: number }>;
      };
      const models = data.models || [];

      if (models.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No models installed. Run `ollama pull <model>` on the host to install one.' }],
        };
      }

      const list = models
        .map((model) => `- ${model.name} (${(model.size / 1e9).toFixed(1)}GB)`)
        .join('\n');

      log(`Found ${models.length} models`);
      return { content: [{ type: 'text' as const, text: `Installed models:\n${list}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to Ollama at ${OLLAMA_HOST}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_generate',
  'Send a prompt to a local Ollama model and get a response.',
  {
    model: z.string().describe('The model name, e.g. "llama3.2" or "qwen2.5-coder"'),
    prompt: z.string().describe('The prompt to send to the model'),
    system: z.string().optional().describe('Optional system prompt'),
  },
  async (args) => {
    log(`>>> Generating with ${args.model} (${args.prompt.length} chars)...`);
    writeStatus('generating', `Generating with ${args.model}`);
    try {
      const body: Record<string, unknown> = {
        model: args.model,
        prompt: args.prompt,
        stream: false,
      };
      if (args.system) body.system = args.system;

      const res = await ollamaFetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, OLLAMA_GENERATE_TIMEOUT_MS);

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        response: string;
        total_duration?: number;
        eval_count?: number;
      };

      let meta = '';
      if (data.total_duration) {
        const secs = (data.total_duration / 1e9).toFixed(1);
        meta = `\n\n[${args.model} | ${secs}s${data.eval_count ? ` | ${data.eval_count} tokens` : ''}]`;
        log(`<<< Done: ${args.model} | ${secs}s | ${data.eval_count || '?'} tokens | ${data.response.length} chars`);
        writeStatus('done', `${args.model} | ${secs}s | ${data.eval_count || '?'} tokens`);
      } else {
        log(`<<< Done: ${args.model} | ${data.response.length} chars`);
        writeStatus('done', `${args.model} | ${data.response.length} chars`);
      }

      return { content: [{ type: 'text' as const, text: data.response + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to call Ollama: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

if (OLLAMA_ADMIN_TOOLS) {
  server.tool(
    'ollama_pull_model',
    'Pull a model from the Ollama registry by name.',
    {
      model: z.string().describe('Model name to pull'),
    },
    async (args) => {
      log(`Pulling model: ${args.model}...`);
      writeStatus('pulling', `Pulling ${args.model}`);
      try {
        const res = await ollamaFetch('/api/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model, stream: false }),
        }, OLLAMA_PULL_TIMEOUT_MS);
        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${errorText}` }],
            isError: true,
          };
        }
        const data = await res.json() as { status: string };
        log(`Pull complete: ${args.model} — ${data.status}`);
        writeStatus('done', `Pulled ${args.model}`);
        return { content: [{ type: 'text' as const, text: `Pull complete: ${args.model} — ${data.status}` }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to pull model: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_delete_model',
    'Delete a locally installed Ollama model.',
    {
      model: z.string().describe('Model name to delete'),
    },
    async (args) => {
      log(`Deleting model: ${args.model}...`);
      writeStatus('deleting', `Deleting ${args.model}`);
      try {
        const res = await ollamaFetch('/api/delete', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model }),
        });
        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${errorText}` }],
            isError: true,
          };
        }
        log(`Deleted: ${args.model}`);
        writeStatus('done', `Deleted ${args.model}`);
        return { content: [{ type: 'text' as const, text: `Deleted model: ${args.model}` }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to delete model: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_show_model',
    'Show details for a locally installed Ollama model.',
    {
      model: z.string().describe('Model name to inspect'),
    },
    async (args) => {
      log(`Showing model info: ${args.model}...`);
      try {
        const res = await ollamaFetch('/api/show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model }),
        });
        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${errorText}` }],
            isError: true,
          };
        }
        const data = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to show model info: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_list_running',
    'List Ollama models currently loaded in memory.',
    {},
    async () => {
      log('Listing running models...');
      try {
        const res = await ollamaFetch('/api/ps');
        if (!res.ok) {
          return {
            content: [{ type: 'text' as const, text: `Ollama API error: ${res.status} ${res.statusText}` }],
            isError: true,
          };
        }
        const data = await res.json() as {
          models?: Array<{
            name: string;
            size: number;
            size_vram: number;
            processor: string;
            expires_at: string;
          }>;
        };
        const models = data.models || [];
        if (models.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No models currently loaded in memory.' }] };
        }

        const list = models
          .map((model) => {
            const size = model.size_vram > 0 ? model.size_vram : model.size;
            return `- ${model.name} (${(size / 1e9).toFixed(1)}GB ${model.processor}, unloads at ${model.expires_at})`;
          })
          .join('\n');

        log(`${models.length} model(s) running`);
        return { content: [{ type: 'text' as const, text: `Models loaded in memory:\n${list}` }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list running models: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  log('Admin tools enabled (pull, delete, show, list-running)');
}

const transport = new StdioServerTransport();
await server.connect(transport);
