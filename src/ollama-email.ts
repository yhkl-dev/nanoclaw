import nodemailer, { Transporter } from 'nodemailer';
import { logger } from './logger.js';

interface EmailConfig {
  server: string;
  user: string;
  password: string;
  port?: number;
  secure?: boolean;
}

export interface EmailPayload {
  to: string | string[];
  subject: string;
  body: string;
  html?: string;
  from?: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  errorMessage?: string;
  errorDetails?: Record<string, unknown>;
}

// 从环境变量加载 SMTP 配置
function loadEmailConfig(): EmailConfig | null {
  const server = process.env.SMTP_SERVER;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;

  if (!server || !user || !password) {
    logger.warn('SMTP configuration incomplete, skipping email sending');
    return null;
  }

  return {
    server,
    user,
    password,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
  };
}

/**
 * 发送邮件的工具实现
 */
export async function sendEmailTool(
  payload: EmailPayload,
): Promise<EmailResult> {
  const config = loadEmailConfig();

  if (!config) {
    return {
      success: false,
      errorMessage:
        'SMTP configuration not found. Please set SMTP_SERVER, SMTP_USER, and SMTP_PASSWORD environment variables.',
      errorDetails: {
        missingVars: ['SMTP_SERVER', 'SMTP_USER', 'SMTP_PASSWORD'].filter(
          (v) => !process.env[v],
        ),
      },
    };
  }

  try {
    // 创建 SMTP 传输器
    const transporter: Transporter = nodemailer.createTransport({
      host: config.server,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.password,
      },
    });

    // 验证连接
    await transporter.verify();

    // 发送准备
    const from = payload.from || config.user;
    const message = {
      from: `"NanoClaw Assistant" <${from}>`,
      to: typeof payload.to === 'string' ? payload.to : payload.to.join(', '),
      subject: payload.subject,
      text: payload.body,
      html: payload.html || payload.body,
    };

    // 发送邮件
    const info = await transporter.sendMail(message);

    logger.info(`Email sent successfully: ${info.messageId}`);

    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      `Failed to send email: ${errorMessage}`,
    );

    return {
      success: false,
      errorMessage,
      errorDetails: {
        errorType: error instanceof Error ? error.name : 'unknown',
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
  }
}

/**
 * 获取邮件工具的调用定义
 */
export function getEmailToolDefinition(): {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
} {
  return {
    type: 'function',
    function: {
      name: 'send_email',
      description:
        'Send an email via SMTP. Requires SMTP_SERVER, SMTP_USER, and SMTP_PASSWORD to be configured in environment variables.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Recipient email address. Can be comma-separated for multiple recipients.',
          },
          subject: {
            type: 'string',
            description: 'Email subject line',
          },
          body: {
            type: 'string',
            description: 'Email body text (plain text)',
          },
          html: {
            type: 'string',
            description: 'Email body HTML (optional)',
          },
          from: {
            type: 'string',
            description:
              'Sender email address (optional, defaults to SMTP_USER)',
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  };
}

/**
 * 检查 SMTP 配置状态
 */
export function checkEmailStatus(): {
  configured: boolean;
  missing: string[];
  server?: string;
  user?: string;
} {
  const server = process.env.SMTP_SERVER;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;

  const missing: string[] = [];

  if (!server) missing.push('SMTP_SERVER');
  if (!user) missing.push('SMTP_USER');
  if (!password) missing.push('SMTP_PASSWORD');

  return {
    configured: missing.length === 0,
    missing,
    server: server
      ? server.replace(/@\d+\.\d+\.\d+,\d+$/, '@x.x.x.x')
      : undefined,
    user: user ? user.replace(/@[^@]+$/, '@xxxxx') : undefined,
  };
}
