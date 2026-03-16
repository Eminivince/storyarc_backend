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
import { UserStatus } from "@prisma/client";
import {
  AppUserRole,
  CreatorApplicationSnapshot,
  ForgotPasswordInput,
  GoogleAuthCallbackInput,
  GoogleAuthStartInput,
  LoginInput,
  OnboardingStep,
  PendingRegistrationPayload,
  PendingGoogleAuthPayload,
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
import {
  buildSessionCacheKey,
  CachedSessionLookup,
  getSessionCacheTtlSeconds,
} from "./session-cache";

const HASH_ROUNDS = 12;
const GOOGLE_OAUTH_STATE_TTL_SECONDS = 10 * 60;
const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

type AuthUserSnapshot = {
  id: string;
  email: string;
  role: AppUserRole;
  status: UserStatus;
  profile: UserProfileSnapshot | null;
  creatorApplication?: CreatorApplicationSnapshot | null;
};

type GoogleUserInfo = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  sub?: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly resendEmailService: ResendEmailService,
  ) {}

  async startGoogleAuth(input: GoogleAuthStartInput) {
    if (!this.isGoogleAuthConfigured()) {
      return {
        url: this.buildGoogleCallbackErrorUrl("google_not_configured"),
      };
    }

    const state = this.generateOpaqueToken();

    await this.redis.setJson(
      this.getGoogleAuthStateKey(state),
      {
        nextPath: input.nextPath,
      } satisfies PendingGoogleAuthPayload,
      GOOGLE_OAUTH_STATE_TTL_SECONDS,
    );

    const params = new URLSearchParams({
      client_id: env.googleClientId!,
      prompt: "select_account",
      redirect_uri: env.googleRedirectUri!,
      response_type: "code",
      scope: "openid email profile",
      state,
    });

    return {
      url: `${GOOGLE_AUTHORIZATION_URL}?${params.toString()}`,
    };
  }

  async handleGoogleCallback(
    input: GoogleAuthCallbackInput,
    requestMeta: RequestMeta,
  ) {
    if (!this.isGoogleAuthConfigured()) {
      return {
        url: this.buildGoogleCallbackErrorUrl("google_not_configured"),
      };
    }

    if (input.error) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          input.error === "access_denied"
            ? "google_access_denied"
            : "google_auth_failed",
        ),
      };
    }

    if (!input.code || !input.state) {
      return {
        url: this.buildGoogleCallbackErrorUrl("google_auth_failed"),
      };
    }

    const redisKey = this.getGoogleAuthStateKey(input.state);
    const pendingGoogleAuth = await this.redis.getJson<PendingGoogleAuthPayload>(
      redisKey,
    );

    await this.redis.delete(redisKey);

    if (!pendingGoogleAuth) {
      return {
        url: this.buildGoogleCallbackErrorUrl("google_state_invalid"),
      };
    }

    try {
      const googleTokens = await this.exchangeGoogleCodeForTokens(input.code);
      const googleProfile = await this.fetchGoogleUserInfo(googleTokens.accessToken);
      const authResponse = await this.completeGoogleAuth(
        googleProfile,
        requestMeta,
      );

      return {
        url: this.buildGoogleCallbackSuccessUrl({
          nextPath: pendingGoogleAuth.nextPath,
          tokens: authResponse.tokens,
        }),
      };
    } catch (error) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          this.getGoogleCallbackErrorCode(error),
        ),
      };
    }
  }

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
        status: user.status,
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
        status: user.status,
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
    await this.clearSessionCache(sessionId);

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
        status: session.user.status,
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
      displayName: user.profile?.displayName ?? "TaleStead Reader",
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
    const sessions = await this.prisma.session.findMany({
      where: {
        userId: verifiedReset.userId,
      },
      select: {
        id: true,
      },
    });

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
    await this.clearSessionCacheBatch(sessions.map((session) => session.id));

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
        status: user.status,
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
        status: updatedUser.status,
      }),
      user: this.mapUser({
        creatorApplication: updatedUser.creatorApplication,
        email: updatedUser.email,
        id: updatedUser.id,
        profile: updatedUser.profile,
        role: updatedUser.role,
        status: updatedUser.status,
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
    await this.clearSessionCache(sessionId);

    return {
      message: "Session revoked.",
    };
  }

  private async exchangeGoogleCodeForTokens(code: string) {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      body: new URLSearchParams({
        client_id: env.googleClientId!,
        client_secret: env.googleClientSecret!,
        code,
        grant_type: "authorization_code",
        redirect_uri: env.googleRedirectUri!,
      }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          access_token?: string;
        }
      | null;

    if (!response.ok || typeof payload?.access_token !== "string") {
      throw new BadRequestException("Google token exchange failed.");
    }

    return {
      accessToken: payload.access_token,
    };
  }

  private async fetchGoogleUserInfo(accessToken: string) {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      method: "GET",
    });
    const payload = (await response.json().catch(() => null)) as GoogleUserInfo | null;

    if (!response.ok || !payload) {
      throw new BadRequestException("Google profile lookup failed.");
    }

    return payload;
  }

  private async completeGoogleAuth(
    googleProfile: GoogleUserInfo,
    requestMeta: RequestMeta,
  ) {
    const providerUserId = googleProfile.sub?.trim() ?? "";
    const email = googleProfile.email
      ? this.normalizeEmail(googleProfile.email)
      : null;

    if (!providerUserId || !email || googleProfile.email_verified !== true) {
      throw new UnauthorizedException(
        "Google account did not include a verified email address.",
      );
    }

    const [existingIdentity, existingUserByEmail] = await Promise.all([
      this.prisma.authIdentity.findUnique({
        where: {
          provider_providerUserId: {
            provider: "GOOGLE",
            providerUserId,
          },
        },
        select: {
          id: true,
          userId: true,
        },
      }),
      this.prisma.user.findUnique({
        where: { email },
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
      }),
    ]);
    const existingUserByIdentity = existingIdentity
      ? await this.prisma.user.findUnique({
          where: { id: existingIdentity.userId },
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
        })
      : null;

    if (existingIdentity && !existingUserByIdentity) {
      throw new ConflictException(
        "This Google account is already linked to a different TaleStead user.",
      );
    }

    if (
      existingUserByIdentity &&
      existingUserByEmail &&
      existingUserByIdentity.id !== existingUserByEmail.id
    ) {
      throw new ConflictException(
        "This Google account is already linked to a different TaleStead user.",
      );
    }

    const existingUser = existingUserByIdentity ?? existingUserByEmail;

    if (existingUser && existingUser.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is currently unavailable.");
    }

    const displayName = this.getGoogleDisplayName(googleProfile, email);
    const now = new Date();

    if (!existingUser) {
      const createdUser = await this.prisma.user.create({
        data: {
          email,
          emailVerifiedAt: now,
          role: "READER",
          authIdentities: {
            create: {
              provider: "GOOGLE",
              providerEmail: email,
              providerUserId,
            },
          },
          profile: {
            create: {
              avatarUrl: googleProfile.picture ?? null,
              displayName,
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

      await this.redis.delete(this.getPendingRegistrationKey(email));

      return this.createSessionResponse(
        {
          id: createdUser.id,
          creatorApplication: createdUser.creatorApplication,
          email: createdUser.email,
          role: createdUser.role,
          status: createdUser.status,
          profile: createdUser.profile,
        },
        requestMeta,
      );
    }

    const profileUpdate = {
      ...(!existingUser.profile?.avatarUrl && googleProfile.picture
        ? { avatarUrl: googleProfile.picture }
        : {}),
      ...(!existingUser.profile?.displayName ? { displayName } : {}),
    };
    const shouldSyncProfile =
      !existingUser.profile || Object.keys(profileUpdate).length > 0;
    const shouldVerifyEmail = !existingUser.emailVerifiedAt;
    const shouldLinkIdentity = !existingIdentity;

    const syncedUser =
      shouldSyncProfile || shouldVerifyEmail || shouldLinkIdentity
        ? await this.prisma.user.update({
            where: { id: existingUser.id },
            data: {
              ...(shouldVerifyEmail ? { emailVerifiedAt: now } : {}),
              ...(shouldLinkIdentity
                ? {
                    authIdentities: {
                      create: {
                        provider: "GOOGLE",
                        providerEmail: email,
                        providerUserId,
                      },
                    },
                  }
                : {}),
              ...(shouldSyncProfile
                ? {
                    profile: {
                      upsert: {
                        create: {
                          avatarUrl: googleProfile.picture ?? null,
                          displayName,
                        },
                        update: profileUpdate,
                      },
                    },
                  }
                : {}),
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
          })
        : existingUser;

    await this.redis.delete(this.getPendingRegistrationKey(email));

    return this.createSessionResponse(
      {
        id: syncedUser.id,
        creatorApplication: syncedUser.creatorApplication,
        email: syncedUser.email,
        role: syncedUser.role,
        status: syncedUser.status,
        profile: syncedUser.profile,
      },
      requestMeta,
    );
  }

  private getGoogleCallbackErrorCode(error: unknown) {
    if (error instanceof ConflictException) {
      return "google_account_conflict";
    }

    if (error instanceof UnauthorizedException) {
      if (error.message.includes("verified email")) {
        return "google_email_unverified";
      }

      if (error.message.includes("unavailable")) {
        return "google_account_unavailable";
      }
    }

    if (error instanceof BadRequestException) {
      if (error.message.includes("token exchange")) {
        return "google_token_exchange_failed";
      }

      if (error.message.includes("profile lookup")) {
        return "google_profile_fetch_failed";
      }
    }

    return "google_auth_failed";
  }

  private isGoogleAuthConfigured() {
    return Boolean(
      env.googleClientId &&
        env.googleClientSecret &&
        env.googleRedirectUri,
    );
  }

  private getGoogleDisplayName(googleProfile: GoogleUserInfo, email: string) {
    const displayName = googleProfile.name?.trim();

    if (displayName) {
      return displayName;
    }

    return this.getDerivedUsername(email);
  }

  private getGoogleAuthStateKey(state: string) {
    return `auth:google:state:${state}`;
  }

  private getGoogleFrontendCallbackBaseUrl() {
    const frontendBase = env.frontendAppUrl?.replace(/\/+$/, "") ?? "";

    return `${frontendBase}/auth/google/callback`;
  }

  private buildGoogleCallbackErrorUrl(errorCode: string) {
    const params = new URLSearchParams({
      error: errorCode,
    });

    return `${this.getGoogleFrontendCallbackBaseUrl()}?${params.toString()}`;
  }

  private buildGoogleCallbackSuccessUrl(input: {
    nextPath: string | null;
    tokens: {
      accessToken: string;
      expiresInSeconds: number;
      refreshToken: string;
      tokenType: string;
    };
  }) {
    const hash = new URLSearchParams({
      accessToken: input.tokens.accessToken,
      refreshToken: input.tokens.refreshToken,
    });

    if (input.nextPath) {
      hash.set("next", input.nextPath);
    }

    return `${this.getGoogleFrontendCallbackBaseUrl()}#${hash.toString()}`;
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
    await this.cacheSessionLookup({
      accessTokenExpiresAt,
      revokedAt: null,
      sessionId,
      userId: user.id,
      userStatus: user.status,
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
      displayName: user.profile?.displayName ?? "TaleStead User",
      onboarding: this.mapOnboarding(user.profile),
    };
  }

  private async cacheSessionLookup(input: {
    accessTokenExpiresAt: Date;
    revokedAt: Date | null;
    sessionId: string;
    userId: string;
    userStatus: UserStatus;
  }) {
    const ttlSeconds = getSessionCacheTtlSeconds(input.accessTokenExpiresAt);

    if (!ttlSeconds) {
      return;
    }

    await this.redis.setJson(
      buildSessionCacheKey(input.sessionId),
      {
        accessTokenExpiresAt: input.accessTokenExpiresAt.toISOString(),
        revokedAt: input.revokedAt ? input.revokedAt.toISOString() : null,
        userId: input.userId,
        userStatus: input.userStatus,
      } satisfies CachedSessionLookup,
      ttlSeconds,
    );
  }

  private async clearSessionCache(sessionId: string) {
    await this.redis.delete(buildSessionCacheKey(sessionId));
  }

  private async clearSessionCacheBatch(sessionIds: string[]) {
    await Promise.all(
      sessionIds.map((sessionId) =>
        this.redis.delete(buildSessionCacheKey(sessionId)),
      ),
    );
  }

  private mapAccountProfile(user: AuthUserSnapshot) {
    return {
      allowMessages: user.profile?.allowMessages ?? false,
      avatarUrl: user.profile?.avatarUrl ?? null,
      bio: user.profile?.bio ?? "",
      contentFiltering: user.profile?.contentFiltering ?? true,
      discord: user.profile?.discord ?? "",
      displayLanguage: user.profile?.displayLanguage ?? "English (US)",
      displayName: user.profile?.displayName ?? "TaleStead Reader",
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
