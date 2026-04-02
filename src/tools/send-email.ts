import nodemailer from 'nodemailer';
interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
  implementation: (params: Record<string, unknown>) => Promise<string>;
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_SERVER || 'smtp.163.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASSWORD || '',
  },
});

export const sendEmailTool: ToolDefinition = {
  name: 'send_email',
  description: 'Send an email via SMTP server',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Recipient email address',
      },
      subject: {
        type: 'string',
        description: 'Email subject line',
      },
      body: {
        type: 'string',
        description: 'Email body content (plain text)',
      },
      html: {
        type: 'string',
        description: 'Optional HTML email content',
      },
      cc: {
        type: 'string',
        description: 'Optional CC recipient(s), comma-separated',
      },
    },
    required: ['to', 'subject', 'body'],
  },
  implementation: async (params: Record<string, unknown>) => {
    const { to, subject, body, html, cc } = params as {
      to: string;
      subject: string;
      body: string;
      html?: string;
      cc?: string;
    };

    try {
      const result = await transporter.sendMail({
        from: `"NanoClaw" <${process.env.SMTP_USER || 'noreply@nanoclaw.com'}>`,
        to,
        cc,
        subject: `[NanoClaw] ${subject}`,
        text: body,
        html: html || body,
      });

      return JSON.stringify({
        success: true,
        message: 'Email sent successfully',
        messageId: result.messageId,
        recipients: result.envelope.to,
        sentAt: new Date().toISOString(),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      return JSON.stringify({
        success: false,
        error: errorMessage,
        sentAt: new Date().toISOString(),
      });
    }
  },
};
