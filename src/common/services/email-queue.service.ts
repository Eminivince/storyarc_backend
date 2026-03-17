import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { RedisService } from "../../redis/redis.service";
import { ResendEmailService } from "../../auth/resend-email.service";

const QUEUE_KEY = "email:queue";
const LOCK_KEY = "email-queue:lock";
const LOCK_TTL_SECONDS = 30;
const POLL_INTERVAL_MS = 5_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_SECONDS = 5;

interface QueuedEmail {
  method: string;
  params: Record<string, unknown>;
  retries: number;
  nextAttemptAt: number;
}

@Injectable()
export class EmailQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailQueueService.name);
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;

  constructor(
    private readonly redisService: RedisService,
    private readonly resendEmailService: ResendEmailService,
  ) {}

  onModuleInit() {
    this.intervalId = setInterval(() => {
      void this.processCycle();
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async enqueue(method: string, params: Record<string, unknown>): Promise<void> {
    const item: QueuedEmail = {
      method,
      params,
      retries: 0,
      nextAttemptAt: Date.now(),
    };

    await this.redisService.pushToList(QUEUE_KEY, item);
    this.logger.log(`Enqueued email: ${method}`);
  }

  private async processCycle(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    let lockToken: string | null = null;

    try {
      lockToken = await this.redisService.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);

      if (!lockToken) {
        return;
      }

      const queueLength = await this.redisService.listLength(QUEUE_KEY);

      if (queueLength === 0) {
        return;
      }

      let processed = 0;

      while (processed < queueLength) {
        const raw = await this.redisService.popFromList(QUEUE_KEY);

        if (!raw) {
          break;
        }

        const item = raw as QueuedEmail;
        processed++;

        if (item.nextAttemptAt > Date.now()) {
          await this.redisService.pushToList(QUEUE_KEY, item);
          continue;
        }

        await this.processItem(item);
      }
    } catch (error) {
      this.logger.error(
        `Email queue processing cycle failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      if (lockToken) {
        await this.redisService.releaseLock(LOCK_KEY, lockToken);
      }

      this.isProcessing = false;
    }
  }

  private async processItem(item: QueuedEmail): Promise<void> {
    const method = item.method as keyof ResendEmailService;

    if (typeof this.resendEmailService[method] !== "function") {
      this.logger.error(
        `Dead letter: unknown method "${item.method}" — dropping email.`,
      );
      return;
    }

    try {
      await (this.resendEmailService[method] as (params: Record<string, unknown>) => Promise<void>)(
        item.params,
      );

      this.logger.log(`Email sent successfully: ${item.method}`);
    } catch (error) {
      const attempt = item.retries + 1;

      if (attempt >= MAX_RETRIES) {
        this.logger.error(
          `Dead letter: email "${item.method}" failed after ${MAX_RETRIES} retries. ` +
            `Last error: ${error instanceof Error ? error.message : "unknown error"}. ` +
            `Params: ${JSON.stringify(item.params)}`,
        );
        return;
      }

      const backoffMs = Math.pow(BACKOFF_BASE_SECONDS, attempt) * 1_000;

      const retryItem: QueuedEmail = {
        ...item,
        retries: attempt,
        nextAttemptAt: Date.now() + backoffMs,
      };

      await this.redisService.pushToList(QUEUE_KEY, retryItem);

      this.logger.warn(
        `Email "${item.method}" failed (attempt ${attempt}/${MAX_RETRIES}), ` +
          `retrying in ${backoffMs / 1_000}s. Error: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
