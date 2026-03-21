import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import type { RedisOptions } from "ioredis";
import { env } from "../../config/env";

/**
 * DI token for the shared Throttler Redis storage instance (used by ThrottlerModule + shutdown hook).
 */
export const THROTTLER_REDIS_STORAGE = Symbol("THROTTLER_REDIS_STORAGE");

/** Client options aligned with {@link RedisService} for consistent timeout / retry behavior. */
export function getThrottlerRedisClientOptions(): RedisOptions {
  return {
    enableOfflineQueue: false,
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
export class ThrottlerRedisStorageLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(THROTTLER_REDIS_STORAGE)
    private readonly storage: ThrottlerStorageRedisService,
  ) {}

  onModuleDestroy() {
    this.storage.onModuleDestroy();
  }
}
