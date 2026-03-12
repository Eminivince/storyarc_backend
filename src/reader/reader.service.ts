import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, StoryStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import {
  ChapterAccessState,
  RequiredPreviousChapter,
  resolveChapterAccessState,
} from "../monetization/chapter-access";
import { MonetizationService } from "../monetization/monetization.service";
import {
  defaultBookPlatformPolicy,
  isStoryLive,
  normalizeConfiguredPremiumWindowHours,
  resolveEffectiveChapterAccess,
} from "../utils/book-admin";
import {
  CreateBookmarkInput,
  UpdateStoryRatingInput,
  UpdateReadingProgressInput,
} from "./reader.types";

type StoryWithReaderRelations = Prisma.StoryGetPayload<{
  include: {
    adminControl: true;
    assets: true;
    publishedChapters: {
      include: {
        adminOverride: true;
        chapter: true;
      };
    };
  };
}>;

type ProgressWithRelations = Prisma.ReadingProgressGetPayload<{
  include: {
    chapter: true;
    story: {
      include: {
        adminControl: true;
        assets: true;
      };
    };
  };
}>;

type StoryRatingEligibility = {
  canRate: boolean;
  hasCompletedStory: boolean;
  hasUnlockedAllChapters: boolean;
  ratingEligibilityMessage: string | null;
};

const homeCreatorBenefits = [
  {
    title: "Creator Studio",
    description:
      "Professional writing environment with world-building wikis and plot organizers.",
  },
  {
    title: "Global Reach",
    description:
      "Instantly distribute your work to a global audience of hungry readers in 15+ languages.",
  },
  {
    title: "Fair Monetization",
    description:
      "From micro-transactions to subscription models, keep up to 85% of your earnings.",
  },
];

@Injectable()
export class ReaderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monetizationService: MonetizationService,
  ) {}

  async getHomeCatalog() {
    const stories = await this.getPublishedStories();

    if (stories.length === 0) {
      return {
        creatorBenefits: homeCreatorBenefits,
        featured: null,
        trendingStories: [],
      };
    }

    const featuredStory =
      stories.find((story) => story.featured) ??
      [...stories].sort((left, right) => right.totalReads - left.totalReads)[0];
    const trendingStories = [...stories].sort(
      (left, right) => right.totalReads - left.totalReads,
    );

    return {
      creatorBenefits: homeCreatorBenefits,
      featured: featuredStory ? this.mapHomeFeaturedStory(featuredStory) : null,
      trendingStories: this.dedupeStoryCards(trendingStories),
    };
  }

  async getDashboard(userId: string) {
    const [profile, stories, continueReading] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { userId },
        select: { selectedGenres: true },
      }),
      this.getPublishedStories(),
      this.getContinueReading(userId),
    ]);

    if (stories.length === 0) {
      return {
        availableGenres: [],
        continueReading: [],
        featured: null,
        rows: [],
      };
    }

    const selectedGenres = profile?.selectedGenres ?? [];
    const normalizedSelectedGenres = selectedGenres.map((genre) =>
      this.normalizeTerm(genre),
    );
    const featuredStory =
      stories.find((story) => story.featured) ??
      [...stories].sort((left, right) => right.totalReads - left.totalReads)[0];

    const genreMatches = stories.filter((story) =>
      story.genreSlugs.some((genreSlug) =>
        normalizedSelectedGenres.includes(this.normalizeTerm(genreSlug)),
      ),
    );

    const trendingStories = [...stories].sort(
      (left, right) => right.totalReads - left.totalReads,
    );
    const freshStories = [...stories].sort((left, right) => {
      const leftValue = left.latestChapterAt?.getTime() ?? 0;
      const rightValue = right.latestChapterAt?.getTime() ?? 0;

      return rightValue - leftValue;
    });

    return {
      availableGenres: Array.from(
        new Set(stories.flatMap((story) => story.genreSlugs.map((slug) => this.slugToLabel(slug)))),
      ),
      continueReading,
      featured: this.mapFeaturedStory(featuredStory),
      rows: [
        {
          id: "for-you",
          title:
            selectedGenres.length > 0
              ? `Because you picked ${selectedGenres[0]}`
              : "Recommended for you",
          stories: this.dedupeStoryCards(genreMatches.length > 0 ? genreMatches : stories),
        },
        {
          id: "trending",
          title: "Trending now",
          stories: this.dedupeStoryCards(trendingStories),
        },
        {
          id: "fresh",
          title: "Fresh chapters",
          stories: this.dedupeStoryCards(freshStories),
        },
      ],
    };
  }

  async listStories(input: { genre?: string; query?: string }) {
    const [stories, genres] = await Promise.all([
      this.getPublishedStories(),
      this.prisma.genre.findMany({
        orderBy: { name: "asc" },
        select: { name: true, slug: true },
      }),
    ]);

    const filteredStories = this.filterStories(stories, input);

    return {
      genres: genres.map((genre) => ({
        label: genre.name,
        slug: genre.slug,
      })),
      stories: filteredStories.map((story) => this.mapStoryCard(story)),
    };
  }

  async search(rawQuery?: string) {
    const query = this.normalizeOptionalQuery(rawQuery);
    const stories = this.filterStories(await this.getPublishedStories(), {
      query,
    });

    const authorMap = new Map<
      string,
      {
        genres: Set<string>;
        name: string;
        storyCount: number;
        totalReads: number;
      }
    >();

    for (const story of stories) {
      const current =
        authorMap.get(story.authorName) ??
        {
          genres: new Set<string>(),
          name: story.authorName,
          storyCount: 0,
          totalReads: 0,
        };

      current.storyCount += 1;
      current.totalReads += story.totalReads;

      for (const genreSlug of story.genreSlugs) {
        current.genres.add(this.slugToLabel(genreSlug));
      }

      authorMap.set(story.authorName, current);
    }

    return {
      authors: Array.from(authorMap.values())
        .sort((left, right) => right.totalReads - left.totalReads)
        .map((author) => ({
          genres: Array.from(author.genres).slice(0, 2),
          name: author.name,
          storyCount: author.storyCount,
          totalReads: author.totalReads,
          totalReadsLabel: this.formatCompactNumber(author.totalReads),
        })),
      query: query ?? "",
      stories: stories.map((story) => this.mapStoryCard(story)),
    };
  }

  async getStoryDetails(userId: string, storySlug: string) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const [{ chapterAccessMap, progress }, bookmarks, storyRating] =
      await Promise.all([
        this.getStoryReaderAccessContext(userId, story),
        this.prisma.bookmark.findMany({
          where: {
            storyId: story.id,
            userId,
          },
          select: {
            publishedChapterId: true,
          },
        }),
        this.prisma.storyRating.findUnique({
          where: {
            userId_storyId: {
              storyId: story.id,
              userId,
            },
          },
          select: {
            rating: true,
          },
        }),
      ]);

    const bookmarkedChapterIds = new Set(
      bookmarks.map(
        (bookmark: { publishedChapterId: string }) => bookmark.publishedChapterId,
      ),
    );
    const firstChapter = story.publishedChapters[0] ?? null;
    const storyControl = this.getStoryControl(story);
    const ratingEligibility = this.getStoryRatingEligibility({
      chapterAccessMap,
      chapters: story.publishedChapters,
      progress,
    });

    return {
      chapters: story.publishedChapters.map((chapter) => {
        const chapterAccess = chapterAccessMap.get(chapter.id);

        return {
          accessState: chapterAccess?.accessState ?? "READABLE",
          chapterNumber: chapter.chapterNumber,
          chapterSlug: chapter.slug,
          isBookmarked: bookmarkedChapterIds.has(chapter.id),
          isCurrent: progress?.publishedChapterId === chapter.id,
          premium: this.getEffectiveChapterPremium(chapter, storyControl),
          publishedAt: chapter.publishedAt,
          publishedAtLabel: this.formatRelativeDate(chapter.publishedAt),
          requiredPreviousChapter: chapterAccess?.requiredPreviousChapter ?? null,
          title: chapter.title,
        };
      }),
      continueReading: progress
        ? {
            chapterSlug: progress.chapter.slug,
            chapterTitle: progress.chapter.title,
            paragraphIndex: progress.paragraphIndex,
            progressPercent: progress.progressPercent,
            resumeLabel: this.getResumeLabel(
              progress.paragraphIndex,
              progress.progressPercent,
            ),
          }
        : null,
      story: {
        authorName: story.authorName,
        chapterCount: story.publishedChapters.length,
        coverImage:
          story.assets?.coverImageUrl ??
          story.assets?.cardImageUrl ??
          story.assets?.bannerImageUrl ??
          "",
        canRate: ratingEligibility.canRate,
        firstChapterSlug: firstChapter?.slug ?? null,
        genres: story.genreSlugs.map((genreSlug) => this.slugToLabel(genreSlug)),
        hasCompletedStory: ratingEligibility.hasCompletedStory,
        hasUnlockedAllChapters: ratingEligibility.hasUnlockedAllChapters,
        maturityRating: story.maturityRating,
        rating: Number(story.averageRating.toFixed(1)),
        ratingEligibilityMessage: ratingEligibility.ratingEligibilityMessage,
        readsCount: story.totalReads,
        readsLabel: this.formatCompactNumber(story.totalReads),
        reviewCount: story.reviewCount,
        shortSynopsis: story.shortSynopsis,
        slug: story.slug,
        status: this.mapStoryStatus(story.status),
        synopsis: story.synopsis,
        tagLabels: story.tagSlugs.map((tagSlug) => this.slugToLabel(tagSlug)),
        title: story.title,
        userRating: storyRating?.rating ?? null,
      },
    };
  }

  async updateStoryRating(
    userId: string,
    storySlug: string,
    input: UpdateStoryRatingInput,
  ) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const [{ progress, chapterAccessMap }, existingRating] = await Promise.all([
      this.getStoryReaderAccessContext(userId, story),
      this.prisma.storyRating.findUnique({
        where: {
          userId_storyId: {
            storyId: story.id,
            userId,
          },
        },
        select: {
          id: true,
          rating: true,
        },
      }),
    ]);
    const ratingEligibility = this.getStoryRatingEligibility({
      chapterAccessMap,
      chapters: story.publishedChapters,
      progress,
    });

    if (!ratingEligibility.canRate) {
      throw new ForbiddenException(
        ratingEligibility.ratingEligibilityMessage ??
          "Finish reading and unlock every published chapter before rating this book.",
      );
    }

    const currentReviewCount = Math.max(
      story.reviewCount,
      existingRating ? 1 : 0,
    );
    const currentWeightedRating = story.averageRating * currentReviewCount;
    const nextReviewCount = existingRating
      ? currentReviewCount
      : currentReviewCount + 1;
    const nextAverageRating =
      nextReviewCount > 0
        ? Number(
            (
              (currentWeightedRating - (existingRating?.rating ?? 0) + input.rating) /
              nextReviewCount
            ).toFixed(4),
          )
        : 0;

    if (existingRating) {
      await this.prisma.storyRating.update({
        where: { id: existingRating.id },
        data: {
          rating: input.rating,
        },
      });
    } else {
      await this.prisma.storyRating.create({
        data: {
          rating: input.rating,
          storyId: story.id,
          userId,
        },
      });
    }

    await this.prisma.story.update({
      where: { id: story.id },
      data: {
        averageRating: nextAverageRating,
        reviewCount: nextReviewCount,
      },
    });

    return {
      story: {
        canRate: true,
        hasCompletedStory: ratingEligibility.hasCompletedStory,
        hasUnlockedAllChapters: ratingEligibility.hasUnlockedAllChapters,
        rating: Number(nextAverageRating.toFixed(1)),
        ratingEligibilityMessage: null,
        reviewCount: nextReviewCount,
        slug: story.slug,
        userRating: input.rating,
      },
    };
  }

  async getChapter(userId: string, storySlug: string, chapterSlug: string) {
    const story = await this.prisma.story.findUnique({
      where: { slug: storySlug },
      include: {
        adminControl: true,
        assets: true,
      },
    });

    if (!story || !this.isReadableStatus(story.status) || !isStoryLive(story)) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = await this.prisma.publishedChapter.findUnique({
      where: {
        storyId_slug: {
          slug: chapterSlug,
          storyId: story.id,
        },
      },
      include: {
        adminOverride: true,
        chapter: true,
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    const [progress, bookmark, previousChapter, nextChapter] = await Promise.all([
      this.prisma.readingProgress.findUnique({
        where: {
          userId_storyId: {
            storyId: story.id,
            userId,
          },
        },
      }),
      this.prisma.bookmark.findUnique({
        where: {
          userId_publishedChapterId: {
            publishedChapterId: chapter.id,
            userId,
          },
        },
      }),
      chapter.chapterNumber > 1
        ? this.prisma.publishedChapter.findUnique({
            where: {
              storyId_chapterNumber: {
                chapterNumber: chapter.chapterNumber - 1,
                storyId: story.id,
              },
            },
            include: {
              adminOverride: true,
              chapter: true,
            },
          })
        : Promise.resolve(null),
      this.prisma.publishedChapter.findFirst({
        where: {
          chapterNumber: {
            gt: chapter.chapterNumber,
          },
          storyId: story.id,
        },
        include: {
          adminOverride: true,
          chapter: true,
        },
        orderBy: {
          chapterNumber: "asc",
        },
      }),
    ]);
    const storyControl = this.getStoryControl(story);
    const effectiveChapter = resolveEffectiveChapterAccess({
      adminOverride: chapter.adminOverride,
      authorCoinUnlockPrice: chapter.chapter?.coinUnlockPrice ?? chapter.coinUnlockPrice,
      authorPremiumEnabled: chapter.chapter?.premiumEnabled ?? chapter.premium,
      globalCoinCap: storyControl.globalCoinCap,
      lockConfiguredAt: chapter.adminOverride?.updatedAt ?? null,
      premiumWindowHours: storyControl.defaultPremiumWindowHours,
      publishedAt: chapter.publishedAt,
      storyLiveAt: storyControl.liveAt,
    });
    const access = await this.monetizationService.getChapterAccessDecision(userId, {
      chapter,
      isChapterPremium: effectiveChapter.isCurrentlyPremium,
      story,
    });
    const isLocked =
      effectiveChapter.isCurrentlyPremium && access.accessState === "UNLOCK_REQUIRED";

    return {
      chapter: {
        accessSource: access.accessSource,
        accessState: access.accessState,
        authorName: story.authorName,
        bookmarkId: bookmark?.id ?? null,
        chapterNumber: chapter.chapterNumber,
        chapterSlug: chapter.slug,
        chapterTitle: chapter.title,
        isBookmarked: Boolean(bookmark),
        isLocked,
        nextChapter:
          nextChapter === null
            ? null
            : {
                chapterNumber: nextChapter.chapterNumber,
                chapterSlug: nextChapter.slug,
                premium: this.getEffectiveChapterPremium(nextChapter, storyControl),
                title: nextChapter.title,
              },
        paragraphIndex:
          progress?.publishedChapterId === chapter.id ? progress.paragraphIndex : 0,
        paragraphs: access.accessState === "READABLE" ? chapter.bodyParagraphs : [],
        premium: effectiveChapter.isCurrentlyPremium,
        previousChapter:
          previousChapter === null
            ? null
            : {
                chapterNumber: previousChapter.chapterNumber,
                chapterSlug: previousChapter.slug,
                premium: this.getEffectiveChapterPremium(previousChapter, storyControl),
                title: previousChapter.title,
              },
        progressPercent:
          progress?.publishedChapterId === chapter.id ? progress.progressPercent : 0,
        publishedAt: chapter.publishedAt,
        readingMinutes:
          chapter.chapter?.readingMinutes ?? this.estimateReadingMinutes(chapter.bodyParagraphs),
        requiredPreviousChapter: access.requiredPreviousChapter,
        unlockPriceCoins: effectiveChapter.effectiveCoinPrice,
      },
      story: {
        coverImage:
          story.assets?.coverImageUrl ??
          story.assets?.cardImageUrl ??
          story.assets?.bannerImageUrl ??
          "",
        slug: story.slug,
        title: story.title,
      },
    };
  }

  async saveProgress(userId: string, input: UpdateReadingProgressInput) {
    const story = await this.prisma.story.findUnique({
      where: { slug: input.storySlug },
      select: {
        adminControl: {
          select: {
            defaultPremiumWindowHours: true,
            globalCoinCap: true,
            lastUpdatedByAdminUserId: true,
          },
        },
        id: true,
        isLive: true,
        liveAt: true,
        status: true,
      },
    });

    if (!story || !this.isReadableStatus(story.status) || !isStoryLive(story)) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = await this.prisma.publishedChapter.findUnique({
      where: {
        storyId_slug: {
          slug: input.chapterSlug,
          storyId: story.id,
        },
      },
      include: {
        adminOverride: true,
        chapter: {
          select: {
            coinUnlockPrice: true,
            premiumEnabled: true,
            readingMinutes: true,
          },
        },
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    const effectiveChapter = resolveEffectiveChapterAccess({
      adminOverride: chapter.adminOverride,
      authorCoinUnlockPrice: chapter.chapter?.coinUnlockPrice ?? chapter.coinUnlockPrice,
      authorPremiumEnabled: chapter.chapter?.premiumEnabled ?? chapter.premium,
      globalCoinCap: this.getStoryControl(story).globalCoinCap,
      lockConfiguredAt: chapter.adminOverride?.updatedAt ?? null,
      premiumWindowHours: this.getStoryControl(story).defaultPremiumWindowHours,
      publishedAt: chapter.publishedAt,
      storyLiveAt: this.getStoryControl(story).liveAt,
    });

    const access = await this.monetizationService.getChapterAccessDecision(userId, {
      chapter,
      isChapterPremium: effectiveChapter.isCurrentlyPremium,
      story,
    });

    if (access.accessState === "SEQUENCE_BLOCKED") {
      throw new ForbiddenException(
        this.getSequentialAccessMessage(access.requiredPreviousChapter),
      );
    }

    if (access.accessState === "UNLOCK_REQUIRED") {
      throw new ForbiddenException(
        `Chapter unlock required. This premium chapter costs ${effectiveChapter.effectiveCoinPrice} coins.`,
      );
    }

    const nextProgressPercent = this.clampProgress(input.progressPercent);
    const nextParagraphIndex = this.clampParagraphIndex(
      input.paragraphIndex,
      chapter.bodyParagraphs.length,
    );
    const now = new Date();
    const existingProgress = await this.prisma.readingProgress.findUnique({
      where: {
        userId_storyId: {
          storyId: story.id,
          userId,
        },
      },
      select: {
        id: true,
      },
    });

    const progress = await this.prisma.readingProgress.upsert({
      where: {
        userId_storyId: {
          storyId: story.id,
          userId,
        },
      },
      update: {
        lastReadAt: now,
        paragraphIndex: nextParagraphIndex,
        progressPercent: nextProgressPercent,
        publishedChapterId: chapter.id,
      },
      create: {
        lastReadAt: now,
        paragraphIndex: nextParagraphIndex,
        progressPercent: nextProgressPercent,
        publishedChapterId: chapter.id,
        storyId: story.id,
        userId,
      },
    });

    if (!existingProgress) {
      await this.prisma.story.update({
        where: { id: story.id },
        data: {
          totalReads: {
            increment: 1,
          },
        },
      });
    }

    const todayRange = this.getDayRange(now);
    const existingReadEvent = await this.prisma.userActivityEvent.findFirst({
      where: {
        happenedAt: {
          gte: todayRange.start,
          lt: todayRange.end,
        },
        referenceId: chapter.id,
        type: "READ_CHAPTER",
        userId,
      },
      select: {
        id: true,
      },
    });

    if (!existingReadEvent && nextProgressPercent >= 50) {
      await this.prisma.userActivityEvent.create({
        data: {
          happenedAt: now,
          numericValue: 1,
          referenceId: chapter.id,
          type: "READ_CHAPTER",
          userId,
        },
      });
    }

    return {
      progress: {
        chapterSlug: chapter.slug,
        chapterTitle: chapter.title,
        paragraphIndex: progress.paragraphIndex,
        progressPercent: progress.progressPercent,
        resumeLabel: this.getResumeLabel(
          progress.paragraphIndex,
          progress.progressPercent,
        ),
        storySlug: input.storySlug,
      },
    };
  }

  async getBookmarks(userId: string) {
    const bookmarks = await this.prisma.bookmark.findMany({
      where: { userId },
      include: {
        chapter: true,
        story: {
          include: {
            adminControl: true,
            assets: true,
          },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    return {
      bookmarks: bookmarks
        .filter((bookmark) => isStoryLive(bookmark.story))
        .map((bookmark) => ({
          bookmarkId: bookmark.id,
          chapterNumber: bookmark.chapter.chapterNumber,
          chapterSlug: bookmark.chapter.slug,
          chapterTitle: bookmark.chapter.title,
          coverImage:
            bookmark.story.assets?.coverImageUrl ??
            bookmark.story.assets?.cardImageUrl ??
            bookmark.story.assets?.bannerImageUrl ??
            "",
          createdAt: bookmark.createdAt,
          storySlug: bookmark.story.slug,
          storyTitle: bookmark.story.title,
        })),
    };
  }

  async createBookmark(userId: string, input: CreateBookmarkInput) {
    const story = await this.prisma.story.findUnique({
      where: { slug: input.storySlug },
      select: {
        adminControl: {
          select: {
            visibilityState: true,
          },
        },
        id: true,
        isLive: true,
        status: true,
      },
    });

    if (!story || !this.isReadableStatus(story.status) || !isStoryLive(story)) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = await this.prisma.publishedChapter.findUnique({
      where: {
        storyId_slug: {
          slug: input.chapterSlug,
          storyId: story.id,
        },
      },
      select: {
        id: true,
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    const bookmark = await this.prisma.bookmark.upsert({
      where: {
        userId_publishedChapterId: {
          publishedChapterId: chapter.id,
          userId,
        },
      },
      update: {},
      create: {
        publishedChapterId: chapter.id,
        storyId: story.id,
        userId,
      },
    });

    await this.prisma.userActivityEvent.create({
      data: {
        happenedAt: new Date(),
        numericValue: 1,
        referenceId: chapter.id,
        type: "BOOKMARK_CHAPTER",
        userId,
      },
    });

    return {
      bookmarkId: bookmark.id,
      message: "Bookmark saved.",
    };
  }

  async removeBookmark(userId: string, bookmarkId: string) {
    const bookmark = await this.prisma.bookmark.findFirst({
      where: {
        id: bookmarkId,
        userId,
      },
      select: { id: true },
    });

    if (!bookmark) {
      throw new NotFoundException("Bookmark not found.");
    }

    await this.prisma.bookmark.delete({
      where: { id: bookmark.id },
    });

    return {
      message: "Bookmark removed.",
    };
  }

  private async getContinueReading(userId: string) {
    const entries = await this.prisma.readingProgress.findMany({
      where: { userId },
      include: {
        chapter: true,
        story: {
          include: {
            adminControl: true,
            assets: true,
          },
        },
      },
      orderBy: {
        lastReadAt: "desc",
      },
      take: 6,
    });

    return entries
      .filter((entry: ProgressWithRelations) => isStoryLive(entry.story))
      .map((entry: ProgressWithRelations) => ({
        chapterLabel: `Chapter ${entry.chapter.chapterNumber}`,
        chapterSlug: entry.chapter.slug,
        chapterTitle: entry.chapter.title,
        coverImage:
          entry.story.assets?.coverImageUrl ??
          entry.story.assets?.cardImageUrl ??
          entry.story.assets?.bannerImageUrl ??
          "",
        paragraphIndex: entry.paragraphIndex,
        progressPercent: entry.progressPercent,
        resumeLabel: this.getResumeLabel(
          entry.paragraphIndex,
          entry.progressPercent,
        ),
        storySlug: entry.story.slug,
        storyTitle: entry.story.title,
      }));
  }

  private async getPublishedStories() {
    const stories = await this.prisma.story.findMany({
      where: {
        status: {
          in: [StoryStatus.PUBLISHED, StoryStatus.COMPLETED, StoryStatus.HIATUS],
        },
      },
      include: {
        adminControl: true,
        assets: true,
        publishedChapters: {
          include: {
            adminOverride: true,
            chapter: true,
          },
          orderBy: {
            chapterNumber: "asc",
          },
        },
      },
      orderBy: [
        {
          featured: "desc",
        },
        {
          totalReads: "desc",
        },
      ],
    });

    return stories.filter((story) => isStoryLive(story));
  }

  private async getReadableStoryBySlug(storySlug: string) {
    const story = await this.prisma.story.findUnique({
      where: { slug: storySlug },
      include: {
        adminControl: true,
        assets: true,
        publishedChapters: {
          include: {
            adminOverride: true,
            chapter: true,
          },
          orderBy: { chapterNumber: "asc" },
        },
      },
    });

    if (!story || !this.isReadableStatus(story.status) || !isStoryLive(story)) {
      throw new NotFoundException("Story not found.");
    }

    return story;
  }

  private async getStoryReaderAccessContext(
    userId: string,
    story: StoryWithReaderRelations,
  ) {
    const chapterIds = story.publishedChapters.map((chapter) => chapter.id);
    const [progress, hasPremiumSubscription, entitlements] = await Promise.all([
      this.prisma.readingProgress.findUnique({
        where: {
          userId_storyId: {
            storyId: story.id,
            userId,
          },
        },
        include: {
          chapter: true,
        },
      }),
      this.monetizationService.hasActiveSubscriptionAccess(userId),
      chapterIds.length === 0
        ? Promise.resolve([])
        : this.prisma.chapterEntitlement.findMany({
            where: {
              publishedChapterId: {
                in: chapterIds,
              },
              userId,
              OR: [
                { expiresAt: null },
                {
                  expiresAt: {
                    gt: new Date(),
                  },
                },
              ],
            },
            select: {
              publishedChapterId: true,
            },
          }),
    ]);

    return {
      chapterAccessMap: this.buildStoryChapterAccessMap({
        chapters: story.publishedChapters,
        entitlements,
        hasPremiumSubscription,
        storyControl: this.getStoryControl(story),
      }),
      progress,
    };
  }

  private getStoryRatingEligibility(input: {
    chapterAccessMap: Map<
      string,
      {
        accessState: ChapterAccessState;
        requiredPreviousChapter: RequiredPreviousChapter;
      }
    >;
    chapters: StoryWithReaderRelations["publishedChapters"];
    progress:
      | Prisma.ReadingProgressGetPayload<{
          include: {
            chapter: true;
          };
        }>
      | null;
  }): StoryRatingEligibility {
    const lastChapter = input.chapters.at(-1) ?? null;
    const hasUnlockedAllChapters =
      input.chapters.length > 0 &&
      input.chapters.every(
        (chapter) =>
          (input.chapterAccessMap.get(chapter.id)?.accessState ?? "READABLE") ===
          "READABLE",
      );
    const hasCompletedStory = Boolean(
      lastChapter &&
        input.progress?.publishedChapterId === lastChapter.id &&
        input.progress.progressPercent >= 100,
    );

    if (input.chapters.length === 0) {
      return {
        canRate: false,
        hasCompletedStory: false,
        hasUnlockedAllChapters: false,
        ratingEligibilityMessage:
          "This book has no published chapters available for rating yet.",
      };
    }

    if (!hasUnlockedAllChapters) {
      return {
        canRate: false,
        hasCompletedStory,
        hasUnlockedAllChapters,
        ratingEligibilityMessage:
          "Unlock access to every published chapter before rating this book.",
      };
    }

    if (!hasCompletedStory) {
      return {
        canRate: false,
        hasCompletedStory,
        hasUnlockedAllChapters,
        ratingEligibilityMessage: lastChapter
          ? `Finish Chapter ${lastChapter.chapterNumber}: ${lastChapter.title} before rating this book.`
          : "Finish reading this book before rating it.",
      };
    }

    return {
      canRate: true,
      hasCompletedStory: true,
      hasUnlockedAllChapters: true,
      ratingEligibilityMessage: null,
    };
  }

  private filterStories(
    stories: StoryWithReaderRelations[],
    input: { genre?: string; query?: string },
  ) {
    const normalizedQuery = this.normalizeOptionalQuery(input.query);
    const normalizedGenre = this.normalizeOptionalQuery(input.genre);

    return stories.filter((story) => {
      if (
        normalizedGenre &&
        !story.genreSlugs.some(
          (genreSlug) =>
            this.normalizeTerm(genreSlug) === normalizedGenre ||
            this.normalizeTerm(this.slugToLabel(genreSlug)) === normalizedGenre,
        )
      ) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const haystack = [
        story.authorName,
        story.shortSynopsis,
        story.synopsis,
        story.title,
        ...story.genreSlugs,
        ...story.tagSlugs,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }

  private getStoryControl(story: {
    adminControl?: {
      defaultPremiumWindowHours: number;
      globalCoinCap: number;
      lastUpdatedByAdminUserId?: string | null;
    } | null;
    liveAt?: Date | null;
  }) {
    return {
      defaultPremiumWindowHours: normalizeConfiguredPremiumWindowHours(
        story.adminControl?.defaultPremiumWindowHours,
        story.adminControl?.lastUpdatedByAdminUserId ?? null,
      ),
      globalCoinCap:
        story.adminControl?.globalCoinCap ?? defaultBookPlatformPolicy.defaultCoinCap,
      liveAt: story.liveAt ?? null,
    };
  }

  private buildStoryChapterAccessMap(input: {
    chapters: StoryWithReaderRelations["publishedChapters"];
    entitlements: Array<{
      publishedChapterId: string;
    }>;
    hasPremiumSubscription: boolean;
    storyControl: {
      defaultPremiumWindowHours: number;
      globalCoinCap: number;
      liveAt: Date | null;
    };
  }) {
    const entitlementsByChapterId = new Set(
      input.entitlements.map((item) => item.publishedChapterId),
    );
    const chapterByNumber = new Map(
      input.chapters.map((chapter) => [chapter.chapterNumber, chapter] as const),
    );
    const accessMap = new Map<
      string,
      {
        accessState: ChapterAccessState;
        requiredPreviousChapter: RequiredPreviousChapter;
      }
    >();

    for (const chapter of input.chapters) {
      const previousChapter = chapterByNumber.get(chapter.chapterNumber - 1) ?? null;
      const previousChapterAccess = previousChapter
        ? accessMap.get(previousChapter.id)
        : null;
      const previousChapterAccessible = previousChapter
        ? previousChapterAccess?.accessState === "READABLE"
        : true;
      const requiredPreviousChapter = previousChapterAccessible
        ? null
        : {
            chapterNumber: previousChapter!.chapterNumber,
            chapterSlug: previousChapter!.slug,
            title: previousChapter!.title,
          };
      const chapterIsPremium = this.getEffectiveChapterPremium(
        chapter,
        input.storyControl,
      );
      const accessDecision = resolveChapterAccessState({
        hasChapterEntitlement: entitlementsByChapterId.has(chapter.id),
        hasPremiumSubscription: input.hasPremiumSubscription,
        isChapterPremium: chapterIsPremium,
        previousChapterAccessible,
        requiredPreviousChapter,
      });

      accessMap.set(chapter.id, {
        accessState: accessDecision.accessState,
        requiredPreviousChapter: accessDecision.requiredPreviousChapter,
      });
    }

    return accessMap;
  }

  private getSequentialAccessMessage(
    requiredPreviousChapter: RequiredPreviousChapter,
  ) {
    if (!requiredPreviousChapter) {
      return "You need to unlock the previous chapter before continuing.";
    }

    return `Continue with Chapter ${requiredPreviousChapter.chapterNumber}: ${requiredPreviousChapter.title} before opening this chapter.`;
  }

  private getEffectiveChapterPremium(
    chapter: {
      adminOverride?: {
        coinPriceOverride?: number | null;
        lockedOverride?: boolean | null;
        overrideEnabled?: boolean | null;
        premiumWindowHoursOverride?: number | null;
        updatedAt?: Date | null;
      } | null;
      chapter?: {
        coinUnlockPrice?: number | null;
        premiumEnabled?: boolean | null;
      } | null;
      coinUnlockPrice: number;
      premium: boolean;
      publishedAt: Date;
    },
    storyControl: {
      defaultPremiumWindowHours: number;
      globalCoinCap: number;
      liveAt: Date | null;
    },
  ) {
    return resolveEffectiveChapterAccess({
      adminOverride: chapter.adminOverride,
      authorCoinUnlockPrice: chapter.chapter?.coinUnlockPrice ?? chapter.coinUnlockPrice,
      authorPremiumEnabled: chapter.chapter?.premiumEnabled ?? chapter.premium,
      globalCoinCap: storyControl.globalCoinCap,
      lockConfiguredAt: chapter.adminOverride?.updatedAt ?? null,
      premiumWindowHours: storyControl.defaultPremiumWindowHours,
      publishedAt: chapter.publishedAt,
      storyLiveAt: storyControl.liveAt,
    }).isCurrentlyPremium;
  }

  private dedupeStoryCards(stories: StoryWithReaderRelations[]) {
    const seen = new Set<string>();

    return stories
      .filter((story) => {
        if (seen.has(story.slug)) {
          return false;
        }

        seen.add(story.slug);
        return true;
      })
      .slice(0, 6)
      .map((story) => this.mapStoryCard(story));
  }

  private mapFeaturedStory(story: StoryWithReaderRelations) {
    const firstChapter = story.publishedChapters[0] ?? null;

    return {
      authorName: story.authorName,
      bannerImage:
        story.assets?.bannerImageUrl ??
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        "",
      firstChapterSlug: firstChapter?.slug ?? null,
      genres: story.genreSlugs.map((genreSlug) => this.slugToLabel(genreSlug)),
      shortSynopsis: story.shortSynopsis,
      slug: story.slug,
      title: story.title,
    };
  }

  private mapHomeFeaturedStory(story: StoryWithReaderRelations) {
    const firstChapter = story.publishedChapters[0] ?? null;

    return {
      authorName: story.authorName,
      averageRating: Number(story.averageRating.toFixed(1)),
      bannerImage:
        story.assets?.bannerImageUrl ??
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        "",
      coverImage:
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        story.assets?.bannerImageUrl ??
        "",
      firstChapterSlug: firstChapter?.slug ?? null,
      genres: story.genreSlugs.map((genreSlug) => this.slugToLabel(genreSlug)),
      readsLabel: this.formatCompactNumber(story.totalReads),
      shortSynopsis: story.shortSynopsis,
      slug: story.slug,
      statusLabel: this.mapStoryStatus(story.status),
      title: story.title,
    };
  }

  private mapStoryCard(story: StoryWithReaderRelations) {
    const firstChapter = story.publishedChapters[0] ?? null;

    return {
      authorName: story.authorName,
      averageRating: Number(story.averageRating.toFixed(1)),
      chapterCount: story.publishedChapters.length,
      coverImage:
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        story.assets?.bannerImageUrl ??
        "",
      firstChapterSlug: firstChapter?.slug ?? null,
      genreLabel: this.slugToLabel(story.genreSlugs[0] ?? "story"),
      readsCount: story.totalReads,
      readsLabel: this.formatCompactNumber(story.totalReads),
      shortSynopsis: story.shortSynopsis,
      slug: story.slug,
      statusLabel: this.mapStoryStatus(story.status),
      tagLabels: story.tagSlugs.map((tagSlug) => this.slugToLabel(tagSlug)),
      title: story.title,
    };
  }

  private isReadableStatus(status: StoryStatus) {
    return (
      status === StoryStatus.PUBLISHED ||
      status === StoryStatus.COMPLETED ||
      status === StoryStatus.HIATUS
    );
  }

  private mapStoryStatus(status: StoryStatus) {
    if (status === StoryStatus.COMPLETED) {
      return "Complete";
    }

    if (status === StoryStatus.HIATUS) {
      return "Hiatus";
    }

    if (status === StoryStatus.DRAFT) {
      return "Draft";
    }

    return "Ongoing";
  }

  private normalizeOptionalQuery(value?: string | null) {
    if (!value) {
      return undefined;
    }

    const normalized = this.normalizeTerm(value);

    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeTerm(value: string) {
    return value.trim().toLowerCase();
  }

  private estimateReadingMinutes(paragraphs: string[]) {
    const words = paragraphs.join(" ").trim().split(/\s+/).filter(Boolean).length;

    return Math.max(1, Math.ceil(words / 220));
  }

  private slugToLabel(value: string) {
    return value
      .split(/[-_]/g)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
  }

  private formatCompactNumber(value: number) {
    return new Intl.NumberFormat("en", {
      maximumFractionDigits: value >= 100_000 ? 0 : 1,
      notation: "compact",
    }).format(value);
  }

  private formatRelativeDate(value: Date) {
    const diffInMs = Date.now() - value.getTime();
    const diffInDays = Math.max(1, Math.floor(diffInMs / (24 * 60 * 60 * 1000)));

    if (diffInDays === 1) {
      return "Updated 1 day ago";
    }

    if (diffInDays < 7) {
      return `Updated ${diffInDays} days ago`;
    }

    const diffInWeeks = Math.max(1, Math.floor(diffInDays / 7));

    if (diffInWeeks === 1) {
      return "Updated 1 week ago";
    }

    return `Updated ${diffInWeeks} weeks ago`;
  }

  private getDayRange(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    return {
      end,
      start,
    };
  }

  private clampProgress(value: number) {
    if (!Number.isFinite(value)) {
      throw new BadRequestException("progressPercent must be a valid number.");
    }

    return Math.min(100, Math.max(0, Math.round(value)));
  }

  private clampParagraphIndex(value: number, paragraphCount: number) {
    if (!Number.isFinite(value)) {
      throw new BadRequestException("paragraphIndex must be a valid number.");
    }

    if (paragraphCount <= 0) {
      return 0;
    }

    return Math.min(Math.max(0, Math.round(value)), paragraphCount - 1);
  }

  private getResumeLabel(paragraphIndex: number, progressPercent: number) {
    if (progressPercent >= 100) {
      return "Completed";
    }

    if (paragraphIndex <= 0) {
      return "Resume from the beginning";
    }

    return `Resume from paragraph ${paragraphIndex + 1}`;
  }
}
