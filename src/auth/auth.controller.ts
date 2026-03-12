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
  parseForgotPasswordBody,
  parseGoogleAuthCallbackQuery,
  parseGoogleAuthStartQuery,
  parseLoginBody,
  parseRefreshBody,
  parseRegisterBody,
  parseResetPasswordBody,
  parseVerifyResetCodeBody,
} from "./auth.schemas";
import { AuthService } from "./auth.service";

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
  constructor(private readonly authService: AuthService) {}

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
}
