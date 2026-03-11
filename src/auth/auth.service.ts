import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { compare, hash } from "bcryptjs";
import { createHash, randomBytes, randomInt } from "crypto";
import { env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";
import {
  AppUserRole,
  CreatorApplicationSnapshot,
  ForgotPasswordInput,
  LoginInput,
  OnboardingStep,
  PendingRegistrationPayload,
  RefreshInput,
  RegisterInput,
  RequestMeta,
  ResetPasswordInput,
  TokenPayload,
  UpdateCurrentUserProfileInput,
  UserProfileSnapshot,
  VerifiedResetPayload,
  VerifyResetCodeInput,
} from "./auth.types";
import { ResendEmailService } from "./resend-email.service";

const HASH_ROUNDS = 12;

type AuthUserSnapshot = {
  id: string;
  email: string;
  role: AppUserRole;
  profile: UserProfileSnapshot | null;
  creatorApplication?: CreatorApplicationSnapshot | null;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly resendEmailService: ResendEmailService,
  ) {}

  async register(input: RegisterInput) {
    const email = this.normalizeEmail(input.email);
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException("An account with this email already exists.");
    }

    const passwordHash = await hash(input.password, HASH_ROUNDS);
    const code = this.generateOtpCode();
    const expiresAt = this.addMinutes(new Date(), env.registrationCodeTtlMinutes);

    await this.redis.setJson(
      this.getPendingRegistrationKey(email),
      {
        codeHash: this.hashRegistrationCode(email, code),
        displayName: input.displayName,
        email,
        expiresAtIso: expiresAt.toISOString(),
        passwordHash,
      } satisfies PendingRegistrationPayload,
      env.registrationCodeTtlMinutes * 60,
    );

    await this.resendEmailService.sendRegistrationCode({
      code,
      displayName: input.displayName,
      email,
      expiresInMinutes: env.registrationCodeTtlMinutes,
    });

    return {
      email,
      expiresInSeconds: env.registrationCodeTtlMinutes * 60,
      message: "Verification code sent. Check your email to finish registration.",
    };
  }

  async resendRegisterCode(input: ForgotPasswordInput) {
    const email = this.normalizeEmail(input.email);
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException("An account with this email already exists.");
    }

    const pendingRegistration = await this.redis.getJson<PendingRegistrationPayload>(
      this.getPendingRegistrationKey(email),
    );

    if (!pendingRegistration) {
      throw new BadRequestException(
        "Registration has expired. Start account creation again.",
      );
    }

    const code = this.generateOtpCode();
    const expiresAt = this.addMinutes(new Date(), env.registrationCodeTtlMinutes);

    await this.redis.setJson(
      this.getPendingRegistrationKey(email),
      {
        ...pendingRegistration,
        codeHash: this.hashRegistrationCode(email, code),
        expiresAtIso: expiresAt.toISOString(),
      } satisfies PendingRegistrationPayload,
      env.registrationCodeTtlMinutes * 60,
    );

    await this.resendEmailService.sendRegistrationCode({
      code,
      displayName: pendingRegistration.displayName,
      email,
      expiresInMinutes: env.registrationCodeTtlMinutes,
    });

    return {
      email,
      expiresInSeconds: env.registrationCodeTtlMinutes * 60,
      message: "A new verification code has been sent.",
    };
  }

  async verifyRegisterCode(input: VerifyResetCodeInput, requestMeta: RequestMeta) {
    const email = this.normalizeEmail(input.email);
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException("An account with this email already exists.");
    }

    const pendingRegistration = await this.redis.getJson<PendingRegistrationPayload>(
      this.getPendingRegistrationKey(email),
    );

    if (!pendingRegistration) {
      throw new UnauthorizedException("Invalid verification code.");
    }

    if (Date.parse(pendingRegistration.expiresAtIso) <= Date.now()) {
      await this.redis.delete(this.getPendingRegistrationKey(email));
      throw new UnauthorizedException("This verification code has expired.");
    }

    if (
      pendingRegistration.codeHash !== this.hashRegistrationCode(email, input.code)
    ) {
      throw new UnauthorizedException("Invalid verification code.");
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        emailVerifiedAt: new Date(),
        role: "READER",
        profile: {
          create: {
            displayName: pendingRegistration.displayName,
          },
        },
        credential: {
          create: {
            passwordHash: pendingRegistration.passwordHash,
          },
        },
      },
      include: {
        profile: true,
      },
    });

    await this.redis.delete(this.getPendingRegistrationKey(email));

    return this.createSessionResponse(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        creatorApplication: null,
        profile: user.profile,
      },
      requestMeta,
    );
  }

  async login(input: LoginInput, requestMeta: RequestMeta) {
    const email = this.normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        credential: true,
        creatorApplication: {
          select: {
            reviewNotes: true,
            reviewedAt: true,
            status: true,
            submittedAt: true,
          },
        },
        profile: true,
      },
    });

    if (!user?.credential) {
      throw new UnauthorizedException("Invalid email or password.");
    }

    if (user.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is currently unavailable.");
    }

    const passwordMatches = await compare(input.password, user.credential.passwordHash);

    if (!passwordMatches) {
      throw new UnauthorizedException("Invalid email or password.");
    }

    return this.createSessionResponse(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        creatorApplication: user.creatorApplication,
        profile: user.profile,
      },
      requestMeta,
    );
  }

  async logout(userId: string, sessionId: string) {
    await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        userId,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return {
      message: "Signed out successfully.",
    };
  }

  async refresh(input: RefreshInput, requestMeta: RequestMeta) {
    let payload: TokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<TokenPayload>(input.refreshToken, {
        secret: env.jwtRefreshSecret,
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token.");
    }

    if (payload.type !== "refresh") {
      throw new UnauthorizedException("Invalid refresh token type.");
    }

    const session = await this.prisma.session.findUnique({
      where: {
        id: payload.sessionId,
      },
      include: {
        user: {
          include: {
            creatorApplication: {
              select: {
                reviewNotes: true,
                reviewedAt: true,
                status: true,
                submittedAt: true,
              },
            },
            profile: true,
          },
        },
      },
    });

    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.refreshTokenExpiresAt.getTime() <= Date.now() ||
      session.user.status !== "ACTIVE"
    ) {
      throw new UnauthorizedException("Session is no longer active.");
    }

    const refreshTokenMatches = await compare(
      input.refreshToken,
      session.refreshTokenHash,
    );

    if (!refreshTokenMatches) {
      throw new UnauthorizedException("Invalid refresh token.");
    }

    return this.rotateSessionTokens(
      {
        id: session.user.id,
        creatorApplication: session.user.creatorApplication,
        email: session.user.email,
        role: session.user.role,
        profile: session.user.profile,
      },
      session.id,
      requestMeta,
    );
  }

  async forgotPassword(input: ForgotPasswordInput) {
    const email = this.normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        profile: true,
        credential: true,
      },
    });

    if (!user?.credential) {
      return {
        message:
          "If an account with that email exists, a password reset code has been sent.",
      };
    }

    const code = this.generateOtpCode();
    const expiresAt = this.addMinutes(
      new Date(),
      env.passwordResetCodeTtlMinutes,
    );

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        email: user.email,
        codeHash: this.hashResetCode(user.id, code),
        expiresAt,
        verifiedAt: null,
        usedAt: null,
      },
    });

    await this.resendEmailService.sendPasswordResetCode({
      email: user.email,
      displayName: user.profile?.displayName ?? "StoryArc Reader",
      code,
      expiresInMinutes: env.passwordResetCodeTtlMinutes,
    });

    return {
      message:
        "If an account with that email exists, a password reset code has been sent.",
    };
  }

  async verifyResetCode(input: VerifyResetCodeInput) {
    const email = this.normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (!user) {
      throw new UnauthorizedException("Invalid reset code.");
    }

    const resetTokenRecord = await this.prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!resetTokenRecord) {
      throw new UnauthorizedException("Invalid reset code.");
    }

    if (resetTokenRecord.usedAt) {
      throw new UnauthorizedException("Invalid reset code.");
    }

    if (resetTokenRecord.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("This reset code has expired.");
    }

    const codeHash = this.hashResetCode(user.id, input.code);

    if (resetTokenRecord.codeHash !== codeHash) {
      throw new UnauthorizedException("Invalid reset code.");
    }

    const verifiedAt = new Date();
    const verifiedResetToken = this.generateOpaqueToken();

    await this.prisma.passwordResetToken.update({
      where: { id: resetTokenRecord.id },
      data: { verifiedAt },
    });

    await this.redis.setJson(
      this.getVerifiedResetKey(verifiedResetToken),
      {
        userId: user.id,
        passwordResetTokenId: resetTokenRecord.id,
      } satisfies VerifiedResetPayload,
      env.resetVerifiedTokenTtlMinutes * 60,
    );

    return {
      message: "Reset code verified.",
      resetToken: verifiedResetToken,
      expiresInSeconds: env.resetVerifiedTokenTtlMinutes * 60,
    };
  }

  async resetPassword(input: ResetPasswordInput) {
    const redisKey = this.getVerifiedResetKey(input.resetToken);
    const verifiedReset = await this.redis.getJson<VerifiedResetPayload>(redisKey);

    if (!verifiedReset) {
      throw new UnauthorizedException("The password reset token is invalid or expired.");
    }

    const resetTokenRecord = await this.prisma.passwordResetToken.findUnique({
      where: { id: verifiedReset.passwordResetTokenId },
    });

    if (!resetTokenRecord || resetTokenRecord.userId !== verifiedReset.userId) {
      throw new UnauthorizedException("The password reset token is invalid.");
    }

    if (resetTokenRecord.usedAt) {
      throw new BadRequestException("This password reset request has already been used.");
    }

    if (!resetTokenRecord.verifiedAt) {
      throw new BadRequestException("Reset code verification is still required.");
    }

    if (resetTokenRecord.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("This password reset request has expired.");
    }

    const passwordHash = await hash(input.password, HASH_ROUNDS);
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.credential.updateMany({
        where: {
          userId: verifiedReset.userId,
        },
        data: {
          passwordHash,
        },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: resetTokenRecord.id },
        data: { usedAt: now },
      }),
      this.prisma.session.updateMany({
        where: {
          userId: verifiedReset.userId,
        },
        data: {
          revokedAt: now,
        },
      }),
    ]);

    await this.redis.delete(redisKey);

    return {
      message: "Password updated successfully.",
    };
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        creatorApplication: {
          select: {
            reviewNotes: true,
            reviewedAt: true,
            status: true,
            submittedAt: true,
          },
        },
        profile: true,
      },
    });

    if (!user || user.status !== "ACTIVE") {
      throw new UnauthorizedException("The current user account is unavailable.");
    }

    return {
      user: this.mapUser({
        creatorApplication: user.creatorApplication,
        id: user.id,
        email: user.email,
        role: user.role,
        profile: user.profile,
      }),
    };
  }

  async updateCurrentUserProfile(
    userId: string,
    input: UpdateCurrentUserProfileInput,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        creatorApplication: {
          select: {
            reviewNotes: true,
            reviewedAt: true,
            status: true,
            submittedAt: true,
          },
        },
        profile: true,
      },
    });

    if (!user || user.status !== "ACTIVE") {
      throw new UnauthorizedException("The current user account is unavailable.");
    }

    const wasProfileComplete = Boolean(
      user.profile?.displayName &&
        user.profile?.bio &&
        user.profile?.selectedGenres?.length,
    );

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        profile: {
          upsert: {
            create: {
              allowMessages: input.allowMessages,
              bio: input.bio,
              contentFiltering: input.contentFiltering,
              discord: input.discord,
              displayLanguage: input.displayLanguage,
              displayName: input.displayName,
              location: input.location,
              privateLibrary: input.privateLibrary,
              showActivity: input.showActivity,
              tagline: input.tagline,
              twitter: input.twitter,
              website: input.website,
            },
            update: {
              allowMessages: input.allowMessages,
              bio: input.bio,
              contentFiltering: input.contentFiltering,
              discord: input.discord,
              displayLanguage: input.displayLanguage,
              displayName: input.displayName,
              location: input.location,
              privateLibrary: input.privateLibrary,
              showActivity: input.showActivity,
              tagline: input.tagline,
              twitter: input.twitter,
              website: input.website,
            },
          },
        },
      },
      include: {
        creatorApplication: {
          select: {
            reviewNotes: true,
            reviewedAt: true,
            status: true,
            submittedAt: true,
          },
        },
        profile: true,
      },
    });

    const isProfileComplete = Boolean(
      updatedUser.profile?.displayName &&
        updatedUser.profile?.bio &&
        updatedUser.profile?.selectedGenres?.length,
    );

    if (!wasProfileComplete && isProfileComplete) {
      const existingProfileCompleteEvent =
        await this.prisma.userActivityEvent.findFirst({
          where: {
            type: "COMPLETE_PROFILE",
            userId,
          },
          select: {
            id: true,
          },
        });

      if (!existingProfileCompleteEvent) {
        await this.prisma.userActivityEvent.create({
          data: {
            happenedAt: new Date(),
            numericValue: 1,
            type: "COMPLETE_PROFILE",
            userId,
          },
        });
      }
    }

    return {
      message: "Profile updated successfully.",
      profile: this.mapAccountProfile({
        creatorApplication: updatedUser.creatorApplication,
        email: updatedUser.email,
        id: updatedUser.id,
        profile: updatedUser.profile,
        role: updatedUser.role,
      }),
      user: this.mapUser({
        creatorApplication: updatedUser.creatorApplication,
        email: updatedUser.email,
        id: updatedUser.id,
        profile: updatedUser.profile,
        role: updatedUser.role,
      }),
    };
  }

  async getSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return {
      sessions: sessions.map((session: (typeof sessions)[number]) => ({
        id: session.id,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        refreshTokenExpiresAt: session.refreshTokenExpiresAt,
        revokedAt: session.revokedAt,
        current: session.id === currentSessionId,
      })),
    };
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
      },
      select: { id: true },
    });

    if (!session) {
      throw new NotFoundException("Session not found.");
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    return {
      message: "Session revoked.",
    };
  }

  private async createSessionResponse(
    user: AuthUserSnapshot,
    requestMeta: RequestMeta,
  ) {
    const now = new Date();
    const accessTokenExpiresAt = this.addMinutes(now, env.accessTokenTtlMinutes);
    const refreshTokenExpiresAt = this.addDays(now, env.refreshTokenTtlDays);
    const placeholderHash = await hash(this.generateOpaqueToken(), HASH_ROUNDS);

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: placeholderHash,
        userAgent: requestMeta.userAgent,
        ipAddress: requestMeta.ipAddress,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        revokedAt: null,
      },
    });

    return this.rotateSessionTokens(user, session.id, requestMeta);
  }

  private async rotateSessionTokens(
    user: AuthUserSnapshot,
    sessionId: string,
    requestMeta: RequestMeta,
  ) {
    const now = new Date();
    const accessTokenExpiresAt = this.addMinutes(now, env.accessTokenTtlMinutes);
    const refreshTokenExpiresAt = this.addDays(now, env.refreshTokenTtlDays);

    const accessToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        sessionId,
        role: user.role,
        type: "access",
      } satisfies TokenPayload,
      {
        secret: env.jwtAccessSecret,
        expiresIn: `${env.accessTokenTtlMinutes}m`,
      },
    );

    const refreshToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        sessionId,
        role: user.role,
        type: "refresh",
      } satisfies TokenPayload,
      {
        secret: env.jwtRefreshSecret,
        expiresIn: `${env.refreshTokenTtlDays}d`,
      },
    );

    const refreshTokenHash = await hash(refreshToken, HASH_ROUNDS);

    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        refreshTokenHash,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        lastUsedAt: now,
        userAgent: requestMeta.userAgent,
        ipAddress: requestMeta.ipAddress,
      },
    });

    return {
      user: this.mapUser(user),
      session: {
        id: sessionId,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
      },
      tokens: {
        tokenType: "Bearer",
        accessToken,
        refreshToken,
        expiresInSeconds: env.accessTokenTtlMinutes * 60,
      },
    };
  }

  private mapUser(user: AuthUserSnapshot) {
    return {
      avatarUrl: user.profile?.avatarUrl ?? null,
      creatorApplication: this.mapCreatorApplication(user.creatorApplication),
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.profile?.displayName ?? "StoryArc User",
      onboarding: this.mapOnboarding(user.profile),
    };
  }

  private mapAccountProfile(user: AuthUserSnapshot) {
    return {
      allowMessages: user.profile?.allowMessages ?? false,
      avatarUrl: user.profile?.avatarUrl ?? null,
      bio: user.profile?.bio ?? "",
      contentFiltering: user.profile?.contentFiltering ?? true,
      discord: user.profile?.discord ?? "",
      displayLanguage: user.profile?.displayLanguage ?? "English (US)",
      displayName: user.profile?.displayName ?? "StoryArc Reader",
      email: user.email,
      location: user.profile?.location ?? "",
      privateLibrary: user.profile?.privateLibrary ?? true,
      showActivity: user.profile?.showActivity ?? true,
      tagline: user.profile?.tagline ?? "",
      twitter: user.profile?.twitter ?? "",
      username: this.getDerivedUsername(user.email),
      website: user.profile?.website ?? "",
    };
  }

  private mapOnboarding(profile: UserProfileSnapshot | null) {
    const avatarUrl = profile?.avatarUrl ?? null;
    const selectedGenres = profile?.selectedGenres ?? [];
    const readingStyle = profile?.readingStyle ?? null;
    const readingTheme = profile?.readingTheme ?? null;
    const isComplete = Boolean(profile?.onboardingCompletedAt);

    return {
      avatarUrl,
      isComplete,
      readingStyle,
      readingTheme,
      selectedGenres,
      step: this.getOnboardingStep({
        isComplete,
        selectedGenres,
      }),
    };
  }

  private mapCreatorApplication(
    creatorApplication: CreatorApplicationSnapshot | null | undefined,
  ) {
    if (!creatorApplication) {
      return null;
    }

    return {
      reviewNotes: creatorApplication.reviewNotes,
      reviewedAt: creatorApplication.reviewedAt,
      status: creatorApplication.status,
      submittedAt: creatorApplication.submittedAt,
    };
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private getDerivedUsername(email: string) {
    return this.normalizeEmail(email).split("@")[0] ?? "";
  }

  private addMinutes(value: Date, minutes: number) {
    return new Date(value.getTime() + minutes * 60 * 1000);
  }

  private addDays(value: Date, days: number) {
    return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private getOnboardingStep(input: {
    isComplete: boolean;
    selectedGenres: string[];
  }): OnboardingStep {
    if (input.isComplete) {
      return "complete";
    }

    if (input.selectedGenres.length > 0) {
      return "preferences";
    }

    return "genres";
  }

  private hashRegistrationCode(email: string, code: string) {
    return createHash("sha256")
      .update(`${email}:${code}:${env.registrationCodeSecret}`)
      .digest("hex");
  }

  private generateOtpCode() {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }

  private generateOpaqueToken() {
    return randomBytes(48).toString("hex");
  }

  private hashResetCode(userId: string, code: string) {
    return createHash("sha256")
      .update(`${userId}:${code}:${env.passwordResetCodeSecret}`)
      .digest("hex");
  }

  private getVerifiedResetKey(resetToken: string) {
    return `auth:password-reset:${resetToken}`;
  }

  private getPendingRegistrationKey(email: string) {
    return `auth:register:${email}`;
  }
}
