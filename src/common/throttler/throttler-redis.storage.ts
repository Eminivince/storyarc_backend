import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import type { RedisOptions } from "ioredis";
import { env } from "../../config/env";

/**
 * DI token for the shared Throttler Redis storage instance (used by ThrottlerModule + shutdown hook).
 */
export const THROTTLER_REDIS_STORAGE = Symbol("THROTTLER_REDIS_STORAGE");

/**
 * Throttler Redis client options.
 * `enableOfflineQueue: true` avoids "Stream isn't writeable and enableOfflineQueue options is false"
 * when a request hits {@link ThrottlerGuard} before the TCP connection is ready or during reconnect.
 * {@link ThrottlerRedisStorageLifecycle.onModuleInit} still eagerly `connect()`s before HTTP listens.
 */
export function getThrottlerRedisClientOptions(): RedisOptions {
  return {
    enableOfflineQueue: true,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  };
}

/**
 * Dedicated ioredis connection for rate-limit state (separate from {@link RedisService} session cache).
 * Required so limits are consistent across multiple API replicas.
 */
export function createThrottlerRedisStorage(): ThrottlerStorageRedisService {
  return new ThrottlerStorageRedisService(
    env.redisUrl,
    getThrottlerRedisClientOptions(),
  );
}

@Injectable()
export class ThrottlerRedisStorageLifecycle implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(ThrottlerRedisStorageLifecycle.name);

  constructor(
    @Inject(THROTTLER_REDIS_STORAGE)
    private readonly storage: ThrottlerStorageRedisService,
  ) {}

  async onModuleInit() {
    const redis = this.storage.redis;
    try {
      if (redis.status === "wait") {
        await redis.connect();
      }
      await redis.ping();
    } catch (error) {
      this.logger.error(
        `Throttler Redis failed to connect: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  onModuleDestroy() {
    this.storage.onModuleDestroy();
  }
}
