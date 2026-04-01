import { AdminSettingKind, ContractExclusivity, Prisma } from "@prisma/client";
import {
  creatorExclusiveRevenueShareSettingKey,
  creatorNonExclusiveRevenueShareSettingKey,
  getDefaultCreatorRevenueSharePercent,
} from "../creator/creator-finance.constants";

export const AD_UNLOCK_REVENUE_CENTS = 25;

export const dashboardMonthlyRevenueTargetSettingKey =
  "dashboardMonthlyRevenueTargetCents";

export const ADMIN_LIST_DEFAULT_LIMIT = 200;

export type AdminListPagination = {
  limit?: number | null;
  offset?: number | null;
};

export type DefaultAdminSetting = {
  description: string;
  enabled: boolean;
  group: string;
  key: string;
  kind: AdminSettingKind;
  title: string;
  valueCents: number | null;
};

export const defaultAdminSettings: DefaultAdminSetting[] = [
  {
    description: "Put TaleStead into read-only maintenance mode for deployments.",
    enabled: false,
    group: "General Settings",
    key: "maintenanceMode",
    kind: "BOOLEAN",
    title: "Maintenance Mode",
    valueCents: null,
  },
  {
    description: "Allow new author applications to enter the review queue.",
    enabled: true,
    group: "General Settings",
    key: "newCreatorApplications",
    kind: "BOOLEAN",
    title: "Creator Applications",
    valueCents: null,
  },
  {
    description: "Escalate flagged chapters faster and require manual publish review.",
    enabled: true,
    group: "Security Policies",
    key: "strictModeration",
    kind: "BOOLEAN",
    title: "Strict Content Safety",
    valueCents: null,
  },
  {
    description: "Require second approval before creator payouts are released.",
    enabled: true,
    group: "Security Policies",
    key: "twoPersonPayoutReview",
    kind: "BOOLEAN",
    title: "Two-Person Payout Review",
    valueCents: null,
  },
  {
    description:
      "Set the monthly revenue target used by the admin dashboard financial health card.",
    enabled: false,
    group: "Financial Controls",
    key: dashboardMonthlyRevenueTargetSettingKey,
    kind: "CURRENCY_CENTS",
    title: "Monthly Revenue Target",
    valueCents: 5_000_000,
  },
  {
    description:
      "Default revenue share for exclusive creator contracts tied to premium chapter purchases.",
    enabled: true,
    group: "Financial Controls",
    key: creatorExclusiveRevenueShareSettingKey,
    kind: "PERCENTAGE",
    title: "Exclusive Contract Share",
    valueCents: getDefaultCreatorRevenueSharePercent(ContractExclusivity.EXCLUSIVE),
  },
  {
    description:
      "Default revenue share for non-exclusive creator contracts tied to premium chapter purchases.",
    enabled: true,
    group: "Financial Controls",
    key: creatorNonExclusiveRevenueShareSettingKey,
    kind: "PERCENTAGE",
    title: "Non-Exclusive Contract Share",
    valueCents: getDefaultCreatorRevenueSharePercent(ContractExclusivity.NON_EXCLUSIVE),
  },
  {
    description: "Points awarded for each daily check-in.",
    enabled: true,
    group: "Engagement Rewards",
    key: "dailyCheckInReward",
    kind: "CURRENCY_CENTS",
    title: "Daily Check-In Reward",
    valueCents: 50,
  },
  {
    description: "Points awarded for each referral share.",
    enabled: true,
    group: "Engagement Rewards",
    key: "referralShareReward",
    kind: "CURRENCY_CENTS",
    title: "Referral Share Reward",
    valueCents: 20,
  },
];

export const maintenanceActionLabels: Record<string, string> = {
  "clear-cache": "Cache clear started",
  "purge-sessions": "Session purge started",
  "reindex-search": "Search reindex queued",
  "run-backup": "Backup snapshot queued",
};

export const supportHelpCenterCategories = [
  {
    id: "account-billing",
    title: "Account & Billing",
    description:
      "Manage subscriptions, payment methods, invoices, and profile access issues.",
    icon: "payments",
  },
  {
    id: "reading-experience",
    title: "Reading Experience",
    description:
      "Reader settings, chapter access, bookmarks, progress sync, and library troubleshooting.",
    icon: "auto_stories",
  },
  {
    id: "writing-publishing",
    title: "Writing & Publishing",
    description:
      "Creator studio workflows, publishing steps, analytics, and draft management.",
    icon: "edit_note",
  },
  {
    id: "trust-safety",
    title: "Trust & Safety",
    description:
      "Community guidelines, content reporting, moderation decisions, and safe participation.",
    icon: "gavel",
  },
] as const;

export const supportHelpCenterArticles = [
  {
    id: "reset-password",
    categoryId: "account-billing",
    excerpt:
      "Recover access, update your password, and review device/session security after a reset.",
    tag: "Security & Access",
    title: "Resetting your password",
    body:
      "If you cannot access your account, use the password reset flow from the sign-in page. We will send a secure reset link to your email so you can create a new password.\n\nAfter resetting, review your recent sessions and update your security settings to keep your account protected. If you did not request the reset, contact support right away.",
  },
  {
    id: "publish-first-story",
    categoryId: "writing-publishing",
    excerpt:
      "Prepare story metadata, organize volumes and arcs, and move your first project into publication.",
    tag: "Writer's Guide",
    title: "How to publish your first story",
    body:
      "Start by completing your story details, cover art, and genre tags. Organize chapters into volumes and arcs so readers can follow your structure.\n\nWhen you are ready, schedule or publish your chapters from the studio. Keep an eye on the dashboard for early engagement signals and reader feedback.",
  },
  {
    id: "coins-subscriptions",
    categoryId: "account-billing",
    excerpt:
      "Understand memberships, coin balances, billing cycles, and what happens after a successful purchase.",
    tag: "Billing",
    title: "TaleStead Coins and Subscriptions",
    body:
      "Coins unlock premium chapters and support your favorite creators. Subscriptions provide monthly bundles and benefits tied to your plan tier.\n\nCheck your billing settings to review active plans, payment methods, and recent purchases. If a charge looks incorrect, submit a support ticket and include the transaction details.",
  },
  {
    id: "report-inappropriate-content",
    categoryId: "trust-safety",
    excerpt:
      "Report a story or chapter, share context with moderation, and track the status of your report.",
    tag: "Safety",
    title: "Reporting inappropriate content",
    body:
      "Use the report option on any story or chapter to flag content that violates community guidelines. Provide clear context so the moderation team can act quickly.\n\nYou will see updates in your moderation inbox once the report is reviewed. Serious or urgent issues can also be escalated through a support request.",
  },
] as const;

export const supportHelpCenterActions = [
  {
    id: "submit-ticket",
    title: "Submit Ticket",
    icon: "mail",
    description: "Open a support thread and get help from the TaleStead team.",
    primary: true,
    ticketTemplate: {
      category: "GENERAL",
      message:
        "I need help from the TaleStead support team. Please follow up on this support request.",
      priority: "NORMAL",
      subject: "General support request",
    },
  },
  {
    id: "live-chat",
    title: "Live Chat",
    icon: "chat_bubble",
    description:
      "Start a high-priority support request for urgent account or purchase issues.",
    primary: false,
    ticketTemplate: {
      category: "ACCOUNT",
      message:
        "I need fast help from the TaleStead support team. Please contact me about this account issue.",
      priority: "HIGH",
      subject: "Urgent support request",
    },
  },
] as const;

export const adminBookStoryInclude = {
  adminControl: true,
  assets: true,
  author: {
    include: {
      profile: true,
    },
  },
  contentReports: {
    where: {
      status: {
        in: ["OPEN", "IN_REVIEW"] as any,
      },
    },
  },
  publishedChapters: {
    include: {
      adminOverride: true,
      chapter: true,
    },
    orderBy: {
      chapterNumber: "asc" as const,
    },
  },
} satisfies Prisma.StoryInclude;

export type AdminBookStoryRecord = Prisma.StoryGetPayload<{
  include: typeof adminBookStoryInclude;
}>;

export type AdminContractTemplateInput = {
  advancePaymentCents: number;
  body: string;
  companyName: string;
  description: string | null;
  exclusivity: ContractExclusivity;
  geographicRights: string;
  revenueSharePercent: number;
  signingBonusCoins: number;
  templateName: string;
  termMonths: number;
};

export type AdminContractInput = {
  advancePaymentCents: number;
  body: string;
  companyName: string;
  contractType: ContractExclusivity;
  geographicRights: string;
  partyRole: string;
  revenueSharePercent: number;
  signingBonusCoins: number;
  status: ContractStatus;
  storyId: string;
  templateId: string | null;
  templateName: string;
  termMonths: number;
  userId: string;
};

export type AdminSettingValueInput = {
  valueCents: number;
};

export const adminContractInclude = {
  story: {
    include: {
      author: {
        include: {
          profile: true,
        },
      },
    },
  },
  template: true,
  user: {
    include: {
      profile: true,
    },
  },
} satisfies Prisma.ContractInclude;

export const contractTemplateCountInclude = {
  _count: {
    select: {
      contracts: true,
    },
  },
} satisfies Prisma.ContractTemplateInclude;

// Re-export ContractStatus for convenience
import { ContractStatus } from "@prisma/client";
export { ContractStatus };
