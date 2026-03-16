import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RedisModule } from "../redis/redis.module";
import {
  CryptomusWebhookController,
  MonetizationController,
  PaystackWebhookController,
} from "./monetization.controller";
import { MonetizationService } from "./monetization.service";

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [
    MonetizationController,
    PaystackWebhookController,
    CryptomusWebhookController,
  ],
  providers: [MonetizationService],
  exports: [MonetizationService],
})
export class MonetizationModule {}
