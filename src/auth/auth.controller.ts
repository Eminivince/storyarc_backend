import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseDeleteAccountBody,
  parseForgotPasswordBody,
  parseGoogleAuthCallbackQuery,
  parseGoogleAuthStartQuery,
  parseLoginBody,
  parseRefreshBody,
  parseRegisterBody,
  parseRegisterFcmTokenBody,
  parseResetPasswordBody,
  parseTotpChallengeBody,
  parseTotpDisableBody,
  parseTotpVerifySetupBody,
  parseVerifyResetCodeBody,
} from "./auth.schemas";
import { AuthService } from "./auth.service";
import { TotpService } from "./totp.service";

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
) {
  const value = headers[key];

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function getRequestMeta(request: AuthenticatedRequest) {
  const forwardedFor = getHeaderValue(request.headers, "x-forwarded-for");

  return {
    ipAddress:
      forwardedFor?.split(",")[0]?.trim() ??
      request.ip ??
      request.raw?.socket?.remoteAddress ??
      null,
    userAgent: getHeaderValue(request.headers, "user-agent"),
  };
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly totpService: TotpService,
  ) {}

  @Get("google/start")
  @Redirect()
  async startGoogleAuth(@Query() query: unknown) {
    return this.authService.startGoogleAuth(parseGoogleAuthStartQuery(query));
  }

  @Get("google/callback")
  @Redirect()
  async handleGoogleCallback(
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.authService.handleGoogleCallback(
      parseGoogleAuthCallbackQuery(query),
      getRequestMeta(request),
    );
  }

  @Post("register")
  async register(@Body() body: unknown) {
    return this.authService.register(parseRegisterBody(body));
  }

  @Post("register/resend-code")
  async resendRegisterCode(@Body() body: unknown) {
    return this.authService.resendRegisterCode(parseForgotPasswordBody(body));
  }

  @Post("register/verify-code")
  async verifyRegisterCode(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.authService.verifyRegisterCode(
      parseVerifyResetCodeBody(body),
      getRequestMeta(request),
    );
  }

  @Post("login")
  async login(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.authService.login(parseLoginBody(body), getRequestMeta(request));
  }

  @UseGuards(AccessTokenGuard)
  @Post("logout")
  async logout(@Req() request: AuthenticatedRequest) {
    return this.authService.logout(
      request.auth!.userId,
      request.auth!.sessionId,
    );
  }

  @Post("refresh")
  async refresh(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.authService.refresh(parseRefreshBody(body), getRequestMeta(request));
  }

  @Post("forgot-password")
  async forgotPassword(@Body() body: unknown) {
    return this.authService.forgotPassword(parseForgotPasswordBody(body));
  }

  @Post("verify-reset-code")
  async verifyResetCode(@Body() body: unknown) {
    return this.authService.verifyResetCode(parseVerifyResetCodeBody(body));
  }

  @Post("reset-password")
  async resetPassword(@Body() body: unknown) {
    return this.authService.resetPassword(parseResetPasswordBody(body));
  }

  @UseGuards(AccessTokenGuard)
  @Get("sessions")
  async getSessions(@Req() request: AuthenticatedRequest) {
    return this.authService.getSessions(
      request.auth!.userId,
      request.auth!.sessionId,
    );
  }

  @UseGuards(AccessTokenGuard)
  @Delete("sessions/:sessionId")
  async revokeSession(
    @Param("sessionId") sessionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.authService.revokeSession(request.auth!.userId, sessionId);
  }

  // --- 2FA Endpoints ---

  @UseGuards(AccessTokenGuard)
  @Post("2fa/setup")
  async setup2FA(@Req() request: AuthenticatedRequest) {
    return this.totpService.setup(request.auth!.userId);
  }

  @UseGuards(AccessTokenGuard)
  @Post("2fa/verify-setup")
  async verify2FASetup(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { code } = parseTotpVerifySetupBody(body);
    return this.totpService.verifySetup(request.auth!.userId, code);
  }

  @Post("2fa/challenge")
  async complete2FAChallenge(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { challengeToken, code } = parseTotpChallengeBody(body);
    const userId = await this.totpService.verifyChallenge(challengeToken, code);
    return this.authService.complete2FALogin(userId, getRequestMeta(request));
  }

  @UseGuards(AccessTokenGuard)
  @Post("2fa/disable")
  async disable2FA(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { password, code } = parseTotpDisableBody(body);
    return this.totpService.disable(request.auth!.userId, password, code);
  }

  // --- Account Deletion ---

  @UseGuards(AccessTokenGuard)
  @Post("account/delete")
  async deleteAccount(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { password } = parseDeleteAccountBody(body);
    return this.authService.deleteAccount(request.auth!.userId, password);
  }

  // --- FCM Token Management ---

  @UseGuards(AccessTokenGuard)
  @Post("fcm-token")
  async registerFcmToken(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { token, device } = parseRegisterFcmTokenBody(body);
    return this.authService.registerFcmToken(request.auth!.userId, token, device);
  }

  @UseGuards(AccessTokenGuard)
  @Delete("fcm-token/:token")
  async removeFcmToken(
    @Param("token") token: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.authService.removeFcmToken(request.auth!.userId, token);
  }

  // --- Unsubscribe ---

  @Get("unsubscribe")
  async unsubscribe(@Query("token") token: string) {
    return this.authService.processUnsubscribe(token);
  }
}
