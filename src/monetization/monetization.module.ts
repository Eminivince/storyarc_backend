import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EngagementModule } from "../engagement/engagement.module";
import { RedisModule } from "../redis/redis.module";
import {
  CryptomusWebhookController,
  FlutterwaveWebhookController,
  MonetizationController,
  PaystackWebhookController,
  PolarWebhookController,
} from "./monetization.controller";
import { MonetizationService } from "./monetization.service";

@Module({
  imports: [AuthModule, EngagementModule, RedisModule],
  controllers: [
    MonetizationController,
    FlutterwaveWebhookController,
    PaystackWebhookController,
    CryptomusWebhookController,
    PolarWebhookController,
  ],
  providers: [MonetizationService],
  exports: [MonetizationService],
})
export class MonetizationModule {}
