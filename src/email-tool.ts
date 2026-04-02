interface Tool {
  name: string;
  description: string;
  parameters: object;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}
import { emailService } from './email-service.js';

const sendEmailTool: Tool = {
  name: 'send_email',
  description: '通过 SMTP 发送邮件',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: '收件人邮箱地址',
      },
      subject: {
        type: 'string',
        description: '邮件标题',
      },
      body: {
        type: 'string',
        description: '邮件正文内容',
      },
    },
    required: ['to', 'subject', 'body'],
  },
  execute: async (args: any) => {
    try {
      const success = await emailService.sendEmail(args);
      if (success) {
        return {
          success: true,
          message: `✅ 邮件已成功发送到 ${args.to}`,
        };
      } else {
        return {
          success: false,
          message: '❌ 邮件发送失败',
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `❌ 邮件发送出错：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

const testEmailConnectionTool: Tool = {
  name: 'test_email_connection',
  description: '测试 SMTP 连接是否可用',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async () => {
    try {
      const success = await emailService.testConnection();
      if (success) {
        return {
          success: true,
          message: '✅ SMTP 连接正常，可以发送邮件',
        };
      } else {
        return {
          success: false,
          message: '❌ SMTP 连接失败，请检查配置',
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `❌ 连接测试出错：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

const checkEmailStatusTool: Tool = {
  name: 'check_email_status',
  description: '检查当前 SMTP 服务状态',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async () => {
    try {
      const hasTransporter = emailService['transporter'] !== null;
      const hasConfig = emailService['config'] !== null;

      return {
        smtpConfigured: hasConfig,
        connectionReady: hasTransporter && hasConfig,
        status: hasConfig ? 'Configured' : 'Not configured',
        message: hasConfig
          ? '✅ SMTP 配置已加载'
          : '❌ SMTP 未配置，请先设置环境变量',
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ 状态检查出错：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export const emailTools = [
  sendEmailTool,
  testEmailConnectionTool,
  checkEmailStatusTool,
];
