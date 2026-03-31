import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { Resend } from "resend";
import { env } from "../config/env";

function unsubscribeFooter(unsubscribeUrl: string | null) {
  if (!unsubscribeUrl) {
    return "";
  }

  return `
    <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af;">
      <a href="${unsubscribeUrl}" style="color: #9ca3af; text-decoration: underline;">Unsubscribe</a>
      from these emails.
    </div>
  `;
}

function escapeHtmlForEmail(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

@Injectable()
export class ResendEmailService {
  private readonly logger = new Logger(ResendEmailService.name);
  private readonly resend = new Resend(env.resendApiKey);
  private readonly capturedRegistrationCodes = new Map<
    string,
    { code: string; email: string; expiresInMinutes: number }
  >();

  async sendRegistrationCode(params: {
    email: string;
    displayName: string;
    code: string;
    expiresInMinutes: number;
  }) {
    const { email, displayName, code, expiresInMinutes } = params;

    if (env.authEmailDeliveryMode === "capture") {
      this.captureRegistrationCode(email, code, expiresInMinutes);
      return;
    }

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

  getCapturedRegistrationCode(email: string) {
    return this.capturedRegistrationCodes.get(email.trim().toLowerCase()) ?? null;
  }

  private captureRegistrationCode(
    email: string,
    code: string,
    expiresInMinutes: number,
  ) {
    const normalizedEmail = email.trim().toLowerCase();

    this.capturedRegistrationCodes.set(normalizedEmail, {
      code,
      email: normalizedEmail,
      expiresInMinutes,
    });
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

  async sendEmailChangeVerification(newEmail: string, code: string) {
    const result = await this.resend.emails.send({
      from: env.resendFromEmail,
      to: newEmail,
      subject: "Verify your new TaleStead email address",
      text: `Your TaleStead email verification code is ${code}. It expires in 15 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #111827;">
          <p style="font-size: 16px; margin-bottom: 16px;">
            Use the code below to verify your new email address on TaleStead.
          </p>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 24px 0; color: #d97706;">
            ${code}
          </div>
          <p style="font-size: 14px; color: #4b5563;">
            This code expires in 15 minutes. If you did not request this change, you can ignore this email.
          </p>
        </div>
      `,
    });

    if (result.error) {
      this.logger.error(`Resend error while sending email change code: ${result.error.message}`);
      throw new InternalServerErrorException(
        "Could not send the verification code.",
      );
    }
  }

  async sendNotificationEmail(params: {
    email: string;
    preview: string;
    subject: string;
    title: string;
    userName: string;
    unsubscribeUrl?: string;
  }) {
    const { email, preview, subject, title, userName, unsubscribeUrl } = params;

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
          ${unsubscribeFooter(unsubscribeUrl ?? null)}
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

  async sendPurchaseReceipt(params: {
    email: string;
    userName: string;
    itemName: string;
    amountFormatted: string;
    purchaseDate: string;
  }) {
    const { email, userName, itemName, amountFormatted, purchaseDate } = params;

    await this.sendNotificationEmail({
      email,
      userName,
      subject: "Your TaleStead purchase receipt",
      title: "Purchase Confirmation",
      preview: `You purchased ${itemName} for ${amountFormatted} on ${purchaseDate}. Thank you for supporting creators on TaleStead!`,
    });
  }

  async sendPayoutProcessed(params: {
    email: string;
    userName: string;
    amount: string;
  }) {
    await this.sendNotificationEmail({
      email: params.email,
      userName: params.userName,
      subject: "Your TaleStead payout has been processed",
      title: "Payout Processed",
      preview: `Your payout of ${params.amount} has been released. Please allow a few business days for it to arrive in your account.`,
    });
  }

  async sendSubscriptionCharged(params: {
    email: string;
    userName: string;
    planName: string;
    amount: string;
  }) {
    await this.sendNotificationEmail({
      email: params.email,
      userName: params.userName,
      subject: `Your TaleStead ${params.planName} subscription was renewed`,
      title: "Subscription Renewed",
      preview: `Your ${params.planName} plan was renewed for ${params.amount}. Enjoy continued access to premium content!`,
    });
  }

  async sendSecurityAlert(params: {
    email: string;
    userName: string;
    eventType: string;
    ipAddress: string | null;
  }) {
    const locationNote = params.ipAddress ? ` from IP ${params.ipAddress}` : "";

    await this.sendNotificationEmail({
      email: params.email,
      userName: params.userName,
      subject: "TaleStead security alert",
      title: "Security Alert",
      preview: `We detected ${params.eventType}${locationNote}. If this wasn't you, please secure your account immediately by changing your password.`,
    });
  }

  async sendCreatorApplicationStatus(params: {
    email: string;
    userName: string;
    status: "APPROVED" | "REJECTED";
  }) {
    const isApproved = params.status === "APPROVED";

    await this.sendNotificationEmail({
      email: params.email,
      userName: params.userName,
      subject: isApproved
        ? "Welcome to TaleStead Creators!"
        : "Update on your TaleStead creator application",
      title: isApproved ? "You're In!" : "Application Update",
      preview: isApproved
        ? "Congratulations! Your creator application has been approved. You can now start publishing stories on TaleStead."
        : "Unfortunately, your creator application was not approved at this time. Please review the feedback and feel free to reapply.",
    });
  }

  /**
   * Sent when an admin approves a creator application. Includes eligibility and optional reviewer notes.
   */
  async sendCreatorApplicationApproved(params: {
    email: string;
    applicantName: string;
    primaryGenre: string;
    reviewedAt: Date;
    revenueShareEligible: boolean;
    reviewNotesFromTeam: string | null;
    studioDashboardUrl: string | null;
  }) {
    const reviewedLabel = params.reviewedAt.toLocaleDateString("en-US", {
      day: "numeric",
      month: "long",
      weekday: "long",
      year: "numeric",
    });

    const revenueText = params.revenueShareEligible
      ? "You are eligible to enter revenue-sharing story contracts on TaleStead."
      : "You have Creator Studio access. You are not eligible for revenue-sharing story contracts at this time (studio publishing only).";

    const notesHtml =
      params.reviewNotesFromTeam && params.reviewNotesFromTeam.trim().length > 0
        ? `<div style="margin: 20px 0; padding: 16px; background: #f9fafb; border-radius: 12px; border: 1px solid #e5e7eb;">
            <p style="margin: 0 0 8px; font-size: 13px; font-weight: 700; color: #111827; text-transform: uppercase; letter-spacing: 0.06em;">Message from the team</p>
            <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #374151; white-space: pre-wrap;">${escapeHtmlForEmail(
              params.reviewNotesFromTeam.trim(),
            )}</p>
          </div>`
        : "";

    const ctaHtml = params.studioDashboardUrl
      ? `<p style="margin: 28px 0 0;">
          <a href="${escapeHtmlForEmail(params.studioDashboardUrl)}" style="display: inline-block; background: #d97706; color: #ffffff; text-decoration: none; font-weight: 700; padding: 14px 24px; border-radius: 10px; font-size: 15px;">Open Creator Studio</a>
        </p>`
      : `<p style="margin: 20px 0 0; font-size: 15px; color: #4b5563;">Sign in to TaleStead and open <strong>Creator Studio</strong> from your account menu.</p>`;

    const plainNotes =
      params.reviewNotesFromTeam && params.reviewNotesFromTeam.trim().length > 0
        ? `\n\nMessage from the team:\n${params.reviewNotesFromTeam.trim()}`
        : "";

    const plainCta = params.studioDashboardUrl
      ? `\n\nOpen Creator Studio: ${params.studioDashboardUrl}`
      : "";

    const textBody = `Hi ${params.applicantName},

Your TaleStead creator application has been approved as of ${reviewedLabel}.

Application details:
- Name on application: ${params.applicantName}
- Primary genre: ${params.primaryGenre}
- Revenue-sharing contracts: ${params.revenueShareEligible ? "Eligible" : "Not eligible (studio only)"}

${revenueText}${plainNotes}${plainCta}

Welcome aboard — we're glad you're here.`;

    const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #111827;">
          <p style="font-size: 16px; margin-bottom: 16px;">Hi ${escapeHtmlForEmail(params.applicantName)},</p>
          <h1 style="font-size: 24px; margin: 0 0 12px;">You're approved</h1>
          <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 0 0 20px;">
            Your creator application was approved on <strong>${escapeHtmlForEmail(reviewedLabel)}</strong>.
          </p>
          <table style="width: 100%; border-collapse: collapse; font-size: 15px; color: #374151;">
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;">Name</td><td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${escapeHtmlForEmail(params.applicantName)}</td></tr>
            <tr><td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;">Primary genre</td><td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${escapeHtmlForEmail(params.primaryGenre)}</td></tr>
            <tr><td style="padding: 8px 0; color: #6b7280;">Revenue-sharing</td><td style="padding: 8px 0; font-weight: 600;">${params.revenueShareEligible ? "Eligible" : "Not eligible (studio only)"}</td></tr>
          </table>
          <p style="font-size: 15px; line-height: 1.6; color: #374151; margin: 20px 0 0;">
            ${escapeHtmlForEmail(revenueText)}
          </p>
          ${notesHtml}
          ${ctaHtml}
        </div>
      `;

    const result = await this.resend.emails.send({
      from: env.resendFromEmail,
      to: params.email,
      subject: "Your TaleStead creator application was approved",
      text: textBody,
      html: htmlBody,
    });

    if (result.error) {
      this.logger.error(
        JSON.stringify({
          event: "creator_application_approval_email_failed",
          email: params.email,
          resendMessage: result.error.message,
        }),
      );
      throw new InternalServerErrorException(
        "Could not send the creator approval email.",
      );
    }
  }

  async sendModerationNotice(params: {
    email: string;
    userName: string;
    contentType: string;
    action: string;
  }) {
    await this.sendNotificationEmail({
      email: params.email,
      userName: params.userName,
      subject: `Action taken on your ${params.contentType}`,
      title: "Content Moderation Notice",
      preview: `Your ${params.contentType} has been ${params.action} by our moderation team. Please review our community guidelines for more information.`,
    });
  }

  async sendWeeklyDigest(params: {
    email: string;
    userName: string;
    sections: string[];
    unsubscribeUrl: string;
  }) {
    const sectionsHtml = params.sections
      .map((s) => `<li style="margin-bottom: 8px;">${s}</li>`)
      .join("");

    const result = await this.resend.emails.send({
      from: env.resendFromEmail,
      to: params.email,
      subject: "Your TaleStead Weekly Digest",
      text: `Hi ${params.userName}, here's what happened this week on TaleStead.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #111827;">
          <p style="font-size: 16px; margin-bottom: 16px;">Hi ${params.userName},</p>
          <h1 style="font-size: 24px; margin: 0 0 16px;">Your Weekly Digest</h1>
          <ul style="font-size: 16px; line-height: 1.6; color: #374151; padding-left: 20px;">
            ${sectionsHtml}
          </ul>
          ${unsubscribeFooter(params.unsubscribeUrl)}
        </div>
      `,
    });

    if (result.error) {
      this.logger.error(
        `Resend error while sending weekly digest: ${result.error.message}`,
      );
    }
  }

  async sendDataExportReady(params: {
    email: string;
    userName: string;
    dataJson: string;
  }) {
    const result = await this.resend.emails.send({
      from: env.resendFromEmail,
      to: params.email,
      subject: "Your TaleStead Data Export",
      text: `Hi ${params.userName}, your data export is attached to this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #111827;">
          <p style="font-size: 16px; margin-bottom: 16px;">Hi ${escapeHtmlForEmail(params.userName)},</p>
          <h1 style="font-size: 24px; margin: 0 0 16px;">Your Data Export</h1>
          <p style="font-size: 16px; line-height: 1.6; color: #374151;">
            Your personal data export is attached to this email as a JSON file.
            This includes your profile, reading history, reviews, purchases, and engagement data.
          </p>
          <p style="font-size: 14px; line-height: 1.6; color: #6b7280; margin-top: 16px;">
            This export was generated at your request under GDPR Article 20 (right to data portability).
            If you did not request this, please contact support immediately.
          </p>
        </div>
      `,
      attachments: [
        {
          filename: "talestead-data-export.json",
          content: Buffer.from(params.dataJson).toString("base64"),
        },
      ],
    });

    if (result.error) {
      this.logger.error(
        `Resend error while sending data export: ${result.error.message}`,
      );
    }
  }
}
