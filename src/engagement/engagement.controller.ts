import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseCreateAnnouncementBody,
  parseCreatePollBody,
  parseLeaderboardPeriodQuery,
  parseNotificationPreferencesBody,
  parseShareReferralBody,
  parseVotePollBody,
} from "./engagement.schemas";
import { EngagementService } from "./engagement.service";

function assertCreatorRole(request: AuthenticatedRequest) {
  if (
    request.auth?.role !== "CREATOR" &&
    request.auth?.role !== "ADMIN"
  ) {
    throw new ForbiddenException("Creator access is required.");
  }
}

@Controller("engagement")
@UseGuards(AccessTokenGuard)
export class EngagementController {
  constructor(private readonly engagementService: EngagementService) {}

  @Get("overview")
  async getOverview(@Req() request: AuthenticatedRequest) {
    return this.engagementService.getOverview(request.auth!.userId);
  }

  @Post("check-in")
  async checkIn(@Req() request: AuthenticatedRequest) {
    return this.engagementService.claimDailyCheckIn(request.auth!.userId);
  }

  @Post("missions/:missionKey/claim")
  async claimMission(
    @Param("missionKey") missionKey: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagementService.claimMission(
      request.auth!.userId,
      missionKey,
    );
  }

  @Post("referrals/share")
  async shareReferral(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagementService.shareReferral(
      request.auth!.userId,
      parseShareReferralBody(body),
    );
  }

  @Get("leaderboard")
  async getLeaderboard(
    @Query("period") period: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagementService.getLeaderboard(
      request.auth!.userId,
      parseLeaderboardPeriodQuery(period),
    );
  }

  @Get("community")
  async getCommunity(
    @Query("storySlug") storySlug: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagementService.getCommunity(
      request.auth!.userId,
      storySlug?.trim() || undefined,
    );
  }

  @Post("community/announcements")
  async createAnnouncement(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertCreatorRole(request);

    return this.engagementService.createAnnouncement(
      request.auth!.userId,
      parseCreateAnnouncementBody(body),
    );
  }

  @Post("community/polls")
  async createPoll(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertCreatorRole(request);

    return this.engagementService.createPoll(
      request.auth!.userId,
      parseCreatePollBody(body),
    );
  }

  @Post("community/polls/:postId/vote")
  async votePoll(
    @Param("postId") postId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagementService.votePoll(
      request.auth!.userId,
      postId,
      parseVotePollBody(body),
    );
  }

  @Put("notification-preferences")
  async updateNotificationPreferences(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagementService.updateNotificationPreferences(
      request.auth!.userId,
      parseNotificationPreferencesBody(body),
    );
  }

  @Post("notifications/:notificationId/read")
  async markNotificationRead(
    @Param("notificationId") notificationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagementService.markNotificationRead(
      request.auth!.userId,
      notificationId,
    );
  }

  @Post("notifications/read-all")
  async markAllNotificationsRead(@Req() request: AuthenticatedRequest) {
    return this.engagementService.markAllNotificationsRead(request.auth!.userId);
  }
}
