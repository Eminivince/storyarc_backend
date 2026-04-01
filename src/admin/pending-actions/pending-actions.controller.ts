import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import { throttleAdminDestructive, throttleAdminRead } from "../../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { PendingActionsService } from "./pending-actions.service";

@Controller("admin/pending-actions")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
@Throttle(throttleAdminDestructive)
export class PendingActionsController {
  constructor(private readonly service: PendingActionsService) {}

  @Throttle(throttleAdminRead)
  @RequirePermission("admin:audit-log")
  @Get()
  async listPendingActions() {
    return this.service.listPendingActions();
  }

  @RequirePermission("admin:manage")
  @Post(":actionId/approve")
  async approveAction(
    @Param("actionId") actionId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const note = (record?.note as string) ?? null;
    return this.service.approveAction(
      request.auth!.userId,
      actionId,
      note,
      { ipAddress: request.ip, userAgent: request.headers["user-agent"] as string },
    );
  }

  @RequirePermission("admin:manage")
  @Post(":actionId/reject")
  async rejectAction(
    @Param("actionId") actionId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const note = (record?.note as string) ?? null;
    return this.service.rejectAction(
      request.auth!.userId,
      actionId,
      note,
      { ipAddress: request.ip, userAgent: request.headers["user-agent"] as string },
    );
  }
}
