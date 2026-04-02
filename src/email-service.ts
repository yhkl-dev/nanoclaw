import nodemailer from 'nodemailer';

interface EmailConfig {
  server: string;
  user: string;
  password: string;
}

interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

class EmailService {
  private config: EmailConfig | null = null;
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    this.loadConfig();
  }

  private loadConfig(): void {
    this.config = {
      server: process.env.SMTP_SERVER || 'smtp.163.com',
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
    };

    if (!this.config.user || !this.config.password) {
      console.warn('SMTP configuration incomplete - user or password missing');
    }
  }

  async initTransporter(): Promise<boolean> {
    if (!this.config?.user || !this.config?.password) {
      console.error('SMTP credentials not configured');
      return false;
    }

    try {
      this.transporter = nodemailer.createTransport({
        host: this.config.server,
        port: 587, // TLS port
        secure: false,
        auth: {
          user: this.config.user,
          pass: this.config.password,
        },
      });

      // Test connection
      await this.transporter.verify();
      console.log('SMTP connection verified successfully');
      return true;
    } catch (error) {
      console.error('SMTP connection failed:', error);
      this.transporter = null;
      return false;
    }
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    if (!this.transporter) {
      const initialized = await this.initTransporter();
      if (!initialized) {
        console.error(
          'Cannot send email - SMTP not configured or connection failed',
        );
        return false;
      }
    }

    try {
      const info = await this.transporter?.sendMail({
        from: `"${this.config?.user || 'NanoClaw'}" <${this.config?.user || ''}>`,
        to: options.to,
        subject: options.subject,
        text: options.text || options.subject,
        html: options.html || `<p>${options.subject}</p>`,
      });

      console.log(
        `Email sent successfully to ${options.to}. Message ID: ${info?.messageId}`,
      );
      return true;
    } catch (error) {
      console.error('Email sending failed:', error);
      return false;
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.config?.user || !this.config?.password) {
      return {
        success: false,
        message: 'SMTP credentials not configured',
      };
    }

    try {
      await this.initTransporter();
      return {
        success: true,
        message: 'SMTP connection successful',
      };
    } catch (error) {
      return {
        success: false,
        message: `Connection failed: ${error}`,
      };
    }
  }
}

export const emailService = new EmailService();
export default emailService;
