import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
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

  // ---------------------------------------------------------------------------
  // Promo Carousel
  // ---------------------------------------------------------------------------

  @Throttle(throttleAdminRead)
  @RequirePermission("content:featured:read")
  @Get("promo-carousel")
  async getPromoCarousel() {
    return this.service.getPromoCarouselSlides();
  }

  @RequirePermission("content:featured:write")
  @Put("promo-carousel")
  async replacePromoCarousel(@Body() body: unknown) {
    if (!body || !Array.isArray((body as any)?.slides)) {
      throw new BadRequestException("Body must contain a `slides` array.");
    }
    return this.service.replacePromoCarouselSlides((body as any).slides);
  }

  // ---------------------------------------------------------------------------
  // Limited Offers
  // ---------------------------------------------------------------------------

  @Throttle(throttleAdminRead)
  @RequirePermission("content:featured:read")
  @Get("limited-offers")
  async getLimitedOffers() {
    return this.service.getLimitedOffers();
  }

  @RequirePermission("content:featured:write")
  @Post("limited-offers")
  async createLimitedOffer(@Body() body: unknown) {
    const record = body as Record<string, unknown>;
    const storyId = typeof record?.storyId === "string" ? record.storyId : null;
    const discountLabel = typeof record?.discountLabel === "string" ? record.discountLabel : null;
    const startsAt = record?.startsAt ? new Date(record.startsAt as string) : null;
    const endsAt = record?.endsAt ? new Date(record.endsAt as string) : null;

    if (!storyId || !discountLabel || !startsAt || !endsAt) {
      throw new BadRequestException("storyId, discountLabel, startsAt, and endsAt are required.");
    }

    return this.service.createLimitedOffer({ storyId, discountLabel, startsAt, endsAt });
  }

  @RequirePermission("content:featured:write")
  @Delete("limited-offers/:id")
  async deleteLimitedOffer(@Param("id") id: string) {
    return this.service.deleteLimitedOffer(id);
  }

  // ---------------------------------------------------------------------------
  // Popup Promos
  // ---------------------------------------------------------------------------

  @Throttle(throttleAdminRead)
  @RequirePermission("content:featured:read")
  @Get("popup-promos")
  async getPopupPromos() {
    return this.service.getPopupPromos();
  }

  @RequirePermission("content:featured:write")
  @Post("popup-promos")
  async createPopupPromo(@Body() body: unknown) {
    const record = body as Record<string, unknown>;
    const storyId = typeof record?.storyId === "string" ? record.storyId : null;
    const imageUrl = typeof record?.imageUrl === "string" ? record.imageUrl : null;
    const title = typeof record?.title === "string" ? record.title : null;
    const subtitle = typeof record?.subtitle === "string" ? record.subtitle : null;
    const linkType = typeof record?.linkType === "string" ? record.linkType : "story";
    const linkTarget = typeof record?.linkTarget === "string" ? record.linkTarget : null;
    const triggerTiming = record?.triggerTiming === "AFTER_DELAY" ? "AFTER_DELAY" : "IMMEDIATE";
    const delaySeconds = typeof record?.delaySeconds === "number" ? record.delaySeconds : 0;
    const priority = typeof record?.priority === "number" ? record.priority : 0;

    if (!storyId || !imageUrl || !title || !linkTarget) {
      throw new BadRequestException("storyId, imageUrl, title, and linkTarget are required.");
    }

    return this.service.createPopupPromo({
      storyId, imageUrl, title, subtitle, linkType, linkTarget,
      triggerTiming: triggerTiming as "IMMEDIATE" | "AFTER_DELAY",
      delaySeconds, priority,
    });
  }

  @RequirePermission("content:featured:write")
  @Patch("popup-promos/:id")
  async updatePopupPromo(@Param("id") id: string, @Body() body: unknown) {
    return this.service.updatePopupPromo(id, body as Record<string, unknown>);
  }

  @RequirePermission("content:featured:write")
  @Delete("popup-promos/:id")
  async deletePopupPromo(@Param("id") id: string) {
    return this.service.deletePopupPromo(id);
  }
}
