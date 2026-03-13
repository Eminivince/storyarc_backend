import { Controller, Get, Param, Query } from "@nestjs/common";
import { ReaderService } from "./reader.service";
import { parseReadingListLimitQuery } from "./reader.schemas";

@Controller("reader")
export class ReaderPublicController {
  constructor(private readonly readerService: ReaderService) {}

  @Get("home")
  async getHomeCatalog() {
    return this.readerService.getHomeCatalog();
  }

  @Get("reading-lists/shared/:shareSlug")
  async getSharedReadingList(@Param("shareSlug") shareSlug: string) {
    return this.readerService.getSharedReadingList(shareSlug);
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
