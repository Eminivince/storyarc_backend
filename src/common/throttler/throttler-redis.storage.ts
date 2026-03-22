import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import type { RedisOptions } from "ioredis";
import { env } from "../../config/env";

/**
 * Throttler Redis client options.
 * `enableOfflineQueue: true` avoids "Stream isn't writeable and enableOfflineQueue options is false"
 * when a request hits {@link ThrottlerGuard} before the TCP connection is ready or during reconnect.
 * {@link ResilientThrottlerLifecycle} still eagerly connects before HTTP listens.
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
 * Wrapped by {@link ResilientThrottlerStorage} for graceful fallback when Redis is down.
 */
export function createThrottlerRedisStorage(): ThrottlerStorageRedisService {
  return new ThrottlerStorageRedisService(
    env.redisUrl,
    getThrottlerRedisClientOptions(),
  );
}
