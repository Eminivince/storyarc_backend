import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { ResilientThrottlerLifecycle } from "./common/throttler/resilient-throttler.lifecycle";
import { THROTTLE_DEFAULT_MS } from "./common/throttler/throttler.constants";
import { resilientThrottlerStorage } from "./common/throttler/throttler-resilient.instance";
import { throttlerGetTracker } from "./common/throttler/throttler-tracker.util";
import { CreatorModule } from "./creator/creator.module";
import { DatabaseModule } from "./database/database.module";
import { EngagementModule } from "./engagement/engagement.module";
import { HealthModule } from "./health/health.module";
import { MonetizationModule } from "./monetization/monetization.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { AdminModule } from "./admin/admin.module";
import { OperationsModule } from "./operations/operations.module";
import { ReaderModule } from "./reader/reader.module";
import { RedisModule } from "./redis/redis.module";
import { StudioModule } from "./studio/studio.module";
import { WebsocketModule } from "./websocket/websocket.module";

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: "default",
          ttl: THROTTLE_DEFAULT_MS,
          limit: 100,
        },
      ],
      getTracker: throttlerGetTracker,
      storage: resilientThrottlerStorage,
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
    AuthModule,
    CreatorModule,
    EngagementModule,
    OnboardingModule,
    AdminModule,
    OperationsModule,
    MonetizationModule,
    ReaderModule,
    StudioModule,
    WebsocketModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    ResilientThrottlerLifecycle,
  ],
})
export class AppModule {}
