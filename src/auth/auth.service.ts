import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { compare, hash } from "bcryptjs";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import * as jose from "jose";
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
  GuestUpgradeInput,
  PendingRegistrationPayload,
  PendingFacebookAuthPayload,
  PendingGoogleAuthPayload,
  PendingTwitterAuthPayload,
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
import { AuthThrottleService } from "./auth-throttle.service";
import {
  makeGuestDisplayNameBase,
  makeGuestDisplayNameWithSuffix,
} from "./guest-display-names";
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
const FACEBOOK_OAUTH_STATE_TTL_SECONDS = 10 * 60;
const FACEBOOK_GRAPH_VERSION = "v21.0";
const FACEBOOK_AUTHORIZATION_URL = `https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth`;
const FACEBOOK_TOKEN_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`;
const FACEBOOK_ME_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me`;
const TWITTER_OAUTH_STATE_TTL_SECONDS = 10 * 60;
const TWITTER_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TWITTER_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const TWITTER_USERINFO_URL =
  "https://api.twitter.com/2/users/me?user.fields=profile_image_url,username,name";
const APPLE_ISSUER = "https://appleid.apple.com";
const REFRESH_TOKEN_HASH_PREFIX = "sha256:";

const appleJwks = jose.createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

type AuthUserSnapshot = {
  id: string;
  birthYear?: number | null;
  email: string | null;
  isGuest: boolean;
  role: AppUserRole;
  status: UserStatus;
  profile: UserProfileSnapshot | null;
  creatorApplication?: CreatorApplicationSnapshot | null;
  totpCredential?: { verified: boolean } | null;
};

type GoogleUserInfo = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  sub?: string;
};

type TwitterUserInfo = {
  data?: {
    id?: string;
    name?: string;
    username?: string;
    profile_image_url?: string;
  };
};

type FacebookUserInfo = {
  id?: string;
  name?: string;
  email?: string;
  picture?: {
    data?: {
      url?: string;
    };
  };
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly resendEmailService: ResendEmailService,
    private readonly authThrottleService: AuthThrottleService,
  ) {}

  async startGoogleAuth(input: GoogleAuthStartInput) {
    const callbackBaseUrl = this.resolveGoogleOauthCallbackBaseUrl(input);

    if (!this.isGoogleAuthConfigured()) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          callbackBaseUrl,
          "google_not_configured",
        ),
      };
    }

    const state = this.generateOpaqueToken();

    await this.redis.setJson(
      this.getGoogleAuthStateKey(state),
      {
        nextPath: input.nextPath,
        callbackBaseUrl,
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
    const fallbackBase = this.getGoogleFrontendCallbackBaseUrl();

    if (!this.isGoogleAuthConfigured()) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          fallbackBase,
          "google_not_configured",
        ),
      };
    }

    const redisKey = input.state
      ? this.getGoogleAuthStateKey(input.state)
      : null;
    const pendingPeek = redisKey
      ? await this.redis.getJson<PendingGoogleAuthPayload>(redisKey)
      : null;

    if (input.error) {
      if (redisKey && pendingPeek) {
        await this.redis.delete(redisKey);
      }

      const base = pendingPeek?.callbackBaseUrl ?? fallbackBase;

      return {
        url: this.buildGoogleCallbackErrorUrl(
          base,
          input.error === "access_denied"
            ? "google_access_denied"
            : "google_auth_failed",
        ),
      };
    }

    if (!input.code || !input.state) {
      if (redisKey && pendingPeek) {
        await this.redis.delete(redisKey);
      }

      const base = pendingPeek?.callbackBaseUrl ?? fallbackBase;

      return {
        url: this.buildGoogleCallbackErrorUrl(base, "google_auth_failed"),
      };
    }

    const redisKeyResolved = this.getGoogleAuthStateKey(input.state);
    const pendingGoogleAuth =
      await this.redis.getJson<PendingGoogleAuthPayload>(redisKeyResolved);

    await this.redis.delete(redisKeyResolved);

    if (!pendingGoogleAuth) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          fallbackBase,
          "google_state_invalid",
        ),
      };
    }

    const callbackBaseUrl = pendingGoogleAuth.callbackBaseUrl;

    try {
      const googleTokens = await this.exchangeGoogleCodeForTokens(input.code);
      const googleProfile = await this.fetchGoogleUserInfo(
        googleTokens.accessToken,
      );
      const authResponse = await this.completeGoogleAuth(
        googleProfile,
        requestMeta,
      );

      return {
        url: this.buildGoogleCallbackSuccessUrl(callbackBaseUrl, {
          nextPath: pendingGoogleAuth.nextPath,
          tokens: authResponse.tokens,
        }),
      };
    } catch (error) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          callbackBaseUrl,
          this.getGoogleCallbackErrorCode(error),
        ),
      };
    }
  }

  async startFacebookAuth(input: GoogleAuthStartInput) {
    const callbackBaseUrl = this.resolveFacebookOauthCallbackBaseUrl(input);

    if (!this.isFacebookAuthConfigured()) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          callbackBaseUrl,
          "facebook_not_configured",
        ),
      };
    }

    const state = this.generateOpaqueToken();

    await this.redis.setJson(
      this.getFacebookAuthStateKey(state),
      {
        nextPath: input.nextPath,
        callbackBaseUrl,
      } satisfies PendingFacebookAuthPayload,
      FACEBOOK_OAUTH_STATE_TTL_SECONDS,
    );

    const params = new URLSearchParams({
      client_id: env.facebookAppId!,
      redirect_uri: env.facebookRedirectUri!,
      response_type: "code",
      scope: "email,public_profile",
      state,
    });

    return {
      url: `${FACEBOOK_AUTHORIZATION_URL}?${params.toString()}`,
    };
  }

  async handleFacebookCallback(
    input: GoogleAuthCallbackInput,
    requestMeta: RequestMeta,
  ) {
    const fallbackBase = this.getFacebookFrontendCallbackBaseUrl();

    if (!this.isFacebookAuthConfigured()) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          fallbackBase,
          "facebook_not_configured",
        ),
      };
    }

    const redisKey = input.state
      ? this.getFacebookAuthStateKey(input.state)
      : null;
    const pendingPeek = redisKey
      ? await this.redis.getJson<PendingFacebookAuthPayload>(redisKey)
      : null;

    if (input.error) {
      if (redisKey && pendingPeek) {
        await this.redis.delete(redisKey);
      }

      const base = pendingPeek?.callbackBaseUrl ?? fallbackBase;

      return {
        url: this.buildGoogleCallbackErrorUrl(
          base,
          input.error === "access_denied"
            ? "facebook_access_denied"
            : "facebook_auth_failed",
        ),
      };
    }

    if (!input.code || !input.state) {
      if (redisKey && pendingPeek) {
        await this.redis.delete(redisKey);
      }

      const base = pendingPeek?.callbackBaseUrl ?? fallbackBase;

      return {
        url: this.buildGoogleCallbackErrorUrl(base, "facebook_auth_failed"),
      };
    }

    const redisKeyResolved = this.getFacebookAuthStateKey(input.state);
    const pendingFacebook =
      await this.redis.getJson<PendingFacebookAuthPayload>(redisKeyResolved);

    await this.redis.delete(redisKeyResolved);

    if (!pendingFacebook) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          fallbackBase,
          "facebook_state_invalid",
        ),
      };
    }

    const callbackBaseUrl = pendingFacebook.callbackBaseUrl;

    try {
      const accessToken = await this.exchangeFacebookCodeForTokens(input.code);
      const facebookProfile = await this.fetchFacebookUserInfo(accessToken);
      const authResponse = await this.completeFacebookAuth(
        facebookProfile,
        requestMeta,
      );

      return {
        url: this.buildGoogleCallbackSuccessUrl(callbackBaseUrl, {
          nextPath: pendingFacebook.nextPath,
          tokens: authResponse.tokens,
        }),
      };
    } catch (error) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          callbackBaseUrl,
          this.getFacebookCallbackErrorCode(error),
        ),
      };
    }
  }

  async signInWithAppleNative(
    identityToken: string,
    requestMeta: RequestMeta,
  ) {
    if (!this.isAppleAuthConfigured()) {
      throw new BadRequestException(
        "Apple sign-in is not configured on the server.",
      );
    }

    const claims = await this.verifyAppleIdentityToken(identityToken);
    const providerUserId =
      typeof claims.sub === "string" ? claims.sub.trim() : "";

    if (!providerUserId) {
      throw new UnauthorizedException("Invalid Apple sign-in token.");
    }

    const emailRaw =
      typeof claims.email === "string" ? claims.email.trim() : null;
    const email = emailRaw ? this.normalizeEmail(emailRaw) : null;
    const emailVerified =
      claims.email_verified === true || claims.email_verified === "true";

    return this.completeAppleAuth(
      {
        email,
        emailVerified,
        providerUserId,
      },
      requestMeta,
    );
  }

  async startTwitterAuth(input: GoogleAuthStartInput) {
    const callbackBaseUrl = this.resolveTwitterOauthCallbackBaseUrl(input);

    if (!this.isTwitterAuthConfigured()) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          callbackBaseUrl,
          "twitter_not_configured",
        ),
      };
    }

    const state = this.generateOpaqueToken();
    const pkce = this.generatePkcePair();

    await this.redis.setJson(
      this.getTwitterAuthStateKey(state),
      {
        callbackBaseUrl,
        codeVerifier: pkce.verifier,
        nextPath: input.nextPath,
      } satisfies PendingTwitterAuthPayload,
      TWITTER_OAUTH_STATE_TTL_SECONDS,
    );

    const params = new URLSearchParams({
      client_id: env.twitterClientId!,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      redirect_uri: env.twitterRedirectUri!,
      response_type: "code",
      scope: "users.read tweet.read offline.access",
      state,
    });

    return {
      url: `${TWITTER_AUTHORIZE_URL}?${params.toString()}`,
    };
  }

  async handleTwitterCallback(
    input: GoogleAuthCallbackInput,
    requestMeta: RequestMeta,
  ) {
    const fallbackBase = this.getGoogleFrontendCallbackBaseUrl();

    if (!this.isTwitterAuthConfigured()) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          fallbackBase,
          "twitter_not_configured",
        ),
      };
    }

    const redisKey = input.state
      ? this.getTwitterAuthStateKey(input.state)
      : null;
    const pendingPeek = redisKey
      ? await this.redis.getJson<PendingTwitterAuthPayload>(redisKey)
      : null;

    if (input.error) {
      if (redisKey && pendingPeek) {
        await this.redis.delete(redisKey);
      }

      const base = pendingPeek?.callbackBaseUrl ?? fallbackBase;

      return {
        url: this.buildGoogleCallbackErrorUrl(
          base,
          input.error === "access_denied"
            ? "twitter_access_denied"
            : "twitter_auth_failed",
        ),
      };
    }

    if (!input.code || !input.state) {
      if (redisKey && pendingPeek) {
        await this.redis.delete(redisKey);
      }

      const base = pendingPeek?.callbackBaseUrl ?? fallbackBase;

      return {
        url: this.buildGoogleCallbackErrorUrl(base, "twitter_auth_failed"),
      };
    }

    const redisKeyResolved = this.getTwitterAuthStateKey(input.state);
    const pendingTwitter =
      await this.redis.getJson<PendingTwitterAuthPayload>(redisKeyResolved);

    await this.redis.delete(redisKeyResolved);

    if (!pendingTwitter) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          fallbackBase,
          "twitter_state_invalid",
        ),
      };
    }

    const callbackBaseUrl = pendingTwitter.callbackBaseUrl;

    try {
      const accessToken = await this.exchangeTwitterCodeForTokens(
        input.code,
        pendingTwitter.codeVerifier,
      );
      const twitterProfile = await this.fetchTwitterUserInfo(accessToken);
      const authResponse = await this.completeTwitterAuth(
        twitterProfile,
        requestMeta,
      );

      return {
        url: this.buildGoogleCallbackSuccessUrl(callbackBaseUrl, {
          nextPath: pendingTwitter.nextPath,
          tokens: authResponse.tokens,
        }),
      };
    } catch (error) {
      return {
        url: this.buildGoogleCallbackErrorUrl(
          callbackBaseUrl,
          this.getTwitterCallbackErrorCode(error),
        ),
      };
    }
  }

  async register(input: RegisterInput, requestMeta: RequestMeta) {
    const email = this.normalizeEmail(input.email);

    await this.authThrottleService.assertSignupAllowed(email, requestMeta);

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException("An account with this email already exists.");
    }

    const passwordHash = await hash(input.password, HASH_ROUNDS);
    const code = this.generateOtpCode();
    const expiresAt = this.addMinutes(
      new Date(),
      env.registrationCodeTtlMinutes,
    );

    await this.redis.setJson(
      this.getPendingRegistrationKey(email),
      {
        codeHash: this.hashRegistrationCode(email, code),
        displayName: input.displayName,
        email,
        expiresAtIso: expiresAt.toISOString(),
        passwordHash,
        referralCode: input.referralCode,
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
      message:
        "Verification code sent. Check your email to finish registration.",
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

    const pendingRegistration =
      await this.redis.getJson<PendingRegistrationPayload>(
        this.getPendingRegistrationKey(email),
      );

    if (!pendingRegistration) {
      throw new BadRequestException(
        "Registration has expired. Start account creation again.",
      );
    }

    const code = this.generateOtpCode();
    const expiresAt = this.addMinutes(
      new Date(),
      env.registrationCodeTtlMinutes,
    );

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

  async verifyRegisterCode(
    input: VerifyResetCodeInput,
    requestMeta: RequestMeta,
  ) {
    const email = this.normalizeEmail(input.email);
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException("An account with this email already exists.");
    }

    const pendingRegistration =
      await this.redis.getJson<PendingRegistrationPayload>(
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
      pendingRegistration.codeHash !==
      this.hashRegistrationCode(email, input.code)
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
            termsAcceptedVersion: AuthService.CURRENT_TERMS_VERSION,
            termsAcceptedAt: new Date(),
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

    if (pendingRegistration.referralCode) {
      await this.processReferralCode(user.id, pendingRegistration.referralCode);
    }

    return this.createSessionResponse(
      {
        id: user.id,
        email: user.email,
        isGuest: false,
        role: user.role,
        status: user.status,
        creatorApplication: null,
        profile: user.profile,
      },
      requestMeta,
    );
  }

  private async processReferralCode(userId: string, referralCode: string) {
    try {
      const code = await this.prisma.referralCode.findUnique({
        where: { code: referralCode.trim().toUpperCase() },
      });

      if (!code || code.userId === userId) {
        return;
      }

      const existingEvent = await this.prisma.referralEvent.findFirst({
        where: { referralCodeId: code.id, inviteeUserId: userId },
      });

      if (existingEvent) {
        return;
      }

      const sharedEvent = await this.prisma.referralEvent.findFirst({
        where: {
          referralCodeId: code.id,
          status: "SHARED",
          inviteeUserId: null,
        },
        orderBy: { createdAt: "desc" },
      });

      if (sharedEvent) {
        await this.prisma.referralEvent.update({
          where: { id: sharedEvent.id },
          data: {
            inviteeUserId: userId,
            status: "SIGNED_UP",
            completedAt: new Date(),
          },
        });
      } else {
        await this.prisma.referralEvent.create({
          data: {
            channel: "referral_code",
            commissionRate: 0.1,
            inviteeUserId: userId,
            inviterUserId: code.userId,
            referralCodeId: code.id,
            status: "SIGNED_UP",
            completedAt: new Date(),
          },
        });
      }
    } catch {
      // Non-critical: don't block registration if referral processing fails
    }
  }

  /**
   * Reserves a display name not already used on any profile (avoids duplicate auto-names).
   * Under concurrent signups, relies on DB check + retries; final fallback uses long hex.
   */
  private async allocateUniqueGuestDisplayName(): Promise<string> {
    const maxAttempts = 48;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate =
        attempt < 28
          ? makeGuestDisplayNameBase()
          : makeGuestDisplayNameWithSuffix(randomBytes(2).toString("hex"));

      const nameTaken = await this.prisma.profile.findFirst({
        where: { displayName: candidate },
        select: { id: true },
      });

      if (!nameTaken) {
        return candidate;
      }
    }

    return makeGuestDisplayNameWithSuffix(randomBytes(4).toString("hex"));
  }

  async createGuestAccount(requestMeta: RequestMeta) {
    const displayName = await this.allocateUniqueGuestDisplayName();

    const user = await this.prisma.user.create({
      data: {
        email: null,
        isGuest: true,
        role: "READER",
        profile: {
          create: {
            displayName,
          },
        },
      },
      include: {
        profile: true,
      },
    });

    this.logger.log({
      event: "GUEST_ACCOUNT_CREATED",
      userId: user.id,
      displayName,
    });

    return this.createSessionResponse(
      {
        id: user.id,
        email: null,
        isGuest: true,
        role: user.role,
        status: user.status,
        creatorApplication: null,
        profile: user.profile,
      },
      requestMeta,
    );
  }

  async upgradeGuestAccount(
    userId: string,
    input: GuestUpgradeInput,
    requestMeta: RequestMeta,
  ) {
    const email = this.normalizeEmail(input.email);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });

    if (!user || !user.isGuest) {
      throw new BadRequestException("Account is not a guest account.");
    }

    const existingEmail = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingEmail) {
      throw new ConflictException("An account with this email already exists.");
    }

    const passwordHash = await hash(input.password, HASH_ROUNDS);

    const profileUpdate = input.displayName
      ? { displayName: input.displayName.trim() }
      : {};

    const [updatedUser] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          email,
          isGuest: false,
          emailVerifiedAt: new Date(),
        },
        include: {
          profile: true,
          creatorApplication: {
            select: {
              reviewNotes: true,
              revenueShareContractApproved: true,
              reviewedAt: true,
              status: true,
              submittedAt: true,
            },
          },
          totpCredential: { select: { verified: true } },
        },
      }),
      this.prisma.credential.create({
        data: { userId, passwordHash },
      }),
      ...(Object.keys(profileUpdate).length > 0
        ? [
            this.prisma.profile.update({
              where: { userId },
              data: profileUpdate,
            }),
          ]
        : []),
    ]);

    this.logger.log({ event: "GUEST_UPGRADED", userId, email });

    // Invalidate old session cache entries
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    for (const s of sessions) {
      await this.redis.delete(buildSessionCacheKey(s.id));
    }

    return this.createSessionResponse(
      {
        id: updatedUser.id,
        email: updatedUser.email,
        isGuest: false,
        role: updatedUser.role,
        status: updatedUser.status,
        creatorApplication: updatedUser.creatorApplication,
        profile: updatedUser.profile,
        totpCredential: updatedUser.totpCredential,
      },
      requestMeta,
    );
  }

  async login(input: LoginInput, requestMeta: RequestMeta) {
    const email = this.normalizeEmail(input.email);

    await this.authThrottleService.assertLoginAllowed(email, requestMeta);

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        credential: true,
        creatorApplication: {
          select: {
            reviewNotes: true,
            revenueShareContractApproved: true,
            reviewedAt: true,
            status: true,
            submittedAt: true,
          },
        },
        profile: true,
        totpCredential: {
          select: { verified: true },
        },
      },
    });

    if (!user?.credential) {
      await this.authThrottleService.recordLoginFailure(email, requestMeta);
      throw new UnauthorizedException("Invalid email or password.");
    }

    if (user.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is currently unavailable.");
    }

    const passwordMatches = await compare(
      input.password,
      user.credential.passwordHash,
    );

    if (!passwordMatches) {
      await this.authThrottleService.recordLoginFailure(email, requestMeta);
      throw new UnauthorizedException("Invalid email or password.");
    }

    await this.authThrottleService.clearLoginFailures(email, requestMeta);

    // Check if 2FA is enabled — if so, return a challenge instead of a session
    if (user.totpCredential?.verified) {
      // Generate a short-lived challenge token. The caller must present it
      // along with a valid TOTP code to complete login.
      const challengeToken = await this.jwtService.signAsync(
        { sub: user.id, type: "2fa-challenge" },
        { secret: env.jwtAccessSecret, expiresIn: "5m" },
      );

      return { requires2FA: true, challengeToken };
    }

    return this.createSessionResponse(
      {
        birthYear: user.birthYear,
        id: user.id,
        email: user.email,
        isGuest: user.isGuest,
        role: user.role,
        status: user.status,
        creatorApplication: user.creatorApplication,
        profile: user.profile,
        totpCredential: user.totpCredential,
      },
      requestMeta,
    );
  }

  async complete2FALogin(userId: string, requestMeta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        creatorApplication: {
          select: {
            reviewNotes: true,
            revenueShareContractApproved: true,
            reviewedAt: true,
            status: true,
            submittedAt: true,
          },
        },
        profile: true,
        totpCredential: {
          select: { verified: true },
        },
      },
    });

    return this.createSessionResponse(
      {
        birthYear: user.birthYear,
        id: user.id,
        email: user.email,
        isGuest: user.isGuest,
        role: user.role,
        status: user.status,
        creatorApplication: user.creatorApplication,
        profile: user.profile,
        totpCredential: user.totpCredential,
      },
      requestMeta,
    );
  }

  async deleteAccount(userId: string, password: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { credential: true },
    });

    if (!user.credential) {
      throw new BadRequestException(
        "No password credential found. Cannot verify identity.",
      );
    }

    const passwordMatches = await compare(
      password,
      user.credential.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException("Invalid password.");
    }

    const anonymizedEmail = `deleted_${user.id}@removed.talestead.com`;

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          email: anonymizedEmail,
          status: "DELETED",
        },
      });

      await tx.profile.updateMany({
        where: { userId },
        data: {
          displayName: "Deleted User",
          bio: null,
          avatarUrl: null,
          location: null,
          tagline: null,
          website: null,
          twitter: null,
          discord: null,
        },
      });

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    // Clear session caches
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      select: { id: true },
    });

    for (const session of sessions) {
      await this.clearSessionCache(session.id);
    }

    return { message: "Your account has been deleted." };
  }

  async requestDataExport(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        profile: true,
        readingProgress: {
          take: 500,
          orderBy: { updatedAt: "desc" },
          select: {
            storyId: true,
            publishedChapterId: true,
            progressPercent: true,
            updatedAt: true,
          },
        },
        reviews: {
          take: 200,
          orderBy: { createdAt: "desc" },
          select: {
            storyId: true,
            rating: true,
            body: true,
            createdAt: true,
          },
        },
        purchases: {
          take: 500,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            kind: true,
            amountCents: true,
            currency: true,
            status: true,
            createdAt: true,
          },
        },
        bookmarks: {
          take: 200,
          orderBy: { createdAt: "desc" },
          select: {
            storyId: true,
            publishedChapterId: true,
            createdAt: true,
          },
        },
        readingLists: {
          take: 50,
          include: {
            items: {
              take: 100,
              select: { storyId: true, createdAt: true },
            },
          },
        },
        dailyCheckIns: {
          take: 365,
          orderBy: { checkedInAt: "desc" },
          select: { checkedInAt: true, rewardPoints: true },
        },
        follows: {
          take: 200,
          select: { targetType: true, subjectKey: true, createdAt: true },
        },
        comments: {
          take: 500,
          orderBy: { createdAt: "desc" },
          select: {
            publishedChapterId: true,
            body: true,
            createdAt: true,
          },
        },
      },
    });

    const exportData = {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        email: user.email,
        role: user.role,
        birthYear: user.birthYear,
        createdAt: user.createdAt,
      },
      profile: user.profile
        ? {
            displayName: user.profile.displayName,
            bio: user.profile.bio,
            location: user.profile.location,
            tagline: user.profile.tagline,
            website: user.profile.website,
            twitter: user.profile.twitter,
            discord: user.profile.discord,
          }
        : null,
      readingProgress: user.readingProgress,
      reviews: user.reviews,
      purchases: user.purchases,
      bookmarks: user.bookmarks,
      readingLists: user.readingLists.map(
        (list: {
          name: string;
          description: string | null;
          items: unknown[];
        }) => ({
          name: list.name,
          description: list.description,
          items: list.items,
        }),
      ),
      dailyCheckIns: user.dailyCheckIns,
      follows: user.follows,
      comments: user.comments,
    };

    const dataJson = JSON.stringify(exportData, null, 2);

    await this.resendEmailService.sendDataExportReady({
      email: user.email!,
      userName: user.profile?.displayName ?? "TaleStead User",
      dataJson,
    });

    return { message: "Your data export has been sent to your email address." };
  }

  static readonly CURRENT_TERMS_VERSION = "2025-03-31";

  async getTermsStatus(userId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { termsAcceptedVersion: true, termsAcceptedAt: true },
    });

    return {
      currentVersion: AuthService.CURRENT_TERMS_VERSION,
      acceptedVersion: profile?.termsAcceptedVersion ?? null,
      acceptedAt: profile?.termsAcceptedAt?.toISOString() ?? null,
      needsAcceptance:
        profile?.termsAcceptedVersion !== AuthService.CURRENT_TERMS_VERSION,
    };
  }

  async acceptTerms(userId: string, version: string) {
    await this.prisma.profile.update({
      where: { userId },
      data: {
        termsAcceptedVersion: version,
        termsAcceptedAt: new Date(),
      },
    });

    return { message: "Terms accepted.", version };
  }

  async changePassword(
    userId: string,
    sessionId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { credential: true },
    });

    if (!user.credential) {
      throw new BadRequestException(
        "No password credential found. Cannot change password.",
      );
    }

    const passwordMatches = await compare(
      currentPassword,
      user.credential.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException("Current password is incorrect.");
    }

    const newHash = await hash(newPassword, HASH_ROUNDS);

    await this.prisma.credential.update({
      where: { userId },
      data: { passwordHash: newHash },
    });

    // Revoke all sessions except current one
    await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        NOT: { id: sessionId },
      },
      data: { revokedAt: new Date() },
    });

    return { message: "Password changed successfully." };
  }

  async requestEmailChange(userId: string, password: string, newEmail: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { credential: true },
    });

    if (!user.credential) {
      throw new BadRequestException(
        "No password credential found. Cannot verify identity.",
      );
    }

    const passwordMatches = await compare(
      password,
      user.credential.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException("Invalid password.");
    }

    // Check if new email is already in use
    const existing = await this.prisma.user.findFirst({
      where: { email: newEmail.toLowerCase(), status: { not: "DELETED" } },
    });

    if (existing) {
      throw new ConflictException("This email address is already in use.");
    }

    const code = String(randomInt(100000, 999999));
    const codeHash = createHash("sha256").update(code).digest("hex");

    await this.redis.setJson(
      `email-change:${userId}`,
      {
        newEmail: newEmail.toLowerCase(),
        codeHash,
        expiresAtIso: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
      15 * 60,
    );

    await this.resendEmailService.sendEmailChangeVerification(newEmail, code);

    return { message: "Verification code sent to your new email address." };
  }

  async verifyEmailChange(userId: string, code: string) {
    const raw = await this.redis.getJson<{
      newEmail: string;
      codeHash: string;
      expiresAtIso: string;
    }>(`email-change:${userId}`);

    if (!raw) {
      throw new BadRequestException(
        "No pending email change found. Please start again.",
      );
    }

    const pending = raw;

    if (new Date(pending.expiresAtIso) < new Date()) {
      await this.redis.delete(`email-change:${userId}`);
      throw new BadRequestException(
        "Verification code has expired. Please start again.",
      );
    }

    const codeHash = createHash("sha256").update(code).digest("hex");

    const expected = Buffer.from(pending.codeHash, "hex");
    const received = Buffer.from(codeHash, "hex");

    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new BadRequestException("Invalid verification code.");
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { email: pending.newEmail },
    });

    await this.redis.delete(`email-change:${userId}`);

    const updatedUser = await this.getCurrentUser(userId);

    return {
      message: "Email address updated successfully.",
      user: updatedUser.user,
    };
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
      payload = await this.jwtService.verifyAsync<TokenPayload>(
        input.refreshToken,
        {
          secret: env.jwtRefreshSecret,
        },
      );
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
                revenueShareContractApproved: true,
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

    const refreshTokenMatches = await this.verifyRefreshToken(
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
        isGuest: session.user.isGuest,
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
        email: user.email!,
        codeHash: this.hashResetCode(user.id, code),
        expiresAt,
        verifiedAt: null,
        usedAt: null,
      },
    });

    await this.resendEmailService.sendPasswordResetCode({
      email: user.email!,
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
    const verifiedReset =
      await this.redis.getJson<VerifiedResetPayload>(redisKey);

    if (!verifiedReset) {
      throw new UnauthorizedException(
        "The password reset token is invalid or expired.",
      );
    }

    const resetTokenRecord = await this.prisma.passwordResetToken.findUnique({
      where: { id: verifiedReset.passwordResetTokenId },
    });

    if (!resetTokenRecord || resetTokenRecord.userId !== verifiedReset.userId) {
      throw new UnauthorizedException("The password reset token is invalid.");
    }

    if (resetTokenRecord.usedAt) {
      throw new BadRequestException(
        "This password reset request has already been used.",
      );
    }

    if (!resetTokenRecord.verifiedAt) {
      throw new BadRequestException(
        "Reset code verification is still required.",
      );
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
            revenueShareContractApproved: true,
            reviewedAt: true,
            status: true,
            submittedAt: true,
          },
        },
        profile: true,
        totpCredential: {
          select: { verified: true },
        },
      },
    });

    if (!user || user.status !== "ACTIVE") {
      throw new UnauthorizedException(
        "The current user account is unavailable.",
      );
    }

    return {
      user: this.mapUser({
        birthYear: user.birthYear,
        creatorApplication: user.creatorApplication,
        id: user.id,
        email: user.email,
        isGuest: user.isGuest,
        role: user.role,
        status: user.status,
        profile: user.profile,
        totpCredential: user.totpCredential,
      }),
    };
  }

  async getPublicProfile(userId: string, viewerUserId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, status: "ACTIVE" },
      include: {
        profile: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found.");
    }

    const isPrivateLibrary = user.profile?.privateLibrary ?? true;
    const isAuthor = user.role === "CREATOR";

    const [readingLists, badges, reviews, readingProgress, authorStories, followRecord] = await Promise.all([
      isPrivateLibrary
        ? Promise.resolve([])
        : this.prisma.readingList.findMany({
            where: { userId, visibility: "PUBLIC" },
            select: {
              id: true,
              name: true,
              description: true,
              _count: { select: { items: true } },
            },
            take: 10,
            orderBy: { createdAt: "desc" },
          }),
      this.prisma.userBadge.findMany({
        where: { userId },
        include: { badgeDefinition: true },
        take: 20,
        orderBy: { earnedAt: "desc" },
      }),
      this.prisma.review.findMany({
        where: { userId },
        include: {
          story: {
            select: { title: true, slug: true },
          },
        },
        take: 10,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.readingProgress.count({ where: { userId } }),
      isAuthor
        ? this.prisma.story.findMany({
            where: { authorId: userId, isLive: true, deletedAt: null },
            include: {
              assets: { select: { coverImageUrl: true } },
            },
            take: 12,
            orderBy: { totalReads: "desc" },
          })
        : Promise.resolve([]),
      viewerUserId
        ? this.prisma.follow.findFirst({
            where: { userId: viewerUserId, subjectKey: `author:${userId}` },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      profile: {
        userId: user.id,
        displayName: user.profile?.displayName ?? "TaleStead Reader",
        avatarUrl: user.profile?.avatarUrl ?? null,
        bio: user.profile?.bio ?? null,
        tagline: user.profile?.tagline ?? null,
        location: user.profile?.location ?? null,
        website: user.profile?.website ?? null,
        twitter: user.profile?.twitter ?? null,
        joinedAt: user.createdAt.toISOString(),
      },
      stats: {
        storiesRead: readingProgress,
        badges: badges.length,
        reviews: reviews.length,
      },
      badges: badges.map((ub) => ({
        id: ub.badgeDefinition.id,
        title: ub.badgeDefinition.title,
        description: ub.badgeDefinition.description,
        iconUrl: ub.badgeDefinition.iconUrl,
        earnedAt: ub.earnedAt.toISOString(),
      })),
      reviews: reviews.map((r) => ({
        id: r.id,
        storyTitle: r.story.title,
        storySlug: r.story.slug,
        rating: r.rating,
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      })),
      readingLists: readingLists.map((rl) => ({
        id: rl.id,
        name: rl.name,
        description: rl.description,
        storyCount: rl._count.items,
      })),
      isAuthor,
      isFollowing: Boolean(followRecord),
      authorStories: authorStories.map((s) => ({
        id: s.id,
        slug: s.slug,
        title: s.title,
        shortSynopsis: s.shortSynopsis,
        genreLabel: s.genreSlugs?.[0] ?? "Fiction",
        totalReads: s.totalReads,
        averageRating: s.averageRating,
        reviewCount: s.reviewCount,
        coverImageUrl: s.assets?.coverImageUrl ?? null,
      })),
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
            revenueShareContractApproved: true,
            reviewedAt: true,
            status: true,
            submittedAt: true,
          },
        },
        profile: true,
      },
    });

    if (!user || user.status !== "ACTIVE") {
      throw new UnauthorizedException(
        "The current user account is unavailable.",
      );
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
            revenueShareContractApproved: true,
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
        isGuest: updatedUser.isGuest,
        profile: updatedUser.profile,
        role: updatedUser.role,
        status: updatedUser.status,
      }),
      user: this.mapUser({
        creatorApplication: updatedUser.creatorApplication,
        email: updatedUser.email,
        id: updatedUser.id,
        isGuest: updatedUser.isGuest,
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
    const payload = (await response.json().catch(() => null)) as {
      access_token?: string;
    } | null;

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
    const payload = (await response
      .json()
      .catch(() => null)) as GoogleUserInfo | null;

    if (!response.ok || !payload) {
      throw new BadRequestException("Google profile lookup failed.");
    }

    return payload;
  }

  private async exchangeFacebookCodeForTokens(code: string) {
    const tokenUrl = new URL(FACEBOOK_TOKEN_URL);
    tokenUrl.searchParams.set("client_id", env.facebookAppId!);
    tokenUrl.searchParams.set("client_secret", env.facebookAppSecret!);
    tokenUrl.searchParams.set("redirect_uri", env.facebookRedirectUri!);
    tokenUrl.searchParams.set("code", code);

    const response = await fetch(tokenUrl.toString(), { method: "GET" });
    const payload = (await response.json().catch(() => null)) as {
      access_token?: string;
    } | null;

    if (!response.ok || typeof payload?.access_token !== "string") {
      throw new BadRequestException("Facebook token exchange failed.");
    }

    return payload.access_token;
  }

  private async fetchFacebookUserInfo(accessToken: string) {
    const meUrl = new URL(FACEBOOK_ME_URL);
    meUrl.searchParams.set(
      "fields",
      "id,name,email,picture.type(large){url,is_silhouette}",
    );
    meUrl.searchParams.set("access_token", accessToken);

    const response = await fetch(meUrl.toString(), { method: "GET" });
    const payload = (await response
      .json()
      .catch(() => null)) as FacebookUserInfo | null;

    if (!response.ok || !payload) {
      throw new BadRequestException("Facebook profile lookup failed.");
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
              revenueShareContractApproved: true,
              reviewedAt: true,
              status: true,
              submittedAt: true,
            },
          },
          profile: true,
          totpCredential: {
            select: { verified: true },
          },
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
                revenueShareContractApproved: true,
                reviewedAt: true,
                status: true,
                submittedAt: true,
              },
            },
            profile: true,
            totpCredential: {
              select: { verified: true },
            },
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
              revenueShareContractApproved: true,
              reviewedAt: true,
              status: true,
              submittedAt: true,
            },
          },
          profile: true,
          totpCredential: {
            select: { verified: true },
          },
        },
      });

      await this.redis.delete(this.getPendingRegistrationKey(email));

      return this.createSessionResponse(
        {
          id: createdUser.id,
          creatorApplication: createdUser.creatorApplication,
          email: createdUser.email,
          isGuest: createdUser.isGuest,
          role: createdUser.role,
          status: createdUser.status,
          profile: createdUser.profile,
          totpCredential: createdUser.totpCredential,
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
                  revenueShareContractApproved: true,
                  reviewedAt: true,
                  status: true,
                  submittedAt: true,
                },
              },
              profile: true,
              totpCredential: {
                select: { verified: true },
              },
            },
          })
        : existingUser;

    await this.redis.delete(this.getPendingRegistrationKey(email));

    return this.createSessionResponse(
      {
        id: syncedUser.id,
        creatorApplication: syncedUser.creatorApplication,
        email: syncedUser.email,
        isGuest: syncedUser.isGuest,
        role: syncedUser.role,
        status: syncedUser.status,
        profile: syncedUser.profile,
        totpCredential: syncedUser.totpCredential,
      },
      requestMeta,
    );
  }

  private async completeFacebookAuth(
    facebookProfile: FacebookUserInfo,
    requestMeta: RequestMeta,
  ) {
    const providerUserId = facebookProfile.id?.trim() ?? "";
    const emailRaw =
      typeof facebookProfile.email === "string"
        ? facebookProfile.email.trim()
        : "";
    const email = emailRaw ? this.normalizeEmail(emailRaw) : null;
    const pictureUrl = facebookProfile.picture?.data?.url?.trim() ?? null;

    if (!providerUserId || !email) {
      throw new UnauthorizedException(
        "Facebook did not provide an email address. Allow email access to sign in.",
      );
    }

    const [existingIdentity, existingUserByEmail] = await Promise.all([
      this.prisma.authIdentity.findUnique({
        where: {
          provider_providerUserId: {
            provider: "FACEBOOK",
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
              revenueShareContractApproved: true,
              reviewedAt: true,
              status: true,
              submittedAt: true,
            },
          },
          profile: true,
          totpCredential: {
            select: { verified: true },
          },
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
                revenueShareContractApproved: true,
                reviewedAt: true,
                status: true,
                submittedAt: true,
              },
            },
            profile: true,
            totpCredential: {
              select: { verified: true },
            },
          },
        })
      : null;

    if (existingIdentity && !existingUserByIdentity) {
      throw new ConflictException(
        "This Facebook account is already linked to a different TaleStead user.",
      );
    }

    if (
      existingUserByIdentity &&
      existingUserByEmail &&
      existingUserByIdentity.id !== existingUserByEmail.id
    ) {
      throw new ConflictException(
        "This Facebook account is already linked to a different TaleStead user.",
      );
    }

    const existingUser = existingUserByIdentity ?? existingUserByEmail;

    if (existingUser && existingUser.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is currently unavailable.");
    }

    const displayName = this.getFacebookDisplayName(facebookProfile, email);
    const now = new Date();

    if (!existingUser) {
      const createdUser = await this.prisma.user.create({
        data: {
          email,
          emailVerifiedAt: now,
          role: "READER",
          authIdentities: {
            create: {
              provider: "FACEBOOK",
              providerEmail: email,
              providerUserId,
            },
          },
          profile: {
            create: {
              avatarUrl: pictureUrl,
              displayName,
            },
          },
        },
        include: {
          creatorApplication: {
            select: {
              reviewNotes: true,
              revenueShareContractApproved: true,
              reviewedAt: true,
              status: true,
              submittedAt: true,
            },
          },
          profile: true,
          totpCredential: {
            select: { verified: true },
          },
        },
      });

      await this.redis.delete(this.getPendingRegistrationKey(email));

      return this.createSessionResponse(
        {
          id: createdUser.id,
          creatorApplication: createdUser.creatorApplication,
          email: createdUser.email,
          isGuest: createdUser.isGuest,
          role: createdUser.role,
          status: createdUser.status,
          profile: createdUser.profile,
          totpCredential: createdUser.totpCredential,
        },
        requestMeta,
      );
    }

    const profileUpdate = {
      ...(!existingUser.profile?.avatarUrl && pictureUrl
        ? { avatarUrl: pictureUrl }
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
                        provider: "FACEBOOK",
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
                          avatarUrl: pictureUrl,
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
                  revenueShareContractApproved: true,
                  reviewedAt: true,
                  status: true,
                  submittedAt: true,
                },
              },
              profile: true,
              totpCredential: {
                select: { verified: true },
              },
            },
          })
        : existingUser;

    await this.redis.delete(this.getPendingRegistrationKey(email));

    return this.createSessionResponse(
      {
        id: syncedUser.id,
        creatorApplication: syncedUser.creatorApplication,
        email: syncedUser.email,
        isGuest: syncedUser.isGuest,
        role: syncedUser.role,
        status: syncedUser.status,
        profile: syncedUser.profile,
        totpCredential: syncedUser.totpCredential,
      },
      requestMeta,
    );
  }

  private async verifyAppleIdentityToken(identityToken: string) {
    const { payload } = await jose.jwtVerify(identityToken, appleJwks, {
      issuer: APPLE_ISSUER,
      audience: env.appleClientId!,
    });

    return payload;
  }

  private isAppleAuthConfigured() {
    return Boolean(env.appleClientId?.trim());
  }

  private async completeAppleAuth(
    input: {
      email: string | null;
      emailVerified: boolean;
      providerUserId: string;
    },
    requestMeta: RequestMeta,
  ) {
    const { email, emailVerified, providerUserId } = input;

    const [existingIdentity, existingUserByEmail] = await Promise.all([
      this.prisma.authIdentity.findUnique({
        where: {
          provider_providerUserId: {
            provider: "APPLE",
            providerUserId,
          },
        },
        select: {
          id: true,
          userId: true,
        },
      }),
      email
        ? this.prisma.user.findUnique({
            where: { email },
            include: {
              creatorApplication: {
                select: {
                  reviewNotes: true,
                  revenueShareContractApproved: true,
                  reviewedAt: true,
                  status: true,
                  submittedAt: true,
                },
              },
              profile: true,
              totpCredential: {
                select: { verified: true },
              },
            },
          })
        : Promise.resolve(null),
    ]);

    const existingUserByIdentity = existingIdentity
      ? await this.prisma.user.findUnique({
          where: { id: existingIdentity.userId },
          include: {
            creatorApplication: {
              select: {
                reviewNotes: true,
                revenueShareContractApproved: true,
                reviewedAt: true,
                status: true,
                submittedAt: true,
              },
            },
            profile: true,
            totpCredential: {
              select: { verified: true },
            },
          },
        })
      : null;

    if (existingIdentity && !existingUserByIdentity) {
      throw new ConflictException(
        "This Apple account is already linked to a different TaleStead user.",
      );
    }

    if (
      existingUserByIdentity &&
      existingUserByEmail &&
      existingUserByIdentity.id !== existingUserByEmail.id
    ) {
      throw new ConflictException(
        "This Apple account is already linked to a different TaleStead user.",
      );
    }

    const existingUser = existingUserByIdentity ?? existingUserByEmail;

    if (existingUser && existingUser.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is currently unavailable.");
    }

    if (!existingUser && (!email || !emailVerified)) {
      throw new UnauthorizedException(
        "Apple did not provide a verified email for this sign-in. Try again or use another method.",
      );
    }

    const displayName = email
      ? this.getDerivedUsername(email)
      : `Reader ${providerUserId.slice(-6)}`;
    const now = new Date();

    if (!existingUser) {
      const createdUser = await this.prisma.user.create({
        data: {
          email: email!,
          emailVerifiedAt: now,
          role: "READER",
          authIdentities: {
            create: {
              provider: "APPLE",
              providerEmail: email!,
              providerUserId,
            },
          },
          profile: {
            create: {
              avatarUrl: null,
              displayName,
            },
          },
        },
        include: {
          creatorApplication: {
            select: {
              reviewNotes: true,
              revenueShareContractApproved: true,
              reviewedAt: true,
              status: true,
              submittedAt: true,
            },
          },
          profile: true,
          totpCredential: {
            select: { verified: true },
          },
        },
      });

      if (email) {
        await this.redis.delete(this.getPendingRegistrationKey(email));
      }

      return this.createSessionResponse(
        {
          id: createdUser.id,
          creatorApplication: createdUser.creatorApplication,
          email: createdUser.email,
          isGuest: createdUser.isGuest,
          role: createdUser.role,
          status: createdUser.status,
          profile: createdUser.profile,
          totpCredential: createdUser.totpCredential,
        },
        requestMeta,
      );
    }

    const shouldVerifyEmail =
      Boolean(email) && !existingUser.emailVerifiedAt && emailVerified;
    const shouldLinkIdentity = !existingIdentity;

    const syncedUser =
      shouldVerifyEmail || shouldLinkIdentity
        ? await this.prisma.user.update({
            where: { id: existingUser.id },
            data: {
              ...(shouldVerifyEmail ? { emailVerifiedAt: now } : {}),
              ...(shouldLinkIdentity
                ? {
                    authIdentities: {
                      create: {
                        provider: "APPLE",
                        providerEmail: email,
                        providerUserId,
                      },
                    },
                  }
                : {}),
            },
            include: {
              creatorApplication: {
                select: {
                  reviewNotes: true,
                  revenueShareContractApproved: true,
                  reviewedAt: true,
                  status: true,
                  submittedAt: true,
                },
              },
              profile: true,
              totpCredential: {
                select: { verified: true },
              },
            },
          })
        : existingUser;

    if (email) {
      await this.redis.delete(this.getPendingRegistrationKey(email));
    }

    return this.createSessionResponse(
      {
        id: syncedUser.id,
        creatorApplication: syncedUser.creatorApplication,
        email: syncedUser.email,
        isGuest: syncedUser.isGuest,
        role: syncedUser.role,
        status: syncedUser.status,
        profile: syncedUser.profile,
        totpCredential: syncedUser.totpCredential,
      },
      requestMeta,
    );
  }

  private generatePkcePair() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");

    return { challenge, verifier };
  }

  private getTwitterAuthStateKey(state: string) {
    return `auth:twitter:state:${state}`;
  }

  private isTwitterAuthConfigured() {
    return Boolean(
      env.twitterClientId?.trim() && env.twitterRedirectUri?.trim(),
    );
  }

  private resolveTwitterOauthCallbackBaseUrl(input: GoogleAuthStartInput) {
    if (input.client !== "mobile") {
      throw new BadRequestException("X sign-in is only supported from the app.");
    }

    const uri = input.mobileRedirectUri ?? env.mobileOAuthCallbackUrl;

    if (!uri?.trim()) {
      throw new BadRequestException(
        "Mobile X sign-in requires the mobile_redirect query parameter (or MOBILE_OAUTH_CALLBACK_URL on the server).",
      );
    }

    this.assertSafeMobileOAuthRedirectUri(uri);

    return uri.trim();
  }

  private async exchangeTwitterCodeForTokens(
    code: string,
    codeVerifier: string,
  ) {
    const body = new URLSearchParams({
      client_id: env.twitterClientId!,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: env.twitterRedirectUri!,
    });

    if (env.twitterClientSecret?.trim()) {
      body.set("client_secret", env.twitterClientSecret.trim());
    }

    const response = await fetch(TWITTER_TOKEN_URL, {
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    const payload = (await response
      .json()
      .catch(() => null)) as { access_token?: string } | null;

    if (!response.ok || typeof payload?.access_token !== "string") {
      throw new BadRequestException("X token exchange failed.");
    }

    return payload.access_token;
  }

  private async fetchTwitterUserInfo(accessToken: string) {
    const response = await fetch(TWITTER_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      method: "GET",
    });
    const payload = (await response
      .json()
      .catch(() => null)) as TwitterUserInfo | null;

    if (!response.ok || !payload?.data?.id) {
      throw new BadRequestException("X profile lookup failed.");
    }

    return payload;
  }

  private async completeTwitterAuth(
    profile: TwitterUserInfo,
    requestMeta: RequestMeta,
  ) {
    const providerUserId = profile.data!.id!.trim();
    const username = profile.data?.username?.trim() ?? "reader";
    const name = profile.data?.name?.trim();
    const avatarUrl = profile.data?.profile_image_url?.trim() ?? null;
    const displayName = name || username;

    const existingIdentity = await this.prisma.authIdentity.findUnique({
      where: {
        provider_providerUserId: {
          provider: "TWITTER",
          providerUserId,
        },
      },
      select: {
        id: true,
        userId: true,
      },
    });

    const userById = existingIdentity
      ? await this.prisma.user.findUnique({
          where: { id: existingIdentity.userId },
          include: {
            creatorApplication: {
              select: {
                reviewNotes: true,
                revenueShareContractApproved: true,
                reviewedAt: true,
                status: true,
                submittedAt: true,
              },
            },
            profile: true,
            totpCredential: {
              select: { verified: true },
            },
          },
        })
      : null;

    if (existingIdentity && !userById) {
      throw new ConflictException(
        "This X account is already linked to a different TaleStead user.",
      );
    }

    if (userById && userById.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is currently unavailable.");
    }

    const now = new Date();

    if (!userById) {
      const createdUser = await this.prisma.user.create({
        data: {
          email: null,
          emailVerifiedAt: null,
          role: "READER",
          authIdentities: {
            create: {
              provider: "TWITTER",
              providerEmail: null,
              providerUserId,
            },
          },
          profile: {
            create: {
              avatarUrl,
              displayName,
            },
          },
        },
        include: {
          creatorApplication: {
            select: {
              reviewNotes: true,
              revenueShareContractApproved: true,
              reviewedAt: true,
              status: true,
              submittedAt: true,
            },
          },
          profile: true,
          totpCredential: {
            select: { verified: true },
          },
        },
      });

      return this.createSessionResponse(
        {
          id: createdUser.id,
          creatorApplication: createdUser.creatorApplication,
          email: createdUser.email,
          isGuest: createdUser.isGuest,
          role: createdUser.role,
          status: createdUser.status,
          profile: createdUser.profile,
          totpCredential: createdUser.totpCredential,
        },
        requestMeta,
      );
    }

    const profileUpdate = {
      ...(!userById.profile?.avatarUrl && avatarUrl ? { avatarUrl } : {}),
      ...(!userById.profile?.displayName ? { displayName } : {}),
    };
    const shouldSyncProfile =
      !userById.profile || Object.keys(profileUpdate).length > 0;

    const syncedUser = shouldSyncProfile
      ? await this.prisma.user.update({
          where: { id: userById.id },
          data: {
            profile: {
              update: profileUpdate,
            },
          },
          include: {
            creatorApplication: {
              select: {
                reviewNotes: true,
                revenueShareContractApproved: true,
                reviewedAt: true,
                status: true,
                submittedAt: true,
              },
            },
            profile: true,
            totpCredential: {
              select: { verified: true },
            },
          },
        })
      : userById;

    return this.createSessionResponse(
      {
        id: syncedUser.id,
        creatorApplication: syncedUser.creatorApplication,
        email: syncedUser.email,
        isGuest: syncedUser.isGuest,
        role: syncedUser.role,
        status: syncedUser.status,
        profile: syncedUser.profile,
        totpCredential: syncedUser.totpCredential,
      },
      requestMeta,
    );
  }

  private getTwitterCallbackErrorCode(error: unknown) {
    if (error instanceof ConflictException) {
      return "twitter_account_conflict";
    }

    if (error instanceof UnauthorizedException) {
      return "twitter_account_unavailable";
    }

    if (error instanceof BadRequestException) {
      if (error.message.includes("token exchange")) {
        return "twitter_token_exchange_failed";
      }

      if (error.message.includes("profile lookup")) {
        return "twitter_profile_fetch_failed";
      }
    }

    return "twitter_auth_failed";
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

  private getFacebookCallbackErrorCode(error: unknown) {
    if (error instanceof ConflictException) {
      return "facebook_account_conflict";
    }

    if (error instanceof UnauthorizedException) {
      if (error.message.includes("email")) {
        return "facebook_email_missing";
      }

      if (error.message.includes("unavailable")) {
        return "facebook_account_unavailable";
      }
    }

    if (error instanceof BadRequestException) {
      if (error.message.includes("token exchange")) {
        return "facebook_token_exchange_failed";
      }

      if (error.message.includes("profile lookup")) {
        return "facebook_profile_fetch_failed";
      }
    }

    return "facebook_auth_failed";
  }

  private isGoogleAuthConfigured() {
    return Boolean(
      env.googleClientId && env.googleClientSecret && env.googleRedirectUri,
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

  private getFacebookAuthStateKey(state: string) {
    return `auth:facebook:state:${state}`;
  }

  private getFacebookFrontendCallbackBaseUrl() {
    const frontendBase = env.frontendAppUrl?.replace(/\/+$/, "") ?? "";

    return `${frontendBase}/auth/facebook/callback`;
  }

  private resolveFacebookOauthCallbackBaseUrl(
    input: GoogleAuthStartInput,
  ): string {
    if (input.client === "mobile") {
      const uri = input.mobileRedirectUri ?? env.mobileOAuthCallbackUrl;

      if (!uri?.trim()) {
        throw new BadRequestException(
          "Mobile Facebook sign-in requires the mobile_redirect query parameter (or MOBILE_OAUTH_CALLBACK_URL on the server).",
        );
      }

      this.assertSafeMobileOAuthRedirectUri(uri);

      return uri.trim();
    }

    return this.getFacebookFrontendCallbackBaseUrl();
  }

  private isFacebookAuthConfigured() {
    return Boolean(
      env.facebookAppId?.trim() &&
        env.facebookAppSecret?.trim() &&
        env.facebookRedirectUri?.trim(),
    );
  }

  private getFacebookDisplayName(
    facebookProfile: FacebookUserInfo,
    email: string,
  ) {
    const displayName = facebookProfile.name?.trim();

    if (displayName) {
      return displayName;
    }

    return this.getDerivedUsername(email);
  }

  private getGoogleFrontendCallbackBaseUrl() {
    const frontendBase = env.frontendAppUrl?.replace(/\/+$/, "") ?? "";

    return `${frontendBase}/auth/google/callback`;
  }

  private resolveGoogleOauthCallbackBaseUrl(
    input: GoogleAuthStartInput,
  ): string {
    if (input.client === "mobile") {
      const uri = input.mobileRedirectUri ?? env.mobileOAuthCallbackUrl;

      if (!uri?.trim()) {
        throw new BadRequestException(
          "Mobile Google sign-in requires the mobile_redirect query parameter (or MOBILE_OAUTH_CALLBACK_URL on the server).",
        );
      }

      this.assertSafeMobileOAuthRedirectUri(uri);

      return uri.trim();
    }

    return this.getGoogleFrontendCallbackBaseUrl();
  }

  private assertSafeMobileOAuthRedirectUri(uri: string): void {
    const trimmed = uri.trim();

    if (!trimmed.startsWith("storyarc://") && !trimmed.startsWith("exp://")) {
      throw new BadRequestException(
        "mobile_redirect must use the storyarc:// or exp:// scheme.",
      );
    }

    if (/\s/.test(trimmed)) {
      throw new BadRequestException(
        "mobile_redirect must not contain whitespace.",
      );
    }

    const allowsOAuthCallback =
      trimmed.includes("auth/google/callback") ||
      trimmed.includes("auth/x/callback") ||
      trimmed.includes("auth/facebook/callback");

    if (!allowsOAuthCallback) {
      try {
        const parsed = new URL(trimmed);
        const p = parsed.pathname.replace(/\/+/g, "/");
        if (
          !p.includes("/auth/google/callback") &&
          !p.includes("/auth/x/callback") &&
          !p.includes("/auth/facebook/callback")
        ) {
          throw new BadRequestException(
            "mobile_redirect must target auth/google/callback, auth/facebook/callback, or auth/x/callback.",
          );
        }
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
        throw new BadRequestException("mobile_redirect must be a valid URL.");
      }
    }

    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
    } catch {
      throw new BadRequestException("mobile_redirect must be a valid URL.");
    }
  }

  private buildGoogleCallbackErrorUrl(
    callbackBaseUrl: string,
    errorCode: string,
  ) {
    const params = new URLSearchParams({
      error: errorCode,
    });

    return `${callbackBaseUrl}?${params.toString()}`;
  }

  private buildGoogleCallbackSuccessUrl(
    callbackBaseUrl: string,
    input: {
      nextPath: string | null;
      tokens: {
        accessToken: string;
        expiresInSeconds: number;
        refreshToken: string;
        tokenType: string;
      };
    },
  ) {
    const hash = new URLSearchParams({
      accessToken: input.tokens.accessToken,
      refreshToken: input.tokens.refreshToken,
    });

    if (input.nextPath) {
      hash.set("next", input.nextPath);
    }

    return `${callbackBaseUrl}#${hash.toString()}`;
  }

  private async createSessionResponse(
    user: AuthUserSnapshot,
    requestMeta: RequestMeta,
  ) {
    const now = new Date();
    const accessTokenExpiresAt = this.addMinutes(
      now,
      env.accessTokenTtlMinutes,
    );
    const refreshTokenExpiresAt = this.addDays(now, env.refreshTokenTtlDays);
    const placeholderHash = this.hashRefreshToken(this.generateOpaqueToken());

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
    const accessTokenExpiresAt = this.addMinutes(
      now,
      env.accessTokenTtlMinutes,
    );
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

    const refreshTokenHash = this.hashRefreshToken(refreshToken);

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
      isGuest: user.isGuest,
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
      birthYear: user.birthYear ?? null,
      contentFiltering: user.profile?.contentFiltering ?? true,
      creatorApplication: this.mapCreatorApplication(user.creatorApplication),
      id: user.id,
      email: user.email,
      isGuest: user.isGuest,
      role: user.role,
      displayName: user.profile?.displayName ?? "TaleStead User",
      onboarding: this.mapOnboarding(user.profile),
      has2FA: user.totpCredential?.verified ?? false,
    };
  }

  private hashRefreshToken(refreshToken: string) {
    return `${REFRESH_TOKEN_HASH_PREFIX}${createHash("sha256")
      .update(refreshToken)
      .digest("hex")}`;
  }

  private async verifyRefreshToken(refreshToken: string, storedHash: string) {
    if (storedHash.startsWith(REFRESH_TOKEN_HASH_PREFIX)) {
      const expectedHash = Buffer.from(this.hashRefreshToken(refreshToken));
      const actualHash = Buffer.from(storedHash);

      return (
        expectedHash.length === actualHash.length &&
        timingSafeEqual(expectedHash, actualHash)
      );
    }

    return compare(refreshToken, storedHash);
  }

  private async cacheSessionLookup(input: {
    accessTokenExpiresAt: Date;
    isGuest: boolean;
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
        isGuest: input.isGuest,
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
      username: user.email ? this.getDerivedUsername(user.email) : "",
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
      revenueShareContractApproved:
        creatorApplication.revenueShareContractApproved ?? null,
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

  // --- FCM Token Management ---

  async registerFcmToken(userId: string, token: string, device?: string) {
    await this.prisma.fcmToken.upsert({
      where: { token },
      create: { userId, token, device },
      update: { userId, device, updatedAt: new Date() },
    });

    return { message: "FCM token registered." };
  }

  async removeFcmToken(userId: string, token: string) {
    await this.prisma.fcmToken.deleteMany({
      where: { userId, token },
    });

    return { message: "FCM token removed." };
  }

  // --- Unsubscribe ---

  async processUnsubscribe(token: string) {
    if (!token || typeof token !== "string") {
      throw new BadRequestException("Invalid unsubscribe token.");
    }

    let payload: { sub: string; category: string };

    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: env.jwtAccessSecret,
      });
    } catch {
      throw new BadRequestException("Invalid or expired unsubscribe token.");
    }

    if (!payload.sub || !payload.category) {
      throw new BadRequestException("Malformed unsubscribe token.");
    }

    const updateData: Record<string, boolean> = {};
    const categoryToField: Record<string, string> = {
      comments: "emailNewComments",
      digest: "emailWeeklyDigest",
      marketing: "emailMarketing",
    };

    const field = categoryToField[payload.category];

    if (!field) {
      throw new BadRequestException("Unknown email category.");
    }

    updateData[field] = false;

    await this.prisma.notificationPreference.upsert({
      where: { userId: payload.sub },
      create: {
        userId: payload.sub,
        ...updateData,
      },
      update: updateData,
    });

    return {
      message: `You have been unsubscribed from ${payload.category} emails.`,
    };
  }

  async generateUnsubscribeToken(
    userId: string,
    category: string,
  ): Promise<string> {
    return this.jwtService.signAsync(
      { sub: userId, category, type: "unsubscribe" },
      { secret: env.jwtAccessSecret, expiresIn: "90d" },
    );
  }
}
