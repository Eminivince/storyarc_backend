import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import { throttleAdminRead } from "../../common/throttler/throttler.constants";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import { AdminDashboardService } from "./admin-dashboard.service";

@Controller("admin")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
export class AdminDashboardController {
  constructor(private readonly service: AdminDashboardService) {}

  @Throttle(throttleAdminRead)
  @Get("dashboard")
  async getAdminOverview(@Req() request: AuthenticatedRequest) {
    return this.service.getAdminOverview(request.auth!.userId);
  }

  @Throttle(throttleAdminRead)
  @Get("search")
  async globalSearch(@Query("q") q: string | undefined) {
    return this.service.globalSearch(q?.trim() ?? "");
  }
}
