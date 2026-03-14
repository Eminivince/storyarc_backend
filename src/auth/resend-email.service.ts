import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { Resend } from "resend";
import { env } from "../config/env";

@Injectable()
export class ResendEmailService {
  private readonly logger = new Logger(ResendEmailService.name);
  private readonly resend = new Resend(env.resendApiKey);

  async sendRegistrationCode(params: {
    email: string;
    displayName: string;
    code: string;
    expiresInMinutes: number;
  }) {
    const { email, displayName, code, expiresInMinutes } = params;

    const result = await this.resend.emails.send({
      from: env.resendFromEmail,
      to: email,
      subject: "Verify your TaleStead account",
      text: `Hi ${displayName}, your TaleStead verification code is ${code}. It expires in ${expiresInMinutes} minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #111827;">
          <p style="font-size: 16px; margin-bottom: 16px;">Hi ${displayName},</p>
          <p style="font-size: 16px; margin-bottom: 16px;">
            Use the code below to verify your TaleStead account and complete registration.
          </p>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 24px 0; color: #d97706;">
            ${code}
          </div>
          <p style="font-size: 14px; color: #4b5563;">
            This code expires in ${expiresInMinutes} minutes. If you did not start this signup, you can ignore this email.
          </p>
        </div>
      `,
    });

    if (result.error) {
      this.logger.error(
        `Resend error while sending registration OTP: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        "Could not send the registration verification code.",
      );
    }
  }

  async sendPasswordResetCode(params: {
    email: string;
    displayName: string;
    code: string;
    expiresInMinutes: number;
  }) {
    const { email, displayName, code, expiresInMinutes } = params;

    const result = await this.resend.emails.send({
      from: env.resendFromEmail,
      to: email,
      subject: "Your TaleStead password reset code",
      text: `Hi ${displayName}, your TaleStead password reset code is ${code}. It expires in ${expiresInMinutes} minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #111827;">
          <p style="font-size: 16px; margin-bottom: 16px;">Hi ${displayName},</p>
          <p style="font-size: 16px; margin-bottom: 16px;">
            Use the code below to reset your TaleStead password.
          </p>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 24px 0; color: #d97706;">
            ${code}
          </div>
          <p style="font-size: 14px; color: #4b5563;">
            This code expires in ${expiresInMinutes} minutes. If you did not request this, you can ignore this email.
          </p>
        </div>
      `,
    });

    if (result.error) {
      this.logger.error(`Resend error while sending OTP: ${result.error.message}`);
      throw new InternalServerErrorException(
        "Could not send the password reset code.",
      );
    }
  }

  async sendNotificationEmail(params: {
    email: string;
    preview: string;
    subject: string;
    title: string;
    userName: string;
  }) {
    const { email, preview, subject, title, userName } = params;

    const result = await this.resend.emails.send({
      from: env.resendFromEmail,
      to: email,
      subject,
      text: `Hi ${userName}, ${preview}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #111827;">
          <p style="font-size: 16px; margin-bottom: 16px;">Hi ${userName},</p>
          <h1 style="font-size: 24px; margin: 0 0 16px;">${title}</h1>
          <p style="font-size: 16px; line-height: 1.6; color: #374151;">
            ${preview}
          </p>
        </div>
      `,
    });

    if (result.error) {
      this.logger.error(
        `Resend error while sending notification email: ${result.error.message}`,
      );
      throw new InternalServerErrorException("Could not send the notification email.");
    }
  }
}
