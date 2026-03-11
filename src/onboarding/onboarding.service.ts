import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import {
  UpdateOnboardingGenresInput,
  UpdateOnboardingPreferencesInput,
  UploadOnboardingProfilePictureInput,
} from "./onboarding.types";
import { ProfileImageStorageService } from "./profile-image-storage.service";

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly profileImageStorageService: ProfileImageStorageService,
  ) {}

  async saveGenres(userId: string, input: UpdateOnboardingGenresInput) {
    await this.requireActiveUser(userId);

    await this.prisma.profile.upsert({
      where: { userId },
      update: {
        selectedGenres: input.genres,
      },
      create: {
        userId,
        displayName: "StoryArc User",
        selectedGenres: input.genres,
      },
    });

    return this.authService.getCurrentUser(userId);
  }

  async savePreferences(userId: string, input: UpdateOnboardingPreferencesInput) {
    await this.requireActiveUser(userId);

    await this.prisma.profile.upsert({
      where: { userId },
      update: {
        readingStyle: input.readingStyle,
        readingTheme: input.readingTheme,
        onboardingCompletedAt: new Date(),
      },
      create: {
        userId,
        displayName: "StoryArc User",
        readingStyle: input.readingStyle,
        readingTheme: input.readingTheme,
        onboardingCompletedAt: new Date(),
      },
    });

    return this.authService.getCurrentUser(userId);
  }

  async uploadProfilePicture(
    userId: string,
    input: UploadOnboardingProfilePictureInput,
  ) {
    await this.requireActiveUser(userId);

    const avatarUrl = await this.profileImageStorageService.uploadProfilePicture({
      ...input,
      userId,
    });

    await this.prisma.profile.upsert({
      where: { userId },
      update: {
        avatarUrl,
      },
      create: {
        avatarUrl,
        displayName: "StoryArc User",
        userId,
      },
    });

    return {
      message: "Profile picture uploaded.",
      ...(await this.authService.getCurrentUser(userId)),
    };
  }

  private async requireActiveUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });

    if (!user) {
      throw new NotFoundException("User not found.");
    }

    if (user.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is currently unavailable.");
    }
  }
}
