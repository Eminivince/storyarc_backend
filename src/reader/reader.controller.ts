import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseCreateBookmarkBody,
  parseUpdateReadingProgressBody,
} from "./reader.schemas";
import { ReaderService } from "./reader.service";

@Controller("reader")
@UseGuards(AccessTokenGuard)
export class ReaderController {
  constructor(private readonly readerService: ReaderService) {}

  @Get("dashboard")
  async getDashboard(@Req() request: AuthenticatedRequest) {
    return this.readerService.getDashboard(request.auth!.userId);
  }

  @Get("stories")
  async listStories(
    @Query("q") query: string | undefined,
    @Query("genre") genre: string | undefined,
  ) {
    return this.readerService.listStories({
      genre,
      query,
    });
  }

  @Get("search")
  async search(@Query("q") query: string | undefined) {
    return this.readerService.search(query);
  }

  @Get("stories/:storySlug")
  async getStoryDetails(
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.getStoryDetails(request.auth!.userId, storySlug);
  }

  @Get("stories/:storySlug/chapters/:chapterSlug")
  async getChapter(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.getChapter(
      request.auth!.userId,
      storySlug,
      chapterSlug,
    );
  }

  @Put("progress")
  async saveProgress(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.saveProgress(
      request.auth!.userId,
      parseUpdateReadingProgressBody(body),
    );
  }

  @Get("bookmarks")
  async getBookmarks(@Req() request: AuthenticatedRequest) {
    return this.readerService.getBookmarks(request.auth!.userId);
  }

  @Post("bookmarks")
  async createBookmark(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.createBookmark(
      request.auth!.userId,
      parseCreateBookmarkBody(body),
    );
  }

  @Delete("bookmarks/:bookmarkId")
  async removeBookmark(
    @Param("bookmarkId") bookmarkId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.removeBookmark(request.auth!.userId, bookmarkId);
  }
}
