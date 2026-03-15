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
}
