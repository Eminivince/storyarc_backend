import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import { throttleAdminRead, throttleAdminWrite } from "../../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import { parseAdminBookConfigBody, parseAdminBookPolicyBody, parseAdminBookVisibilityBody, parseAdminListLimitQuery, parseAdminListOffsetQuery } from "../../operations/operations.schemas";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { AdminBooksService } from "./admin-books.service";

@Controller("admin")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
@Throttle(throttleAdminWrite)
export class AdminBooksController {
  constructor(private readonly service: AdminBooksService) {}

  @Throttle(throttleAdminRead)
  @RequirePermission("content:books:read")
  @Get("books")
  async getAdminBooks(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.listAdminBooks(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Throttle(throttleAdminRead)
  @RequirePermission("content:books:read")
  @Get("books/:bookSlug")
  async getAdminBook(@Param("bookSlug") bookSlug: string, @Req() request: AuthenticatedRequest) {
    return this.service.getAdminBookDetails(request.auth!.userId, bookSlug);
  }

  @RequirePermission("content:books:write")
  @Patch("books/policy")
  async updateAdminBookPolicy(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.service.updateAdminBookPolicy(request.auth!.userId, parseAdminBookPolicyBody(body));
  }

  @RequirePermission("content:books:visibility")
  @Patch("books/:bookSlug/visibility")
  async updateAdminBookVisibility(
    @Param("bookSlug") bookSlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.updateAdminBookVisibility(request.auth!.userId, bookSlug, parseAdminBookVisibilityBody(body));
  }

  @RequirePermission("content:chapters:config")
  @Put("books/:bookSlug/config")
  async updateAdminBookConfig(
    @Param("bookSlug") bookSlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.updateAdminBookConfig(request.auth!.userId, bookSlug, parseAdminBookConfigBody(body));
  }

  @Throttle(throttleAdminRead)
  @RequirePermission("content:featured:read")
  @Get("featured/weekly")
  async getWeeklyFeatured(@Req() request: AuthenticatedRequest) {
    return this.service.getWeeklyFeaturedStories(request.auth!.userId);
  }

  @RequirePermission("content:featured:write")
  @Post("featured/weekly")
  async setWeeklyFeatured(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const record = body as Record<string, unknown>;
    const slugs = Array.isArray(record?.slugs) ? (record.slugs as string[]) : [];
    return this.service.setWeeklyFeaturedStories(request.auth!.userId, slugs);
  }

  @RequirePermission("content:featured:write")
  @Delete("featured/weekly/:storySlug")
  async removeWeeklyFeatured(@Param("storySlug") storySlug: string, @Req() request: AuthenticatedRequest) {
    return this.service.removeWeeklyFeaturedStory(request.auth!.userId, storySlug);
  }
}
