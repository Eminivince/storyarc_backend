import { Body, Controller, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseOnboardingGenresBody,
  parseOnboardingPreferencesBody,
  parseOnboardingProfilePictureBody,
} from "./onboarding.schemas";
import { OnboardingService } from "./onboarding.service";

@Controller("onboarding")
@UseGuards(AccessTokenGuard)
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Patch("genres")
  async saveGenres(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.onboardingService.saveGenres(
      request.auth!.userId,
      parseOnboardingGenresBody(body),
    );
  }

  @Patch("preferences")
  async savePreferences(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.onboardingService.savePreferences(
      request.auth!.userId,
      parseOnboardingPreferencesBody(body),
    );
  }

  @Post("profile-picture")
  async uploadProfilePicture(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.onboardingService.uploadProfilePicture(
      request.auth!.userId,
      parseOnboardingProfilePictureBody(body),
    );
  }
}
