import { Module } from "@nestjs/common";
import { CreatorAnalyticsService } from "./creator-analytics.service";

@Module({
  providers: [CreatorAnalyticsService],
  exports: [CreatorAnalyticsService],
})
export class AnalyticsModule {}
