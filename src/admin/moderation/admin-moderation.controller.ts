import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import {
  throttleAdminRead,
  throttleAdminWrite,
} from "../../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import {
  parseAdminCommentModerationBody,
  parseAdminListLimitQuery,
  parseAdminListOffsetQuery,
  parseAdminReviewModerationBody,
  parseResolveReportBody,
} from "../../operations/operations.schemas";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { AdminModerationService } from "./admin-moderation.service";

@Controller("admin")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
@Throttle(throttleAdminWrite)
export class AdminModerationController {
  constructor(private readonly service: AdminModerationService) {}

  @Throttle(throttleAdminRead)
  @Get("reports")
  @RequirePermission("moderation.reports.list")
  async getAdminReports(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.listAdminReports(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Patch("reports/:reportId")
  @RequirePermission("moderation.reports.resolve")
  async resolveAdminReport(
    @Param("reportId") reportId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.resolveAdminReport(
      request.auth!.userId,
      reportId,
      parseResolveReportBody(body),
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }

  @Throttle(throttleAdminRead)
  @Get("comments")
  @RequirePermission("moderation.comments.list")
  async getAdminComments(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.listAdminComments(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Patch("comments/:commentId")
  @RequirePermission("moderation.comments.moderate")
  async moderateAdminComment(
    @Param("commentId") commentId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.moderateAdminComment(
      request.auth!.userId,
      commentId,
      parseAdminCommentModerationBody(body),
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }

  @Throttle(throttleAdminRead)
  @Get("reviews")
  @RequirePermission("moderation.reviews.list")
  async getAdminReviews(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.listAdminReviews(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Patch("reviews/:reviewId")
  @RequirePermission("moderation.reviews.moderate")
  async moderateAdminReview(
    @Param("reviewId") reviewId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.moderateAdminReview(
      request.auth!.userId,
      reviewId,
      parseAdminReviewModerationBody(body),
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    );
  }
}
