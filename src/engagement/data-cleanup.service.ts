import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOCK_KEY = "data-cleanup:lock";
const LOCK_TTL_SECONDS = 600; // 10 minutes

@Injectable()
export class DataCleanupService implements OnModuleInit {
  private readonly logger = new Logger(DataCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    setInterval(() => {
      this.runCleanup().catch((error) => {
        this.logger.error("Data cleanup failed", error);
      });
    }, CHECK_INTERVAL_MS);
  }

  private async runCleanup() {
    const lockToken = await this.redis.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);

    if (!lockToken) {
      return;
    }

    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Delete old leaderboard snapshots (> 90 days)
      const deletedSnapshots =
        await this.prisma.leaderboardSnapshot.deleteMany({
          where: {
            createdAt: { lt: ninetyDaysAgo },
          },
        });

      if (deletedSnapshots.count > 0) {
        this.logger.log(
          `Cleaned up ${deletedSnapshots.count} leaderboard snapshot(s) older than 90 days.`,
        );
      }

      // Delete revoked sessions older than 30 days
      const deletedSessions = await this.prisma.session.deleteMany({
        where: {
          revokedAt: { not: null, lt: thirtyDaysAgo },
        },
      });

      if (deletedSessions.count > 0) {
        this.logger.log(
          `Cleaned up ${deletedSessions.count} revoked session(s) older than 30 days.`,
        );
      }
    } finally {
      await this.redis.releaseLock(LOCK_KEY, lockToken);
    }
  }
}
