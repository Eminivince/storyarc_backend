import { Logger } from "@nestjs/common";
import { ThrottlerStorage, ThrottlerStorageService } from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";

/**
 * Uses Redis for distributed rate limits when available; otherwise in-memory
 * {@link ThrottlerStorageService} so the API still boots and serves traffic.
 * Per-process limits when Redis is down (not suitable for strict multi-replica limits).
 */
export class ResilientThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(ResilientThrottlerStorage.name);
  private readonly memory = new ThrottlerStorageService();
  private useRedis = true;

  constructor(private readonly redisStorage: ThrottlerStorageRedisService) {}

  async initializeRedis() {
    const redis = this.redisStorage.redis;
    try {
      if (redis.status === "wait") {
        await redis.connect();
      }
      await redis.ping();
      this.logger.log("Throttler storage: Redis connected.");
    } catch (error) {
      this.disableRedis(
        error instanceof Error ? error.message : String(error),
        "startup",
      );
    }
  }

  destroy() {
    this.memory.onApplicationShutdown();
    this.redisStorage.onModuleDestroy();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ) {
    if (!this.useRedis) {
      return this.memory.increment(key, ttl, limit, blockDuration, throttlerName);
    }

    try {
      return await this.redisStorage.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.disableRedis(message, "increment");
      return this.memory.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  private disableRedis(reason: string, phase: string) {
    if (!this.useRedis) {
      return;
    }

    this.useRedis = false;
    this.logger.warn(
      `Throttler using in-memory storage (${phase}): ${reason}. Rate limits apply per process only.`,
    );

    try {
      this.redisStorage.redis.disconnect(false);
    } catch {
      // ignore
    }
  }
}
