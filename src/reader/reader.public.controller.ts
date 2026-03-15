import { Controller, Get, Param, Query } from "@nestjs/common";
import { parseReadingListLimitQuery, parseStoryCatalogLimitQuery, parseStoryCatalogOffsetQuery, parseStoryRankingKindQuery, parseStoryRankingLimitQuery } from "./reader.schemas";
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
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
  ) {
    return this.readerService.listStories({
      genre,
      limit: parseStoryCatalogLimitQuery(limit),
      offset: parseStoryCatalogOffsetQuery(offset),
      query,
    });
  }

  @Get("search")
  async search(
    @Query("q") query: string | undefined,
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
  ) {
    return this.readerService.search(query, {
      limit: parseStoryCatalogLimitQuery(limit),
      offset: parseStoryCatalogOffsetQuery(offset),
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
