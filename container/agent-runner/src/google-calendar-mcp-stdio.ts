/**
 * Google Calendar MCP Server for NanoClaw
 * Exposes Google Calendar tools to the container agent via stdio MCP.
 * Reads OAuth2 credentials from /home/node/.gmail-mcp/ (mounted from host ~/.gmail-mcp/).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google } from 'googleapis';
import { z } from 'zod';

const CRED_DIR = path.join(os.homedir(), '.gmail-mcp');
const KEYS_PATH = path.join(CRED_DIR, 'gcp-oauth.keys.json');
const TOKENS_PATH = path.join(CRED_DIR, 'credentials.json');

function log(msg: string): void {
  console.error(`[calendar] ${msg}`);
}

function createCalendarClient() {
  if (!fs.existsSync(KEYS_PATH) || !fs.existsSync(TOKENS_PATH)) {
    throw new Error(
      'Google credentials not found in ~/.gmail-mcp/. Run /add-gmail to set up.',
    );
  }

  const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8')) as {
    installed?: { client_id: string; client_secret: string; redirect_uris?: string[] };
    web?: { client_id: string; client_secret: string; redirect_uris?: string[] };
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
  const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8')) as {
    scope?: string;
    access_token?: string;
    refresh_token?: string;
  };

  if (!tokens.scope?.includes('calendar')) {
    throw new Error(
      'Google Calendar not authorized. Re-run OAuth with calendar scope.',
    );
  }

  const clientConfig = keys.installed ?? keys.web ?? keys;
  const auth = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    clientConfig.redirect_uris?.[0],
  );
  auth.setCredentials(tokens);

  // Persist refreshed tokens back to disk.
  auth.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
      Object.assign(current, newTokens);
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(current, null, 2));
    } catch {
      // non-fatal
    }
  });

  return google.calendar({ version: 'v3', auth });
}

const server = new McpServer({ name: 'google_calendar', version: '1.0.0' });

// ── calendar_list ──────────────────────────────────────────────────────────

server.tool(
  'calendar_list',
  'List upcoming events from Google Calendar. Returns title, start/end time, location, and ID.',
  {
    days: z
      .number()
      .int()
      .optional()
      .describe('Number of days ahead to look (default 7).'),
    time_min: z
      .string()
      .optional()
      .describe('ISO 8601 start time (default: now).'),
  },
  async (args) => {
    log(`calendar_list days=${args.days ?? 7}`);
    try {
      const calendar = createCalendarClient();
      const now = new Date();
      const timeMin = args.time_min ?? now.toISOString();
      const daysAhead = args.days ?? 7;
      const timeMax = new Date(
        now.getTime() + daysAhead * 24 * 60 * 60 * 1000,
      ).toISOString();

      const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        maxResults: 20,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = (res.data.items ?? []).map((e) => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        location: e.location,
        description: e.description?.slice(0, 200),
      }));

      log(`Returned ${events.length} events`);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ events }, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ── calendar_create ────────────────────────────────────────────────────────

server.tool(
  'calendar_create',
  'Create a new event in Google Calendar.',
  {
    summary: z.string().describe('Event title.'),
    start: z
      .string()
      .describe(
        'Start time in ISO 8601 (e.g. "2024-06-01T10:00:00+08:00") or date "2024-06-01" for all-day.',
      ),
    end: z
      .string()
      .optional()
      .describe('End time (same format as start). Defaults to start.'),
    description: z.string().optional().describe('Event description.'),
    location: z.string().optional().describe('Event location.'),
  },
  async (args) => {
    log(`calendar_create summary="${args.summary}"`);
    try {
      const calendar = createCalendarClient();
      const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start);
      const end = args.end ?? args.start;

      const event = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: isAllDay ? { date: args.start } : { dateTime: args.start },
          end: isAllDay ? { date: end } : { dateTime: end },
        },
      });

      log(`Created event id=${event.data.id}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              id: event.data.id,
              link: event.data.htmlLink,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ── calendar_update ────────────────────────────────────────────────────────

server.tool(
  'calendar_update',
  'Update an existing Google Calendar event. Only provided fields are changed.',
  {
    id: z.string().describe('Event ID from calendar_list.'),
    summary: z.string().optional().describe('New event title.'),
    start: z
      .string()
      .optional()
      .describe('New start time (ISO 8601 or date string).'),
    end: z
      .string()
      .optional()
      .describe('New end time (ISO 8601 or date string).'),
    description: z.string().optional().describe('New description.'),
    location: z.string().optional().describe('New location.'),
  },
  async (args) => {
    log(`calendar_update id=${args.id}`);
    try {
      const calendar = createCalendarClient();
      const patch: Record<string, unknown> = {};

      if (args.summary !== undefined) patch.summary = args.summary;
      if (args.description !== undefined) patch.description = args.description;
      if (args.location !== undefined) patch.location = args.location;

      if (args.start !== undefined) {
        const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start);
        patch.start = isAllDay
          ? { date: args.start }
          : { dateTime: args.start };
      }
      if (args.end !== undefined) {
        const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.end);
        patch.end = isAllDay ? { date: args.end } : { dateTime: args.end };
      }

      const updated = await calendar.events.patch({
        calendarId: 'primary',
        eventId: args.id,
        requestBody: patch,
      });

      log(`Updated event id=${updated.data.id}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              id: updated.data.id,
              link: updated.data.htmlLink,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ── calendar_delete ────────────────────────────────────────────────────────

server.tool(
  'calendar_delete',
  'Delete an event from Google Calendar by its ID.',
  {
    id: z.string().describe('Event ID from calendar_list.'),
  },
  async (args) => {
    log(`calendar_delete id=${args.id}`);
    try {
      const calendar = createCalendarClient();
      await calendar.events.delete({
        calendarId: 'primary',
        eventId: args.id,
      });
      log(`Deleted event id=${args.id}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

log('Google Calendar MCP server starting...');
const transport = new StdioServerTransport();
await server.connect(transport);
