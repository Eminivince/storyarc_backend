import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";
import { ResendEmailService } from "../auth/resend-email.service";
import { AuthService } from "../auth/auth.service";
import { env } from "../config/env";

const LOCK_KEY = "weekly-digest:lock";
const LOCK_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BATCH_SIZE = 50;

@Injectable()
export class WeeklyDigestService implements OnModuleInit {
  private readonly logger = new Logger(WeeklyDigestService.name);
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
          `Weekly digest check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, CHECK_INTERVAL_MS);
  }

  private async checkAndRun() {
    const now = new Date();

    if (now.getUTCDay() !== 0) {
      return;
    }

    if (now.getUTCHours() < 8 || now.getUTCHours() >= 9) {
      return;
    }

    const lockToken = await this.redis.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);

    if (!lockToken) {
      this.logger.log("Weekly digest already running (lock held). Skipping.");
      return;
    }

    try {
      await this.sendDigests();
    } finally {
      await this.redis.releaseLock(LOCK_KEY, lockToken);
    }
  }

  private async sendDigests() {
    const users = await this.prisma.user.findMany({
      where: {
        status: "ACTIVE",
        notificationPreference: {
          emailWeeklyDigest: true,
        },
      },
      select: {
        id: true,
        email: true,
        profile: { select: { displayName: true } },
      },
    });

    this.logger.log(`Sending weekly digest to ${users.length} users.`);

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const newStoriesCount = await this.prisma.story.count({
      where: {
        isLive: true,
        liveAt: { gte: oneWeekAgo },
      },
    });

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map((user) =>
          this.sendDigestToUser(user, oneWeekAgo, newStoriesCount),
        ),
      );
    }

    this.logger.log("Weekly digest complete.");
  }

  private async sendDigestToUser(
    user: { id: string; email: string; profile: { displayName: string } | null },
    since: Date,
    newStoriesCount: number,
  ) {
    try {
      const newChapterCount = await this.prisma.publishedChapter.count({
        where: {
          publishedAt: { gte: since },
          story: {
            readingListItems: {
              some: {
                readingList: { userId: user.id },
              },
            },
          },
        },
      });

      const sections: string[] = [];

      if (newChapterCount > 0) {
        sections.push(
          `${newChapterCount} new chapter${newChapterCount === 1 ? "" : "s"} from stories you follow`,
        );
      }

      if (newStoriesCount > 0) {
        sections.push(
          `${newStoriesCount} new stor${newStoriesCount === 1 ? "y" : "ies"} published this week`,
        );
      }

      if (sections.length === 0) {
        return;
      }

      const token = await this.authService.generateUnsubscribeToken(
        user.id,
        "weekly-digest",
      );

      const unsubscribeUrl = `${env.frontendAppUrl}/unsubscribe?token=${token}`;
      const userName = user.profile?.displayName ?? "Reader";

      await this.emailService.sendWeeklyDigest({
        email: user.email,
        userName,
        sections,
        unsubscribeUrl,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send weekly digest to user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
