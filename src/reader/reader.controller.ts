import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Put,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseAddStoryToReadingListBody,
  parseCommentSortQuery,
  parseCreateCommentBody,
  parseCreateBookmarkBody,
  parseCreateReadingListBody,
  parseReviewLimitQuery,
  parseReviewSortQuery,
  parseUpsertReviewBody,
  parseUpdateCommentBody,
  parseUpdateReadingListBody,
  parseUpdateStoryRatingBody,
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

  @Get("dashboard/personalization")
  async getDashboardPersonalization(@Req() request: AuthenticatedRequest) {
    return this.readerService.getDashboardPersonalization(request.auth!.userId);
  }

  @Get("dashboard/shelf/:shelfId")
  async getDashboardShelf(
    @Param("shelfId") shelfId: string,
    @Query("limit") limitRaw: string | undefined,
    @Query("offset") offsetRaw: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const parsedLimit = Number.parseInt(limitRaw ?? "10", 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;
    const parsedOffset = Number.parseInt(offsetRaw ?? "0", 10);
    const offset = Number.isFinite(parsedOffset) ? parsedOffset : 0;

    return this.readerService.getDashboardShelf(
      request.auth!.userId,
      shelfId,
      offset,
      limit,
    );
  }

  @Get("library/reading")
  async getLibraryReading(
    @Query("limit") limitRaw: string | undefined,
    @Query("offset") offsetRaw: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const parsedLimit = Number.parseInt(limitRaw ?? "48", 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 48;
    const parsedOffset = Number.parseInt(offsetRaw ?? "0", 10);
    const offset = Number.isFinite(parsedOffset) ? parsedOffset : 0;

    return this.readerService.getLibraryReadingProgress(
      request.auth!.userId,
      limit,
      offset,
    );
  }

  @Get("following")
  async getFollowingFeed(@Req() request: AuthenticatedRequest) {
    return this.readerService.getFollowingFeed(request.auth!.userId);
  }

  @Get("stories/:storySlug")
  async getStoryDetails(
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.getStoryDetails(request.auth!.userId, storySlug);
  }

  @Get("stories/:storySlug/reviews")
  async getStoryReviews(
    @Param("storySlug") storySlug: string,
    @Query("sort") sort: string | undefined,
    @Query("limit") limit: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.getStoryReviews(
      request.auth!.userId,
      storySlug,
      {
        limit: parseReviewLimitQuery(limit),
        sort: parseReviewSortQuery(sort),
      },
    );
  }

  @Put("stories/:storySlug/review")
  async upsertStoryReview(
    @Param("storySlug") storySlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.upsertStoryReview(
      request.auth!.userId,
      storySlug,
      parseUpsertReviewBody(body),
    );
  }

  @Delete("stories/:storySlug/review")
  async deleteStoryReview(
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.deleteStoryReview(request.auth!.userId, storySlug);
  }

  @Post("stories/:storySlug/follow")
  async followStory(
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.followStory(request.auth!.userId, storySlug);
  }

  @Delete("stories/:storySlug/follow")
  async unfollowStory(
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.unfollowStory(request.auth!.userId, storySlug);
  }

  @Post("authors/:authorId/follow")
  async followAuthor(
    @Param("authorId") authorId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.followAuthor(request.auth!.userId, authorId);
  }

  @Delete("authors/:authorId/follow")
  async unfollowAuthor(
    @Param("authorId") authorId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.unfollowAuthor(request.auth!.userId, authorId);
  }

  @Put("stories/:storySlug/rating")
  async updateStoryRating(
    @Param("storySlug") storySlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.updateStoryRating(
      request.auth!.userId,
      storySlug,
      parseUpdateStoryRatingBody(body),
    );
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

  @Get("stories/:storySlug/chapters/:chapterSlug/completion-stats")
  async getChapterCompletionStats(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.getChapterCompletionStats(
      request.auth!.userId,
      storySlug,
      chapterSlug,
    );
  }

  @Get("stories/:storySlug/chapters/:chapterSlug/comments")
  async getChapterComments(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Query("sort") sort: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.getChapterComments(
      request.auth!.userId,
      storySlug,
      chapterSlug,
      parseCommentSortQuery(sort),
    );
  }

  @Post("stories/:storySlug/chapters/:chapterSlug/comments")
  async createComment(
    @Param("storySlug") storySlug: string,
    @Param("chapterSlug") chapterSlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.createComment(
      request.auth!.userId,
      storySlug,
      chapterSlug,
      parseCreateCommentBody(body),
    );
  }

  @Put("comments/:commentId")
  async updateComment(
    @Param("commentId") commentId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.updateComment(
      request.auth!.userId,
      commentId,
      parseUpdateCommentBody(body),
    );
  }

  @Delete("comments/:commentId")
  async deleteComment(
    @Param("commentId") commentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.deleteComment(request.auth!.userId, commentId);
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

  @Get("reading-lists")
  async getReadingLists(@Req() request: AuthenticatedRequest) {
    return this.readerService.getReadingLists(request.auth!.userId);
  }

  @Get("reading-lists/:listId")
  async getReadingListDetails(
    @Param("listId") listId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.getReadingListDetails(request.auth!.userId, listId);
  }

  @Post("reading-lists")
  async createReadingList(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.createReadingList(
      request.auth!.userId,
      parseCreateReadingListBody(body),
    );
  }

  @Put("reading-lists/:listId")
  async updateReadingList(
    @Param("listId") listId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.updateReadingList(
      request.auth!.userId,
      listId,
      parseUpdateReadingListBody(body),
    );
  }

  @Delete("reading-lists/:listId")
  async deleteReadingList(
    @Param("listId") listId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.deleteReadingList(request.auth!.userId, listId);
  }

  @Post("reading-lists/:listId/stories")
  async addStoryToReadingList(
    @Param("listId") listId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.addStoryToReadingList(
      request.auth!.userId,
      listId,
      parseAddStoryToReadingListBody(body),
    );
  }

  @Delete("reading-lists/:listId/stories/:storySlug")
  async removeStoryFromReadingList(
    @Param("listId") listId: string,
    @Param("storySlug") storySlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.removeStoryFromReadingList(
      request.auth!.userId,
      listId,
      storySlug,
    );
  }

  @Post("reading-lists/:listId/regenerate-share-slug")
  async regenerateReadingListShareSlug(
    @Param("listId") listId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.regenerateReadingListShareSlug(
      request.auth!.userId,
      listId,
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

  @Post("reviews/:reviewId/vote")
  async voteOnReview(
    @Param("reviewId") reviewId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const helpful = record.helpful === true;
    return this.readerService.voteOnReview(
      request.auth!.userId,
      reviewId,
      helpful,
    );
  }

  @Get("bookmark-folders")
  async listBookmarkFolders(@Req() request: AuthenticatedRequest) {
    return this.readerService.listBookmarkFolders(request.auth!.userId);
  }

  @Post("bookmark-folders")
  async createBookmarkFolder(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    return this.readerService.createBookmarkFolder(request.auth!.userId, name);
  }

  @Delete("bookmark-folders/:folderId")
  async deleteBookmarkFolder(
    @Param("folderId") folderId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.readerService.deleteBookmarkFolder(request.auth!.userId, folderId);
  }

  @Patch("bookmarks/:bookmarkId/folder")
  async moveBookmarkToFolder(
    @Param("bookmarkId") bookmarkId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const folderId = typeof record.folderId === "string" ? record.folderId : null;
    return this.readerService.moveBookmarkToFolder(
      request.auth!.userId,
      bookmarkId,
      folderId,
    );
  }
}
