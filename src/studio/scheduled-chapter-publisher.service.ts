import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { env } from "../config/env";
import { RedisService } from "../redis/redis.service";
import { StudioService } from "./studio.service";

const AUTO_PUBLISH_LOCK_KEY = "jobs:studio:auto-publish-scheduled-chapters";

@Injectable()
export class ScheduledChapterPublisherService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ScheduledChapterPublisherService.name);
  private readonly batchSize = env.scheduledPublishBatchSize;
  private readonly intervalMs = env.scheduledPublishIntervalSeconds * 1000;
  private readonly lockTtlSeconds = Math.max(
    env.scheduledPublishIntervalSeconds * 2,
    60,
  );
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private startupTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;

  constructor(
    private readonly redisService: RedisService,
    private readonly studioService: StudioService,
  ) {}

  onModuleInit() {
    this.startupTimeoutId = setTimeout(() => {
      void this.runCycle("startup");
    }, 1_000);

    this.intervalId = setInterval(() => {
      void this.runCycle("interval");
    }, this.intervalMs);
  }

  onModuleDestroy() {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async runCycle(trigger: "interval" | "startup") {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    let lockToken: string | null = null;

    try {
      lockToken = await this.redisService.acquireLock(
        AUTO_PUBLISH_LOCK_KEY,
        this.lockTtlSeconds,
      );

      if (!lockToken) {
        return;
      }

      const result = await this.studioService.autoPublishDueChapters(
        new Date(),
        this.batchSize,
      );

      if (result.publishedCount > 0) {
        this.logger.log(
          `Auto-published ${result.publishedCount} scheduled chapter(s) on ${trigger}.`,
        );
      }

      if (result.failureCount > 0) {
        this.logger.warn(
          `Scheduled chapter cycle finished with ${result.failureCount} failure(s) out of ${result.scannedCount} due chapter(s).`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Scheduled chapter auto-publish cycle failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      if (lockToken) {
        await this.redisService.releaseLock(AUTO_PUBLISH_LOCK_KEY, lockToken);
      }

      this.isRunning = false;
    }
  }
}
