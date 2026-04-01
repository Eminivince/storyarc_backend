import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import {
  throttleAdminRead,
  throttleAdminWrite,
} from "../../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import { parseSupportMessageBody } from "../../operations/operations.schemas";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { AdminSupportService } from "./admin-support.service";

@Controller("admin")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
@Throttle(throttleAdminRead)
export class AdminSupportController {
  constructor(private readonly service: AdminSupportService) {}

  @RequirePermission("admin:audit-log")
  @Get("activity")
  async getAdminActivity(
    @Query("adminUserId") adminUserIdFilter: string | undefined,
    @Query("action") action: string | undefined,
    @Query("targetType") targetType: string | undefined,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.getAdminActivity(request.auth!.userId, {
      adminUserId: adminUserIdFilter,
      action,
      targetType,
      from,
      to,
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @RequirePermission("support:tickets:read")
  @Get("messages")
  async getAdminMessages(@Req() request: AuthenticatedRequest) {
    return this.service.getAdminMessages(request.auth!.userId);
  }

  @Throttle(throttleAdminWrite)
  @RequirePermission("support:tickets:reply")
  @Post("messages/:ticketId/reply")
  async replyToSupportTicket(
    @Param("ticketId") ticketId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.replyToSupportTicket(
      request.auth!.userId,
      ticketId,
      parseSupportMessageBody(body).body,
    );
  }
}
