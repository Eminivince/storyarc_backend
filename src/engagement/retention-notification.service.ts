import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";

const LOCK_KEY = "retention-check:lock";
const LOCK_TTL_SECONDS = 300;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BATCH_SIZE = 100;
const MAX_DAILY_NOTIFICATIONS = 2;

@Injectable()
export class RetentionNotificationService implements OnModuleInit {
  private readonly logger = new Logger(RetentionNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    setInterval(() => {
      this.runRetentionCheck().catch((err) => {
        this.logger.error(
          `Retention check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, CHECK_INTERVAL_MS);
  }

  async runRetentionCheck(): Promise<void> {
    const lockToken = await this.redis.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);

    if (!lockToken) {
      this.logger.log("Retention check already running (lock held). Skipping.");
      return;
    }

    try {
      await this.checkCliffhangers();
      await this.checkInactive48h();
      await this.checkInactive7d();
      await this.checkStreakAtRisk();
    } finally {
      await this.redis.releaseLock(LOCK_KEY, lockToken);
    }
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  private async isRateLimited(userId: string): Promise<boolean> {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const redisKey = `retention:daily:${userId}:${dateKey}`;

    const count = await this.redis.increment(redisKey, 86400);

    return count > MAX_DAILY_NOTIFICATIONS;
  }

  // ---------------------------------------------------------------------------
  // Check 1: Cliffhanger notifications
  // ---------------------------------------------------------------------------

  private async checkCliffhangers(): Promise<void> {
    try {
      const now = new Date();
      const hoursAgo = (h: number) =>
        new Date(now.getTime() - h * 60 * 60 * 1000);

      const progressRecords = await this.prisma.readingProgress.findMany({
        where: {
          lastReadAt: { gte: hoursAgo(24), lt: hoursAgo(4) },
          progressPercent: { gte: 80 },
        },
        include: {
          story: { select: { id: true, title: true, slug: true } },
          chapter: {
            select: { id: true, chapterNumber: true, title: true },
          },
        },
        take: BATCH_SIZE,
      });

      for (const progress of progressRecords) {
        const currentChapter = progress.chapter;
        if (!currentChapter) continue;

        // Check if there's a next chapter
        const nextChapter = await this.prisma.publishedChapter.findFirst({
          where: {
            storyId: progress.storyId,
            chapterNumber: { gt: currentChapter.chapterNumber },
          },
          orderBy: { chapterNumber: "asc" },
          select: { id: true, slug: true, title: true },
        });

        if (!nextChapter) continue;

        // Check no recent CLIFFHANGER event for this user+story in last 48h
        const recentEvent = await this.prisma.retentionEvent.findFirst({
          where: {
            userId: progress.userId,
            eventType: "CLIFFHANGER",
            relatedStoryId: progress.storyId,
            sentAt: { gte: hoursAgo(48) },
          },
        });

        if (recentEvent) continue;

        // Check rate limit
        if (await this.isRateLimited(progress.userId)) continue;

        // Create notification and retention event
        await this.prisma.appNotification.create({
          data: {
            userId: progress.userId,
            type: "SYSTEM",
            title: "Continue reading?",
            body: `You were so close to finishing "${progress.story.title}" — the next chapter is waiting!`,
            ctaHref: `/story/${progress.story.slug}/chapter/${nextChapter.slug}`,
            ctaLabel: "Continue reading",
          },
        });

        await this.prisma.retentionEvent.create({
          data: {
            userId: progress.userId,
            eventType: "CLIFFHANGER",
            channelType: "app",
            relatedStoryId: progress.storyId,
          },
        });
      }

      this.logger.log(
        `Cliffhanger check complete. Evaluated ${progressRecords.length} records.`,
      );
    } catch (error) {
      this.logger.error(
        `Cliffhanger check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 2: Inactive 48h notifications
  // ---------------------------------------------------------------------------

  private async checkInactive48h(): Promise<void> {
    try {
      const now = new Date();
      const hoursAgo = (h: number) =>
        new Date(now.getTime() - h * 60 * 60 * 1000);
      const daysAgo = (d: number) =>
        new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

      const staleProgress = await this.prisma.readingProgress.findMany({
        where: {
          lastReadAt: { gte: hoursAgo(72), lt: hoursAgo(48) },
        },
        distinct: ["userId"],
        select: { userId: true },
        take: BATCH_SIZE,
      });

      for (const { userId } of staleProgress) {
        // Check no recent INACTIVE_48H event in last 7 days
        const recentEvent = await this.prisma.retentionEvent.findFirst({
          where: {
            userId,
            eventType: "INACTIVE_48H",
            sentAt: { gte: daysAgo(7) },
          },
        });

        if (recentEvent) continue;

        // Check rate limit
        if (await this.isRateLimited(userId)) continue;

        // Create notification and retention event
        await this.prisma.appNotification.create({
          data: {
            userId,
            type: "SYSTEM",
            title: "We miss you!",
            body: "It's been a couple of days — your stories are waiting for you.",
            ctaHref: "/library",
            ctaLabel: "Back to reading",
          },
        });

        await this.prisma.retentionEvent.create({
          data: {
            userId,
            eventType: "INACTIVE_48H",
            channelType: "app",
          },
        });
      }

      this.logger.log(
        `Inactive 48h check complete. Evaluated ${staleProgress.length} users.`,
      );
    } catch (error) {
      this.logger.error(
        `Inactive 48h check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 3: Inactive 7d notifications
  // ---------------------------------------------------------------------------

  private async checkInactive7d(): Promise<void> {
    try {
      const now = new Date();
      const daysAgo = (d: number) =>
        new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

      // Get users who had activity 7-14 days ago
      const oldActivityUsers = await this.prisma.userActivityEvent.findMany({
        where: { happenedAt: { gte: daysAgo(14), lt: daysAgo(7) } },
        distinct: ["userId"],
        select: { userId: true },
        take: BATCH_SIZE,
      });

      for (const { userId } of oldActivityUsers) {
        // Verify they have NO activity in the last 7 days
        const recentActivity = await this.prisma.userActivityEvent.findFirst({
          where: { userId, happenedAt: { gte: daysAgo(7) } },
        });

        if (recentActivity) continue;

        // Check no recent INACTIVE_7D event in last 30 days
        const recentEvent = await this.prisma.retentionEvent.findFirst({
          where: {
            userId,
            eventType: "INACTIVE_7D",
            sentAt: { gte: daysAgo(30) },
          },
        });

        if (recentEvent) continue;

        // Check rate limit
        if (await this.isRateLimited(userId)) continue;

        // Create notification and retention event
        await this.prisma.appNotification.create({
          data: {
            userId,
            type: "SYSTEM",
            title: "It's been a while!",
            body: "New stories and chapters have been published since your last visit. Come take a look!",
            ctaHref: "/explore",
            ctaLabel: "Explore stories",
          },
        });

        await this.prisma.retentionEvent.create({
          data: {
            userId,
            eventType: "INACTIVE_7D",
            channelType: "app",
          },
        });
      }

      this.logger.log(
        `Inactive 7d check complete. Evaluated ${oldActivityUsers.length} users.`,
      );
    } catch (error) {
      this.logger.error(
        `Inactive 7d check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Check 4: Streak at risk notifications
  // ---------------------------------------------------------------------------

  private async checkStreakAtRisk(): Promise<void> {
    try {
      const now = new Date();
      const currentHour = now.getUTCHours();

      // Only run between 18:00 and 22:00 UTC
      if (currentHour < 18 || currentHour >= 22) {
        return;
      }

      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

      // Find users with streaks > 3 days who haven't checked in today
      const walletsAtRisk = await this.prisma.rewardWallet.findMany({
        where: {
          streakDays: { gt: 3 },
          user: {
            dailyCheckIns: {
              none: {
                checkedInAt: { gte: todayStart, lt: todayEnd },
              },
            },
          },
        },
        select: { userId: true, streakDays: true },
        take: BATCH_SIZE,
      });

      for (const wallet of walletsAtRisk) {
        // Check no STREAK_AT_RISK event for this user today
        const recentEvent = await this.prisma.retentionEvent.findFirst({
          where: {
            userId: wallet.userId,
            eventType: "STREAK_AT_RISK",
            sentAt: { gte: todayStart, lt: todayEnd },
          },
        });

        if (recentEvent) continue;

        // Check rate limit
        if (await this.isRateLimited(wallet.userId)) continue;

        // Create notification and retention event
        await this.prisma.appNotification.create({
          data: {
            userId: wallet.userId,
            type: "REWARD",
            title: "Don't lose your streak!",
            body: `You're on a ${wallet.streakDays}-day streak. Check in today to keep it going!`,
            ctaHref: "/rewards",
            ctaLabel: "Check in now",
          },
        });

        await this.prisma.retentionEvent.create({
          data: {
            userId: wallet.userId,
            eventType: "STREAK_AT_RISK",
            channelType: "app",
          },
        });
      }

      this.logger.log(
        `Streak at risk check complete. Evaluated ${walletsAtRisk.length} wallets.`,
      );
    } catch (error) {
      this.logger.error(
        `Streak at risk check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
