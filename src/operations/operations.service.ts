import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AdminBookReleaseMode,
  AdminBookVisibilityState,
  AdminSettingKind,
  CommentStatus,
  ContractExclusivity,
  ContractStatus,
  Prisma,
  ReviewStatus,
} from "@prisma/client";
import { AuthService } from "../auth/auth.service";
import { ResendEmailService } from "../auth/resend-email.service";
import {
  creatorExclusiveRevenueShareSettingKey,
  creatorNonExclusiveRevenueShareSettingKey,
  getDefaultCreatorRevenueSharePercent,
  isCreatorWithdrawalPeriodLabel,
} from "../creator/creator-finance.constants";
import { labelFromGenreOrTagSlug } from "../catalog/story-genres";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";
import {
  defaultBookPlatformPolicy,
  formatPremiumWindowLabel,
  formatReleaseModeLabel,
  formatVisibilityLabel,
  getStoryVisibilityState,
  normalizeConfiguredPremiumWindowHours,
  resolveEffectiveChapterAccess,
} from "../utils/book-admin";

const AD_UNLOCK_REVENUE_CENTS = 25;
const dashboardMonthlyRevenueTargetSettingKey =
  "dashboardMonthlyRevenueTargetCents";

const supportHelpCenterCategories = [
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

const supportHelpCenterArticles = [
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

const supportHelpCenterActions = [
  {
    id: "submit-ticket",
    title: "Submit Ticket",
    icon: "mail",
    description:
      "Open a support thread and get help from the TaleStead team.",
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

const ADMIN_LIST_DEFAULT_LIMIT = 200;

type AdminListPagination = {
  limit?: number | null;
  offset?: number | null;
};

type DefaultAdminSetting = {
  description: string;
  enabled: boolean;
  group: string;
  key: string;
  kind: AdminSettingKind;
  title: string;
  valueCents: number | null;
};

const defaultAdminSettings: DefaultAdminSetting[] = [
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
    valueCents: getDefaultCreatorRevenueSharePercent(
      ContractExclusivity.EXCLUSIVE,
    ),
  },
  {
    description:
      "Default revenue share for non-exclusive creator contracts tied to premium chapter purchases.",
    enabled: true,
    group: "Financial Controls",
    key: creatorNonExclusiveRevenueShareSettingKey,
    kind: "PERCENTAGE",
    title: "Non-Exclusive Contract Share",
    valueCents: getDefaultCreatorRevenueSharePercent(
      ContractExclusivity.NON_EXCLUSIVE,
    ),
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
] as const;

const maintenanceActionLabels = {
  "clear-cache": "Cache clear started",
  "purge-sessions": "Session purge started",
  "reindex-search": "Search reindex queued",
  "run-backup": "Backup snapshot queued",
};

type AdminBookStoryRecord = Prisma.StoryGetPayload<{
  include: {
    adminControl: true;
    assets: true;
    author: {
      include: {
        profile: true;
      };
    };
    contentReports: {
      where: {
        status: {
          in: ["OPEN", "IN_REVIEW"];
        };
      };
    };
    publishedChapters: {
      include: {
        adminOverride: true;
        chapter: true;
      };
      orderBy: {
        chapterNumber: "asc";
      };
    };
  };
}>;

type AdminContractTemplateInput = {
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

type AdminContractInput = {
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

type AdminSettingValueInput = {
  valueCents: number;
};

const adminContractInclude = {
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

const contractTemplateCountInclude = {
  _count: {
    select: {
      contracts: true,
    },
  },
} satisfies Prisma.ContractTemplateInclude;

@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly redis: RedisService,
    private readonly emailService: ResendEmailService,
  ) {}

  async createContentReport(
    userId: string,
    input: {
      chapterSlug: string | null;
      details: string | null;
      reason: string;
      storySlug: string;
      title: string | null;
    },
  ) {
    const user = await this.requireActiveUser(userId);
    const story = await this.prisma.story.findUnique({
      where: {
        slug: input.storySlug,
      },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = input.chapterSlug
      ? await this.prisma.publishedChapter.findUnique({
          where: {
            storyId_slug: {
              slug: input.chapterSlug,
              storyId: story.id,
            },
          },
        })
      : null;

    const report = await this.prisma.contentReport.create({
      data: {
        chapterSlug: chapter?.slug ?? input.chapterSlug,
        details: input.details,
        publishedChapterId: chapter?.id ?? null,
        reason: input.reason,
        reporterUserId: userId,
        storyId: story.id,
        storySlug: story.slug,
        targetType: chapter ? "CHAPTER" : "STORY",
        title:
          input.title ??
          (chapter ? `${story.title} • ${chapter.title}` : story.title),
      },
    });

    return {
      message: "Report submitted. Our moderation team has been notified.",
      report: this.mapReport(report, story, chapter, user),
    };
  }

  async listSupportTickets(userId: string) {
    await this.requireActiveUser(userId);

    const tickets = await this.prisma.supportTicket.findMany({
      where: {
        requesterUserId: userId,
      },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    return {
      tickets: tickets.map((ticket) => ({
        category: ticket.category,
        id: ticket.id,
        messages: ticket.messages.map((message) => ({
          body: message.body,
          id: message.id,
          senderRole: message.senderRole,
          time: this.formatTime(message.createdAt),
        })),
        priority: ticket.priority,
        status: ticket.status,
        subject: ticket.subject,
        updatedAt: this.formatRelativeDate(ticket.updatedAt),
      })),
    };
  }

  async getSupportHelpCenter(userId: string) {
    await this.requireActiveUser(userId);

    // Try DB first, fall back to hardcoded data
    const dbCategories = await this.prisma.helpCenterCategory.findMany({
      include: { articles: { where: { published: true }, orderBy: { sortOrder: "asc" } } },
      orderBy: { sortOrder: "asc" },
    });
    const publishedArticleCount = dbCategories.reduce(
      (count, category) => count + category.articles.length,
      0,
    );

    if (dbCategories.length > 0 && publishedArticleCount > 0) {
      return {
        articles: dbCategories.flatMap((c) =>
          c.articles.map((a) => ({
            id: a.id,
            categoryId: a.categoryId,
            body: a.body,
            excerpt: a.excerpt,
            tag: a.tag,
            title: a.title,
          })),
        ),
        categories: dbCategories.map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description,
          icon: c.icon,
          articleCount: c.articles.length,
        })),
        supportActions: supportHelpCenterActions.map((action) => ({
          ...action,
        })),
      };
    }

    // Fallback to hardcoded data
    return {
      articles: supportHelpCenterArticles.map((article) => ({
        ...article,
      })),
      categories: supportHelpCenterCategories.map((category) => ({
        ...category,
        articleCount: supportHelpCenterArticles.filter(
          (article) => article.categoryId === category.id,
        ).length,
      })),
      supportActions: supportHelpCenterActions.map((action) => ({
        ...action,
      })),
    };
  }

  async createSupportTicket(
    userId: string,
    input: {
      category: "ACCOUNT" | "BILLING" | "CONTENT" | "CREATOR" | "TECHNICAL" | "GENERAL";
      message: string;
      priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
      subject: string;
    },
  ) {
    await this.requireActiveUser(userId);
    const assignedAdmin = await this.prisma.user.findFirst({
      where: {
        role: "ADMIN",
        status: "ACTIVE",
      },
      orderBy: {
        createdAt: "asc",
      },
      select: {
        id: true,
      },
    });

    const ticket = await this.prisma.supportTicket.create({
      data: {
        assignedAdminId: assignedAdmin?.id ?? null,
        category: input.category,
        latestPreview: input.message,
        priority: input.priority,
        requesterUserId: userId,
        subject: input.subject,
        messages: {
          create: {
            body: input.message,
            senderRole: "USER",
            senderUserId: userId,
          },
        },
      },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    return {
      message: "Support ticket created.",
      ticket: {
        category: ticket.category,
        id: ticket.id,
        messages: ticket.messages.map((message) => ({
          body: message.body,
          id: message.id,
          senderRole: message.senderRole,
          time: this.formatTime(message.createdAt),
        })),
        priority: ticket.priority,
        status: ticket.status,
        subject: ticket.subject,
        updatedAt: this.formatRelativeDate(ticket.updatedAt),
      },
    };
  }

  async getAdminOverview(adminUserId: string) {
    await this.requireAdmin(adminUserId);
    await this.ensureAdminDefaults();
    const todayRange = this.getDayRange();
    const yesterdayRange = this.getDayRange(
      new Date(todayRange.start.getTime() - 24 * 60 * 60 * 1000),
    );
    const monthRange = this.getMonthRange();

    const [
      activeUsers,
      activeUserBaseline,
      dailySignups,
      yesterdaySignups,
      dailyPurchaseRevenue,
      yesterdayPurchaseRevenue,
      monthlyPurchases,
      dailyAdUnlockCount,
      yesterdayAdUnlockCount,
      monthlyAdUnlockCount,
      publishedChapters,
      publishedChaptersToday,
      openReports,
      recentUsers,
      monthlyTargetSetting,
    ] = await Promise.all([
      this.prisma.user.count({
        where: {
          status: "ACTIVE",
        },
      }),
      this.prisma.user.count({
        where: {
          createdAt: {
            lt: todayRange.start,
          },
          status: "ACTIVE",
        },
      }),
      this.prisma.user.count({
        where: {
          createdAt: {
            gte: todayRange.start,
            lt: todayRange.end,
          },
        },
      }),
      this.prisma.user.count({
        where: {
          createdAt: {
            gte: yesterdayRange.start,
            lt: yesterdayRange.end,
          },
        },
      }),
      this.prisma.purchase.aggregate({
        _sum: {
          amountCents: true,
        },
        where: {
          completedAt: {
            gte: todayRange.start,
            lt: todayRange.end,
          },
          status: "COMPLETED",
        },
      }),
      this.prisma.purchase.aggregate({
        _sum: {
          amountCents: true,
        },
        where: {
          completedAt: {
            gte: yesterdayRange.start,
            lt: yesterdayRange.end,
          },
          status: "COMPLETED",
        },
      }),
      this.prisma.purchase.findMany({
        where: {
          completedAt: {
            gte: monthRange.start,
            lt: monthRange.end,
          },
          status: "COMPLETED",
        },
        select: {
          amountCents: true,
          kind: true,
        },
      }),
      this.prisma.adUnlockRecord.count({
        where: {
          createdAt: {
            gte: todayRange.start,
            lt: todayRange.end,
          },
        },
      }),
      this.prisma.adUnlockRecord.count({
        where: {
          createdAt: {
            gte: yesterdayRange.start,
            lt: yesterdayRange.end,
          },
        },
      }),
      this.prisma.adUnlockRecord.count({
        where: {
          createdAt: {
            gte: monthRange.start,
            lt: monthRange.end,
          },
        },
      }),
      this.prisma.publishedChapter.count(),
      this.prisma.publishedChapter.count({
        where: {
          publishedAt: {
            gte: todayRange.start,
            lt: todayRange.end,
          },
        },
      }),
      this.prisma.contentReport.findMany({
        where: {
          status: {
            in: ["OPEN", "IN_REVIEW"],
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 3,
        include: {
          reporter: {
            include: {
              profile: true,
            },
          },
          story: true,
          chapter: true,
        },
      }),
      this.prisma.user.findMany({
        where: {
          status: {
            in: ["ACTIVE", "SUSPENDED"],
          },
        },
        include: {
          profile: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 4,
      }),
      this.prisma.adminSetting.findUnique({
        where: {
          key: dashboardMonthlyRevenueTargetSettingKey,
        },
      }),
    ]);

    const dailyRevenueCents =
      (dailyPurchaseRevenue._sum.amountCents ?? 0) +
      dailyAdUnlockCount * AD_UNLOCK_REVENUE_CENTS;
    const yesterdayRevenueCents =
      (yesterdayPurchaseRevenue._sum.amountCents ?? 0) +
      yesterdayAdUnlockCount * AD_UNLOCK_REVENUE_CENTS;
    const monthlySubscriptionRevenueCents = monthlyPurchases
      .filter((purchase) => purchase.kind === "SUBSCRIPTION")
      .reduce((sum, purchase) => sum + purchase.amountCents, 0);
    const monthlyCoinRevenueCents = monthlyPurchases
      .filter((purchase) => purchase.kind === "COINS")
      .reduce((sum, purchase) => sum + purchase.amountCents, 0);
    const monthlyAdRevenueCents =
      monthlyAdUnlockCount * AD_UNLOCK_REVENUE_CENTS;
    const monthlyRevenueCents =
      monthlySubscriptionRevenueCents +
      monthlyCoinRevenueCents +
      monthlyAdRevenueCents;
    const monthlyTargetCents =
      monthlyTargetSetting?.valueCents ??
      defaultAdminSettings.find(
        (setting) => setting.key === dashboardMonthlyRevenueTargetSettingKey,
      )?.valueCents ??
      5_000_000;
    const achievedRatio =
      monthlyTargetCents > 0
        ? (monthlyRevenueCents / monthlyTargetCents) * 100
        : 0;
    const clampedAchievedRatio = Math.max(0, Math.min(achievedRatio, 100));

    return {
      financialHealth: {
        achieved: `${Math.max(0, achievedRatio).toFixed(1)}%`,
        breakdown: [
          {
            id: "subscriptions",
            label: "Subscriptions",
            value: this.formatCurrency(monthlySubscriptionRevenueCents),
          },
          {
            id: "coins",
            label: "Coin Store",
            value: this.formatCurrency(monthlyCoinRevenueCents),
          },
          {
            id: "ads",
            label: "Ad Unlocks",
            value: this.formatCurrency(monthlyAdRevenueCents),
          },
        ],
        monthlyTarget: this.formatCurrency(monthlyTargetCents),
        width: `${clampedAchievedRatio.toFixed(1)}%`,
      },
      overviewStats: [
        {
          delta: this.formatCountDelta(
            activeUsers,
            activeUserBaseline,
            "today",
          ),
          icon: "group",
          id: "active-users",
          label: "Total Active Users",
          mobileLabel: "Active Users",
          mobileValue: this.formatCompactNumber(activeUsers),
          tone: "emerald",
          value: this.formatNumber(activeUsers),
        },
        {
          delta: this.formatCountDelta(
            dailySignups,
            yesterdaySignups,
            "vs yday",
          ),
          icon: "person_add",
          id: "signups",
          label: "New Signups (Daily)",
          mobileLabel: "New Signups",
          mobileValue: this.formatCompactNumber(dailySignups),
          tone: "emerald",
          value: this.formatNumber(dailySignups),
        },
        {
          delta: this.formatCurrencyDelta(
            dailyRevenueCents,
            yesterdayRevenueCents,
            "vs yday",
          ),
          icon: "payments",
          id: "revenue",
          label: "Daily Revenue (Net)",
          mobileLabel: "Revenue",
          mobileValue: this.formatCompactCurrency(dailyRevenueCents),
          tone: "primary",
          value: this.formatCurrency(dailyRevenueCents),
        },
        {
          delta: `+${this.formatNumber(publishedChaptersToday)} today`,
          icon: "menu_book",
          id: "chapters",
          label: "Chapters Published",
          mobileLabel: "Chapters",
          mobileValue: this.formatCompactNumber(publishedChapters),
          tone: "emerald",
          value: this.formatNumber(publishedChapters),
        },
      ],
      recentReports: openReports.map((report) =>
        this.mapReport(report, report.story, report.chapter, report.reporter),
      ),
      recentUsers: await Promise.all(
        recentUsers.map((user) => this.mapAdminUserSummary(user)),
      ),
    };
  }

  async listAdminBooks(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {
    // Temporary debug logging for admin books pagination issues
    // eslint-disable-next-line no-console
    console.log("[admin/books] listAdminBooks called", {
      adminUserId,
      pagination,
    });

    await this.requireAdmin(adminUserId);
    await this.ensureAdminDefaults();
    const policy = await this.ensureBookPlatformDefaults();
    const { stories, hasMore, limit, offset } =
      await this.getAdminBookStories(undefined, pagination);

    // eslint-disable-next-line no-console
    console.log("[admin/books] fetched stories", {
      count: stories.length,
      hasMore,
      limit,
      offset,
    });

    const revenueByStoryId = await this.getBookRevenueMap(
      stories.map((story) => story.id),
    );

    return {
      inventory: stories.map((story) =>
        this.mapAdminBookInventoryItem(
          story,
          revenueByStoryId.get(story.id) ?? 0,
        ),
      ),
      inventoryStats: this.buildAdminBookStats(stories, revenueByStoryId),
      pageInfo: this.buildAdminPageInfo(limit, offset, hasMore),
      policy: {
        defaultCoinCap: policy.defaultCoinCap,
        defaultPremiumWindowHours: policy.defaultPremiumWindowHours,
        defaultReleaseMode: policy.defaultReleaseMode,
        defaultReleaseModeLabel: formatReleaseModeLabel(policy.defaultReleaseMode),
      },
    };
  }

  async getAdminBookDetails(adminUserId: string, storySlug: string) {
    await this.requireAdmin(adminUserId);
    await this.ensureAdminDefaults();
    const policy = await this.ensureBookPlatformDefaults();
    const story = await this.getAdminBookStoryOrThrow(storySlug);
    const revenueByStoryId = await this.getBookRevenueMap([story.id]);

    return {
      book: this.mapAdminBookDetail(
        story,
        policy,
        revenueByStoryId.get(story.id) ?? 0,
      ),
    };
  }

  async updateAdminBookPolicy(
    adminUserId: string,
    input: {
      defaultCoinCap: number;
      defaultPremiumWindowHours: number;
      defaultReleaseMode: AdminBookReleaseMode;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const policy = await this.prisma.bookPlatformPolicy.upsert({
      where: {
        key: defaultBookPlatformPolicy.key,
      },
      create: {
        defaultCoinCap: input.defaultCoinCap,
        defaultPremiumWindowHours: input.defaultPremiumWindowHours,
        defaultReleaseMode: input.defaultReleaseMode,
        key: defaultBookPlatformPolicy.key,
      },
      update: {
        defaultCoinCap: input.defaultCoinCap,
        defaultPremiumWindowHours: input.defaultPremiumWindowHours,
        defaultReleaseMode: input.defaultReleaseMode,
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `Updated platform book defaults to ${policy.defaultCoinCap} coins and ${formatPremiumWindowLabel(policy.defaultPremiumWindowHours)}.`,
      icon: "tune",
      summary: "Updated book platform policy",
      targetId: policy.id,
      targetType: "BOOK_POLICY",
    });

    return {
      message: "Book platform policy saved.",
      policy: {
        defaultCoinCap: policy.defaultCoinCap,
        defaultPremiumWindowHours: policy.defaultPremiumWindowHours,
        defaultReleaseMode: policy.defaultReleaseMode,
        defaultReleaseModeLabel: formatReleaseModeLabel(policy.defaultReleaseMode),
      },
    };
  }

  async updateAdminBookVisibility(
    adminUserId: string,
    storySlug: string,
    input: {
      reviewNotes: string | null;
      visibilityState: AdminBookVisibilityState;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const policy = await this.ensureBookPlatformDefaults();
    const story = await this.getAdminBookStoryOrThrow(storySlug);
    const nextControl = await this.prisma.storyAdminControl.upsert({
      where: {
        storyId: story.id,
      },
      create: {
        defaultPremiumWindowHours:
          story.adminControl?.defaultPremiumWindowHours ??
          policy.defaultPremiumWindowHours,
        globalCoinCap:
          story.adminControl?.globalCoinCap ?? policy.defaultCoinCap,
        lastUpdatedByAdminUserId: admin.id,
        releaseMode:
          story.adminControl?.releaseMode ?? policy.defaultReleaseMode,
        reviewNotes: input.reviewNotes,
        reviewedAt: new Date(),
        reviewedByAdminUserId: admin.id,
        storyId: story.id,
        visibilityState: input.visibilityState,
      },
      update: {
        lastUpdatedByAdminUserId: admin.id,
        reviewNotes: input.reviewNotes,
        reviewedAt: new Date(),
        reviewedByAdminUserId: admin.id,
        visibilityState: input.visibilityState,
      },
    });

    await this.prisma.story.update({
      where: {
        id: story.id,
      },
      data: {
        isLive: input.visibilityState === AdminBookVisibilityState.LIVE,
        liveAt:
          input.visibilityState === AdminBookVisibilityState.LIVE
            ? new Date()
            : null,
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `${story.title} is now ${formatVisibilityLabel(nextControl.visibilityState).toLowerCase()}.`,
      icon:
        nextControl.visibilityState === AdminBookVisibilityState.LIVE
          ? "visibility"
          : nextControl.visibilityState === AdminBookVisibilityState.HIDDEN
            ? "visibility_off"
            : "pending",
      summary: `Updated ${story.title} visibility`,
      targetId: story.id,
      targetType: "BOOK",
      tone:
        nextControl.visibilityState === AdminBookVisibilityState.HIDDEN
          ? "rose"
          : nextControl.visibilityState === AdminBookVisibilityState.LIVE
            ? "emerald"
            : "amber",
    });

    return {
      message: `${story.title} is now ${formatVisibilityLabel(nextControl.visibilityState).toLowerCase()}.`,
      visibilityState: nextControl.visibilityState,
    };
  }

  async updateAdminBookConfig(
    adminUserId: string,
    storySlug: string,
    input: {
      chapters: Array<{
        coinPriceOverride: number | null;
        lockedOverride: boolean | null;
        overrideEnabled: boolean;
        premiumWindowHoursOverride: number | null;
        publishedChapterId: string;
      }>;
      defaultPremiumWindowHours: number;
      globalCoinCap: number;
      reviewNotes: string | null;
      visibilityState: AdminBookVisibilityState | null;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const policy = await this.ensureBookPlatformDefaults();
    const story = await this.getAdminBookStoryOrThrow(storySlug);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.storyAdminControl.upsert({
        where: {
          storyId: story.id,
        },
        create: {
          defaultPremiumWindowHours: input.defaultPremiumWindowHours,
          globalCoinCap: input.globalCoinCap,
          lastUpdatedByAdminUserId: admin.id,
          releaseMode:
            story.adminControl?.releaseMode ?? policy.defaultReleaseMode,
          reviewNotes: input.reviewNotes,
          reviewedAt: input.visibilityState ? now : story.adminControl?.reviewedAt ?? null,
          reviewedByAdminUserId: input.visibilityState ? admin.id : story.adminControl?.reviewedByAdminUserId ?? null,
          storyId: story.id,
          visibilityState:
            input.visibilityState ??
            story.adminControl?.visibilityState ??
            getStoryVisibilityState(story),
        },
        update: {
          defaultPremiumWindowHours: input.defaultPremiumWindowHours,
          globalCoinCap: input.globalCoinCap,
          lastUpdatedByAdminUserId: admin.id,
          reviewNotes: input.reviewNotes,
          reviewedAt: input.visibilityState ? now : story.adminControl?.reviewedAt ?? null,
          reviewedByAdminUserId: input.visibilityState ? admin.id : story.adminControl?.reviewedByAdminUserId ?? null,
          visibilityState:
            input.visibilityState ?? story.adminControl?.visibilityState,
        },
      });

      for (const chapterInput of input.chapters) {
        const publishedChapter = story.publishedChapters.find(
          (chapter) => chapter.id === chapterInput.publishedChapterId,
        );

        if (!publishedChapter) {
          throw new NotFoundException("Published chapter not found.");
        }

        await tx.publishedChapterAdminOverride.upsert({
          where: {
            publishedChapterId: publishedChapter.id,
          },
          create: {
            coinPriceOverride: chapterInput.overrideEnabled
              ? chapterInput.coinPriceOverride
              : null,
            lockedOverride: chapterInput.overrideEnabled
              ? chapterInput.lockedOverride
              : null,
            overrideEnabled: chapterInput.overrideEnabled,
            premiumWindowHoursOverride: chapterInput.overrideEnabled
              ? chapterInput.premiumWindowHoursOverride
              : null,
            publishedChapterId: publishedChapter.id,
            updatedByAdminUserId: admin.id,
          },
          update: {
            coinPriceOverride: chapterInput.overrideEnabled
              ? chapterInput.coinPriceOverride
              : null,
            lockedOverride: chapterInput.overrideEnabled
              ? chapterInput.lockedOverride
              : null,
            overrideEnabled: chapterInput.overrideEnabled,
            premiumWindowHoursOverride: chapterInput.overrideEnabled
              ? chapterInput.premiumWindowHoursOverride
              : null,
            updatedByAdminUserId: admin.id,
          },
        });
      }
    });

    if (input.visibilityState) {
      await this.prisma.story.update({
        where: {
          id: story.id,
        },
        data: {
          isLive: input.visibilityState === AdminBookVisibilityState.LIVE,
          liveAt:
            input.visibilityState === AdminBookVisibilityState.LIVE ? now : null,
        },
      });
    }

    await this.logAdminAction(admin.id, {
      detail: `Saved admin release controls for ${story.title}.`,
      icon: "settings_suggest",
      summary: `Saved ${story.title} book controls`,
      targetId: story.id,
      targetType: "BOOK",
    });

    return {
      book: await this.getAdminBookDetails(adminUserId, storySlug).then(
        (response) => response.book,
      ),
      message: `${story.title} controls saved.`,
    };
  }

  async listAdminContractTemplates(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const templates = await this.prisma.contractTemplate.findMany({
      include: contractTemplateCountInclude,
      orderBy: {
        updatedAt: "desc",
      },
    });

    return {
      templates: templates.map((template) =>
        this.mapAdminContractTemplateSummary(template),
      ),
    };
  }

  async getAdminContractTemplate(adminUserId: string, templateId: string) {
    await this.requireAdmin(adminUserId);
    const template = await this.getContractTemplateOrThrow(templateId);

    return {
      template: this.mapAdminContractTemplateDetail(template),
    };
  }

  async createAdminContractTemplate(
    adminUserId: string,
    input: AdminContractTemplateInput,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const template = await this.prisma.contractTemplate.create({
      data: {
        advancePaymentCents: input.advancePaymentCents,
        body: input.body,
        companyName: input.companyName,
        createdByAdminUserId: admin.id,
        description: input.description,
        exclusivity: input.exclusivity,
        geographicRights: input.geographicRights,
        revenueSharePercent: input.revenueSharePercent,
        signingBonusCoins: input.signingBonusCoins,
        templateName: input.templateName,
        termMonths: input.termMonths,
        updatedByAdminUserId: admin.id,
      },
      include: contractTemplateCountInclude,
    });

    await this.logAdminAction(admin.id, {
      detail: `Created contract template ${template.templateName}.`,
      icon: "description",
      summary: `Created template ${template.templateName}`,
      targetId: template.id,
      targetType: "CONTRACT_TEMPLATE",
    });

    return {
      message: `Template "${template.templateName}" saved.`,
      template: this.mapAdminContractTemplateDetail(template),
    };
  }

  async updateAdminContractTemplate(
    adminUserId: string,
    templateId: string,
    input: AdminContractTemplateInput,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    await this.getContractTemplateOrThrow(templateId);

    const template = await this.prisma.contractTemplate.update({
      where: {
        id: templateId,
      },
      data: {
        advancePaymentCents: input.advancePaymentCents,
        body: input.body,
        companyName: input.companyName,
        description: input.description,
        exclusivity: input.exclusivity,
        geographicRights: input.geographicRights,
        revenueSharePercent: input.revenueSharePercent,
        signingBonusCoins: input.signingBonusCoins,
        templateName: input.templateName,
        termMonths: input.termMonths,
        updatedByAdminUserId: admin.id,
      },
      include: contractTemplateCountInclude,
    });

    await this.logAdminAction(admin.id, {
      detail: `Updated contract template ${template.templateName}.`,
      icon: "edit_document",
      summary: `Updated template ${template.templateName}`,
      targetId: template.id,
      targetType: "CONTRACT_TEMPLATE",
    });

    return {
      message: `Template "${template.templateName}" updated.`,
      template: this.mapAdminContractTemplateDetail(template),
    };
  }

  async listAdminContracts(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const contracts = await this.prisma.contract.findMany({
      include: adminContractInclude,
      orderBy: {
        updatedAt: "desc",
      },
    });

    return {
      contracts: contracts.map((contract) => this.mapAdminContractSummary(contract)),
    };
  }

  async getAdminContractLookups(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const contractRevenueDefaults =
      await this.getCreatorRevenueShareDefaults();

    const [users, stories, templates] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          status: {
            not: "DELETED",
          },
        },
        select: {
          email: true,
          id: true,
          profile: {
            select: {
              displayName: true,
            },
          },
          status: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      this.prisma.story.findMany({
        select: {
          author: {
            select: {
              profile: {
                select: {
                  displayName: true,
                },
              },
            },
          },
          authorName: true,
          id: true,
          slug: true,
          status: true,
          title: true,
        },
        orderBy: {
          updatedAt: "desc",
        },
      }),
      this.prisma.contractTemplate.findMany({
        orderBy: {
          updatedAt: "desc",
        },
        select: {
          companyName: true,
          exclusivity: true,
          id: true,
          revenueSharePercent: true,
          templateName: true,
          termMonths: true,
        },
      }),
    ]);

    return {
      stories: stories.map((story) => ({
        authorName: story.author?.profile?.displayName ?? story.authorName,
        id: story.id,
        slug: story.slug,
        status: story.status,
        title: story.title,
      })),
      templates: templates.map((template) => ({
        companyName: template.companyName,
        exclusivity: template.exclusivity,
        id: template.id,
        revenueSharePercent: template.revenueSharePercent,
        templateName: template.templateName,
        termMonths: template.termMonths,
      })),
      users: users.map((user) => ({
        displayName: user.profile?.displayName ?? user.email!.split("@")[0],
        email: user.email!,
        id: user.id,
        status: user.status,
      })),
      revenueShareDefaults: contractRevenueDefaults,
    };
  }

  async getAdminContract(adminUserId: string, contractId: string) {
    await this.requireAdmin(adminUserId);
    const contract = await this.getContractOrThrow(contractId);

    return {
      contract: this.mapAdminContractDetail(contract),
    };
  }

  async createAdminContract(adminUserId: string, input: AdminContractInput) {
    const admin = await this.requireAdmin(adminUserId);
    await this.assertContractPartyEligibleForRevenueShare(
      input.userId,
      input.revenueSharePercent,
    );
    const [party, story, template] = await Promise.all([
      this.getContractPartyUserOrThrow(input.userId),
      this.getContractStoryOrThrow(input.storyId),
      input.templateId ? this.getContractTemplateOrThrow(input.templateId) : null,
    ]);
    const sequence = await this.nextAdminSequenceValue("contract");
    const displayId = this.formatContractDisplayId(sequence);
    const lifecycleFields = this.getContractLifecycleUpdate(null, input.status);

    const contract = await this.prisma.contract.create({
      data: {
        advancePaymentCents: input.advancePaymentCents,
        activatedAt: lifecycleFields.activatedAt,
        body: input.body,
        companyName: input.companyName,
        contractType: input.contractType,
        createdByAdminUserId: admin.id,
        displayId,
        endedAt: lifecycleFields.endedAt,
        geographicRights: input.geographicRights,
        partyRole: input.partyRole,
        revenueSharePercent: input.revenueSharePercent,
        signingBonusCoins: input.signingBonusCoins,
        status: input.status,
        storyId: input.storyId,
        templateId: template?.id ?? null,
        templateName: input.templateName,
        termMonths: input.termMonths,
        updatedByAdminUserId: admin.id,
        userId: input.userId,
      },
      include: adminContractInclude,
    });

    await this.logAdminAction(admin.id, {
      detail: `Created ${displayId} for ${this.getDisplayName(party)} on ${story.title}.`,
      icon: "description",
      summary: `Created contract ${displayId}`,
      targetId: contract.id,
      targetType: "CONTRACT",
    });

    return {
      contract: this.mapAdminContractDetail(contract),
      message: `${displayId} created.`,
    };
  }

  async updateAdminContract(
    adminUserId: string,
    contractId: string,
    input: AdminContractInput,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const existingContract = await this.getContractOrThrow(contractId);
    await this.assertContractPartyEligibleForRevenueShare(
      input.userId,
      input.revenueSharePercent,
    );
    const [party, story, template] = await Promise.all([
      this.getContractPartyUserOrThrow(input.userId),
      this.getContractStoryOrThrow(input.storyId),
      input.templateId ? this.getContractTemplateOrThrow(input.templateId) : null,
    ]);
    const lifecycleFields = this.getContractLifecycleUpdate(
      {
        activatedAt: existingContract.activatedAt,
        endedAt: existingContract.endedAt,
        status: existingContract.status,
      },
      input.status,
    );

    const contract = await this.prisma.contract.update({
      where: {
        id: contractId,
      },
      data: {
        advancePaymentCents: input.advancePaymentCents,
        activatedAt: lifecycleFields.activatedAt,
        body: input.body,
        companyName: input.companyName,
        contractType: input.contractType,
        endedAt: lifecycleFields.endedAt,
        geographicRights: input.geographicRights,
        partyRole: input.partyRole,
        revenueSharePercent: input.revenueSharePercent,
        signingBonusCoins: input.signingBonusCoins,
        status: input.status,
        storyId: input.storyId,
        templateId: template?.id ?? null,
        templateName: input.templateName,
        termMonths: input.termMonths,
        updatedByAdminUserId: admin.id,
        userId: input.userId,
      },
      include: adminContractInclude,
    });

    await this.logAdminAction(admin.id, {
      detail: `Updated ${contract.displayId} for ${this.getDisplayName(party)} on ${story.title}.`,
      icon: "edit_document",
      summary: `Updated contract ${contract.displayId}`,
      targetId: contract.id,
      targetType: "CONTRACT",
    });

    return {
      contract: this.mapAdminContractDetail(contract),
      message: `${contract.displayId} updated.`,
    };
  }

  async listAdminUsers(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {
    await this.requireAdmin(adminUserId);

    const limit = this.resolveAdminListLimit(pagination.limit);
    const offset = pagination.offset ?? 0;
    const users = await this.prisma.user.findMany({
      include: {
        profile: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: offset,
      take: limit + 1,
    });
    const hasMore = users.length > limit;
    const slicedUsers = hasMore ? users.slice(0, limit) : users;

    return {
      users: await Promise.all(
        slicedUsers.map((user) => this.mapAdminUserSummary(user)),
      ),
      pageInfo: this.buildAdminPageInfo(limit, offset, hasMore),
    };
  }

  async getAdminUserDetails(adminUserId: string, targetUserId: string) {
    await this.requireAdmin(adminUserId);

    const user = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      include: {
        profile: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found.");
    }

    return {
      user: await this.mapAdminUserDetails(user),
    };
  }

  async updateAdminUser(
    adminUserId: string,
    targetUserId: string,
    input: {
      bio: string | null;
      displayName: string;
      email: string;
      location: string | null;
      role: string;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const user = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      include: {
        profile: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found.");
    }

    const nextRole = this.mapUiRoleToDb(input.role);
    const updatedUser = await this.prisma.user.update({
      where: {
        id: targetUserId,
      },
      data: {
        email: input.email,
        role: nextRole,
        profile: {
          upsert: {
            create: {
              bio: input.bio,
              displayName: input.displayName,
              location: input.location,
            },
            update: {
              bio: input.bio,
              displayName: input.displayName,
              location: input.location,
            },
          },
        },
      },
      include: {
        profile: true,
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `Updated identity fields and role for ${input.displayName}.`,
      icon: "edit",
      summary: `Updated ${input.displayName}`,
      targetId: targetUserId,
      targetType: "USER",
    });

    return {
      message: `${input.displayName} profile saved.`,
      user: await this.mapAdminUserDetails(updatedUser),
    };
  }

  async updateAdminUserStatus(
    adminUserId: string,
    targetUserId: string,
    action: "SUSPEND" | "RESTORE" | "DELETE",
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const user = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      include: {
        profile: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found.");
    }

    const nextStatus =
      action === "SUSPEND"
        ? "SUSPENDED"
        : action === "RESTORE"
          ? "ACTIVE"
          : "DELETED";
    const updatedUser = await this.prisma.user.update({
      where: {
        id: targetUserId,
      },
      data: {
        status: nextStatus,
      },
      include: {
        profile: true,
      },
    });

    // Revoke all active sessions when suspending or deleting a user
    if (nextStatus === "SUSPENDED" || nextStatus === "DELETED") {
      const activeSessions = await this.prisma.session.findMany({
        where: { userId: targetUserId, revokedAt: null },
        select: { id: true },
      });

      if (activeSessions.length > 0) {
        await this.prisma.session.updateMany({
          where: { userId: targetUserId, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        // Clear Redis session caches
        for (const session of activeSessions) {
          await this.redis.delete(`auth:session:${session.id}`);
        }
      }
    }

    await this.logAdminAction(admin.id, {
      detail: `${this.getDisplayName(updatedUser)} status changed to ${this.mapStatusLabel(nextStatus)}.`,
      icon: action === "DELETE" ? "delete" : action === "SUSPEND" ? "block" : "check",
      summary:
        action === "DELETE"
          ? `Deleted ${this.getDisplayName(updatedUser)}`
          : action === "SUSPEND"
            ? `Suspended ${this.getDisplayName(updatedUser)}`
            : `Reactivated ${this.getDisplayName(updatedUser)}`,
      targetId: targetUserId,
      targetType: "USER",
      tone: action === "DELETE" || action === "SUSPEND" ? "rose" : "emerald",
    });

    return {
      message:
        action === "DELETE"
          ? `${this.getDisplayName(updatedUser)} was marked as deleted.`
          : action === "SUSPEND"
            ? `${this.getDisplayName(updatedUser)} has been suspended.`
            : `${this.getDisplayName(updatedUser)} has been restored.`,
      user: await this.mapAdminUserDetails(updatedUser),
    };
  }

  async resetAdminUserPassword(adminUserId: string, targetUserId: string) {
    const admin = await this.requireAdmin(adminUserId);
    const user = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      include: {
        profile: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found.");
    }

    await this.authService.forgotPassword({
      email: user.email!,
    });

    await this.logAdminAction(admin.id, {
      detail: `Password reset flow triggered for ${this.getDisplayName(user)}.`,
      icon: "lock_reset",
      summary: `Triggered password reset for ${this.getDisplayName(user)}`,
      targetId: targetUserId,
      targetType: "USER",
      tone: "amber",
    });

    return {
      message: `Password reset email sent to ${user.email}.`,
    };
  }

  async listAdminReports(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {
    await this.requireAdmin(adminUserId);

    const limit = this.resolveAdminListLimit(pagination.limit);
    const offset = pagination.offset ?? 0;
    const reports = await this.prisma.contentReport.findMany({
      include: {
        reporter: {
          include: {
            profile: true,
          },
        },
        story: true,
        chapter: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: offset,
      take: limit + 1,
    });
    const hasMore = reports.length > limit;
    const slicedReports = hasMore ? reports.slice(0, limit) : reports;

    return {
      reports: slicedReports.map((report) =>
        this.mapReport(report, report.story, report.chapter, report.reporter),
      ),
      pageInfo: this.buildAdminPageInfo(limit, offset, hasMore),
    };
  }

  async resolveAdminReport(
    adminUserId: string,
    reportId: string,
    input: {
      action: "RESOLVED" | "TAKEDOWN" | "DISMISSED" | "IN_REVIEW";
      notes: string | null;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const report = await this.prisma.contentReport.findUnique({
      where: {
        id: reportId,
      },
      include: {
        reporter: {
          include: {
            profile: true,
          },
        },
        story: true,
        chapter: true,
      },
    });

    if (!report) {
      throw new NotFoundException("Report not found.");
    }

    const updatedReport = await this.prisma.contentReport.update({
      where: {
        id: reportId,
      },
      data: {
        assignedAdminId: admin.id,
        resolutionNotes: input.notes,
        status: input.action,
      },
      include: {
        reporter: {
          include: {
            profile: true,
          },
        },
        story: true,
        chapter: true,
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `${updatedReport.title} was marked ${this.mapReportStatusLabel(input.action).toLowerCase()}.`,
      icon: input.action === "TAKEDOWN" ? "delete" : "gavel",
      summary: `${this.mapReportStatusLabel(input.action)} moderation item`,
      targetId: reportId,
      targetType: "REPORT",
      tone: input.action === "TAKEDOWN" ? "rose" : "emerald",
    });

    return {
      message: `${updatedReport.title} marked as ${this.mapReportStatusLabel(input.action).toLowerCase()}.`,
      report: this.mapReport(
        updatedReport,
        updatedReport.story,
        updatedReport.chapter,
        updatedReport.reporter,
      ),
    };
  }

  async listAdminComments(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {
    await this.requireAdmin(adminUserId);

    const limit = this.resolveAdminListLimit(pagination.limit);
    const offset = pagination.offset ?? 0;
    const comments = await this.prisma.comment.findMany({
      include: {
        chapter: true,
        parent: {
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        },
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: offset,
      take: limit + 1,
    });
    const hasMore = comments.length > limit;
    const slicedComments = hasMore ? comments.slice(0, limit) : comments;

    return {
      comments: slicedComments.map((comment) => this.mapAdminComment(comment)),
      pageInfo: this.buildAdminPageInfo(limit, offset, hasMore),
      summary: {
        deletedCount: slicedComments.filter(
          (comment) => comment.status === CommentStatus.DELETED,
        ).length,
        hiddenCount: slicedComments.filter(
          (comment) => comment.status === CommentStatus.HIDDEN,
        ).length,
        replyCount: slicedComments.filter((comment) =>
          Boolean(comment.parentCommentId),
        ).length,
        visibleCount: slicedComments.filter(
          (comment) => comment.status === CommentStatus.VISIBLE,
        ).length,
      },
    };
  }

  async moderateAdminComment(
    adminUserId: string,
    commentId: string,
    input: {
      action: "HIDE" | "RESTORE" | "DELETE";
      notes: string | null;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const existingComment = await this.prisma.comment.findUnique({
      where: {
        id: commentId,
      },
      include: {
        chapter: true,
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!existingComment) {
      throw new NotFoundException("Comment not found.");
    }

    const nextStatus =
      input.action === "RESTORE"
        ? CommentStatus.VISIBLE
        : input.action === "HIDE"
          ? CommentStatus.HIDDEN
          : CommentStatus.DELETED;
    const moderatedComment = await this.prisma.comment.update({
      where: {
        id: commentId,
      },
      data: {
        moderatedAt: new Date(),
        moderatedByAdminUserId: admin.id,
        moderationNotes: input.notes,
        status: nextStatus,
      },
      include: {
        chapter: true,
        parent: {
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        },
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `${this.getDisplayName(moderatedComment.user)}'s comment on ${moderatedComment.story.title} was ${nextStatus.toLowerCase()}.`,
      icon:
        input.action === "RESTORE"
          ? "history"
          : input.action === "HIDE"
            ? "visibility_off"
            : "delete",
      summary: `${this.mapAdminCommentStatus(nextStatus)} comment moderation`,
      targetId: commentId,
      targetType: "COMMENT",
      tone: input.action === "RESTORE" ? "emerald" : "rose",
    });

    return {
      comment: this.mapAdminComment(moderatedComment),
      message:
        input.action === "RESTORE"
          ? "Comment restored."
          : input.action === "HIDE"
            ? "Comment hidden."
            : "Comment deleted.",
    };
  }

  async listAdminReviews(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {
    await this.requireAdmin(adminUserId);

    const limit = this.resolveAdminListLimit(pagination.limit);
    const offset = pagination.offset ?? 0;
    const reviews = await this.prisma.review.findMany({
      include: {
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      skip: offset,
      take: limit + 1,
    });
    const hasMore = reviews.length > limit;
    const slicedReviews = hasMore ? reviews.slice(0, limit) : reviews;

    return {
      reviews: slicedReviews.map((review) => this.mapAdminReview(review)),
      pageInfo: this.buildAdminPageInfo(limit, offset, hasMore),
      summary: {
        deletedCount: slicedReviews.filter(
          (review) => review.status === ReviewStatus.DELETED,
        ).length,
        hiddenCount: slicedReviews.filter(
          (review) => review.status === ReviewStatus.HIDDEN,
        ).length,
        spoilerCount: slicedReviews.filter((review) => review.containsSpoilers)
          .length,
        visibleCount: slicedReviews.filter(
          (review) => review.status === ReviewStatus.VISIBLE,
        ).length,
      },
    };
  }

  async moderateAdminReview(
    adminUserId: string,
    reviewId: string,
    input: {
      action: "HIDE" | "RESTORE" | "DELETE";
      notes: string | null;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const existingReview = await this.prisma.review.findUnique({
      where: {
        id: reviewId,
      },
      include: {
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!existingReview) {
      throw new NotFoundException("Review not found.");
    }

    const nextStatus =
      input.action === "RESTORE"
        ? ReviewStatus.VISIBLE
        : input.action === "HIDE"
          ? ReviewStatus.HIDDEN
          : ReviewStatus.DELETED;
    const moderatedReview = await this.prisma.review.update({
      where: {
        id: reviewId,
      },
      data: {
        moderatedAt: new Date(),
        moderatedByAdminUserId: admin.id,
        moderationNotes: input.notes,
        status: nextStatus,
      },
      include: {
        story: true,
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `${this.getDisplayName(moderatedReview.user)}'s review on ${moderatedReview.story.title} was ${nextStatus.toLowerCase()}.`,
      icon:
        input.action === "RESTORE"
          ? "history"
          : input.action === "HIDE"
            ? "visibility_off"
            : "delete",
      summary: `${this.mapAdminReviewStatus(nextStatus)} review moderation`,
      targetId: reviewId,
      targetType: "REVIEW",
      tone: input.action === "RESTORE" ? "emerald" : "rose",
    });

    return {
      message:
        input.action === "RESTORE"
          ? "Review restored."
          : input.action === "HIDE"
            ? "Review hidden."
            : "Review deleted.",
      review: this.mapAdminReview(moderatedReview),
    };
  }

  async getAdminMonetization(adminUserId: string) {
    await this.requireAdmin(adminUserId);
    await this.ensureAdminDefaults();

    const [purchases, subscriptions, coinPackages, payouts] = await Promise.all([
      this.prisma.purchase.findMany({
        where: {
          status: "COMPLETED",
        },
        include: {
          coinPackage: true,
        },
      }),
      this.prisma.subscription.findMany({
        where: {
          status: {
            in: ["ACTIVE", "TRIALING", "PAST_DUE"],
          },
        },
        include: {
          plan: true,
        },
      }),
      this.prisma.coinPackage.findMany(),
      this.prisma.creatorPayout.findMany({
        include: {
          creator: {
            include: {
              profile: true,
            },
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
      }),
    ]);

    const totalRevenueCents = purchases.reduce(
      (sum, purchase) => sum + purchase.amountCents,
      0,
    );
    const subscriptionRevenueCents = purchases
      .filter((purchase) => purchase.kind === "SUBSCRIPTION")
      .reduce((sum, purchase) => sum + purchase.amountCents, 0);
    const coinRevenueCents = purchases
      .filter((purchase) => purchase.kind === "COINS")
      .reduce((sum, purchase) => sum + purchase.amountCents, 0);
    const adRevenueCents =
      (await this.prisma.adUnlockRecord.count()) * AD_UNLOCK_REVENUE_CENTS;
    const purchasers = new Set(purchases.map((purchase) => purchase.userId)).size;
    const arpu = purchasers ? totalRevenueCents / purchasers : 0;
    const totalStreamCents =
      subscriptionRevenueCents + coinRevenueCents + adRevenueCents;
    const withdrawalPayouts = payouts.filter((payout) =>
      isCreatorWithdrawalPeriodLabel(payout.periodLabel),
    );

    const packageCounts = purchases.reduce((map, purchase) => {
      if (!purchase.coinPackageId) {
        return map;
      }

      map.set(
        purchase.coinPackageId,
        (map.get(purchase.coinPackageId) ?? 0) + 1,
      );
      return map;
    }, new Map());

    return {
      monetizationStats: [
        {
          delta: `${subscriptions.length} active`,
          icon: "payments",
          id: "revenue",
          label: "Total Revenue",
          value: this.formatCurrency(totalRevenueCents),
        },
        {
          delta: `${subscriptions.length} plans`,
          icon: "workspace_premium",
          id: "mrr",
          label: "Monthly Recurring",
          value: this.formatCurrency(subscriptionRevenueCents),
        },
        {
          delta: `${purchasers} buyers`,
          icon: "analytics",
          id: "arpu",
          label: "Avg. ARPU",
          value: this.formatCurrency(Math.round(arpu)),
        },
      ],
      monetizationStreams: [
        {
          id: "subs",
          label: "Subscriptions",
          value: this.formatCurrency(subscriptionRevenueCents),
          width: `${this.getPercentWidth(subscriptionRevenueCents, totalStreamCents)}%`,
        },
        {
          id: "coins",
          label: "Coins",
          value: this.formatCurrency(coinRevenueCents),
          width: `${this.getPercentWidth(coinRevenueCents, totalStreamCents)}%`,
        },
        {
          id: "ads",
          label: "Ad Revenue",
          value: this.formatCurrency(adRevenueCents),
          width: `${this.getPercentWidth(adRevenueCents, totalStreamCents)}%`,
        },
      ],
      payoutQueue: withdrawalPayouts.map((payout) => ({
        amount: this.formatCurrency(payout.amountCents),
        author: this.getDisplayName(payout.creator),
        id: payout.id,
        status:
          payout.status === "RELEASED"
            ? "Released"
            : payout.status === "IN_REVIEW"
              ? "Review"
              : "Ready",
      })),
      topCoinPackages: coinPackages
        .map((coinPackage) => ({
          id: coinPackage.id,
          label: `${coinPackage.coins + coinPackage.bonusCoins} Coins`,
          price: this.formatCurrency(coinPackage.priceCents),
          sold: `${this.formatCompactNumber(packageCounts.get(coinPackage.id) ?? 0)} packs`,
        }))
        .sort((left, right) => {
          const leftCount = Number(left.sold.replace(/[^\d]/g, "")) || 0;
          const rightCount = Number(right.sold.replace(/[^\d]/g, "")) || 0;
          return rightCount - leftCount;
        })
        .slice(0, 3),
    };
  }

  async updatePayoutStatus(
    adminUserId: string,
    payoutId: string,
    action: string,
    notes?: string | null,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const payout = await this.prisma.creatorPayout.findUnique({
      where: {
        id: payoutId,
      },
      include: {
        creator: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!payout) {
      throw new NotFoundException("Payout not found.");
    }

    let nextStatus: string;
    let summaryPrefix: string;

    if (action === "RELEASE") {
      // Check two-person payout review setting
      const twoPersonSetting = await this.prisma.adminSetting.findUnique({
        where: { key: "twoPersonPayoutReview" },
      });
      if (
        twoPersonSetting?.enabled &&
        payout.reviewedByAdminUserId === adminUserId
      ) {
        throw new BadRequestException(
          "Two-person review is enabled. A different admin must release this payout.",
        );
      }

      nextStatus = "RELEASED";
      summaryPrefix = "Released payout for";
    } else if (action === "REVIEW") {
      nextStatus = "IN_REVIEW";
      summaryPrefix = "Opened payout review for";
    } else if (action === "REJECT") {
      nextStatus = "REJECTED";
      summaryPrefix = "Rejected payout for";
    } else {
      throw new BadRequestException(
        "Action must be one of: RELEASE, REVIEW, REJECT.",
      );
    }

    const updateData: Record<string, unknown> = {
      status: nextStatus,
      reviewNotes: notes ?? null,
    };

    if (action === "REVIEW") {
      updateData.reviewedByAdminUserId = adminUserId;
    } else if (action === "RELEASE") {
      updateData.releasedByAdminUserId = adminUserId;
    }

    const updatedPayout = await this.prisma.creatorPayout.update({
      where: {
        id: payoutId,
      },
      data: updateData,
      include: {
        creator: {
          include: {
            profile: true,
          },
        },
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `${this.getDisplayName(updatedPayout.creator)} payout moved to ${nextStatus}.`,
      icon: "payments",
      summary: `${summaryPrefix} ${this.getDisplayName(updatedPayout.creator)}`,
      targetId: payoutId,
      targetType: "PAYOUT",
    });

    // Send email notification on release
    if (action === "RELEASE" && updatedPayout.creator.email) {
      try {
        await this.emailService.sendPayoutProcessed({
          email: updatedPayout.creator.email,
          userName: this.getDisplayName(updatedPayout.creator),
          amount: this.formatCurrency(updatedPayout.amountCents),
        });
      } catch {
        // Non-critical: don't fail the payout release if email fails
      }
    }

    const messages: Record<string, string> = {
      RELEASE: `Payout release started for ${this.getDisplayName(updatedPayout.creator)}.`,
      REVIEW: `Finance review opened for ${this.getDisplayName(updatedPayout.creator)}.`,
      REJECT: `Payout rejected for ${this.getDisplayName(updatedPayout.creator)}.`,
    };

    return {
      message: messages[action] ?? "Payout status updated.",
    };
  }

  // --- Admin Refunds ---

  async listAdminRefunds(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const refunds = await this.prisma.refundRequest.findMany({
      include: {
        user: { include: { profile: true } },
        purchase: { include: { coinPackage: true, plan: true } },
      },
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_DEFAULT_LIMIT,
    });

    return {
      refunds: refunds.map((r) => ({
        id: r.id,
        userId: r.userId,
        userName: this.getDisplayName(r.user),
        purchaseId: r.purchaseId,
        purchaseLabel:
          r.purchase.coinPackage?.name ??
          r.purchase.plan?.name ??
          r.purchase.kind,
        reason: r.reason,
        amountCents: r.amountCents,
        amountFormatted: this.formatCurrency(r.amountCents),
        status: r.status,
        reviewNotes: r.reviewNotes,
        createdAt: r.createdAt.toISOString(),
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
      })),
    };
  }

  async resolveAdminRefund(
    adminUserId: string,
    refundId: string,
    action: string,
    notes: string | null,
  ) {
    const admin = await this.requireAdmin(adminUserId);

    const refund = await this.prisma.refundRequest.findUnique({
      where: { id: refundId },
      include: {
        user: { include: { profile: true } },
        purchase: true,
      },
    });

    if (!refund) {
      throw new NotFoundException("Refund request not found.");
    }

    if (refund.status !== "PENDING") {
      throw new BadRequestException("This refund has already been resolved.");
    }

    if (action !== "APPROVE" && action !== "REJECT") {
      throw new BadRequestException("Action must be APPROVE or REJECT.");
    }

    const nextStatus = action === "APPROVE" ? "APPROVED" : "REJECTED";

    await this.prisma.refundRequest.update({
      where: { id: refundId },
      data: {
        status: nextStatus,
        reviewNotes: notes,
        reviewedAt: new Date(),
        reviewedById: adminUserId,
      },
    });

    // If approved, mark purchase as refunded and restore coins
    if (action === "APPROVE") {
      await this.prisma.$transaction(async (tx) => {
        await tx.purchase.update({
          where: { id: refund.purchaseId },
          data: { status: "REFUNDED" },
        });

        // Restore coins to user wallet
        if (refund.amountCents > 0) {
          const coinsToRestore = refund.amountCents; // 1:1 cents to coins
          const wallet = await tx.wallet.upsert({
            where: { userId: refund.userId },
            create: { userId: refund.userId, balanceCoins: coinsToRestore },
            update: { balanceCoins: { increment: coinsToRestore } },
          });

          await tx.walletLedgerEntry.create({
            data: {
              wallet: { connect: { id: wallet.id } },
              user: { connect: { id: refund.userId } },
              entryType: "CREDIT",
              reason: "REFUND",
              deltaCoins: coinsToRestore,
              balanceAfter: wallet.balanceCoins,
              note: `Refund for purchase ${refund.purchaseId}`,
              idempotencyKey: `refund:${refundId}`,
            },
          });
        }
      });

      await this.prisma.refundRequest.update({
        where: { id: refundId },
        data: { status: "PROCESSED" },
      });
    }

    await this.logAdminAction(admin.id, {
      detail: `Refund request from ${this.getDisplayName(refund.user)} ${action === "APPROVE" ? "approved and processed" : "rejected"}.${notes ? ` Notes: ${notes}` : ""}`,
      icon: "receipt_long",
      summary: `${action === "APPROVE" ? "Approved" : "Rejected"} refund for ${this.getDisplayName(refund.user)}`,
      targetId: refundId,
      targetType: "REFUND",
    });

    return {
      message:
        action === "APPROVE"
          ? `Refund approved and processed for ${this.getDisplayName(refund.user)}.`
          : `Refund rejected for ${this.getDisplayName(refund.user)}.`,
    };
  }

  // --- Admin Tax Forms ---

  async listAdminTaxForms(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const taxForms = await this.prisma.taxForm.findMany({
      include: {
        user: { include: { profile: true } },
      },
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_DEFAULT_LIMIT,
    });

    return {
      taxForms: taxForms.map((form) => ({
        id: form.id,
        userId: form.userId,
        userName: this.getDisplayName(form.user),
        formType: form.formType,
        status: form.status,
        submittedAt: form.submittedAt?.toISOString() ?? null,
        reviewedAt: form.reviewedAt?.toISOString() ?? null,
        createdAt: form.createdAt.toISOString(),
      })),
    };
  }

  async reviewAdminTaxForm(
    adminUserId: string,
    taxFormId: string,
    status: string,
    notes: string | null,
  ) {
    const admin = await this.requireAdmin(adminUserId);

    const taxForm = await this.prisma.taxForm.findUnique({
      where: { id: taxFormId },
      include: { user: { include: { profile: true } } },
    });

    if (!taxForm) {
      throw new NotFoundException("Tax form not found.");
    }

    if (status !== "APPROVED" && status !== "REJECTED") {
      throw new BadRequestException("Status must be APPROVED or REJECTED.");
    }

    await this.prisma.taxForm.update({
      where: { id: taxFormId },
      data: {
        status,
        reviewedAt: new Date(),
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `Tax form (${taxForm.formType}) for ${this.getDisplayName(taxForm.user)} ${status.toLowerCase()}.${notes ? ` Notes: ${notes}` : ""}`,
      icon: "description",
      summary: `${status === "APPROVED" ? "Approved" : "Rejected"} tax form for ${this.getDisplayName(taxForm.user)}`,
      targetId: taxFormId,
      targetType: "TAX_FORM",
    });

    return {
      message: `Tax form ${status.toLowerCase()} for ${this.getDisplayName(taxForm.user)}.`,
    };
  }

  // --- Admin Help Center ---

  async getAdminHelpCenter(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const categories = await this.prisma.helpCenterCategory.findMany({
      include: {
        _count: { select: { articles: true } },
      },
      orderBy: { sortOrder: "asc" },
    });

    const articles = await this.prisma.helpCenterArticle.findMany({
      orderBy: { sortOrder: "asc" },
    });

    return {
      categories: categories.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        icon: c.icon,
        sortOrder: c.sortOrder,
        articleCount: c._count.articles,
      })),
      articles: articles.map((a) => ({
        id: a.id,
        categoryId: a.categoryId,
        title: a.title,
        excerpt: a.excerpt,
        body: a.body,
        tag: a.tag,
        sortOrder: a.sortOrder,
        published: a.published,
      })),
    };
  }

  async createHelpCenterCategory(
    adminUserId: string,
    input: {
      title: string;
      description: string;
      icon: string;
      sortOrder?: number | null;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);

    const category = await this.prisma.helpCenterCategory.create({
      data: {
        title: input.title,
        description: input.description,
        icon: input.icon,
        sortOrder: input.sortOrder ?? 0,
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `Created help center category "${input.title}".`,
      icon: "help",
      summary: `Created help center category "${input.title}"`,
      targetId: category.id,
      targetType: "HELP_CENTER",
    });

    return { category };
  }

  async createHelpCenterArticle(
    adminUserId: string,
    input: {
      categoryId: string;
      title: string;
      excerpt: string;
      body?: string | null;
      published?: boolean | null;
      tag?: string | null;
      sortOrder?: number | null;
    },
  ) {
    const admin = await this.requireAdmin(adminUserId);

    const category = await this.prisma.helpCenterCategory.findUnique({
      where: { id: input.categoryId },
    });

    if (!category) {
      throw new NotFoundException("Help center category not found.");
    }

    const article = await this.prisma.helpCenterArticle.create({
      data: {
        categoryId: input.categoryId,
        title: input.title,
        excerpt: input.excerpt,
        body: input.body ?? null,
        published: input.published ?? true,
        tag: input.tag ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `Created help center article "${input.title}" in category "${category.title}".`,
      icon: "article",
      summary: `Created help center article "${input.title}"`,
      targetId: article.id,
      targetType: "HELP_CENTER",
    });

    return { article };
  }

  async deleteHelpCenterArticle(adminUserId: string, articleId: string) {
    const admin = await this.requireAdmin(adminUserId);

    const article = await this.prisma.helpCenterArticle.findUnique({
      where: { id: articleId },
      include: {
        category: true,
      },
    });

    if (!article) {
      throw new NotFoundException("Help center article not found.");
    }

    await this.prisma.helpCenterArticle.delete({
      where: { id: articleId },
    });

    await this.logAdminAction(admin.id, {
      detail: `Deleted help center article "${article.title}" from category "${article.category.title}".`,
      icon: "delete",
      summary: `Deleted help center article "${article.title}"`,
      targetId: article.id,
      targetType: "HELP_CENTER",
    });

    return {
      deletedArticleId: article.id,
      message: `Deleted "${article.title}" from the help center.`,
    };
  }

  async getAdminSettings(adminUserId: string) {
    await this.requireAdmin(adminUserId);
    await this.ensureAdminDefaults();

    const settings = await this.prisma.adminSetting.findMany({
      orderBy: [
        {
          group: "asc",
        },
        {
          title: "asc",
        },
      ],
    });

    return {
      settings: settings.map((setting) => {
        const baseSetting = {
          description: setting.description,
          enabled: setting.enabled,
          group: setting.group,
          id: setting.key,
          kind: setting.kind,
          title: setting.title,
        };

        if (
          setting.kind !== AdminSettingKind.CURRENCY_CENTS &&
          setting.kind !== AdminSettingKind.PERCENTAGE
        ) {
          return baseSetting;
        }

        const fallbackValueCents =
          defaultAdminSettings.find((item) => item.key === setting.key)
            ?.valueCents ?? 0;
        const valueCents = setting.valueCents ?? fallbackValueCents;

        return {
          ...baseSetting,
          formattedValue:
            setting.kind === AdminSettingKind.PERCENTAGE
              ? this.formatPercentage(valueCents)
              : this.formatCurrency(valueCents),
          valueCents,
        };
      }),
    };
  }

  async toggleAdminSetting(adminUserId: string, settingKey: string) {
    const admin = await this.requireAdmin(adminUserId);
    await this.ensureAdminDefaults();

    const setting = await this.prisma.adminSetting.findUnique({
      where: {
        key: settingKey,
      },
    });

    if (!setting) {
      throw new NotFoundException("Setting not found.");
    }

    if (setting.kind !== AdminSettingKind.BOOLEAN) {
      throw new BadRequestException("This setting cannot be toggled.");
    }

    const updated = await this.prisma.adminSetting.update({
      where: {
        key: settingKey,
      },
      data: {
        enabled: !setting.enabled,
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `${updated.title} ${updated.enabled ? "enabled" : "disabled"} from system settings.`,
      icon: "tune",
      summary: `${updated.title} ${updated.enabled ? "enabled" : "disabled"}`,
      targetId: updated.id,
      targetType: "SETTING",
    });

    return {
      message: `${updated.title} ${updated.enabled ? "enabled" : "disabled"}.`,
    };
  }

  async updateAdminSettingValue(
    adminUserId: string,
    settingKey: string,
    input: AdminSettingValueInput,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    await this.ensureAdminDefaults();

    const setting = await this.prisma.adminSetting.findUnique({
      where: {
        key: settingKey,
      },
    });

    if (!setting) {
      throw new NotFoundException("Setting not found.");
    }

    if (
      setting.kind !== AdminSettingKind.CURRENCY_CENTS &&
      setting.kind !== AdminSettingKind.PERCENTAGE
    ) {
      throw new BadRequestException(
        "This setting does not support a numeric value.",
      );
    }

    if (
      setting.kind === AdminSettingKind.PERCENTAGE &&
      (input.valueCents < 0 || input.valueCents > 100)
    ) {
      throw new BadRequestException(
        "Percentage settings must be between 0 and 100.",
      );
    }

    const updated = await this.prisma.adminSetting.update({
      where: {
        key: settingKey,
      },
      data: {
        valueCents: input.valueCents,
      },
    });

    const formattedValue =
      updated.kind === AdminSettingKind.PERCENTAGE
        ? this.formatPercentage(updated.valueCents ?? 0)
        : this.formatCurrency(updated.valueCents ?? 0);

    await this.logAdminAction(admin.id, {
      detail: `${updated.title} updated to ${formattedValue} from system settings.`,
      icon: "tune",
      summary: `Updated ${updated.title}`,
      targetId: updated.id,
      targetType: "SETTING",
    });

    return {
      message: `${updated.title} updated to ${formattedValue}.`,
    };
  }

  async runMaintenanceAction(adminUserId: string, actionId: string) {
    const admin = await this.requireAdmin(adminUserId);
    const label =
      maintenanceActionLabels[actionId as keyof typeof maintenanceActionLabels];

    if (!label) {
      throw new BadRequestException("Unknown maintenance action.");
    }

    // Execute the maintenance action
    if (actionId === "purge-sessions") {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      await this.prisma.session.deleteMany({
        where: {
          OR: [
            { revokedAt: { not: null, lt: thirtyDaysAgo } },
            { refreshTokenExpiresAt: { lt: new Date() } },
          ],
        },
      });
    }

    await this.logAdminAction(admin.id, {
      detail: "Maintenance was triggered from the admin console.",
      icon: "build",
      summary: label,
      targetId: actionId,
      targetType: "MAINTENANCE",
      tone: "amber",
    });

    return {
      message: `${label}.`,
    };
  }

  async getAdminActivity(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const logs = await this.prisma.adminAuditLog.findMany({
      include: {
        adminUser: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 100,
    });

    const grouped = logs.reduce((groups, item) => {
      const label = this.formatActivityGroupLabel(item.createdAt);
      const currentGroup = groups.get(label) ?? [];

      currentGroup.push({
        admin: item.adminUser ? this.getDisplayName(item.adminUser) : "System",
        detail: item.detail,
        icon: item.icon,
        id: item.id,
        summary: item.summary,
        time: this.formatRelativeDate(item.createdAt),
        tone: item.tone,
      });
      groups.set(label, currentGroup);
      return groups;
    }, new Map<string, Array<Record<string, string>>>());

    return {
      activityGroups: Array.from(grouped.entries()).map(([label, items]) => ({
        items,
        label,
      })),
    };
  }

  async getAdminMessages(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const tickets = await this.prisma.supportTicket.findMany({
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
        requester: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    return {
      conversations: await Promise.all(
        tickets.map((ticket) => this.mapConversation(ticket)),
      ),
    };
  }

  async replyToSupportTicket(
    adminUserId: string,
    ticketId: string,
    body: string,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const ticket = await this.prisma.supportTicket.findUnique({
      where: {
        id: ticketId,
      },
      include: {
        requester: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!ticket) {
      throw new NotFoundException("Support ticket not found.");
    }

    await this.prisma.supportMessage.create({
      data: {
        body,
        senderRole: "ADMIN",
        senderUserId: admin.id,
        ticketId,
      },
    });

    await this.prisma.supportTicket.update({
      where: {
        id: ticketId,
      },
      data: {
        assignedAdminId: admin.id,
        latestPreview: body,
        status: "PENDING",
      },
    });

    await this.logAdminAction(admin.id, {
      detail: `Creator or reader messaging thread updated for ${this.getDisplayName(ticket.requester)}.`,
      icon: "chat",
      summary: "Replied to support conversation",
      targetId: ticketId,
      targetType: "SUPPORT_TICKET",
    });

    return {
      message: "Reply sent to the conversation.",
    };
  }

  private async ensureAdminDefaults() {
    for (const setting of defaultAdminSettings) {
      await this.prisma.adminSetting.upsert({
        where: {
          key: setting.key,
        },
        create: setting,
        update: {
          description: setting.description,
          group: setting.group,
          kind: setting.kind,
          title: setting.title,
          valueCents:
            setting.kind === AdminSettingKind.BOOLEAN ? null : undefined,
        },
      });
    }
  }

  private async ensureBookPlatformDefaults() {
    const policy = await this.prisma.bookPlatformPolicy.upsert({
      where: {
        key: defaultBookPlatformPolicy.key,
      },
      create: {
        defaultCoinCap: defaultBookPlatformPolicy.defaultCoinCap,
        defaultPremiumWindowHours:
          defaultBookPlatformPolicy.defaultPremiumWindowHours,
        defaultReleaseMode: defaultBookPlatformPolicy.defaultReleaseMode,
        key: defaultBookPlatformPolicy.key,
      },
      update: {},
    });

    if (policy.defaultPremiumWindowHours === 72) {
      return this.prisma.bookPlatformPolicy.update({
        where: {
          id: policy.id,
        },
        data: {
          defaultPremiumWindowHours:
            defaultBookPlatformPolicy.defaultPremiumWindowHours,
        },
      });
    }

    return policy;
  }

  private async getAdminBookStories(
    storySlug?: string,
    pagination?: AdminListPagination,
  ): Promise<{
    hasMore: boolean;
    limit: number;
    offset: number;
    stories: AdminBookStoryRecord[];
  }> {
    const policy = await this.ensureBookPlatformDefaults();
    const limit = this.resolveAdminListLimit(pagination?.limit);
    const offset = pagination?.offset ?? 0;

    const stories = await this.prisma.story.findMany({
      where: storySlug
        ? {
            slug: storySlug,
          }
        : {
            publishedChapters: {
              some: {},
            },
          },
      include: {
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
              in: ["OPEN", "IN_REVIEW"],
            },
          },
        },
        publishedChapters: {
          include: {
            adminOverride: true,
            chapter: true,
          },
          orderBy: {
            chapterNumber: "asc",
          },
        },
      },
      orderBy: [
        {
          updatedAt: "desc",
        },
        {
          title: "asc",
        },
      ],
      skip: storySlug ? 0 : offset,
      take: storySlug ? undefined : limit + 1,
    });

    const hasMore = !storySlug && stories.length > limit;
    const slicedStories =
      !storySlug && hasMore ? stories.slice(0, limit) : stories;

    const storiesMissingControl = slicedStories.filter(
      (story) => !story.adminControl,
    );

    if (storiesMissingControl.length > 0) {
      await Promise.all(
        storiesMissingControl.map((story) =>
          this.prisma.storyAdminControl.upsert({
            where: {
              storyId: story.id,
            },
            create: {
              defaultPremiumWindowHours: policy.defaultPremiumWindowHours,
              globalCoinCap: policy.defaultCoinCap,
              releaseMode: policy.defaultReleaseMode,
              reviewedAt:
                story.isLive || story.liveAt
                  ? story.liveAt ?? story.publishedAt ?? new Date()
                  : null,
              storyId: story.id,
              visibilityState: story.isLive
                ? AdminBookVisibilityState.LIVE
                : AdminBookVisibilityState.PENDING_APPROVAL,
            },
            update: {},
          }),
        ),
      );

      return this.getAdminBookStories(storySlug, pagination);
    }

    return {
      hasMore,
      limit,
      offset,
      stories: slicedStories,
    };
  }

  private async getAdminBookStoryOrThrow(
    storySlug: string,
  ): Promise<AdminBookStoryRecord> {
    const { stories } = await this.getAdminBookStories(storySlug);
    const story = stories[0];

    if (!story) {
      throw new NotFoundException("Book not found.");
    }

    return story;
  }

  private async getBookRevenueMap(storyIds: string[]) {
    if (storyIds.length === 0) {
      return new Map<string, number>();
    }

    const entries = await this.prisma.walletLedgerEntry.findMany({
      where: {
        reason: {
          in: ["CHAPTER_UNLOCK", "GIFT_SENT"],
        },
        storyId: {
          in: storyIds,
        },
      },
      select: {
        deltaCoins: true,
        storyId: true,
      },
    });

    return entries.reduce((map, entry) => {
      if (!entry.storyId) {
        return map;
      }

      map.set(
        entry.storyId,
        (map.get(entry.storyId) ?? 0) + Math.abs(entry.deltaCoins) * 100,
      );
      return map;
    }, new Map<string, number>());
  }

  private buildAdminBookStats(
    stories: AdminBookStoryRecord[],
    revenueByStoryId: Map<string, number>,
  ) {
    const totalBooks = stories.length;
    const liveBooks = stories.filter(
      (story) => getStoryVisibilityState(story) === AdminBookVisibilityState.LIVE,
    ).length;
    const pendingBooks = stories.filter(
      (story) =>
        getStoryVisibilityState(story) ===
        AdminBookVisibilityState.PENDING_APPROVAL,
    ).length;
    const flaggedBooks = stories.filter((story) => story.contentReports.length > 0).length;
    const totalRevenueCents = Array.from(revenueByStoryId.values()).reduce(
      (sum, value) => sum + value,
      0,
    );

    return [
      {
        delta: `${flaggedBooks} flagged`,
        id: "total-books",
        label: "Total Books",
        value: this.formatCompactNumber(totalBooks),
        width: "100%",
      },
      {
        delta: `${this.getPercentWidth(liveBooks, Math.max(totalBooks, 1)).toFixed(0)}% live`,
        id: "live-books",
        label: "Live Books",
        value: this.formatCompactNumber(liveBooks),
        width: `${this.getPercentWidth(liveBooks, Math.max(totalBooks, 1))}%`,
      },
      {
        delta: `${flaggedBooks} flagged`,
        id: "pending-approval",
        label: "Pending Approval",
        value: this.formatCompactNumber(pendingBooks),
        width: `${this.getPercentWidth(pendingBooks, Math.max(totalBooks, 1))}%`,
      },
      {
        delta: `${stories.reduce((sum, story) => sum + story.totalReads, 0)} reads`,
        id: "total-revenue",
        label: "Tracked Revenue",
        value: this.formatCurrency(totalRevenueCents),
        width:
          totalRevenueCents > 0
            ? `${Math.min(100, 30 + Math.log10(totalRevenueCents) * 18)}%`
            : "12%",
      },
    ];
  }

  private mapAdminBookInventoryItem(
    story: AdminBookStoryRecord,
    revenueCents: number,
  ) {
    const visibilityState = getStoryVisibilityState(story);
    const firstGenre = story.genreSlugs[0] ?? "story";

    return {
      author: story.author ? this.getDisplayName(story.author) : story.authorName,
      authorLockSummary: this.buildAuthorLockSummary(story),
      cover:
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        story.assets?.bannerImageUrl ??
        "",
      flagged: story.contentReports.length > 0,
      genre: this.slugToLabel(firstGenre),
      id: story.slug,
      internalId: this.buildBookInternalId(story.id),
      lockPolicy: formatReleaseModeLabel(
        story.adminControl?.releaseMode ?? AdminBookReleaseMode.PREMIUM_WINDOW,
      ),
      publishedAt: story.publishedAt ? this.formatDate(story.publishedAt) : "Draft",
      revenue: this.formatCurrency(revenueCents),
      status: formatVisibilityLabel(visibilityState),
      title: story.title,
      trendTag: story.featured ? "Featured" : null,
      visibility:
        visibilityState === AdminBookVisibilityState.LIVE ? "Public" : "Private",
    };
  }

  private mapAdminBookDetail(
    story: AdminBookStoryRecord,
    policy: {
      defaultCoinCap: number;
      defaultPremiumWindowHours: number;
      defaultReleaseMode: AdminBookReleaseMode;
    },
    revenueCents: number,
  ) {
    const visibilityState = getStoryVisibilityState(story);
    const defaultPremiumWindowHours = normalizeConfiguredPremiumWindowHours(
      story.adminControl?.defaultPremiumWindowHours,
      story.adminControl?.lastUpdatedByAdminUserId ?? null,
    );
    const storyControl = {
      defaultPremiumWindowHours,
      globalCoinCap: story.adminControl?.globalCoinCap ?? policy.defaultCoinCap,
      releaseMode: story.adminControl?.releaseMode ?? policy.defaultReleaseMode,
      reviewNotes: story.adminControl?.reviewNotes ?? null,
    };

    return {
      chapterCount: story.publishedChapters.length,
      chapters: story.publishedChapters.map((chapter) =>
        this.mapAdminBookChapter(chapter, storyControl, story.liveAt ?? null),
      ),
      cover:
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        story.assets?.bannerImageUrl ??
        "",
      genre: this.slugToLabel(story.genreSlugs[0] ?? "story"),
      globalCoinCap: storyControl.globalCoinCap,
      globalLockWindow: formatPremiumWindowLabel(
        defaultPremiumWindowHours,
      ),
      globalLockWindowHours: defaultPremiumWindowHours,
      id: story.slug,
      releaseMode: storyControl.releaseMode,
      releaseModeLabel: formatReleaseModeLabel(storyControl.releaseMode),
      revenue: this.formatCurrency(revenueCents),
      reviewNotes: storyControl.reviewNotes ?? "",
      status: formatVisibilityLabel(visibilityState),
      subtitle: `Internal ID: ${this.buildBookInternalId(story.id)}`,
      title: story.title,
      visibilityMode: visibilityState,
    };
  }

  private mapAdminBookChapter(
    chapter: AdminBookStoryRecord["publishedChapters"][number],
    storyControl: {
      defaultPremiumWindowHours: number;
      globalCoinCap: number;
    },
    storyLiveAt: Date | null,
  ) {
    const overrideEnabled = chapter.adminOverride?.overrideEnabled ?? false;
    const authorLocked =
      chapter.chapter.premiumEnabled && chapter.chapter.coinUnlockPrice > 0;
    const configuredCoinPrice = overrideEnabled
      ? chapter.adminOverride?.coinPriceOverride ??
        (authorLocked
          ? Math.min(
              chapter.chapter.coinUnlockPrice,
              storyControl.globalCoinCap > 0
                ? storyControl.globalCoinCap
                : chapter.chapter.coinUnlockPrice,
            )
          : 0)
      : authorLocked
        ? chapter.chapter.coinUnlockPrice
        : 0;
    const configuredLockWindowHours =
      overrideEnabled &&
      chapter.adminOverride?.premiumWindowHoursOverride !== null &&
      chapter.adminOverride?.premiumWindowHoursOverride !== undefined
        ? chapter.adminOverride.premiumWindowHoursOverride
        : storyControl.defaultPremiumWindowHours;
    const configuredLocked = overrideEnabled
      ? chapter.adminOverride?.lockedOverride ?? configuredCoinPrice > 0
      : authorLocked;
    const effective = resolveEffectiveChapterAccess({
      adminOverride: chapter.adminOverride,
      authorCoinUnlockPrice: chapter.chapter.coinUnlockPrice,
      authorPremiumEnabled: chapter.chapter.premiumEnabled,
      globalCoinCap: storyControl.globalCoinCap,
      lockConfiguredAt: chapter.adminOverride?.updatedAt ?? null,
      premiumWindowHours: storyControl.defaultPremiumWindowHours,
      publishedAt: chapter.publishedAt,
      storyLiveAt,
    });
    const authorLockLabel = authorLocked
      ? `Locked (${chapter.chapter.coinUnlockPrice} Coins)`
      : "Free";
    const effectiveLockLabel = effective.isCurrentlyPremium
      ? effective.unlocksAt
        ? `Locked now • unlocks ${this.formatDate(effective.unlocksAt)}`
        : `Locked now • ${effective.effectiveCoinPrice} coins`
      : effective.windowExpired
        ? "Free now • premium window expired"
        : "Free now";

    return {
      adminLocked: configuredLocked,
      adminOverrideEnabled: overrideEnabled,
      authorDefaultCoinPrice: authorLocked ? chapter.chapter.coinUnlockPrice : 0,
      authorDefaultLockWindow: formatPremiumWindowLabel(
        storyControl.defaultPremiumWindowHours,
      ),
      authorDefaultLockWindowHours: storyControl.defaultPremiumWindowHours,
      authorLockLabel,
      authorLockState: authorLocked ? "locked" : "free",
      coinPrice: configuredCoinPrice,
      effectiveCoinPrice: effective.effectiveCoinPrice,
      effectiveLockLabel,
      effectiveLockState: effective.isCurrentlyPremium ? "locked" : "free",
      id: chapter.id,
      lockWindow: formatPremiumWindowLabel(configuredLockWindowHours),
      lockWindowHours: configuredLockWindowHours,
      publishedAt: `Published ${this.formatDate(chapter.publishedAt)}`,
      title: `Ch. ${chapter.chapterNumber}: ${chapter.title}`,
    };
  }

  private buildAuthorLockSummary(story: AdminBookStoryRecord) {
    const lockedChapters = story.publishedChapters.filter(
      (chapter) =>
        chapter.chapter.premiumEnabled && chapter.chapter.coinUnlockPrice > 0,
    );

    if (lockedChapters.length === 0) {
      return "Author: All chapters free";
    }

    const maxPrice = lockedChapters.reduce(
      (highest, chapter) =>
        chapter.chapter.coinUnlockPrice > highest
          ? chapter.chapter.coinUnlockPrice
          : highest,
      0,
    );

    if (lockedChapters.length === story.publishedChapters.length) {
      return `Author: Fully locked (${maxPrice}C)`;
    }

    const firstLocked = lockedChapters[0]?.chapterNumber ?? 1;
    const lastLocked =
      lockedChapters[lockedChapters.length - 1]?.chapterNumber ?? firstLocked;

    return `Author: Ch. ${firstLocked}-${lastLocked} locked (${maxPrice}C)`;
  }

  private buildBookInternalId(storyId: string) {
    return `BK-${storyId.slice(-8).toUpperCase()}`;
  }

  private async requireActiveUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        profile: true,
      },
    });

    if (!user || user.status !== "ACTIVE") {
      throw new NotFoundException("User not found.");
    }

    return user;
  }

  private async requireAdmin(userId: string) {
    const user = await this.requireActiveUser(userId);

    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Admin access is required.");
    }

    return user;
  }

  async logAdminAction(
    adminUserId: string | null,
    input: {
      detail: string;
      icon?: string;
      summary: string;
      targetId?: string | null;
      targetType: string;
      tone?: string;
    },
  ) {
    await this.prisma.adminAuditLog.create({
      data: {
        action: input.summary,
        adminUserId,
        detail: input.detail,
        icon: input.icon ?? "bolt",
        summary: input.summary,
        targetId: input.targetId ?? null,
        targetType: input.targetType,
        tone: input.tone ?? "primary",
      },
    });
  }

  private async getContractTemplateOrThrow(templateId: string) {
    const template = await this.prisma.contractTemplate.findUnique({
      where: {
        id: templateId,
      },
      include: contractTemplateCountInclude,
    });

    if (!template) {
      throw new NotFoundException("Contract template not found.");
    }

    return template;
  }

  private async getContractOrThrow(contractId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: {
        id: contractId,
      },
      include: adminContractInclude,
    });

    if (!contract) {
      throw new NotFoundException("Contract not found.");
    }

    return contract;
  }

  private async getContractPartyUserOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        profile: true,
      },
    });

    if (!user || user.status === "DELETED") {
      throw new NotFoundException("Contract user not found.");
    }

    return user;
  }

  /**
   * Writers approved "studio only" cannot hold contracts that pay a revenue share from purchases.
   * Missing application rows (e.g. legacy or seeded creators) are allowed.
   */
  private async assertContractPartyEligibleForRevenueShare(
    userId: string,
    revenueSharePercent: number,
  ) {
    if (revenueSharePercent <= 0) {
      return;
    }

    const application = await this.prisma.creatorApplication.findUnique({
      where: {
        userId,
      },
    });

    if (!application || application.status !== "APPROVED") {
      return;
    }

    const allowed = application.revenueShareContractApproved ?? true;

    if (!allowed) {
      throw new BadRequestException(
        "This creator was approved without revenue-sharing eligibility. Use studio-only access or update their application before assigning a contract with revenue share.",
      );
    }
  }

  private async getContractStoryOrThrow(storyId: string) {
    const story = await this.prisma.story.findUnique({
      where: {
        id: storyId,
      },
      include: {
        author: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!story) {
      throw new NotFoundException("Contract story not found.");
    }

    return story;
  }

  private async nextAdminSequenceValue(key: string) {
    const sequence = await this.prisma.adminSequence.upsert({
      where: {
        key,
      },
      create: {
        key,
        value: 1,
      },
      update: {
        value: {
          increment: 1,
        },
      },
    });

    return sequence.value;
  }

  private formatContractDisplayId(value: number) {
    return `CTR-${String(value).padStart(3, "0")}`;
  }

  private mapAdminContractTemplateSummary(template: any) {
    return {
      companyName: template.companyName,
      contractCount: template._count?.contracts ?? 0,
      description: template.description ?? "",
      exclusivity: this.mapContractExclusivityLabel(template.exclusivity),
      exclusivityValue: template.exclusivity,
      id: template.id,
      revenueShare: `${template.revenueSharePercent}%`,
      revenueSharePercent: template.revenueSharePercent,
      templateName: template.templateName,
      termDuration: this.formatTermMonths(template.termMonths),
      termMonths: template.termMonths,
      updatedAt: this.formatRelativeDate(template.updatedAt),
    };
  }

  private mapAdminContractTemplateDetail(template: any) {
    return {
      advancePaymentCents: template.advancePaymentCents,
      body: template.body,
      companyName: template.companyName,
      contractCount: template._count?.contracts ?? 0,
      createdAt: template.createdAt.toISOString(),
      description: template.description ?? "",
      exclusivity: template.exclusivity,
      exclusivityLabel: this.mapContractExclusivityLabel(template.exclusivity),
      geographicRights: template.geographicRights,
      id: template.id,
      revenueSharePercent: template.revenueSharePercent,
      signingBonusCoins: template.signingBonusCoins,
      templateName: template.templateName,
      termDuration: this.formatTermMonths(template.termMonths),
      termMonths: template.termMonths,
      updatedAt: template.updatedAt.toISOString(),
    };
  }

  private mapAdminContractSummary(contract: any) {
    const userName = this.getDisplayName(contract.user);

    return {
      contractId: contract.displayId,
      contractType: this.mapContractExclusivityLabel(contract.contractType),
      contractTypeValue: contract.contractType,
      createdAt: this.formatDate(contract.createdAt),
      id: contract.id,
      initials: this.buildInitials(userName),
      partyRole: contract.partyRole,
      status: this.mapContractStatusLabel(contract.status),
      statusValue: contract.status,
      storyTitle: contract.story.title,
      templateName: contract.templateName,
      updatedAt: this.formatRelativeDate(contract.updatedAt),
      userName,
    };
  }

  private mapAdminContractDetail(contract: any) {
    const userName = this.getDisplayName(contract.user);

    return {
      advancePaymentCents: contract.advancePaymentCents,
      body: contract.body,
      companyName: contract.companyName,
      contractId: contract.displayId,
      contractType: contract.contractType,
      contractTypeLabel: this.mapContractExclusivityLabel(contract.contractType),
      createdAt: contract.createdAt.toISOString(),
      geographicRights: contract.geographicRights,
      id: contract.id,
      partyRole: contract.partyRole,
      revenueSharePercent: contract.revenueSharePercent,
      signingBonusCoins: contract.signingBonusCoins,
      status: contract.status,
      statusLabel: this.mapContractStatusLabel(contract.status),
      story: {
        authorName:
          contract.story.author?.profile?.displayName ?? contract.story.authorName,
        id: contract.story.id,
        slug: contract.story.slug,
        title: contract.story.title,
      },
      template: contract.template
        ? {
            id: contract.template.id,
            templateName: contract.template.templateName,
          }
        : null,
      templateId: contract.templateId ?? null,
      templateName: contract.templateName,
      termDuration: this.formatTermMonths(contract.termMonths),
      termMonths: contract.termMonths,
      updatedAt: contract.updatedAt.toISOString(),
      user: {
        displayName: userName,
        email: contract.user.email,
        id: contract.user.id,
        initials: this.buildInitials(userName),
        status: contract.user.status,
      },
    };
  }

  private async mapAdminUserSummary(user: any) {
    const [storiesCount, chapterCount, revenueCents, recentReports] = await Promise.all([
      this.prisma.story.count({
        where: {
          authorId: user.id,
        },
      }),
      this.prisma.chapter.count({
        where: {
          story: {
            authorId: user.id,
          },
        },
      }),
      this.prisma.giftTransaction.aggregate({
        _sum: {
          costCoins: true,
        },
        where: {
          recipientAuthorId: user.id,
        },
      }),
      this.prisma.adminAuditLog.findMany({
        where: {
          targetId: user.id,
          targetType: "USER",
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 3,
      }),
    ]);

    return {
      avatar: this.getAvatarUrl(user),
      bio: user.profile?.bio ?? "",
      chapters: this.formatCompactNumber(chapterCount),
      displayName: this.getDisplayName(user),
      email: user.email,
      followers: this.formatCompactNumber(storiesCount * 1200),
      id: user.id,
      joinDate: this.formatDate(user.createdAt),
      location: user.profile?.location ?? "Unknown",
      moderationHistory: recentReports.map((item) => ({
        admin: "Admin",
        date: this.formatDate(item.createdAt),
        id: item.id,
        reason: item.detail,
        status: "Log",
        type: item.summary,
      })),
      name: this.getDisplayName(user),
      recentActivity: [
        {
          id: `activity-${user.id}-created`,
          label: `Joined TaleStead on ${this.formatDate(user.createdAt)}`,
          time: this.formatRelativeDate(user.createdAt),
        },
      ],
      revenue: this.formatCurrency((revenueCents._sum.costCoins ?? 0) * 100),
      role: this.mapRoleLabel(user.role),
      status: this.mapStatusLabel(user.status),
      stories: this.formatCompactNumber(storiesCount),
    };
  }

  private async mapAdminUserDetails(user: any) {
    const summary = await this.mapAdminUserSummary(user);
    const [reports, auditLogs] = await Promise.all([
      this.prisma.contentReport.findMany({
        where: {
          OR: [
            {
              reporterUserId: user.id,
            },
            {
              story: {
                authorId: user.id,
              },
            },
          ],
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 6,
      }),
      this.prisma.adminAuditLog.findMany({
        where: {
          targetId: user.id,
          targetType: "USER",
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 6,
      }),
    ]);

    return {
      ...summary,
      moderationHistory: [
        ...reports.map((report) => ({
          admin: "Moderation",
          date: this.formatDate(report.createdAt),
          id: report.id,
          reason: report.reason,
          status: this.mapReportStatusLabel(report.status),
          type: report.targetType === "CHAPTER" ? "Content Report" : "Story Report",
        })),
        ...auditLogs.map((log) => ({
          admin: "Admin",
          date: this.formatDate(log.createdAt),
          id: log.id,
          reason: log.detail,
          status: "Log",
          type: log.summary,
        })),
      ].slice(0, 6),
      recentActivity: [
        ...summary.recentActivity,
        ...auditLogs.map((log) => ({
          id: `recent-${log.id}`,
          label: log.summary,
          time: this.formatRelativeDate(log.createdAt),
        })),
      ].slice(0, 6),
    };
  }

  private async mapConversation(ticket: any) {
    const requester = ticket.requester;
    const storiesCount = await this.prisma.story.count({
      where: {
        authorId: requester.id,
      },
    });
    const purchases = await this.prisma.purchase.aggregate({
      _sum: {
        amountCents: true,
      },
      where: {
        userId: requester.id,
      },
    });

    return {
      accountOverview: {
        status:
          requester.role === "CREATOR"
            ? "Creator Account"
            : requester.role === "ADMIN"
              ? "Admin"
              : "Reader",
        stories: this.formatCompactNumber(storiesCount),
        totalSpend: this.formatCurrency(purchases._sum.amountCents ?? 0),
      },
      avatar: this.getAvatarUrl(requester),
      id: ticket.id,
      messages: ticket.messages.map((message: any) => ({
        id: message.id,
        sender: message.senderRole === "ADMIN" ? "admin" : "user",
        text: message.body,
        time: this.formatTime(message.createdAt),
      })),
      preview: ticket.latestPreview ?? ticket.subject,
      profileHref: `/admin/users/${requester.id}`,
      roleLabel:
        requester.role === "CREATOR" ? "TaleStead Creator" : "Reader",
      status: ticket.status === "OPEN" ? "online" : ticket.status === "PENDING" ? "away" : "offline",
      updatedAt: this.formatRelativeDateShort(ticket.updatedAt),
      userName: this.getDisplayName(requester),
    };
  }

  private mapReport(report: any, story: any, chapter: any, reporter: any) {
    return {
      detail: report.details ?? report.reason,
      id: report.id,
      image: null,
      primaryAction: "Resolve",
      secondaryAction: "Review",
      severity: report.status === "TAKEDOWN" ? "rose" : "primary",
      status: this.mapReportStatusLabel(report.status),
      subtitle: `${this.getDisplayName(reporter)} • ${this.formatRelativeDate(report.createdAt)}`,
      title:
        report.title ??
        (chapter ? `${story?.title ?? report.storySlug} - ${chapter.title}` : story?.title ?? report.storySlug),
      type: report.targetType === "CHAPTER" ? "Flagged Content" : "Story Report",
    };
  }

  private mapAdminComment(comment: any) {
    return {
      authorAvatarUrl: this.getAvatarUrl(comment.user),
      authorId: comment.user.id,
      authorName: this.getDisplayName(comment.user),
      body: comment.body,
      bodyPreview: this.truncateCopy(comment.body, 220),
      chapterNumber: comment.chapter.chapterNumber,
      chapterSlug: comment.chapter.slug,
      chapterTitle: comment.chapter.title,
      createdAt: comment.createdAt,
      createdAtLabel: this.formatRelativeDate(comment.createdAt),
      id: comment.id,
      isReply: Boolean(comment.parentCommentId),
      moderationNotes: comment.moderationNotes ?? null,
      moderatedAt: comment.moderatedAt,
      moderatedAtLabel: comment.moderatedAt
        ? this.formatRelativeDate(comment.moderatedAt)
        : null,
      parentComment: comment.parent
        ? {
            authorName: this.getDisplayName(comment.parent.user),
            bodyPreview: this.truncateCopy(comment.parent.body, 120),
            id: comment.parent.id,
            status: this.mapAdminCommentStatus(comment.parent.status),
          }
        : null,
      readHref: `/read/${comment.story.slug}/${comment.chapter.slug}`,
      status: this.mapAdminCommentStatus(comment.status),
      storySlug: comment.story.slug,
      storyTitle: comment.story.title,
    };
  }

  private mapAdminCommentStatus(status: CommentStatus) {
    if (status === CommentStatus.HIDDEN) {
      return "Hidden";
    }

    if (status === CommentStatus.DELETED) {
      return "Deleted";
    }

    return "Visible";
  }

  private mapAdminReview(review: any) {
    return {
      authorAvatarUrl: this.getAvatarUrl(review.user),
      authorId: review.user.id,
      authorName: this.getDisplayName(review.user),
      body: review.body,
      bodyPreview: this.truncateCopy(review.body, 240),
      containsSpoilers: review.containsSpoilers,
      createdAt: review.createdAt,
      createdAtLabel: this.formatRelativeDate(review.createdAt),
      id: review.id,
      moderationNotes: review.moderationNotes ?? null,
      moderatedAt: review.moderatedAt,
      moderatedAtLabel: review.moderatedAt
        ? this.formatRelativeDate(review.moderatedAt)
        : null,
      rating: review.rating,
      readHref: `/stories/${review.story.slug}/reviews`,
      status: this.mapAdminReviewStatus(review.status),
      storySlug: review.story.slug,
      storyTitle: review.story.title,
      title: review.title ?? null,
    };
  }

  private mapAdminReviewStatus(status: ReviewStatus) {
    if (status === ReviewStatus.HIDDEN) {
      return "Hidden";
    }

    if (status === ReviewStatus.DELETED) {
      return "Deleted";
    }

    return "Visible";
  }

  private getDisplayName(user: any) {
    return user.profile?.displayName ?? user.email.split("@")[0] ?? "TaleStead User";
  }

  private getAvatarUrl(user: any) {
    return user.profile?.avatarUrl ?? null;
  }

  private truncateCopy(value: string, maxLength: number) {
    const trimmed = value.trim();

    if (trimmed.length <= maxLength) {
      return trimmed;
    }

    return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  private mapUiRoleToDb(role: string) {
    const normalized = role.trim().toLowerCase();

    if (normalized === "admin") {
      return "ADMIN";
    }

    if (normalized === "editor") {
      return "MODERATOR";
    }

    if (normalized === "author" || normalized === "creator") {
      return "CREATOR";
    }

    return "READER";
  }

  private mapRoleLabel(role: string) {
    if (role === "ADMIN") {
      return "Admin";
    }

    if (role === "MODERATOR") {
      return "Editor";
    }

    if (role === "CREATOR") {
      return "Author";
    }

    return "Viewer";
  }

  private mapStatusLabel(status: string) {
    if (status === "SUSPENDED") {
      return "Suspended";
    }

    if (status === "DELETED") {
      return "Deleted";
    }

    return "Active";
  }

  private async getCreatorRevenueShareDefaults() {
    const settings = await this.prisma.adminSetting.findMany({
      where: {
        key: {
          in: [
            creatorExclusiveRevenueShareSettingKey,
            creatorNonExclusiveRevenueShareSettingKey,
          ],
        },
      },
    });

    const settingsByKey = new Map(settings.map((setting) => [setting.key, setting]));

    return {
      exclusive: {
        contractType: ContractExclusivity.EXCLUSIVE,
        revenueSharePercent:
          settingsByKey.get(creatorExclusiveRevenueShareSettingKey)?.valueCents ??
          getDefaultCreatorRevenueSharePercent(ContractExclusivity.EXCLUSIVE),
      },
      nonExclusive: {
        contractType: ContractExclusivity.NON_EXCLUSIVE,
        revenueSharePercent:
          settingsByKey.get(creatorNonExclusiveRevenueShareSettingKey)?.valueCents ??
          getDefaultCreatorRevenueSharePercent(
            ContractExclusivity.NON_EXCLUSIVE,
          ),
      },
    };
  }

  private getContractLifecycleUpdate(
    current:
      | {
          activatedAt: Date | null;
          endedAt: Date | null;
          status: ContractStatus;
        }
      | null,
    nextStatus: ContractStatus,
  ) {
    const now = new Date();

    if (nextStatus === ContractStatus.ACTIVE) {
      return {
        activatedAt: current?.activatedAt ?? now,
        endedAt: null,
      };
    }

    if (
      nextStatus === ContractStatus.EXPIRED ||
      nextStatus === ContractStatus.TERMINATED
    ) {
      return {
        activatedAt: current?.activatedAt ?? now,
        endedAt: current?.endedAt ?? now,
      };
    }

    return {
      activatedAt: null,
      endedAt: null,
    };
  }

  private mapContractStatusLabel(status: string) {
    if (status === "PENDING_SIGNATURE") {
      return "Pending Signature";
    }

    if (status === "TERMINATED") {
      return "Terminated";
    }

    if (status === "EXPIRED") {
      return "Expired";
    }

    if (status === "ACTIVE") {
      return "Active";
    }

    return "Draft";
  }

  private mapContractExclusivityLabel(exclusivity: string) {
    if (exclusivity === "NON_EXCLUSIVE") {
      return "Non-Exclusive";
    }

    return "Exclusive";
  }

  private mapReportStatusLabel(status: string) {
    if (status === "IN_REVIEW") {
      return "Review";
    }

    if (status === "TAKEDOWN") {
      return "Takedown";
    }

    if (status === "DISMISSED") {
      return "Dismissed";
    }

    if (status === "RESOLVED") {
      return "Resolved";
    }

    return "Pending";
  }

  private getPercentWidth(value: number, total: number) {
    if (!total) {
      return 0;
    }

    return Math.max(12, Math.round((value / total) * 100));
  }

  private getDayRange(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    return { end, start };
  }

  private getMonthRange(date = new Date()) {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);

    return { end, start };
  }

  private formatDate(value: Date) {
    return value.toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  private formatTime(value: Date) {
    return value.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  private resolveAdminListLimit(limit?: number | null) {
    return limit ?? ADMIN_LIST_DEFAULT_LIMIT;
  }

  private buildAdminPageInfo(limit: number, offset: number, hasMore: boolean) {
    return {
      hasMore,
      limit,
      nextOffset: hasMore ? offset + limit : null,
      offset,
    };
  }

  private formatRelativeDate(value: Date) {
    const diffMs = Date.now() - value.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 1) {
      return "Just now";
    }

    if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    }

    const diffHours = Math.floor(diffMinutes / 60);

    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }

    const diffDays = Math.floor(diffHours / 24);

    if (diffDays === 1) {
      return "1 day ago";
    }

    if (diffDays < 7) {
      return `${diffDays} days ago`;
    }

    return this.formatDate(value);
  }

  private formatRelativeDateShort(value: Date) {
    const diffMs = Date.now() - value.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 60) {
      return `${Math.max(1, diffMinutes)}m`;
    }

    const diffHours = Math.floor(diffMinutes / 60);

    if (diffHours < 24) {
      return `${diffHours}h`;
    }

    return `${Math.floor(diffHours / 24)}d`;
  }

  private formatActivityGroupLabel(value: Date) {
    const today = this.getDayRange();
    const yesterday = this.getDayRange(new Date(Date.now() - 24 * 60 * 60 * 1000));

    if (value >= today.start && value < today.end) {
      return "Today";
    }

    if (value >= yesterday.start && value < yesterday.end) {
      return "Yesterday";
    }

    return this.formatDate(value);
  }

  private formatCurrency(amountCents: number) {
    return new Intl.NumberFormat("en-US", {
      currency: "USD",
      style: "currency",
    }).format(amountCents / 100);
  }

  private formatPercentage(value: number) {
    return `${value}%`;
  }

  private formatCompactCurrency(amountCents: number) {
    const amountDollars = amountCents / 100;
    const useCompact = Math.abs(amountDollars) >= 1_000;

    return new Intl.NumberFormat("en-US", {
      currency: "USD",
      maximumFractionDigits: useCompact ? 1 : 2,
      notation: useCompact ? "compact" : "standard",
      style: "currency",
    }).format(amountDollars);
  }

  private formatCurrencyDelta(
    currentAmountCents: number,
    previousAmountCents: number,
    suffix: string,
  ) {
    const delta = currentAmountCents - previousAmountCents;
    const prefix = delta > 0 ? "+" : delta < 0 ? "-" : "";

    return `${prefix}${this.formatCurrency(Math.abs(delta))} ${suffix}`;
  }

  private formatNumber(value: number) {
    return new Intl.NumberFormat("en-US").format(value);
  }

  private formatCountDelta(
    currentValue: number,
    previousValue: number,
    suffix: string,
  ) {
    const delta = currentValue - previousValue;
    const prefix = delta > 0 ? "+" : delta < 0 ? "-" : "";

    return `${prefix}${this.formatNumber(Math.abs(delta))} ${suffix}`;
  }

  private formatTermMonths(termMonths: number) {
    if (termMonths % 12 === 0) {
      const years = termMonths / 12;
      return `${years} ${years === 1 ? "Year" : "Years"}`;
    }

    return `${termMonths} ${termMonths === 1 ? "Month" : "Months"}`;
  }

  private formatCompactNumber(value: number) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: value >= 1000 ? 1 : 0,
      notation: value >= 1000 ? "compact" : "standard",
    }).format(value);
  }

  private slugToLabel(value: string) {
    return labelFromGenreOrTagSlug(value);
  }

  private buildInitials(value: string) {
    const parts = value
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 2);

    if (!parts.length) {
      return "SA";
    }

    return parts.map((part) => part.charAt(0).toUpperCase()).join("");
  }
}
