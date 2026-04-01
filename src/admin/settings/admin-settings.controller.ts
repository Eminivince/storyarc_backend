import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import { parseAdminSettingValueBody } from "../../operations/operations.schemas";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { AdminSettingsService } from "./admin-settings.service";

@Controller("admin")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
export class AdminSettingsController {
  constructor(private readonly service: AdminSettingsService) {}

  @RequirePermission("settings:read")
  @Get("settings")
  async getAdminSettings(@Req() request: AuthenticatedRequest) {
    return this.service.getAdminSettings(request.auth!.userId);
  }

  @RequirePermission("settings:write")
  @Post("settings/:settingKey/toggle")
  async toggleAdminSetting(@Param("settingKey") settingKey: string, @Req() request: AuthenticatedRequest) {
    return this.service.toggleAdminSetting(request.auth!.userId, settingKey);
  }

  @RequirePermission("settings:write")
  @Put("settings/:settingKey")
  async updateAdminSettingValue(
    @Param("settingKey") settingKey: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.updateAdminSettingValue(request.auth!.userId, settingKey, parseAdminSettingValueBody(body));
  }

  @RequirePermission("maintenance:execute")
  @Post("maintenance/:actionId")
  async runMaintenanceAction(@Param("actionId") actionId: string, @Req() request: AuthenticatedRequest) {
    return this.service.runMaintenanceAction(request.auth!.userId, actionId);
  }
}
