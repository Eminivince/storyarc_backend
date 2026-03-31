/**
 * Manually send the same email as ResendEmailService.sendCreatorApplicationApproved.
 * Keep payload/structure aligned with backend/src/auth/resend-email.service.ts
 *
 * Usage (from backend/):
 *   npm run email:creator-approved -- --email=writer@example.com --name="Jane Author"
 *
 * Options:
 *   --email           Recipient (required)
 *   --name            Applicant name on application (required)
 *   --genre           Primary genre (default: Fantasy)
 *   --no-revenue-share   Studio-only approval (no revenue-sharing contracts)
 *   --notes           Optional message from the team (plain text)
 *   --studio-url      Optional Creator Studio URL for the CTA button
 *   --reviewed-at     Optional ISO date (default: now)
 *
 * Requires RESEND_API_KEY and RESEND_FROM_EMAIL in .env (same as the running API).
 */

import { Resend } from "resend";
import { env } from "../src/config/env";

function escapeHtmlForEmail(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-revenue-share") {
      out.revenueShare = false;
      continue;
    }
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = arg.slice(2, eq).replace(/-/g, "");
    const value = arg.slice(eq + 1);
    out[key] = value;
  }
  return out;
}

function buildBodies(params: {
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

  return { textBody, htmlBody };
}

async function main() {
  const args = parseArgs(process.argv);

  const email = (args.email as string)?.trim() || process.env.MANUAL_APPROVAL_EMAIL?.trim();
  const applicantName =
    (args.name as string)?.trim() || process.env.MANUAL_APPROVAL_NAME?.trim();
  const primaryGenre =
    (args.genre as string)?.trim() ||
    process.env.MANUAL_APPROVAL_GENRE?.trim() ||
    "Fantasy";
  const reviewNotesFromTeam =
    (args.notes as string)?.trim() || process.env.MANUAL_APPROVAL_NOTES?.trim() || null;
  const studioDashboardUrl =
    (args.studiourl as string)?.trim() || process.env.MANUAL_APPROVAL_STUDIO_URL?.trim() || null;

  const revenueShareEligible =
    args.revenueShare === false
      ? false
      : process.env.MANUAL_APPROVAL_NO_REVENUE_SHARE === "1"
        ? false
        : true;

  let reviewedAt = new Date();
  const reviewedAtRaw = (args.reviewedat as string)?.trim() || process.env.MANUAL_APPROVAL_REVIEWED_AT?.trim();
  if (reviewedAtRaw) {
    const parsed = new Date(reviewedAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      console.error("Invalid --reviewed-at (use ISO 8601, e.g. 2026-03-27T12:00:00Z)");
      process.exit(1);
    }
    reviewedAt = parsed;
  }

  if (!email || !applicantName) {
    console.error(
      "Usage: npm run email:creator-approved -- --email=you@x.com --name=\"Full Name\" [--genre=Fantasy] [--notes=\"...\"] [--studio-url=https://...] [--no-revenue-share]",
    );
    process.exit(1);
  }

  const { textBody, htmlBody } = buildBodies({
    applicantName,
    primaryGenre,
    reviewedAt,
    revenueShareEligible,
    reviewNotesFromTeam,
    studioDashboardUrl,
  });

  const resend = new Resend(env.resendApiKey);
  const result = await resend.emails.send({
    from: env.resendFromEmail,
    to: email,
    subject: "Your TaleStead creator application was approved",
    text: textBody,
    html: htmlBody,
  });

  if (result.error) {
    console.error("Resend error:", result.error.message);
    process.exit(1);
  }

  console.log("Sent creator approval email to", email, result.data?.id ? `(id: ${result.data.id})` : "");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
