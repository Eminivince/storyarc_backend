import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EmailQueueService } from "../common/services/email-queue.service";
import { RedisModule } from "../redis/redis.module";
import { BadgeEvaluationService } from "./badge-evaluation.service";
import { EngagementController } from "./engagement.controller";
import { EngagementService } from "./engagement.service";
import { CreatorScorecardService } from "./creator-scorecard.service";
import { DataCleanupService } from "./data-cleanup.service";
import { RetentionNotificationService } from "./retention-notification.service";
import { WeeklyDigestService } from "./weekly-digest.service";

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [EngagementController],
  providers: [
    EngagementService,
    BadgeEvaluationService,
    CreatorScorecardService,
    EmailQueueService,
    RetentionNotificationService,
    WeeklyDigestService,
    DataCleanupService,
  ],
  exports: [EngagementService, BadgeEvaluationService, EmailQueueService],
})
export class EngagementModule {}
