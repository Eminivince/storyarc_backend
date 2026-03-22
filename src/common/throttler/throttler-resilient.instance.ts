import { createThrottlerRedisStorage } from "./throttler-redis.storage";
import { ResilientThrottlerStorage } from "./throttler-resilient.storage";

/** Shared instance wired into {@link ThrottlerModule} and {@link ResilientThrottlerLifecycle}. */
export const resilientThrottlerStorage = new ResilientThrottlerStorage(
  createThrottlerRedisStorage(),
);
