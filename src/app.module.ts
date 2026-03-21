import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { throttlerGetTracker } from "./common/throttler/throttler-tracker.util";
import { THROTTLE_DEFAULT_MS } from "./common/throttler/throttler.constants";
import { CreatorModule } from "./creator/creator.module";
import { DatabaseModule } from "./database/database.module";
import { EngagementModule } from "./engagement/engagement.module";
import { HealthModule } from "./health/health.module";
import { MonetizationModule } from "./monetization/monetization.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
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
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
    AuthModule,
    CreatorModule,
    EngagementModule,
    OnboardingModule,
    OperationsModule,
    MonetizationModule,
    ReaderModule,
    StudioModule,
    WebsocketModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
