import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import {
  MonetizationController,
  PaystackWebhookController,
} from "./monetization.controller";
import { MonetizationService } from "./monetization.service";

@Module({
  imports: [AuthModule],
  controllers: [MonetizationController, PaystackWebhookController],
  providers: [MonetizationService],
  exports: [MonetizationService],
})
export class MonetizationModule {}
