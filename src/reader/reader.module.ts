import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module";
import { AuthModule } from "../auth/auth.module";
import { EngagementModule } from "../engagement/engagement.module";
import { MonetizationModule } from "../monetization/monetization.module";
import { RedisModule } from "../redis/redis.module";
import { ReaderController } from "./reader.controller";
import { ReaderPublicController } from "./reader.public.controller";
import { ReaderService } from "./reader.service";
import { StoryRankingsService } from "./story-rankings.service";

@Module({
  imports: [AnalyticsModule, AuthModule, EngagementModule, MonetizationModule, RedisModule],
  controllers: [ReaderController, ReaderPublicController],
  providers: [ReaderService, StoryRankingsService],
})
export class ReaderModule {}
