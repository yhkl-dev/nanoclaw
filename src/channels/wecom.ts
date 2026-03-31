import { randomUUID } from 'node:crypto';

import {
  type BaseMessage,
  type SendMsgBody,
  WSClient,
} from '@wecom/aibot-node-sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  WECOM_BOT_ID,
  WECOM_BOT_SECRET,
  WECOM_WS_URL,
} from '../config.js';
import { storeChatMetadata, storeMessageDirect } from '../db.js';
import { logger } from '../logger.js';
import type { Channel, NewMessage } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

const WECOM_JID_PREFIX = 'wecom:';
const CONNECT_TIMEOUT_MS = 15000;

function toWeComJid(message: BaseMessage): string {
  const chatId =
    message.chattype === 'group' ? message.chatid : message.from.userid;
  return `${WECOM_JID_PREFIX}${chatId}`;
}

function jidToChatId(jid: string): string {
  return jid.startsWith(WECOM_JID_PREFIX)
    ? jid.slice(WECOM_JID_PREFIX.length)
    : jid;
}

function buildMessageContent(message: BaseMessage): string {
  switch (message.msgtype) {
    case 'text':
      return message.text?.content?.trim() || '';
    case 'voice':
      return message.voice?.content?.trim() || '[voice message]';
    case 'image':
      return '[image message]';
    case 'file':
      return '[file message]';
    case 'mixed':
      return (
        message.mixed?.msg_item
          .map((item: { msgtype: string; text?: { content: string } }) => {
            if (item.msgtype === 'text')
              return item.text?.content?.trim() || '';
            if (item.msgtype === 'image') return '[image message]';
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .trim() || '[mixed message]'
      );
    default:
      return '';
  }
}

function toTimestamp(message: BaseMessage): string {
  if (typeof message.create_time === 'number') {
    return new Date(message.create_time * 1000).toISOString();
  }
  return new Date().toISOString();
}

function toSender(message: BaseMessage): string {
  return `${WECOM_JID_PREFIX}${message.from.userid}`;
}

function toChatName(message: BaseMessage): string {
  if (message.chattype === 'group') {
    return `WeCom Group ${message.chatid || 'unknown'}`;
  }
  return `WeCom ${message.from.userid}`;
}

export class WeComChannel implements Channel {
  readonly name = 'wecom';

  private client: WSClient | null = null;
  private connected = false;
  private readonly chatKinds = new Map<string, boolean>();
  private readonly chatNames = new Map<string, string>();

  constructor(private readonly opts: ChannelOpts) {}

  async connect(): Promise<void> {
    if (this.client?.isConnected) {
      this.connected = true;
      return;
    }

    if (!WECOM_BOT_ID || !WECOM_BOT_SECRET) {
      throw new Error('WeCom bot credentials are not configured');
    }

    const client = new WSClient({
      botId: WECOM_BOT_ID,
      secret: WECOM_BOT_SECRET,
      ...(WECOM_WS_URL ? { wsUrl: WECOM_WS_URL } : {}),
      logger: {
        debug: (message, ...args) =>
          logger.debug({ args }, `[wecom] ${message}`),
        info: (message, ...args) => logger.info({ args }, `[wecom] ${message}`),
        warn: (message, ...args) => logger.warn({ args }, `[wecom] ${message}`),
        error: (message, ...args) =>
          logger.error({ args }, `[wecom] ${message}`),
      },
    });

    this.bindClientEvents(client);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        client.off('authenticated', onAuthenticated);
      };
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        client.disconnect();
        reject(err);
      };
      const timeout = setTimeout(() => {
        settleReject(new Error('Timed out connecting to WeCom bot'));
      }, CONNECT_TIMEOUT_MS);
      const wrapResolve = () => {
        clearTimeout(timeout);
        settleResolve();
      };
      const onAuthenticated = () => {
        this.connected = true;
        this.client = client;
        wrapResolve();
      };

      client.once('authenticated', onAuthenticated);
      client.connect();
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client?.isConnected) {
      throw new Error('WeCom channel is not connected');
    }
    const chatId = jidToChatId(jid);
    const body: SendMsgBody = {
      msgtype: 'markdown',
      markdown: { content: text },
    };
    await this.client.sendMessage(chatId, body);

    const timestamp = new Date().toISOString();
    const isGroup = this.chatKinds.get(jid);
    storeChatMetadata(
      jid,
      timestamp,
      this.chatNames.get(jid),
      this.name,
      isGroup,
    );
    storeMessageDirect({
      id: `wecom-out:${randomUUID()}`,
      chat_jid: jid,
      sender: `${WECOM_JID_PREFIX}bot`,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
    });
  }

  isConnected(): boolean {
    return this.connected && Boolean(this.client?.isConnected);
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(WECOM_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client?.disconnect();
    this.client = null;
  }

  private bindClientEvents(client: WSClient): void {
    client.on('message', (frame) => {
      const body = frame.body;
      if (!body) return;

      const content = buildMessageContent(body);
      if (!content) return;

      const chatJid = toWeComJid(body);
      const timestamp = toTimestamp(body);
      const chatName = toChatName(body);
      const isGroup = body.chattype === 'group';
      this.ensureRegistered(chatJid, chatName, isGroup);
      this.chatKinds.set(chatJid, isGroup);
      this.chatNames.set(chatJid, chatName);
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        this.name,
        isGroup,
      );

      const message: NewMessage = {
        id: body.msgid,
        chat_jid: chatJid,
        sender: toSender(body),
        sender_name: body.from.userid,
        content,
        timestamp,
      };
      this.opts.onMessage(chatJid, message);
    });

    client.on('authenticated', () => {
      this.connected = true;
      logger.info('WeCom bot authenticated');
    });

    client.on('disconnected', (reason) => {
      this.connected = false;
      logger.warn({ reason }, 'WeCom bot disconnected');
    });

    client.on('reconnecting', (attempt) => {
      logger.warn({ attempt }, 'WeCom bot reconnecting');
    });

    client.on('error', (err) => {
      this.connected = false;
      logger.error({ err }, 'WeCom bot error');
    });
  }

  private ensureRegistered(
    chatJid: string,
    chatName: string,
    isGroup: boolean,
  ): void {
    const registeredGroups = this.opts.registeredGroups();
    if (registeredGroups[chatJid]) return;

    if (isGroup) return;
    if (Object.keys(registeredGroups).length > 0) return;

    this.opts.registerGroup(chatJid, {
      name: chatName,
      folder: 'main',
      trigger: DEFAULT_TRIGGER,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
    });
    logger.info(
      { chatJid },
      'Auto-registered first WeCom direct chat as main group',
    );
  }
}

registerChannel('wecom', (opts) => {
  if (!WECOM_BOT_ID || !WECOM_BOT_SECRET) return null;
  return new WeComChannel(opts);
});
