import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuthService } from "../../auth/auth.service";
import { PrismaService } from "../../database/prisma.service";
import { RedisService } from "../../redis/redis.service";
import {
  AdminAuditService,
  AdminRequestContext,
} from "../admin-audit.service";
import {
  AdminListPagination,
  ADMIN_LIST_DEFAULT_LIMIT,
} from "../admin-constants";
import {
  buildAdminPageInfo,
  buildInitials,
  formatCompactNumber,
  formatCurrency,
  formatDate,
  formatRelativeDate,
  getAvatarUrl,
  getDisplayName,
  mapReportStatusLabel,
  mapRoleLabel,
  mapStatusLabel,
  mapUiRoleToDb,
  resolveAdminListLimit,
} from "../admin-format.utils";

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly authService: AuthService,
    private readonly redis: RedisService,
  ) {}

  private async getAdminUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found.");
    return user;
  }

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "ACTIVE")
      throw new NotFoundException("User not found.");
    if (user.role !== "ADMIN")
      throw new ForbiddenException("Admin access is required.");
    return user;
  }

  async listAdminUsers(
    adminUserId: string,
    pagination: AdminListPagination = {},
  ) {

    const limit = resolveAdminListLimit(pagination.limit);
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
      pageInfo: buildAdminPageInfo(limit, offset, hasMore),
    };
  }

  async getAdminUserDetails(adminUserId: string, targetUserId: string) {

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
    context?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
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

    const nextRole = mapUiRoleToDb(input.role);
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

    await this.audit.log(
      admin.id,
      {
        detail: `Updated identity fields and role for ${input.displayName}.`,
        icon: "edit",
        summary: `Updated ${input.displayName}`,
        targetId: targetUserId,
        targetType: "USER",
      },
      context,
    );

    return {
      message: `${input.displayName} profile saved.`,
      user: await this.mapAdminUserDetails(updatedUser),
    };
  }

  async updateAdminUserStatus(
    adminUserId: string,
    targetUserId: string,
    action: "SUSPEND" | "RESTORE" | "DELETE",
    context?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
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

    await this.audit.log(
      admin.id,
      {
        detail: `${getDisplayName(updatedUser)} status changed to ${mapStatusLabel(nextStatus)}.`,
        icon:
          action === "DELETE"
            ? "delete"
            : action === "SUSPEND"
              ? "block"
              : "check",
        summary:
          action === "DELETE"
            ? `Deleted ${getDisplayName(updatedUser)}`
            : action === "SUSPEND"
              ? `Suspended ${getDisplayName(updatedUser)}`
              : `Reactivated ${getDisplayName(updatedUser)}`,
        targetId: targetUserId,
        targetType: "USER",
        tone:
          action === "DELETE" || action === "SUSPEND" ? "rose" : "emerald",
      },
      context,
    );

    return {
      message:
        action === "DELETE"
          ? `${getDisplayName(updatedUser)} was marked as deleted.`
          : action === "SUSPEND"
            ? `${getDisplayName(updatedUser)} has been suspended.`
            : `${getDisplayName(updatedUser)} has been restored.`,
      user: await this.mapAdminUserDetails(updatedUser),
    };
  }

  async resetAdminUserPassword(
    adminUserId: string,
    targetUserId: string,
    context?: AdminRequestContext,
  ) {
    const admin = await this.getAdminUser(adminUserId);
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

    await this.audit.log(
      admin.id,
      {
        detail: `Password reset flow triggered for ${getDisplayName(user)}.`,
        icon: "lock_reset",
        summary: `Triggered password reset for ${getDisplayName(user)}`,
        targetId: targetUserId,
        targetType: "USER",
        tone: "amber",
      },
      context,
    );

    return {
      message: `Password reset email sent to ${user.email}.`,
    };
  }

  // --- Private helpers ---

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
      moderationHistory: recentReports.map((item: any) => ({
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
        ...reports.map((report: any) => ({
          admin: "Moderation",
          date: formatDate(report.createdAt),
          id: report.id,
          reason: report.reason,
          status: mapReportStatusLabel(report.status),
          type:
            report.targetType === "CHAPTER"
              ? "Content Report"
              : "Story Report",
        })),
        ...auditLogs.map((log: any) => ({
          admin: "Admin",
          date: formatDate(log.createdAt),
          id: log.id,
          reason: log.detail,
          status: "Log",
          type: log.summary,
        })),
      ].slice(0, 6),
      recentActivity: [
        ...summary.recentActivity,
        ...auditLogs.map((log: any) => ({
          id: `recent-${log.id}`,
          label: log.summary,
          time: formatRelativeDate(log.createdAt),
        })),
      ].slice(0, 6),
    };
  }
}
