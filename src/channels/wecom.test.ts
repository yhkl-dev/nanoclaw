import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockWSClient extends EventEmitter {
  isConnected = false;
  sendMessage = vi.fn(async () => ({ errcode: 0 }));
  connect() {
    this.isConnected = true;
    queueMicrotask(() => this.emit('authenticated'));
    return this;
  }
  disconnect() {
    this.isConnected = false;
  }
}

const wsClientInstances: MockWSClient[] = [];

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: class extends MockWSClient {
    constructor() {
      super();
      wsClientInstances.push(this);
    }
  },
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Henry',
  DEFAULT_TRIGGER: '@Henry',
  WECOM_BOT_ID: 'bot-id',
  WECOM_BOT_SECRET: 'bot-secret',
  WECOM_WS_URL: undefined,
}));

const storeChatMetadata = vi.fn();
const storeMessageDirect = vi.fn();
vi.mock('../db.js', () => ({
  storeChatMetadata,
  storeMessageDirect,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('WeComChannel', () => {
  beforeEach(() => {
    wsClientInstances.length = 0;
    storeChatMetadata.mockReset();
    storeMessageDirect.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('maps inbound group text messages into NanoClaw messages', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const registerGroup = vi.fn();
    const { WeComChannel } = await import('./wecom.js');
    const channel = new WeComChannel({
      onMessage,
      onChatMetadata,
      registerGroup,
      registeredGroups: () => ({}),
    });

    await channel.connect();
    const client = wsClientInstances[0]!;
    client.emit('message', {
      body: {
        msgid: 'm-1',
        aibotid: 'bot-1',
        chatid: 'room-1',
        chattype: 'group',
        from: { userid: 'alice' },
        msgtype: 'text',
        text: { content: '@Henry hello' },
        create_time: 1710000000,
      },
    });

    expect(onChatMetadata).toHaveBeenCalledWith(
      'wecom:room-1',
      '2024-03-09T16:00:00.000Z',
      'WeCom Group room-1',
      'wecom',
      true,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'wecom:room-1',
      expect.objectContaining({
        id: 'm-1',
        chat_jid: 'wecom:room-1',
        sender: 'wecom:alice',
        sender_name: 'alice',
        content: '@Henry hello',
      }),
    );
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it('sends outbound messages through the SDK', async () => {
    const { WeComChannel } = await import('./wecom.js');
    const channel = new WeComChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registerGroup: vi.fn(),
      registeredGroups: () => ({}),
    });

    await channel.connect();
    const client = wsClientInstances[0]!;
    await channel.sendMessage('wecom:user-1', 'reply text');

    expect(client.sendMessage).toHaveBeenCalledWith('user-1', {
      msgtype: 'markdown',
      markdown: { content: 'reply text' },
    });
    expect(storeChatMetadata).toHaveBeenCalledWith(
      'wecom:user-1',
      expect.any(String),
      undefined,
      'wecom',
      undefined,
    );
    expect(storeMessageDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_jid: 'wecom:user-1',
        sender: 'wecom:bot',
        sender_name: 'Henry',
        content: 'reply text',
        is_from_me: true,
        is_bot_message: true,
      }),
    );
  });

  it('auto-registers the first WeCom direct chat as the main group', async () => {
    const registerGroup = vi.fn();
    const { WeComChannel } = await import('./wecom.js');
    const channel = new WeComChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registerGroup,
      registeredGroups: () => ({}),
    });

    await channel.connect();
    const client = wsClientInstances[0]!;
    client.emit('message', {
      body: {
        msgid: 'm-2',
        aibotid: 'bot-1',
        chattype: 'single',
        from: { userid: 'YangKai' },
        msgtype: 'text',
        text: { content: '@Henry 你好' },
        create_time: 1710000001,
      },
    });

    expect(registerGroup).toHaveBeenCalledWith(
      'wecom:YangKai',
      expect.objectContaining({
        folder: 'main',
        trigger: '@Henry',
        requiresTrigger: false,
        isMain: true,
      }),
    );
  });
});
