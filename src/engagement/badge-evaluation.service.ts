import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { UserBadge } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";
import { WebsocketService } from "../websocket/websocket.service";
import { ActivityFeedService } from "./activity-feed.service";

@Injectable()
export class BadgeEvaluationService {
  private readonly logger = new Logger(BadgeEvaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(forwardRef(() => WebsocketService))
    private readonly websocketService: WebsocketService,
    @Inject(forwardRef(() => ActivityFeedService))
    private readonly activityFeedService: ActivityFeedService,
  ) {}

  async evaluateBadges(userId: string): Promise<UserBadge[]> {
    const definitions = await this.prisma.badgeDefinition.findMany({
      where: { isActive: true },
    });

    const existingBadges = await this.prisma.userBadge.findMany({
      where: { userId },
      select: { badgeDefinitionId: true },
    });

    const earnedIds = new Set(existingBadges.map((b) => b.badgeDefinitionId));
    const newlyEarned: UserBadge[] = [];

    for (const definition of definitions) {
      if (earnedIds.has(definition.id)) {
        continue;
      }

      try {
        const met = await this.checkRequirement(
          userId,
          definition.requirementType,
          definition.requirementValue,
        );

        if (!met) {
          continue;
        }

        const userBadge = await this.prisma.userBadge.create({
          data: {
            userId,
            badgeDefinitionId: definition.id,
            earnedAt: new Date(),
            featured: false,
          },
        });

        await this.prisma.appNotification.create({
          data: {
            userId,
            type: "REWARD",
            title: `Badge Earned: ${definition.title}`,
            body: definition.description,
            ctaHref: "/profile/badges",
            ctaLabel: "View Badges",
          },
        });

        if (definition.rewardPoints > 0) {
          const wallet = await this.prisma.rewardWallet.findUnique({
            where: { userId },
          });

          if (wallet) {
            const newBalance = wallet.balancePoints + definition.rewardPoints;

            await this.prisma.rewardWallet.update({
              where: { userId },
              data: { balancePoints: newBalance },
            });

            await this.prisma.rewardLedgerEntry.create({
              data: {
                userId,
                rewardWalletId: wallet.id,
                entryType: "CREDIT",
                reason: "BADGE_EARNED",
                deltaPoints: definition.rewardPoints,
                balanceAfter: newBalance,
                idempotencyKey: `badge-${definition.key}-${userId}`,
                note: `Earned badge: ${definition.title}`,
              },
            });
          }
        }

        newlyEarned.push(userBadge);

        try {
          this.websocketService.emitToUser(userId, "badge:earned", {
            badgeKey: definition.key,
            badgeTitle: definition.title,
            rarity: definition.rarity,
          });
          this.websocketService.emitToUser(userId, "notification:new", {
            timestamp: Date.now(),
          });
        } catch {
          // Socket emit is best-effort
        }

        this.activityFeedService
          .recordActivity(userId, "EARNED_BADGE", {
            badgeKey: definition.key,
            badgeTitle: definition.title,
            rarity: definition.rarity,
          })
          .catch(() => undefined);

        this.logger.log(
          `User ${userId} earned badge: ${definition.key}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to evaluate badge ${definition.key} for user ${userId}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }

    return newlyEarned;
  }

  private async checkRequirement(
    userId: string,
    requirementType: string,
    requirementValue: number,
  ): Promise<boolean> {
    switch (requirementType) {
      case "chapters_read": {
        const count = await this.prisma.userActivityEvent.count({
          where: { userId, type: "READ_CHAPTER" },
        });
        return count >= requirementValue;
      }

      case "chapters_read_daily": {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

        const count = await this.prisma.userActivityEvent.count({
          where: {
            userId,
            type: "READ_CHAPTER",
            happenedAt: { gte: start, lt: end },
          },
        });
        return count >= requirementValue;
      }

      case "streak_days": {
        const wallet = await this.prisma.rewardWallet.findUnique({
          where: { userId },
          select: { streakDays: true },
        });
        return (wallet?.streakDays ?? 0) >= requirementValue;
      }

      case "comments_count": {
        const count = await this.prisma.comment.count({
          where: { userId },
        });
        return count >= requirementValue;
      }

      case "reviews_count": {
        const count = await this.prisma.review.count({
          where: { userId },
        });
        return count >= requirementValue;
      }

      case "bookmarks_count": {
        const count = await this.prisma.bookmark.count({
          where: { userId },
        });
        return count >= requirementValue;
      }

      case "reading_lists_count": {
        const count = await this.prisma.readingList.count({
          where: { userId },
        });
        return count >= requirementValue;
      }

      case "chapters_published": {
        const count = await this.prisma.publishedChapter.count({
          where: { chapter: { story: { authorId: userId } } },
        });
        return count >= requirementValue;
      }

      case "stories_completed": {
        // Complex query — to be implemented later
        return false;
      }

      default: {
        this.logger.warn(`Unknown requirement type: ${requirementType}`);
        return false;
      }
    }
  }
}
