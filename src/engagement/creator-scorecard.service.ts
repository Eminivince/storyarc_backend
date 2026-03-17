import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";
import { ResendEmailService } from "../auth/resend-email.service";
import { AuthService } from "../auth/auth.service";
import { env } from "../config/env";

const LOCK_KEY = "creator-scorecard:lock";
const LOCK_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BATCH_SIZE = 50;

@Injectable()
export class CreatorScorecardService implements OnModuleInit {
  private readonly logger = new Logger(CreatorScorecardService.name);
  private intervalRef: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly emailService: ResendEmailService,
    private readonly authService: AuthService,
  ) {}

  onModuleInit() {
    this.intervalRef = setInterval(() => {
      this.checkAndRun().catch((error) => {
        this.logger.error(
          `Creator scorecard check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, CHECK_INTERVAL_MS);
  }

  private async checkAndRun() {
    const now = new Date();

    // Run on Mondays between 08:00-09:00 UTC (day after weekly digest)
    if (now.getUTCDay() !== 1) {
      return;
    }

    if (now.getUTCHours() < 8 || now.getUTCHours() >= 9) {
      return;
    }

    const lockToken = await this.redis.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);

    if (!lockToken) {
      this.logger.log("Creator scorecard already running (lock held). Skipping.");
      return;
    }

    try {
      await this.generateAndSendScorecards();
    } finally {
      await this.redis.releaseLock(LOCK_KEY, lockToken);
    }
  }

  private getWeekRange(): { weekStart: Date; weekEnd: Date } {
    const now = new Date();
    // Previous week: Monday 00:00 to Sunday 23:59:59
    const weekEnd = new Date(now);
    weekEnd.setUTCDate(weekEnd.getUTCDate() - weekEnd.getUTCDay() + 0); // Last Sunday
    weekEnd.setUTCHours(23, 59, 59, 999);

    const weekStart = new Date(weekEnd);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6); // Previous Monday
    weekStart.setUTCHours(0, 0, 0, 0);

    return { weekEnd, weekStart };
  }

  private async generateAndSendScorecards() {
    const { weekStart, weekEnd } = this.getWeekRange();

    const creators = await this.prisma.user.findMany({
      where: {
        status: "ACTIVE",
        role: { in: ["CREATOR", "ADMIN"] },
      },
      select: {
        id: true,
        email: true,
        profile: { select: { displayName: true } },
      },
    });

    this.logger.log(`Generating scorecards for ${creators.length} creators.`);

    for (let i = 0; i < creators.length; i += BATCH_SIZE) {
      const batch = creators.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map((creator) =>
          this.generateAndSendForCreator(creator, weekStart, weekEnd),
        ),
      );
    }

    this.logger.log("Creator scorecard generation complete.");
  }

  private async generateAndSendForCreator(
    creator: { id: string; email: string; profile: { displayName: string } | null },
    weekStart: Date,
    weekEnd: Date,
  ) {
    try {
      // Check if scorecard already exists for this week
      const existing = await this.prisma.creatorScorecard.findUnique({
        where: {
          userId_weekStart: {
            userId: creator.id,
            weekStart,
          },
        },
      });

      if (existing?.emailSentAt) {
        return;
      }

      const stats = await this.aggregateStats(creator.id, weekStart, weekEnd);

      const scorecard = await this.prisma.creatorScorecard.upsert({
        where: {
          userId_weekStart: {
            userId: creator.id,
            weekStart,
          },
        },
        create: {
          userId: creator.id,
          weekStart,
          weekEnd,
          ...stats,
        },
        update: stats,
      });

      // Get previous week's scorecard for trends
      const previousWeekStart = new Date(weekStart);
      previousWeekStart.setDate(previousWeekStart.getDate() - 7);

      const previousScorecard = await this.prisma.creatorScorecard.findUnique({
        where: {
          userId_weekStart: {
            userId: creator.id,
            weekStart: previousWeekStart,
          },
        },
      });

      await this.sendScorecardEmail(creator, scorecard, previousScorecard);

      await this.prisma.creatorScorecard.update({
        where: { id: scorecard.id },
        data: { emailSentAt: new Date() },
      });
    } catch (error) {
      this.logger.error(
        `Failed to generate scorecard for creator ${creator.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async aggregateStats(userId: string, weekStart: Date, weekEnd: Date) {
    const [totalViews, uniqueReaders, newFollowers, chaptersPublished, avgRatingResult, totalComments] =
      await Promise.all([
        this.prisma.chapterReadEvent.count({
          where: {
            story: { authorId: userId },
            createdAt: { gte: weekStart, lt: weekEnd },
          },
        }),
        this.prisma.chapterReadEvent
          .groupBy({
            by: ["userId"],
            where: {
              story: { authorId: userId },
              createdAt: { gte: weekStart, lt: weekEnd },
            },
          })
          .then((groups) => groups.length),
        this.prisma.follow.count({
          where: {
            targetType: "AUTHOR",
            targetUserId: userId,
            createdAt: { gte: weekStart, lt: weekEnd },
          },
        }),
        this.prisma.publishedChapter.count({
          where: {
            story: { authorId: userId },
            publishedAt: { gte: weekStart, lt: weekEnd },
          },
        }),
        this.prisma.review
          .aggregate({
            _avg: { rating: true },
            where: {
              story: { authorId: userId },
              createdAt: { gte: weekStart, lt: weekEnd },
            },
          })
          .then((agg) => agg._avg.rating ?? 0),
        this.prisma.comment.count({
          where: {
            story: { authorId: userId },
            createdAt: { gte: weekStart, lt: weekEnd },
          },
        }),
      ]);

    // Average retention from chapter read events
    const chapterEvents = await this.prisma.chapterReadEvent.findMany({
      where: {
        story: { authorId: userId },
        createdAt: { gte: weekStart, lt: weekEnd },
      },
      select: { maxProgressPercent: true },
    });

    const avgRetention =
      chapterEvents.length > 0
        ? chapterEvents.reduce((sum, e) => sum + e.maxProgressPercent, 0) / chapterEvents.length
        : 0;

    return {
      avgRating: Math.round(avgRatingResult * 10) / 10,
      avgRetention: Math.round(avgRetention * 10) / 10,
      chaptersPublished,
      newFollowers,
      totalComments,
      totalReaders: uniqueReaders,
      totalViews,
    };
  }

  private getTrendArrow(current: number, previous: number): string {
    if (current > previous) return "↑";
    if (current < previous) return "↓";
    return "→";
  }

  private async sendScorecardEmail(
    creator: { id: string; email: string; profile: { displayName: string } | null },
    scorecard: {
      totalViews: number;
      totalReaders: number;
      newFollowers: number;
      chaptersPublished: number;
      avgRating: number;
      totalComments: number;
    },
    previousScorecard: {
      totalViews: number;
      totalReaders: number;
      newFollowers: number;
      chaptersPublished: number;
      avgRating: number;
      totalComments: number;
    } | null,
  ) {
    const userName = creator.profile?.displayName ?? "Creator";

    const lines: string[] = [
      `Views: ${scorecard.totalViews}${previousScorecard ? ` ${this.getTrendArrow(scorecard.totalViews, previousScorecard.totalViews)}` : ""}`,
      `Readers: ${scorecard.totalReaders}${previousScorecard ? ` ${this.getTrendArrow(scorecard.totalReaders, previousScorecard.totalReaders)}` : ""}`,
      `New Followers: ${scorecard.newFollowers}${previousScorecard ? ` ${this.getTrendArrow(scorecard.newFollowers, previousScorecard.newFollowers)}` : ""}`,
      `Chapters Published: ${scorecard.chaptersPublished}`,
      `Avg Rating: ${scorecard.avgRating}`,
      `Comments: ${scorecard.totalComments}${previousScorecard ? ` ${this.getTrendArrow(scorecard.totalComments, previousScorecard.totalComments)}` : ""}`,
    ];

    const token = await this.authService.generateUnsubscribeToken(
      creator.id,
      "creator-scorecard",
    );

    const unsubscribeUrl = `${env.frontendAppUrl}/unsubscribe?token=${token}`;

    await this.emailService.sendNotificationEmail({
      email: creator.email,
      preview: `Here's your weekly performance scorecard: ${lines.join(" | ")}`,
      subject: "Your Weekly Creator Scorecard",
      title: "Weekly Performance Scorecard",
      userName,
      unsubscribeUrl,
    });
  }
}
