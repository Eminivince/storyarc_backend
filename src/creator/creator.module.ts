import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import {
  AdminCreatorApplicationsController,
  CreatorController,
} from "./creator.controller";
import { CreatorFinanceService } from "./creator-finance.service";
import { CreatorService } from "./creator.service";

@Module({
  imports: [AuthModule],
  controllers: [CreatorController, AdminCreatorApplicationsController],
  providers: [CreatorService, CreatorFinanceService],
})
export class CreatorModule {}
