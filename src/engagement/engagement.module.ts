import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RedisModule } from "../redis/redis.module";
import { EngagementController } from "./engagement.controller";
import { EngagementService } from "./engagement.service";

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [EngagementController],
  providers: [EngagementService],
  exports: [EngagementService],
})
export class EngagementModule {}
