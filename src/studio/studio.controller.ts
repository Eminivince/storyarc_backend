import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseStudioChapterDraftBody,
  parseStudioCoverUploadBody,
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
@UseGuards(AccessTokenGuard)
export class StudioController {
  constructor(private readonly studioService: StudioService) {}

  @Get("stories")
  async listStories(@Req() request: AuthenticatedRequest) {
    assertStudioAccess(request);

    return this.studioService.listStories(request.auth!.userId);
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
}
