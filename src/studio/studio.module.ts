import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module";
import { AuthModule } from "../auth/auth.module";
import { EngagementModule } from "../engagement/engagement.module";
import { ScheduledChapterPublisherService } from "./scheduled-chapter-publisher.service";
import { StudioController } from "./studio.controller";
import { StudioService } from "./studio.service";

@Module({
  imports: [AnalyticsModule, AuthModule, EngagementModule],
  controllers: [StudioController],
  providers: [StudioService, ScheduledChapterPublisherService],
})
export class StudioModule {}
