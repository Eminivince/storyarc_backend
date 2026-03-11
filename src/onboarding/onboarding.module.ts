import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OnboardingController } from "./onboarding.controller";
import { ProfileImageStorageService } from "./profile-image-storage.service";
import { OnboardingService } from "./onboarding.service";

@Module({
  imports: [AuthModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, ProfileImageStorageService],
})
export class OnboardingModule {}
