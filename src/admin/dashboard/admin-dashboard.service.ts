import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AdminSettingKind } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { AdminAuditService } from "../admin-audit.service";
import {
  AD_UNLOCK_REVENUE_CENTS,
  AdminBookStoryRecord,
  dashboardMonthlyRevenueTargetSettingKey,
  defaultAdminSettings,
} from "../admin-constants";
import {
  formatCompactCurrency,
  formatCompactNumber,
  formatCountDelta,
  formatCurrency,
  formatCurrencyDelta,
  formatDate,
  formatNumber,
  formatRelativeDate,
  getAvatarUrl,
  getDayRange,
  getDisplayName,
  getMonthRange,
  getPercentWidth,
  mapReportStatusLabel,
  mapRoleLabel,
  mapStatusLabel,
  slugToLabel,
  buildBookInternalId,
  resolveAdminListLimit,
  buildAdminPageInfo,
} from "../admin-format.utils";
import {
  defaultBookPlatformPolicy,
  getStoryVisibilityState,
} from "../../utils/book-admin";
import { AdminBookVisibilityState, AdminBookReleaseMode } from "@prisma/client";

@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async getAdminOverview(adminUserId: string) {
    await this.ensureAdminDefaults();
    const todayRange = getDayRange();
    const yesterdayRange = getDayRange(
      new Date(todayRange.start.getTime() - 24 * 60 * 60 * 1000),
    );
    const monthRange = getMonthRange();

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
            value: formatCurrency(monthlySubscriptionRevenueCents),
          },
          {
            id: "coins",
            label: "Coin Store",
            value: formatCurrency(monthlyCoinRevenueCents),
          },
          {
            id: "ads",
            label: "Ad Unlocks",
            value: formatCurrency(monthlyAdRevenueCents),
          },
        ],
        monthlyTarget: formatCurrency(monthlyTargetCents),
        width: `${clampedAchievedRatio.toFixed(1)}%`,
      },
      overviewStats: [
        {
          delta: formatCountDelta(activeUsers, activeUserBaseline, "today"),
          icon: "group",
          id: "active-users",
          label: "Total Active Users",
          mobileLabel: "Active Users",
          mobileValue: formatCompactNumber(activeUsers),
          tone: "emerald",
          value: formatNumber(activeUsers),
        },
        {
          delta: formatCountDelta(dailySignups, yesterdaySignups, "vs yday"),
          icon: "person_add",
          id: "signups",
          label: "New Signups (Daily)",
          mobileLabel: "New Signups",
          mobileValue: formatCompactNumber(dailySignups),
          tone: "emerald",
          value: formatNumber(dailySignups),
        },
        {
          delta: formatCurrencyDelta(
            dailyRevenueCents,
            yesterdayRevenueCents,
            "vs yday",
          ),
          icon: "payments",
          id: "revenue",
          label: "Daily Revenue (Net)",
          mobileLabel: "Revenue",
          mobileValue: formatCompactCurrency(dailyRevenueCents),
          tone: "primary",
          value: formatCurrency(dailyRevenueCents),
        },
        {
          delta: `+${formatNumber(publishedChaptersToday)} today`,
          icon: "menu_book",
          id: "chapters",
          label: "Chapters Published",
          mobileLabel: "Chapters",
          mobileValue: formatCompactNumber(publishedChapters),
          tone: "emerald",
          value: formatNumber(publishedChapters),
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

  async globalSearch(term: string) {
    if (!term || term.length < 1) {
      return { users: [], stories: [] };
    }

    const [users, stories] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          OR: [
            { email: { contains: term, mode: "insensitive" } },
            { profile: { displayName: { contains: term, mode: "insensitive" } } },
          ],
        },
        include: { profile: true },
        take: 10,
      }),
      this.prisma.story.findMany({
        where: {
          OR: [
            { title: { contains: term, mode: "insensitive" } },
            { slug: { contains: term, mode: "insensitive" } },
            { authorName: { contains: term, mode: "insensitive" } },
          ],
        },
        include: { assets: true },
        take: 10,
      }),
    ]);

    return {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: getDisplayName(u),
        role: u.role,
        avatarUrl: getAvatarUrl(u),
      })),
      stories: stories.map((s) => ({
        id: s.id,
        slug: s.slug,
        title: s.title,
        authorName: s.authorName,
        coverImageUrl: s.assets?.coverImageUrl ?? null,
      })),
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

  private mapReport(report: any, story: any, chapter: any, reporter: any) {
    return {
      detail: report.details ?? report.reason,
      id: report.id,
      image: null,
      primaryAction: "Resolve",
      secondaryAction: "Review",
      severity: report.status === "TAKEDOWN" ? "rose" : "primary",
      status: mapReportStatusLabel(report.status),
      subtitle: `${getDisplayName(reporter)} • ${formatRelativeDate(report.createdAt)}`,
      title:
        report.title ??
        (chapter
          ? `${story?.title ?? report.storySlug} - ${chapter.title}`
          : story?.title ?? report.storySlug),
      type:
        report.targetType === "CHAPTER" ? "Flagged Content" : "Story Report",
    };
  }

  private async mapAdminUserSummary(user: any) {
    const [storiesCount, chapterCount, revenueCents, recentReports] =
      await Promise.all([
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
      avatar: getAvatarUrl(user),
      bio: user.profile?.bio ?? "",
      chapters: formatCompactNumber(chapterCount),
      displayName: getDisplayName(user),
      email: user.email,
      followers: formatCompactNumber(storiesCount * 1200),
      id: user.id,
      joinDate: formatDate(user.createdAt),
      location: user.profile?.location ?? "Unknown",
      moderationHistory: recentReports.map((item) => ({
        admin: "Admin",
        date: formatDate(item.createdAt),
        id: item.id,
        reason: item.detail,
        status: "Log",
        type: item.summary,
      })),
      name: getDisplayName(user),
      recentActivity: [
        {
          id: `activity-${user.id}-created`,
          label: `Joined TaleStead on ${formatDate(user.createdAt)}`,
          time: formatRelativeDate(user.createdAt),
        },
      ],
      revenue: formatCurrency((revenueCents._sum.costCoins ?? 0) * 100),
      role: mapRoleLabel(user.role),
      status: mapStatusLabel(user.status),
      stories: formatCompactNumber(storiesCount),
    };
  }
}
