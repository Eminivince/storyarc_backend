import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
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
})
export class AppModule {}
