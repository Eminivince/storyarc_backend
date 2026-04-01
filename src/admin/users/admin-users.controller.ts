import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import {
  throttleAdminDestructive,
  throttleAdminRead,
  throttleAdminWrite,
} from "../../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import {
  parseAdminListLimitQuery,
  parseAdminListOffsetQuery,
  parseAdminUserStatusBody,
  parseUpdateAdminUserBody,
} from "../../operations/operations.schemas";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { AdminUsersService } from "./admin-users.service";

@Controller("admin")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
@Throttle(throttleAdminWrite)
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Throttle(throttleAdminRead)
  @Get("users")
  @RequirePermission("users.list")
  async getAdminUsers(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.listAdminUsers(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Throttle(throttleAdminRead)
  @Get("users/:userId")
  @RequirePermission("users.read")
  async getAdminUser(
    @Param("userId") userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.getAdminUserDetails(request.auth!.userId, userId);
  }

  @Put("users/:userId")
  @RequirePermission("users.update")
  async updateAdminUser(
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.updateAdminUser(
      request.auth!.userId,
      userId,
      parseUpdateAdminUserBody(body),
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }

  @Throttle(throttleAdminDestructive)
  @Patch("users/:userId/status")
  @RequirePermission("users.update")
  async updateAdminUserStatus(
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseAdminUserStatusBody(body);

    return this.service.updateAdminUserStatus(
      request.auth!.userId,
      userId,
      input.action,
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }

  @Post("users/:userId/reset-password")
  @RequirePermission("users.update")
  async resetAdminUserPassword(
    @Param("userId") userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.resetAdminUserPassword(
      request.auth!.userId,
      userId,
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }
}
