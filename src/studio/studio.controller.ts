import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { CreatorAnalyticsService } from "../analytics/creator-analytics.service";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { RegisteredUserGuard } from "../common/guards/registered-user.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseStudioAnalyticsQuery,
  parseStudioChapterDraftBody,
  parseStudioCoverUploadBody,
  parseStudioStoryListLimitQuery,
  parseStudioStoryListOffsetQuery,
  parseStudioPublishBody,
  parseStudioStoryBody,
  parseStudioStructureBody,
} from "./studio.schemas";
import { StudioService } from "./studio.service";

function assertStudioAccess(request: AuthenticatedRequest) {
  if (request.auth?.role !== "CREATOR" && request.auth?.role !== "ADMIN") {
    throw new ForbiddenException("Creator access is required.");
  }
}

@Controller("studio")
@UseGuards(AccessTokenGuard, RegisteredUserGuard)
export class StudioController {
  constructor(
    private readonly studioService: StudioService,
    private readonly creatorAnalyticsService: CreatorAnalyticsService,
  ) {}

  @Get("stories")
  async listStories(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.listStories(request.auth!.userId, {
      limit: parseStudioStoryListLimitQuery(limit),
      offset: parseStudioStoryListOffsetQuery(offset),
    });
  }

  @Get("analytics")
  async getAnalytics(
    @Query("days") days: string | undefined,
    @Query("storySlug") storySlug: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.creatorAnalyticsService.getCreatorDashboardAnalytics(
      request.auth!.userId,
      parseStudioAnalyticsQuery(days, storySlug),
    );
  }

  @Get("stories/:storySlug")
  async getStory(
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.getStory(request.auth!.userId, storySlug);
  }

  @Post("stories")
  async createStory(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    assertStudioAccess(request);

    return this.studioService.createStory(
      request.auth!.userId,
      parseStudioStoryBody(body),
    );
  }

  @Patch("stories/:storySlug")
  async updateStory(
    @Param("storySlug") storySlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.updateStory(
      request.auth!.userId,
      storySlug,
      parseStudioStoryBody(body),
    );
  }

  @Put("stories/:storySlug/chapters/draft")
  async saveChapterDraft(
    @Param("storySlug") storySlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.saveChapterDraft(
      request.auth!.userId,
      storySlug,
      parseStudioChapterDraftBody(body),
    );
  }

  @Get("stories/:storySlug/chapters/:chapterId")
  async getChapterDraft(
    @Param("storySlug") storySlug: string,
    @Param("chapterId") chapterId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.getChapterDraft(
      request.auth!.userId,
      storySlug,
      chapterId,
    );
  }

  @Post("chapters/:chapterId/publish")
  async publishChapter(
    @Param("chapterId") chapterId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.publishChapter(
      request.auth!.userId,
      chapterId,
      parseStudioPublishBody(body),
    );
  }

  @Put("stories/:storySlug/structure")
  async saveStructure(
    @Param("storySlug") storySlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.saveStructure(
      request.auth!.userId,
      storySlug,
      parseStudioStructureBody(body),
    );
  }

  @Post("covers")
  async uploadCover(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    assertStudioAccess(request);

    return this.studioService.uploadCover(parseStudioCoverUploadBody(body));
  }

  @Delete("stories/:storySlug")
  async deleteStory(
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.deleteStory(request.auth!.userId, storySlug);
  }

  @Put("stories/:storySlug/chapters/reorder")
  async reorderChapters(
    @Param("storySlug") storySlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    const record = body as Record<string, unknown>;
    const chapterIds = record.chapterIds;

    if (!Array.isArray(chapterIds) || !chapterIds.every((id) => typeof id === "string")) {
      throw new ForbiddenException("chapterIds must be an array of strings.");
    }

    return this.studioService.reorderChapters(
      request.auth!.userId,
      storySlug,
      chapterIds as string[],
    );
  }

  @Post("stories/:storySlug/chapters/:chapterId/bin")
  async moveChapterToBin(
    @Param("storySlug") storySlug: string,
    @Param("chapterId") chapterId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.moveChapterToStudioBin(
      request.auth!.userId,
      storySlug,
      chapterId,
    );
  }

  @Post("stories/:storySlug/chapters/:chapterId/restore")
  async restoreChapterFromBin(
    @Param("storySlug") storySlug: string,
    @Param("chapterId") chapterId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    return this.studioService.restoreChapterFromStudioBin(
      request.auth!.userId,
      storySlug,
      chapterId,
    );
  }

  @Post("stories/:storySlug/chapters/bulk-action")
  async bulkChapterAction(
    @Param("storySlug") storySlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertStudioAccess(request);

    const record = body as Record<string, unknown>;
    const chapterIds = record.chapterIds;
    const action = record.action;

    if (!Array.isArray(chapterIds) || !chapterIds.every((id) => typeof id === "string")) {
      throw new ForbiddenException("chapterIds must be an array of strings.");
    }

    if (typeof action !== "string") {
      throw new ForbiddenException("action must be a string.");
    }

    return this.studioService.bulkChapterAction(
      request.auth!.userId,
      storySlug,
      chapterIds as string[],
      action,
    );
  }
}
