import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import {
  AdminCreatorApplicationsController,
  CreatorController,
} from "./creator.controller";
import { CreatorService } from "./creator.service";

@Module({
  imports: [AuthModule],
  controllers: [CreatorController, AdminCreatorApplicationsController],
  providers: [CreatorService],
})
export class CreatorModule {}
