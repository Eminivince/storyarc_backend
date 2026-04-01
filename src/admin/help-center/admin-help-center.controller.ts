import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import { parseAdminHelpCenterArticleBody, parseAdminHelpCenterCategoryBody } from "../../operations/operations.schemas";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { AdminHelpCenterService } from "./admin-help-center.service";

@Controller("admin")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
export class AdminHelpCenterController {
  constructor(private readonly service: AdminHelpCenterService) {}

  @RequirePermission("help-center:read")
  @Get("help-center")
  async getAdminHelpCenter(@Req() request: AuthenticatedRequest) {
    return this.service.getAdminHelpCenter(request.auth!.userId);
  }

  @RequirePermission("help-center:write")
  @Post("help-center/categories")
  async createHelpCenterCategory(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.service.createHelpCenterCategory(request.auth!.userId, parseAdminHelpCenterCategoryBody(body));
  }

  @RequirePermission("help-center:write")
  @Post("help-center/articles")
  async createHelpCenterArticle(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.service.createHelpCenterArticle(request.auth!.userId, parseAdminHelpCenterArticleBody(body));
  }

  @RequirePermission("help-center:write")
  @Delete("help-center/articles/:articleId")
  async deleteHelpCenterArticle(@Param("articleId") articleId: string, @Req() request: AuthenticatedRequest) {
    return this.service.deleteHelpCenterArticle(request.auth!.userId, articleId);
  }
}
