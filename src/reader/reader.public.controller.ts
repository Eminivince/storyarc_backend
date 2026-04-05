import { Controller, Get, Param, Query } from "@nestjs/common";
import { parseMinRatingQuery, parseReadingListLimitQuery, parseSearchSortQuery, parseStoryCatalogLimitQuery, parseStoryCatalogOffsetQuery, parseStoryRankingKindQuery, parseStoryRankingLimitQuery, parseStoryStatusFilterQuery } from "./reader.schemas";
import { ReaderService } from "./reader.service";
import { StoryRankingsService } from "./story-rankings.service";

@Controller("reader")
export class ReaderPublicController {
  constructor(
    private readonly readerService: ReaderService,
    private readonly storyRankingsService: StoryRankingsService,
  ) {}

  @Get("home")
  async getHomeCatalog() {
    return this.readerService.getHomeCatalog();
  }

  @Get("reading-lists/shared/:shareSlug")
  async getSharedReadingList(@Param("shareSlug") shareSlug: string) {
    return this.readerService.getSharedReadingList(shareSlug);
  }

  /** Per-genre #1 story cover for Explore tiles (must register before `rankings` if routes conflict). */
  @Get("rankings/genre-spotlights")
  async getGenreSpotlightCovers(@Query("kind") kind: string | undefined) {
    return this.storyRankingsService.getGenreSpotlightCovers({
      kind: parseStoryRankingKindQuery(kind),
    });
  }

  @Get("rankings")
  async getStoryRankings(
    @Query("genre") genre: string | undefined,
    @Query("kind") kind: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    return this.storyRankingsService.getStoryRankings({
      genre: genre?.trim() || null,
      kind: parseStoryRankingKindQuery(kind),
      limit: parseStoryRankingLimitQuery(limit),
    });
  }

  @Get("stories")
  async listStories(
    @Query("q") query: string | undefined,
    @Query("genre") genre: string | undefined,
    @Query("tags") tags: string | undefined,
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
  ) {
    return this.readerService.listStories({
      genre,
      limit: parseStoryCatalogLimitQuery(limit),
      offset: parseStoryCatalogOffsetQuery(offset),
      query,
      tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    });
  }

  @Get("search/trending")
  async getTrendingSearches() {
    return this.readerService.getTrendingSearches();
  }

  @Get("search")
  async search(
    @Query("q") query: string | undefined,
    @Query("genre") genre: string | undefined,
    @Query("status") status: string | undefined,
    @Query("minRating") minRating: string | undefined,
    @Query("sort") sort: string | undefined,
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
  ) {
    return this.readerService.search(query, {
      genre: genre?.trim() || undefined,
      limit: parseStoryCatalogLimitQuery(limit),
      minRating: parseMinRatingQuery(minRating),
      offset: parseStoryCatalogOffsetQuery(offset),
      sort: parseSearchSortQuery(sort),
      status: parseStoryStatusFilterQuery(status),
    });
  }

  @Get("public-reading-lists")
  async getPublicReadingLists(
    @Query("q") query: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    return this.readerService.getPublicReadingLists({
      limit: parseReadingListLimitQuery(limit),
      query,
    });
  }
}
