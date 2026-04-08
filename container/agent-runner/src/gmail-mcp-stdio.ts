/**
 * Gmail MCP Server for NanoClaw
 * Exposes core Gmail tools to the container agent via stdio MCP.
 * Reads OAuth2 credentials from /home/node/.gmail-mcp/ (mounted from host ~/.gmail-mcp/).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google, gmail_v1 } from 'googleapis';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { z } from 'zod';

const CRED_DIR = path.join(os.homedir(), '.gmail-mcp');
const KEYS_PATH = path.join(CRED_DIR, 'gcp-oauth.keys.json');
const TOKENS_PATH = path.join(CRED_DIR, 'credentials.json');
const OUTBOUND_HTTPS_PROXY =
  process.env.HTTPS_PROXY ?? process.env.https_proxy ?? undefined;

function log(msg: string): void {
  console.error(`[gmail] ${msg}`);
}

type OAuthKeys = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  client_id?: string;
  client_secret?: string;
  redirect_uris?: string[];
};

type OAuthTokens = {
  scope?: string;
  access_token?: string;
  refresh_token?: string;
};

function hasAnyGmailScope(scopeValue: string | undefined): boolean {
  if (!scopeValue) return false;
  return [
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.labels',
    'https://www.googleapis.com/auth/gmail.metadata',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
  ].some((scope) => scopeValue.includes(scope));
}

function hasGmailWriteScope(scopeValue: string | undefined): boolean {
  if (!scopeValue) return false;
  return [
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
  ].some((scope) => scopeValue.includes(scope));
}

function createGmailClient(): { gmail: gmail_v1.Gmail; scope?: string } {
  if (!fs.existsSync(KEYS_PATH) || !fs.existsSync(TOKENS_PATH)) {
    throw new Error(
      'Google credentials not found in ~/.gmail-mcp/. Run /add-gmail to set up.',
    );
  }

  const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8')) as OAuthKeys;
  const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8')) as OAuthTokens;

  if (!hasAnyGmailScope(tokens.scope)) {
    throw new Error(
      'Gmail is not authorized in ~/.gmail-mcp/credentials.json. Re-run /add-gmail authorization.',
    );
  }

  const clientConfig = keys.installed ?? keys.web ?? keys;
  const auth = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    clientConfig.redirect_uris?.[0],
  );
  auth.setCredentials(tokens);

  if (OUTBOUND_HTTPS_PROXY) {
    const agent = new HttpsProxyAgent(OUTBOUND_HTTPS_PROXY);
    auth.transporter.defaults = {
      ...auth.transporter.defaults,
      agent,
    };
  }

  auth.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
      Object.assign(current, newTokens);
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(current, null, 2));
    } catch {
      // non-fatal
    }
  });

  return {
    gmail: google.gmail({ version: 'v1', auth }),
    scope: tokens.scope,
  };
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  const value = headers?.find(
    (header) => header.name?.toLowerCase() === name.toLowerCase(),
  )?.value;
  return value ?? undefined;
}

function decodeBody(data: string | null | undefined): string {
  if (!data) return '';
  return Buffer.from(data, 'base64').toString('utf-8');
}

function extractTextBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBody(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const nested = extractTextBody(part);
      if (nested) return nested;
    }
  }

  if (payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  return '';
}

function summarizeMessage(msg: gmail_v1.Schema$Message) {
  const headers = msg.payload?.headers;
  return {
    id: msg.id,
    threadId: msg.threadId,
    messageIdHeader: getHeader(headers, 'Message-ID'),
    referencesHeader: getHeader(headers, 'References'),
    snippet: msg.snippet,
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
    date: getHeader(headers, 'Date'),
    labelIds: msg.labelIds ?? [],
  };
}

function attachmentSummary(
  payload: gmail_v1.Schema$MessagePart | undefined,
): Array<{ filename: string; mimeType?: string; attachmentId?: string; size?: number }> {
  if (!payload) return [];
  const items: Array<{
    filename: string;
    mimeType?: string;
    attachmentId?: string;
    size?: number;
  }> = [];

  if (payload.filename) {
    items.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? undefined,
      attachmentId: payload.body?.attachmentId ?? undefined,
      size: payload.body?.size ?? undefined,
    });
  }

  for (const part of payload.parts ?? []) {
    items.push(...attachmentSummary(part));
  }

  return items;
}

function sanitizeHeaderValue(value: string, fieldName: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${fieldName} must not contain CR or LF characters.`);
  }
  return value.trim();
}

function sanitizeHeaderList(values: string[] | undefined, fieldName: string): string[] | undefined {
  return values?.map((value) => sanitizeHeaderValue(value, fieldName));
}

function encodeRawEmail(input: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  inReplyTo?: string;
  references?: string;
}): string {
  const to = sanitizeHeaderList(input.to, 'To') ?? [];
  const cc = sanitizeHeaderList(input.cc, 'Cc');
  const bcc = sanitizeHeaderList(input.bcc, 'Bcc');
  const subject = sanitizeHeaderValue(input.subject, 'Subject');
  const inReplyTo = input.inReplyTo
    ? sanitizeHeaderValue(input.inReplyTo, 'In-Reply-To')
    : undefined;
  const references = input.references
    ? sanitizeHeaderValue(input.references, 'References')
    : undefined;
  const headers = [
    `To: ${to.join(', ')}`,
    cc && cc.length > 0 ? `Cc: ${cc.join(', ')}` : undefined,
    bcc && bcc.length > 0 ? `Bcc: ${bcc.join(', ')}` : undefined,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : undefined,
    references ? `References: ${references}` : undefined,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.body,
  ]
    .filter(Boolean)
    .join('\r\n');

  return Buffer.from(headers)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const server = new McpServer({ name: 'gmail', version: '1.0.0' });

server.tool(
  'send_email',
  'Send a plain-text Gmail message immediately.',
  {
    to: z.array(z.string()).min(1).describe('Recipient email addresses.'),
    subject: z.string().describe('Email subject line.'),
    body: z.string().describe('Plain-text email body.'),
    cc: z.array(z.string()).optional().describe('Optional CC recipients.'),
    bcc: z.array(z.string()).optional().describe('Optional BCC recipients.'),
    threadId: z.string().optional().describe('Optional Gmail thread ID to reply within.'),
    inReplyTo: z
      .string()
      .optional()
      .describe('Optional RFC 2822 Message-ID for threaded replies.'),
    references: z
      .string()
      .optional()
      .describe('Optional References header for threaded replies.'),
  },
  async (args) => {
    log(`send_email subject="${args.subject}"`);
    if (args.threadId && !args.inReplyTo) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: threadId replies require inReplyTo from read_email or search_emails.',
          },
        ],
        isError: true,
      };
    }
    try {
      const { gmail, scope } = createGmailClient();
      if (!hasGmailWriteScope(scope)) {
        throw new Error(
          'Current Gmail credentials do not allow sending mail. Re-run /add-gmail with send/compose scope.',
        );
      }
      const raw = encodeRawEmail({
        ...args,
        references: args.references ?? args.inReplyTo,
      });
      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw,
          threadId: args.threadId,
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { ok: true, id: res.data.id, threadId: res.data.threadId },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'draft_email',
  'Create a plain-text Gmail draft.',
  {
    to: z.array(z.string()).min(1).describe('Recipient email addresses.'),
    subject: z.string().describe('Email subject line.'),
    body: z.string().describe('Plain-text email body.'),
    cc: z.array(z.string()).optional().describe('Optional CC recipients.'),
    bcc: z.array(z.string()).optional().describe('Optional BCC recipients.'),
    threadId: z.string().optional().describe('Optional Gmail thread ID to draft within.'),
    inReplyTo: z
      .string()
      .optional()
      .describe('Optional RFC 2822 Message-ID for threaded drafts.'),
    references: z
      .string()
      .optional()
      .describe('Optional References header for threaded drafts.'),
  },
  async (args) => {
    log(`draft_email subject="${args.subject}"`);
    if (args.threadId && !args.inReplyTo) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: threadId drafts require inReplyTo from read_email or search_emails.',
          },
        ],
        isError: true,
      };
    }
    try {
      const { gmail, scope } = createGmailClient();
      if (!hasGmailWriteScope(scope)) {
        throw new Error(
          'Current Gmail credentials do not allow drafting mail. Re-run /add-gmail with compose scope.',
        );
      }
      const raw = encodeRawEmail({
        ...args,
        references: args.references ?? args.inReplyTo,
      });
      const res = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw,
            threadId: args.threadId,
          },
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: true,
                id: res.data.id,
                messageId: res.data.message?.id,
                threadId: res.data.message?.threadId,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'search_emails',
  'Search Gmail messages using Gmail query syntax and return compact message summaries.',
  {
    query: z
      .string()
      .describe("Gmail search query, for example 'in:inbox newer_than:7d'."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of messages to return (default 10).'),
  },
  async (args) => {
    log(`search_emails query="${args.query}"`);
    try {
      const { gmail } = createGmailClient();
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: args.query,
        maxResults: args.maxResults ?? 10,
      });

      const messages = await Promise.all(
        (list.data.messages ?? []).map(async (message) => {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: message.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID', 'References'],
          });
          return summarizeMessage(detail.data);
        }),
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ messages }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'read_email',
  'Read a specific Gmail message by ID, including headers, plain-text body, and attachment metadata.',
  {
    messageId: z.string().describe('Gmail message ID from search_emails results.'),
  },
  async (args) => {
    log(`read_email id=${args.messageId}`);
    try {
      const { gmail } = createGmailClient();
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: args.messageId,
        format: 'full',
      });

      const message = res.data;
      const headers = message.payload?.headers;
      const result = {
        ...summarizeMessage(message),
        bodyText: extractTextBody(message.payload),
        attachments: attachmentSummary(message.payload),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'list_email_labels',
  'List available Gmail labels, including system and user-defined labels.',
  {},
  async () => {
    log('list_email_labels');
    try {
      const { gmail } = createGmailClient();
      const res = await gmail.users.labels.list({ userId: 'me' });
      const labels = (res.data.labels ?? []).map((label) => ({
        id: label.id,
        name: label.name,
        type: label.type,
        messagesTotal: label.messagesTotal,
        messagesUnread: label.messagesUnread,
        threadsTotal: label.threadsTotal,
        threadsUnread: label.threadsUnread,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ labels }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'modify_email',
  'Add or remove Gmail labels on a specific message.',
  {
    messageId: z.string().describe('Gmail message ID to modify.'),
    addLabelIds: z
      .array(z.string())
      .optional()
      .describe('Label IDs to add, for example ["STARRED"].'),
    removeLabelIds: z
      .array(z.string())
      .optional()
      .describe('Label IDs to remove, for example ["UNREAD"].'),
  },
  async (args) => {
    log(`modify_email id=${args.messageId}`);
    try {
      const { gmail, scope } = createGmailClient();
      if (!hasGmailWriteScope(scope)) {
        throw new Error(
          'Current Gmail credentials do not allow modifying mail. Re-run /add-gmail with modify scope.',
        );
      }
      const res = await gmail.users.messages.modify({
        userId: 'me',
        id: args.messageId,
        requestBody: {
          addLabelIds: args.addLabelIds,
          removeLabelIds: args.removeLabelIds,
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: true,
                id: res.data.id,
                labelIds: res.data.labelIds ?? [],
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'trash_email',
  'Move a Gmail message to Trash by ID.',
  {
    messageId: z.string().describe('Gmail message ID to move to Trash.'),
  },
  async (args) => {
    log(`trash_email id=${args.messageId}`);
    try {
      const { gmail, scope } = createGmailClient();
      if (!hasGmailWriteScope(scope)) {
        throw new Error(
          'Current Gmail credentials do not allow trashing mail. Re-run /add-gmail with modify scope.',
        );
      }
      const res = await gmail.users.messages.trash({
        userId: 'me',
        id: args.messageId,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { ok: true, id: res.data.id, labelIds: res.data.labelIds ?? [] },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

log('Gmail MCP server starting...');
const transport = new StdioServerTransport();
await server.connect(transport);
