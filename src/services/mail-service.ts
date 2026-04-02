import nodemailer from 'nodemailer';

export interface EmailConfig {
  from?: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

export interface MailResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class MailService {
  private transporter: nodemailer.Transporter | null = null;
  private initialized = false;

  constructor() {}

  /**
   * 初始化 SMTP 传输器
   */
  private initializeTransporter(): nodemailer.Transporter {
    if (this.initialized && this.transporter) {
      return this.transporter;
    }

    const {
      SMTP_SERVER,
      SMTP_PORT = '587',
      SMTP_USER,
      SMTP_PASSWORD,
      SMTP_SECURE = 'false',
      SMTP_FROM = SMTP_USER,
    } = process.env;

    if (!SMTP_SERVER || !SMTP_USER || !SMTP_PASSWORD) {
      throw new Error(
        'SMTP 配置不完整：缺少 SMTP_SERVER, SMTP_USER 或 SMTP_PASSWORD',
      );
    }

    this.transporter = nodemailer.createTransport({
      host: SMTP_SERVER,
      port: parseInt(SMTP_PORT),
      secure: SMTP_SECURE === 'true',
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASSWORD,
      },
    });

    // 测试连接
    this.transporter.verify((error: Error | null) => {
      if (error) {
        console.error('SMTP 连接验证失败:', error);
      } else {
        console.log('SMTP 连接正常，可以发送邮件');
      }
    });

    this.initialized = true;
    return this.transporter;
  }

  /**
   * 发送单个邮件
   */
  async sendEmail(config: EmailConfig): Promise<MailResponse> {
    try {
      const transporter = this.initializeTransporter();

      const from =
        config.from || process.env.SMTP_FROM || process.env.SMTP_USER;

      const mailOptions = {
        from: from || 'NanoClaw <no-reply@nanoclaw.local>',
        to: Array.isArray(config.to) ? config.to.join(', ') : config.to,
        subject: config.subject,
        text: config.text,
        html: config.html,
      };

      const info = await transporter.sendMail(mailOptions);

      console.log('✅ 邮件发送成功:', {
        messageId: info.messageId,
        to: config.to,
        subject: config.subject,
      });

      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error('❌ 邮件发送失败:', errorMessage);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 批量发送邮件
   */
  async sendBatchEmails(configs: EmailConfig[]): Promise<MailResponse[]> {
    return Promise.all(configs.map((config) => this.sendEmail(config)));
  }

  /**
   * 测试 SMTP 连接
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const transporter = this.initializeTransporter();

      return new Promise((resolve) => {
        transporter.verify((error: Error | null) => {
          if (error) {
            console.error('SMTP 连接测试失败:', error);
            resolve({
              success: false,
              message: `SMTP 连接失败：${error.message}`,
            });
          } else {
            console.log('✅ SMTP 连接测试成功');
            resolve({
              success: true,
              message: 'SMTP 连接正常，可以发送邮件',
            });
          }
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      console.error('SMTP 连接测试失败:', errorMessage);

      return {
        success: false,
        message: `SMTP 连接测试失败：${errorMessage}`,
      };
    }
  }
}

// 导出单例
export const mailService = new MailService();
