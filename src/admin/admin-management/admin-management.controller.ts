import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import {
  throttleAdminDestructive,
  throttleAdminRead,
} from "../../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { AdminManagementService } from "./admin-management.service";

@Controller("admin/admins")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
@Throttle(throttleAdminDestructive)
export class AdminManagementController {
  constructor(private readonly service: AdminManagementService) {}

  @Throttle(throttleAdminRead)
  @RequirePermission("admin:manage")
  @Get("roles")
  async listAdminRoles() {
    return this.service.listAdminRoles();
  }

  @Throttle(throttleAdminRead)
  @RequirePermission("admin:manage")
  @Get()
  async listAdminUsers() {
    return this.service.listAdminUsers();
  }

  @RequirePermission("admin:manage")
  @Post(":userId/assign-role")
  async assignAdminRole(
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const adminRoleId = record.adminRoleId as string;

    if (!adminRoleId || typeof adminRoleId !== "string") {
      throw new Error("adminRoleId is required.");
    }

    return this.service.assignAdminRole(
      request.auth!.userId,
      userId,
      adminRoleId,
      { ipAddress: request.ip, userAgent: request.headers["user-agent"] as string },
    );
  }

  @RequirePermission("admin:manage")
  @Delete(":userId/role")
  async revokeAdminRole(
    @Param("userId") userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.revokeAdminRole(
      request.auth!.userId,
      userId,
      { ipAddress: request.ip, userAgent: request.headers["user-agent"] as string },
    );
  }
}
