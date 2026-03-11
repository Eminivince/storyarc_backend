import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import { parseUpdateCurrentUserProfileBody } from "./auth.schemas";
import { AuthService } from "./auth.service";

@Controller()
export class MeController {
  constructor(private readonly authService: AuthService) {}

  @UseGuards(AccessTokenGuard)
  @Get("me")
  async getCurrentUser(@Req() request: AuthenticatedRequest) {
    return this.authService.getCurrentUser(request.auth!.userId);
  }

  @UseGuards(AccessTokenGuard)
  @Put("me/profile")
  async updateCurrentUserProfile(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.authService.updateCurrentUserProfile(
      request.auth!.userId,
      parseUpdateCurrentUserProfileBody(body),
    );
  }
}
