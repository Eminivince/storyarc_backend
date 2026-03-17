import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RedisModule } from "../redis/redis.module";
import {
  AdminCreatorApplicationsController,
  CreatorController,
} from "./creator.controller";
import { ContractExpirationService } from "./contract-expiration.service";
import { CreatorFinanceService } from "./creator-finance.service";
import { CreatorService } from "./creator.service";

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [CreatorController, AdminCreatorApplicationsController],
  providers: [CreatorService, CreatorFinanceService, ContractExpirationService],
})
export class CreatorModule {}
