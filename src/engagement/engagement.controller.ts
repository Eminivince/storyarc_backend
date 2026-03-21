import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import {
  throttlePayment,
  throttleWithdrawal,
} from "../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseCreateAnnouncementBody,
  parseCreatePollBody,
  parseLeaderboardPeriodQuery,
  parseNotificationPreferencesBody,
  parseParagraphIndexParam,
  parseReactionBody,
  parseAdminCreateChallengeBody,
  parseAdminUpdateChallengeBody,
  parseReadingTimeBody,
  parseShareReferralBody,
  parseVotePollBody,
} from "./engagement.schemas";
import { ActivityFeedService } from "./activity-feed.service";
import { ChallengeService } from "./challenge.service";
import { ChurnPredictionService } from "./churn-prediction.service";
import { EngagementService } from "./engagement.service";
import { PointShopService } from "./point-shop.service";
import { ReactionService } from "./reaction.service";
import { ReferralService } from "./referral.service";

function assertCreatorRole(request: AuthenticatedRequest) {
  if (
    request.auth?.role !== "CREATOR" &&
    request.auth?.role !== "ADMIN"
  ) {
    throw new ForbiddenException("Creator access is required.");
  }
}

function assertAdminRole(request: AuthenticatedRequest) {
  if (request.auth?.role !== "ADMIN") {
    throw new ForbiddenException("Admin access is required.");
  }
}

@Controller("engagement")
@UseGuards(AccessTokenGuard)
export class EngagementController {
  constructor(
    private readonly engagementService: EngagementService,
    private readonly reactionService: ReactionService,
    private readonly challengeService: ChallengeService,
    private readonly pointShopService: PointShopService,
    private readonly activityFeedService: ActivityFeedService,
    private readonly churnPredictionService: ChurnPredictionService,
    private readonly referralService: ReferralService,
  ) {}

  @Get("overview")
  async getOverview(@Req() request: AuthenticatedRequest) {
    return this.engagementService.getOverview(request.auth!.userId);
  }

  @Get("notifications")
  async getNotifications(@Req() request: AuthenticatedRequest) {
    return this.engagementService.getNotifications(request.auth!.userId);
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

  @Throttle(throttlePayment)
  @Post("streak-shield/purchase")
  async purchaseStreakShield(@Req() request: AuthenticatedRequest) {
    return this.engagementService.purchaseStreakShield(request.auth!.userId);
  }

  @Post("reading-time")
  async recordReadingTime(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagementService.recordReadingTime(
      request.auth!.userId,
      parseReadingTimeBody(body),
    );
  }

  @Get("creator-scorecard")
  async getCreatorScorecard(@Req() request: AuthenticatedRequest) {
    assertCreatorRole(request);
    return this.engagementService.getCreatorScorecard(request.auth!.userId);
  }

  @Get("badges")
  async getBadges(@Req() request: AuthenticatedRequest) {
    return this.engagementService.getBadges(request.auth!.userId);
  }

  @Put("badges/:badgeId/feature")
  async toggleBadgeFeatured(
    @Param("badgeId") badgeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.engagementService.toggleBadgeFeatured(
      request.auth!.userId,
      badgeId,
    );
  }

  // ── paragraph reactions ────────────────────────────────────────────

  @Put("stories/:storySlug/chapters/:chapterSlug/paragraphs/:index/reaction")
  async upsertParagraphReaction(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Param("index") index: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { reactionType } = parseReactionBody(body);

    return this.reactionService.upsertParagraphReaction(
      request.auth!.userId,
      storySlug,
      chapterSlug,
      parseParagraphIndexParam(index),
      reactionType,
    );
  }

  @Delete("stories/:storySlug/chapters/:chapterSlug/paragraphs/:index/reaction")
  async removeParagraphReaction(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Param("index") index: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reactionService.removeParagraphReaction(
      request.auth!.userId,
      storySlug,
      chapterSlug,
      parseParagraphIndexParam(index),
    );
  }

  // ── chapter reactions ──────────────────────────────────────────────

  @Put("stories/:storySlug/chapters/:chapterSlug/reaction")
  async upsertChapterReaction(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { reactionType } = parseReactionBody(body);

    return this.reactionService.upsertChapterReaction(
      request.auth!.userId,
      storySlug,
      chapterSlug,
      reactionType,
    );
  }

  @Delete("stories/:storySlug/chapters/:chapterSlug/reaction")
  async removeChapterReaction(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reactionService.removeChapterReaction(
      request.auth!.userId,
      storySlug,
      chapterSlug,
    );
  }

  // ── aggregated reactions ───────────────────────────────────────────

  @Get("stories/:storySlug/chapters/:chapterSlug/reactions")
  async getChapterReactions(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reactionService.getChapterReactions(
      request.auth!.userId,
      storySlug,
      chapterSlug,
    );
  }

  @Get("stories/:storySlug/chapters/:chapterSlug/reaction-heatmap")
  async getReactionHeatmap(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reactionService.getReactionHeatmap(
      request.auth!.userId,
      storySlug,
      chapterSlug,
    );
  }

  // ── challenges ─────────────────────────────────────────────────────

  @Get("challenges")
  async getActiveChallenges(@Req() request: AuthenticatedRequest) {
    return this.challengeService.getActiveChallenges(request.auth!.userId);
  }

  @Post("challenges/:challengeId/claim")
  async claimChallengeReward(
    @Param("challengeId") challengeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.challengeService.claimChallengeReward(
      request.auth!.userId,
      challengeId,
    );
  }

  @Get("challenges/:challengeId/leaderboard")
  async getChallengeLeaderboard(
    @Param("challengeId") challengeId: string,
  ) {
    return this.challengeService.getChallengeLeaderboard(challengeId);
  }

  @Post("admin/challenges")
  async adminCreateChallenge(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertAdminRole(request);
    return this.challengeService.adminCreateChallenge(
      parseAdminCreateChallengeBody(body),
    );
  }

  @Put("admin/challenges/:id")
  async adminUpdateChallenge(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertAdminRole(request);
    return this.challengeService.adminUpdateChallenge(
      id,
      parseAdminUpdateChallengeBody(body),
    );
  }

  @Get("admin/challenges")
  async adminListChallenges(@Req() request: AuthenticatedRequest) {
    assertAdminRole(request);
    return this.challengeService.adminListChallenges();
  }

  // ── point shop ─────────────────────────────────────────────────────

  @Get("shop")
  async getShopCatalog() {
    return this.pointShopService.getShopCatalog();
  }

  @Throttle(throttlePayment)
  @Post("shop/:itemId/purchase")
  async purchaseShopItem(
    @Param("itemId") itemId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.pointShopService.purchaseItem(request.auth!.userId, itemId);
  }

  @Get("shop/my-items")
  async getMyShopItems(@Req() request: AuthenticatedRequest) {
    return this.pointShopService.getUserItems(request.auth!.userId);
  }

  // ── activity feed ──────────────────────────────────────────────────

  @Get("activity-feed")
  async getActivityFeed(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.activityFeedService.getActivityFeed(
      request.auth!.userId,
      cursor?.trim() || undefined,
      limit ? Math.min(parseInt(limit, 10) || 20, 50) : 20,
    );
  }

  @Get("activity-feed/me")
  async getOwnActivity(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.activityFeedService.getOwnActivity(
      request.auth!.userId,
      cursor?.trim() || undefined,
      limit ? Math.min(parseInt(limit, 10) || 20, 50) : 20,
    );
  }

  // ── referral affiliate ───────────────────────────────────────────

  @Get("referrals/dashboard")
  async getReferralDashboard(@Req() request: AuthenticatedRequest) {
    return this.referralService.getReferralDashboard(request.auth!.userId);
  }

  @Throttle(throttleWithdrawal)
  @Post("referrals/withdraw")
  async requestReferralWithdrawal(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const amountCents = Number(record?.amountCents);

    if (!amountCents || amountCents <= 0 || !Number.isFinite(amountCents)) {
      throw new ForbiddenException("amountCents must be a positive number.");
    }

    return this.referralService.requestReferralWithdrawal(
      request.auth!.userId,
      Math.floor(amountCents),
    );
  }

  @Get("referrals/earnings")
  async getReferralEarnings(@Req() request: AuthenticatedRequest) {
    return this.referralService.getReferralEarnings(request.auth!.userId);
  }

  // ── Churn Prediction ────────────────────────────────────────────

  @Get("returning-user-check")
  async getReturningUserCheck(@Req() request: AuthenticatedRequest) {
    return (
      (await this.churnPredictionService.getReturningUserIntervention(
        request.auth!.userId,
      )) ?? { interventionId: null }
    );
  }

  @Post("interventions/:id/click")
  async recordInterventionClick(
    @Param("id") id: string,
  ) {
    await this.churnPredictionService.recordInterventionClick(id);
    return { ok: true };
  }

  @Post("interventions/:id/convert")
  async recordInterventionConversion(
    @Param("id") id: string,
  ) {
    await this.churnPredictionService.recordInterventionConversion(id);
    return { ok: true };
  }

  @Get("admin/churn-metrics")
  async getChurnMetrics(@Req() request: AuthenticatedRequest) {
    assertAdminRole(request);
    return this.churnPredictionService.getChurnMetrics();
  }
}
