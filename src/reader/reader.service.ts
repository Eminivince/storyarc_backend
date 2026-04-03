import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import {
  AdminBookVisibilityState,
  CommentStatus,
  FollowTargetType,
  Prisma,
  ReadingListVisibility,
  ReviewStatus,
  StoryStatus,
  UserStatus,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { CreatorAnalyticsService } from "../analytics/creator-analytics.service";
import { ActivityFeedService } from "../engagement/activity-feed.service";
import { BadgeEvaluationService } from "../engagement/badge-evaluation.service";
import { ChallengeService } from "../engagement/challenge.service";
import { EngagementService } from "../engagement/engagement.service";
import { RedisService } from "../redis/redis.service";
import {
  ChapterAccessState,
  RequiredPreviousChapter,
  resolveChapterAccessState,
} from "../monetization/chapter-access";
import { MonetizationService } from "../monetization/monetization.service";
import {
  labelFromGenreOrTagSlug,
  sortGenresForReaderDisplay,
} from "../catalog/story-genres";
import {
  buildDashboardPromoCarousel,
  loadPromoSlidesFromDb,
  parsePromoCarouselFromEnv,
} from "./dashboard-promo-carousel";
import { parseFloatingPromosFromEnv } from "./reader-floating-promo";
import {
  defaultBookPlatformPolicy,
  getStoryVisibilityState,
  isStoryLive,
  normalizeConfiguredPremiumWindowHours,
  resolveEffectiveChapterAccess,
} from "../utils/book-admin";
import { richTextToPlainText } from "../utils/rich-text";
import {
  AddStoryToReadingListInput,
  CommentSort,
  CreateCommentInput,
  CreateBookmarkInput,
  CreateReadingListInput,
  ReaderCommentNode,
  ReviewSort,
  UpsertReviewInput,
  UpdateCommentInput,
  UpdateReadingListInput,
  UpdateStoryRatingInput,
  UpdateReadingProgressInput,
} from "./reader.types";

/**
 * Story + chapters for reader APIs. Omits `PublishedChapter.bodyParagraphs` and `Chapter.bodyDraft`
 * so story detail / access checks stay fast for long books (those fields are loaded in `getChapter`).
 */
const readableStoryForReaderInclude = {
  adminControl: true,
  assets: true,
  volumes: {
    orderBy: { sortOrder: "asc" as const },
    select: {
      id: true,
      number: true,
      title: true,
    },
  },
  publishedChapters: {
    orderBy: { chapterNumber: "asc" as const },
    select: {
      id: true,
      storyId: true,
      chapterId: true,
      slug: true,
      title: true,
      chapterNumber: true,
      premium: true,
      coinUnlockPrice: true,
      publishedAt: true,
      adminOverride: true,
      chapter: {
        select: {
          coinUnlockPrice: true,
          premiumEnabled: true,
          volumeId: true,
          wordCount: true,
        },
      },
    },
  },
} satisfies Prisma.StoryInclude;

type StoryWithReaderRelations = Prisma.StoryGetPayload<{
  include: typeof readableStoryForReaderInclude;
}>;

const publishedStoryCatalogSelect = {
  id: true,
  slug: true,
  title: true,
  shortSynopsis: true,
  synopsis: true,
  authorId: true,
  authorName: true,
  status: true,
  isLive: true,
  liveAt: true,
  featured: true,
  genreSlugs: true,
  tagSlugs: true,
  totalReads: true,
  averageRating: true,
  reviewCount: true,
  publishedAt: true,
  latestChapterAt: true,
  createdAt: true,
  adminControl: {
    select: {
      visibilityState: true,
    },
  },
  assets: {
    select: {
      bannerImageUrl: true,
      cardImageUrl: true,
      coverImageUrl: true,
    },
  },
  publishedChapters: {
    orderBy: {
      chapterNumber: "asc" as const,
    },
    select: {
      chapterNumber: true,
      publishedAt: true,
      slug: true,
      title: true,
    },
    take: 1,
  },
  _count: {
    select: {
      publishedChapters: true,
    },
  },
} satisfies Prisma.StorySelect;

type PublishedStoryCatalogRecord = Prisma.StoryGetPayload<{
  select: typeof publishedStoryCatalogSelect;
}>;

type CachedPublishedChapterRecord = {
  chapterNumber: number;
  publishedAt: number;
  slug: string;
  title: string;
};

type CachedPublishedStoryCatalogRecord = Omit<
  PublishedStoryCatalogRecord,
  "createdAt" | "publishedAt" | "latestChapterAt" | "liveAt" | "publishedChapters"
> & {
  createdAt: number;
  publishedAt: number | null;
  latestChapterAt: number | null;
  liveAt: number | null;
  publishedChapters: CachedPublishedChapterRecord[];
};

type StoryCardSource = {
  adminControl?: {
    visibilityState?: AdminBookVisibilityState | null;
  } | null;
  assets?: {
    bannerImageUrl?: string | null;
    cardImageUrl?: string | null;
    coverImageUrl?: string | null;
  } | null;
  authorId?: string | null;
  authorName: string;
  averageRating: number;
  createdAt: Date;
  featured?: boolean;
  genreSlugs: string[];
  id: string;
  isLive?: boolean | null;
  latestChapterAt?: Date | null;
  liveAt?: Date | null;
  publishedAt?: Date | null;
  publishedChapters: Array<{
    chapterNumber: number;
    publishedAt?: Date;
    slug: string;
    title?: string;
  }>;
  reviewCount: number;
  shortSynopsis: string;
  slug: string;
  status: StoryStatus;
  synopsis: string;
  tagSlugs: string[];
  title: string;
  totalReads: number;
  _count?: {
    publishedChapters: number;
  };
};

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

type FollowWithTargets = Prisma.FollowGetPayload<{
  include: {
    story: {
      include: {
        adminControl: true;
        assets: true;
        publishedChapters: {
          orderBy: {
            publishedAt: "desc";
          };
          take: 1;
        };
      };
    };
    targetUser: {
      include: {
        profile: true;
      };
    };
  };
}>;

type CommentWithAuthor = Prisma.CommentGetPayload<{
  include: {
    user: {
      include: {
        profile: true;
      };
    };
  };
}>;

type ReviewWithAuthor = Prisma.ReviewGetPayload<{
  include: {
    user: {
      include: {
        profile: true;
      };
    };
  };
}>;

type ReadingListWithItems = Prisma.ReadingListGetPayload<{
  include: {
    user: {
      include: {
        profile: true;
      };
    };
    items: {
      orderBy: {
        addedAt: "desc";
      };
      include: {
        story: {
          include: {
            adminControl: true;
            assets: true;
            publishedChapters: {
              include: {
                adminOverride: true;
                chapter: true;
              };
              orderBy: {
                chapterNumber: "asc";
              };
            };
          };
        };
      };
    };
  };
}>;

type ReadingListProgressWithChapter = Prisma.ReadingProgressGetPayload<{
  include: {
    chapter: true;
  };
}>;

type StoryRatingEligibility = {
  canRate: boolean;
  hasCompletedStory: boolean;
  hasUnlockedAllChapters: boolean;
  ratingEligibilityMessage: string | null;
};

type RecommendationSignalSnapshot = {
  authorFollows: Array<{ targetUserId: string | null }>;
  bookmarks: Array<{ storyId: string | null }>;
  follows: Array<{ storyId: string | null }>;
  ratings: Array<{ rating: number; storyId: string | null }>;
  readingListItems: Array<{ storyId: string | null }>;
  readingProgress: Array<{ progressPercent: number; storyId: string | null }>;
  reviews: Array<{ rating: number; storyId: string | null }>;
  selectedGenres: string[];
};

const RECOMMENDATION_SIGNAL_CACHE_TTL_SECONDS = 45 * 60;
const HOME_CATALOG_CACHE_TTL_SECONDS = 5 * 60;
const PUBLISHED_STORY_METADATA_CACHE_TTL_SECONDS = 60 * 60;

/** Matches dashboard row preview size (dedupeStoryCards default). */
const DASHBOARD_PREVIEW_ROW_LIMIT = 6;
/** Matches admin cap on `LimitedOffer` rows; reader returns at most this many active window offers. */
const DASHBOARD_LIMITED_OFFERS_MAX = 6;

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
    private readonly engagementService: EngagementService,
    private readonly activityFeedService: ActivityFeedService,
    private readonly badgeEvaluationService: BadgeEvaluationService,
    private readonly challengeService: ChallengeService,
    private readonly creatorAnalyticsService: CreatorAnalyticsService,
    private readonly redisService: RedisService,
  ) {}

  async getHomeCatalog() {
    const stories = await this.getPublishedStories(
      {
        limit: 24,
      },
      {
        cacheKeyLabel: "home",
        cacheTtlSeconds: HOME_CATALOG_CACHE_TTL_SECONDS,
      },
    );

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

  /**
   * Active limited-time offers for the reader dashboard (admin-configured, max {@link DASHBOARD_LIMITED_OFFERS_MAX}).
   */
  private async getActiveLimitedOffersForDashboard() {
    const now = new Date();
    const offerRows = await this.prisma.limitedOffer.findMany({
      where: {
        isActive: true,
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      orderBy: { sortOrder: "asc" },
      take: DASHBOARD_LIMITED_OFFERS_MAX,
      select: {
        id: true,
        discountLabel: true,
        storyId: true,
      },
    });

    if (offerRows.length === 0) {
      return [];
    }

    const storyIds = offerRows.map((row) => row.storyId);
    const stories = await this.prisma.story.findMany({
      where: {
        ...this.buildPublishedStoryWhere({}),
        id: { in: storyIds },
      },
      select: publishedStoryCatalogSelect,
    });
    const storyById = new Map(stories.map((story) => [story.id, story] as const));
    const cards: Array<
      { discountLabel: string; offerId: string } & ReturnType<ReaderService["mapStoryCard"]>
    > = [];

    for (const row of offerRows) {
      const record = storyById.get(row.storyId);
      if (!record || !isStoryLive(record)) {
        continue;
      }
      const source = this.publishedCatalogRecordToStoryCardSource(record);
      cards.push({
        discountLabel: row.discountLabel,
        offerId: row.id,
        ...this.mapStoryCard(source),
      });
    }

    return cards;
  }

  /**
   * Fast first paint: small DB slices + continue reading + featured.
   * Client should call {@link getDashboardPersonalization} after load for "for you" + genres.
   */
  async getDashboard(userId: string) {
    const catalogWhere = this.buildPublishedStoryWhere({});

    const [continueReading, trendingPack, freshPack, featuredStory, limitedOffers] =
      await Promise.all([
        this.getContinueReading(userId),
        this.queryPublishedStories({
          limit: DASHBOARD_PREVIEW_ROW_LIMIT,
          offset: 0,
          orderMode: "trending",
        }),
        this.queryPublishedStories({
          limit: DASHBOARD_PREVIEW_ROW_LIMIT,
          offset: 0,
          orderMode: "fresh",
        }),
        this.getDashboardFeaturedStoryRecord(catalogWhere),
        this.getActiveLimitedOffersForDashboard(),
      ]);

    const trendingStories = trendingPack.stories;
    const freshStories = freshPack.stories;
    const dbPromoSlides = await loadPromoSlidesFromDb(this.prisma);
    const envPromoSlides = dbPromoSlides.length > 0 ? dbPromoSlides : parsePromoCarouselFromEnv();
    const featuredMapped = featuredStory ? this.mapFeaturedStory(featuredStory) : null;
    const promoCarousel = buildDashboardPromoCarousel(
      envPromoSlides,
      featuredMapped
        ? {
            bannerImage: featuredMapped.bannerImage,
            shortSynopsis: featuredMapped.shortSynopsis,
            slug: featuredMapped.slug,
            title: featuredMapped.title,
          }
        : null,
    );
    const floatingPromos = parseFloatingPromosFromEnv();

    if (
      !featuredStory &&
      trendingStories.length === 0 &&
      freshStories.length === 0 &&
      promoCarousel.length === 0 &&
      limitedOffers.length === 0
    ) {
      return {
        availableGenres: [],
        continueReading,
        featured: null,
        limitedOffers: [],
        personalizationPending: true,
        promoCarousel: [],
        floatingPromos,
        rows: [],
      };
    }

    return {
      availableGenres: [],
      continueReading,
      featured: featuredMapped,
      limitedOffers,
      personalizationPending: true,
      promoCarousel,
      floatingPromos,
      rows: [
        {
          id: "for-you",
          personalizationPending: true,
          stories: [],
          title: "Recommended for you",
        },
        {
          id: "trending",
          stories: this.dedupeStoryCards(trendingStories),
          title: "Trending now",
        },
        {
          id: "fresh",
          stories: this.dedupeStoryCards(freshStories),
          title: "Fresh chapters",
        },
      ],
    };
  }

  /** Full-catalog recommendations + genre list (heavier; load after dashboard shell). */
  async getDashboardPersonalization(userId: string) {
    const stories = await this.getPublishedStories(
      {},
      {
        cacheKeyLabel: "dashboard",
        cacheTtlSeconds: HOME_CATALOG_CACHE_TTL_SECONDS,
      },
    );

    if (stories.length === 0) {
      return {
        availableGenres: [],
        forYouRow: {
          id: "for-you" as const,
          stories: [],
          title: "Recommended for you",
        },
      };
    }

    const recommendedStories = await this.getRecommendedStoryCards({
      excludeSeenStories: true,
      stories,
      userId,
    });

    return {
      availableGenres: Array.from(
        new Set(stories.flatMap((story) => story.genreSlugs.map((slug) => this.slugToLabel(slug)))),
      ),
      forYouRow: {
        id: "for-you" as const,
        stories: recommendedStories.stories,
        title:
          recommendedStories.selectedGenres.length > 0
            ? `Because you picked ${recommendedStories.selectedGenres[0]}`
            : "Recommended for you",
      },
    };
  }

  private async getDashboardFeaturedStoryRecord(
    catalogWhere: Prisma.StoryWhereInput,
  ): Promise<PublishedStoryCatalogRecord | null> {
    const featuredPick = await this.prisma.story.findFirst({
      where: {
        AND: [catalogWhere, { featured: true }],
      },
      orderBy: [
        {
          totalReads: Prisma.SortOrder.desc,
        },
        {
          updatedAt: Prisma.SortOrder.desc,
        },
      ],
      select: publishedStoryCatalogSelect,
    });

    if (featuredPick) {
      return featuredPick;
    }

    return this.prisma.story.findFirst({
      where: catalogWhere,
      orderBy: [
        {
          totalReads: Prisma.SortOrder.desc,
        },
        {
          updatedAt: Prisma.SortOrder.desc,
        },
      ],
      select: publishedStoryCatalogSelect,
    });
  }

  async getDashboardShelf(userId: string, shelfId: string, offset: number, limit: number) {
    const allowedShelves = new Set([
      "for-you", "trending", "fresh", "new-novels", "editors-picks",
      "completed-novels", "readers-pick",
    ]);

    if (!allowedShelves.has(shelfId)) {
      throw new BadRequestException("Unknown dashboard shelf.");
    }

    const take = Math.min(Math.max(limit, 1), 50);
    const skip = Math.max(offset, 0);

    if (shelfId === "editors-picks") {
      const { stories: pageRecords, pageInfo } = await this.queryPublishedStories({
        editorPick: true,
        limit: take,
        offset: skip,
        orderMode: "editor_pick",
      });

      return {
        shelfId,
        title: "Editor\u2019s Picks",
        stories: pageRecords.map((story) => this.mapStoryCard(story)),
        pageInfo,
      };
    }

    if (shelfId === "new-novels") {
      const publishedSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const { stories: pageRecords, pageInfo } = await this.queryPublishedStories({
        limit: take,
        offset: skip,
        orderMode: "new_listings",
        publishedSince,
      });

      return {
        shelfId,
        title: "New novels",
        stories: pageRecords.map((story) => this.mapStoryCard(story)),
        pageInfo,
      };
    }

    if (shelfId === "trending") {
      const { stories: pageRecords, pageInfo } = await this.queryPublishedStories({
        limit: take,
        offset: skip,
        orderMode: "trending",
      });

      return {
        shelfId,
        title: "Trending now",
        stories: pageRecords.map((story) => this.mapStoryCard(story)),
        pageInfo,
      };
    }

    if (shelfId === "fresh") {
      const { stories: pageRecords, pageInfo } = await this.queryPublishedStories({
        limit: take,
        offset: skip,
        orderMode: "fresh",
      });

      return {
        shelfId,
        title: "Fresh chapters",
        stories: pageRecords.map((story) => this.mapStoryCard(story)),
        pageInfo,
      };
    }

    if (shelfId === "completed-novels") {
      const { stories: pageRecords, pageInfo } = await this.queryPublishedStories({
        limit: take,
        offset: skip,
        orderMode: "rating",
        statusFilter: "completed",
      });

      return {
        shelfId,
        title: "Completed novels",
        stories: pageRecords.map((story) => this.mapStoryCard(story)),
        pageInfo,
      };
    }

    if (shelfId === "readers-pick") {
      // Top rated stories — weekly readers pick (min 3.5 stars)
      const { stories: pageRecords, pageInfo } = await this.queryPublishedStories({
        limit: take,
        offset: skip,
        orderMode: "rating",
        minRating: 3.5,
        publishedSince: undefined,
      });

      return {
        shelfId,
        title: "Readers\u2019 pick",
        stories: pageRecords.map((story) => this.mapStoryCard(story)),
        pageInfo,
      };
    }

    const allStories = await this.getPublishedStories(
      {},
      {
        cacheKeyLabel: "dashboard",
        cacheTtlSeconds: HOME_CATALOG_CACHE_TTL_SECONDS,
      },
    );

    if (allStories.length === 0) {
      return {
        shelfId,
        title: "Recommended for you",
        stories: [],
        pageInfo: {
          hasMore: false,
          limit: take,
          nextOffset: null,
          offset: skip,
        },
      };
    }

    const recommended = await this.getRecommendedStoryCards({
      excludeSeenStories: true,
      limit: null,
      stories: allStories,
      userId,
    });

    const title =
      recommended.selectedGenres.length > 0
        ? `Because you picked ${recommended.selectedGenres[0]}`
        : "Recommended for you";

    const slice = recommended.stories.slice(skip, skip + take);
    const hasMore = skip + take < recommended.stories.length;

    return {
      shelfId,
      title,
      stories: slice,
      pageInfo: {
        hasMore,
        limit: take,
        nextOffset: hasMore ? skip + take : null,
        offset: skip,
      },
    };
  }

  /**
   * In-progress titles for the reader library (one row per story, newest activity first).
   */
  async getLibraryReadingProgress(userId: string, limit: number, offset: number) {
    const take = Math.min(Math.max(limit, 1), 60);
    const skip = Math.max(offset, 0);

    const entries = await this.prisma.readingProgress.findMany({
      where: { userId },
      include: {
        chapter: true,
        story: {
          include: {
            adminControl: true,
            assets: true,
            _count: {
              select: { publishedChapters: true },
            },
          },
        },
      },
      orderBy: { lastReadAt: "desc" },
      skip,
      take,
    });

    const items = entries
      .filter((entry) => isStoryLive(entry.story))
      .map((entry) => {
        const firstGenreSlug = entry.story.genreSlugs[0] ?? "story";
        return {
          chapterNumber: entry.chapter.chapterNumber,
          chapterSlug: entry.chapter.slug,
          chapterTitle: entry.chapter.title,
          coverImage:
            entry.story.assets?.coverImageUrl ??
            entry.story.assets?.cardImageUrl ??
            entry.story.assets?.bannerImageUrl ??
            "",
          genreLabel: this.slugToLabel(firstGenreSlug),
          kindLabel: "Novel",
          lastReadAt: entry.lastReadAt.toISOString(),
          lastReadAtLabel: this.formatRelativeDate(entry.lastReadAt),
          progressPercent: entry.progressPercent,
          storySlug: entry.story.slug,
          storyTitle: entry.story.title,
          totalChapters: entry.story._count.publishedChapters,
        };
      });

    return { items };
  }

  async getFollowingFeed(userId: string) {
    const follows = await this.prisma.follow.findMany({
      where: {
        userId,
      },
      include: {
        story: {
          include: {
            adminControl: true,
            assets: true,
            publishedChapters: {
              orderBy: {
                publishedAt: "desc",
              },
              take: 1,
            },
          },
        },
        targetUser: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const followedStoryIds = new Set<string>();
    const followedAuthorIds = new Set<string>();
    const followedStories = [];
    const followedAuthors = [];

    for (const follow of follows) {
      if (
        follow.targetType === FollowTargetType.STORY &&
        follow.story &&
        this.isReadableStatus(follow.story.status) &&
        isStoryLive(follow.story) &&
        !followedStoryIds.has(follow.story.id)
      ) {
        followedStoryIds.add(follow.story.id);
        followedStories.push(this.mapFollowedStorySummary(follow));
      }

      if (
        follow.targetType === FollowTargetType.AUTHOR &&
        follow.targetUser &&
        !followedAuthorIds.has(follow.targetUser.id)
      ) {
        followedAuthorIds.add(follow.targetUser.id);
      }
    }

    const authorStoryRecords = followedAuthorIds.size
      ? await this.prisma.story.findMany({
          where: {
            authorId: {
              in: Array.from(followedAuthorIds),
            },
            status: {
              in: [StoryStatus.PUBLISHED, StoryStatus.COMPLETED, StoryStatus.HIATUS],
            },
          },
          include: {
            adminControl: true,
          },
        })
      : [];
    const authorStoryCountById = authorStoryRecords.reduce((map, story) => {
      if (!story.authorId || !isStoryLive(story)) {
        return map;
      }

      map.set(story.authorId, (map.get(story.authorId) ?? 0) + 1);
      return map;
    }, new Map<string, number>());

    for (const follow of follows) {
      if (
        follow.targetType !== FollowTargetType.AUTHOR ||
        !follow.targetUser ||
        !followedAuthorIds.has(follow.targetUser.id)
      ) {
        continue;
      }

      followedAuthors.push({
        avatarUrl: follow.targetUser.profile?.avatarUrl ?? null,
        id: follow.targetUser.id,
        name: this.getDisplayName(follow.targetUser),
        storyCount: authorStoryCountById.get(follow.targetUser.id) ?? 0,
      });
      followedAuthorIds.delete(follow.targetUser.id);
    }

    if (!followedStories.length && !followedAuthors.length) {
      return {
        followedAuthors: [],
        followedStories: [],
        items: [],
      };
    }

    const followFilters: Prisma.PublishedChapterWhereInput[] = [];

    if (followedStories.length) {
      followFilters.push({
        storyId: {
          in: followedStories.map((story) => story.id),
        },
      });
    }

    if (followedAuthors.length) {
      followFilters.push({
        story: {
          authorId: {
            in: followedAuthors.map((author) => author.id),
          },
        },
      });
    }

    const chapters = await this.prisma.publishedChapter.findMany({
      where: {
        OR: followFilters,
      },
      include: {
        story: {
          include: {
            adminControl: true,
            assets: true,
          },
        },
      },
      orderBy: {
        publishedAt: "desc",
      },
      take: 24,
    });

    return {
      followedAuthors,
      followedStories,
      items: chapters
        .filter(
          (chapter) =>
            this.isReadableStatus(chapter.story.status) && isStoryLive(chapter.story),
        )
        .map((chapter) => ({
          authorId: chapter.story.authorId ?? null,
          authorName: chapter.story.authorName,
          chapterNumber: chapter.chapterNumber,
          chapterSlug: chapter.slug,
          chapterTitle: chapter.title,
          coverImage:
            chapter.story.assets?.coverImageUrl ??
            chapter.story.assets?.cardImageUrl ??
            chapter.story.assets?.bannerImageUrl ??
            "",
          id: chapter.id,
          publishedAt: chapter.publishedAt,
          publishedAtLabel: this.formatRelativeDate(chapter.publishedAt),
          storySlug: chapter.story.slug,
          storyTitle: chapter.story.title,
        })),
    };
  }

  async followStory(userId: string, storySlug: string) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const subjectKey = this.buildFollowSubjectKey("story", story.id);

    await this.prisma.follow.upsert({
      where: {
        userId_subjectKey: {
          subjectKey,
          userId,
        },
      },
      update: {
        storyId: story.id,
        targetType: FollowTargetType.STORY,
        targetUserId: null,
      },
      create: {
        storyId: story.id,
        subjectKey,
        targetType: FollowTargetType.STORY,
        userId,
      },
    });

    this.redisService.delete(`story:agg:${story.id}`).catch(() => undefined);

    return {
      following: true,
      message: `Following ${story.title}.`,
    };
  }

  async unfollowStory(userId: string, storySlug: string) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const subjectKey = this.buildFollowSubjectKey("story", story.id);

    await this.prisma.follow.deleteMany({
      where: {
        subjectKey,
        userId,
      },
    });

    this.redisService.delete(`story:agg:${story.id}`).catch(() => undefined);

    return {
      following: false,
      message: `Unfollowed ${story.title}.`,
    };
  }

  async followAuthor(userId: string, authorId: string) {
    if (authorId === userId) {
      throw new BadRequestException("You cannot follow your own author profile.");
    }

    const author = await this.prisma.user.findFirst({
      where: {
        id: authorId,
        status: UserStatus.ACTIVE,
      },
      include: {
        profile: true,
      },
    });

    if (!author) {
      throw new NotFoundException("Author not found.");
    }

    const subjectKey = this.buildFollowSubjectKey("author", author.id);

    await this.prisma.follow.upsert({
      where: {
        userId_subjectKey: {
          subjectKey,
          userId,
        },
      },
      update: {
        storyId: null,
        targetType: FollowTargetType.AUTHOR,
        targetUserId: author.id,
      },
      create: {
        subjectKey,
        targetType: FollowTargetType.AUTHOR,
        targetUserId: author.id,
        userId,
      },
    });

    return {
      following: true,
      message: `Following ${this.getDisplayName(author)}.`,
    };
  }

  async unfollowAuthor(userId: string, authorId: string) {
    const author = await this.prisma.user.findFirst({
      where: {
        id: authorId,
        status: UserStatus.ACTIVE,
      },
      include: {
        profile: true,
      },
    });

    if (!author) {
      throw new NotFoundException("Author not found.");
    }

    const subjectKey = this.buildFollowSubjectKey("author", author.id);

    await this.prisma.follow.deleteMany({
      where: {
        subjectKey,
        userId,
      },
    });

    return {
      following: false,
      message: `Unfollowed ${this.getDisplayName(author)}.`,
    };
  }

  async listStories(input: {
    genre?: string;
    limit?: number | null;
    offset?: number | null;
    query?: string;
    tags?: string[];
  }) {
    const [storyCatalog, genres] = await Promise.all([
      this.queryPublishedStories({
        genre: input.genre,
        limit: input.limit ?? null,
        offset: input.offset ?? null,
        query: input.query,
        tags: input.tags,
      }),
      this.prisma.genre.findMany({
        orderBy: { name: "asc" },
        select: { name: true, slug: true },
      }),
    ]);

    const genreOptions = genres.map((genre) => ({
      label: genre.name,
      slug: genre.slug,
    }));

    return {
      genres: sortGenresForReaderDisplay(genreOptions),
      pageInfo: storyCatalog.pageInfo,
      stories: storyCatalog.stories.map((story) => this.mapStoryCard(story)),
    };
  }

  async search(
    rawQuery?: string,
    options: {
      genre?: string;
      limit?: number | null;
      minRating?: number | null;
      offset?: number | null;
      sort?: "relevance" | "rating" | "reads" | "newest";
      status?: string;
    } = {},
  ) {
    const query = this.normalizeOptionalQuery(rawQuery);
    const sortToOrderMode: Record<string, "default" | "rating" | "reads" | "fresh"> = {
      relevance: "default",
      rating: "rating",
      reads: "reads",
      newest: "fresh",
    };
    const { pageInfo, stories } = await this.queryPublishedStories({
      genre: options.genre,
      limit: options.limit ?? null,
      minRating: options.minRating,
      offset: options.offset ?? null,
      orderMode: sortToOrderMode[options.sort ?? "relevance"] ?? "default",
      query,
      statusFilter: options.status === "all" ? undefined : options.status,
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
      pageInfo,
      stories: stories.map((story) => this.mapStoryCard(story)),
    };
  }

  async getTrendingSearches() {
    const cacheKey = "reader:trending-searches";
    const cached = await this.redisService.getJson<{ queries: Array<{ query: string; slug: string; coverImage: string }> }>(cacheKey);
    if (cached) return cached;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const topStories = await this.prisma.story.findMany({
      where: {
        ...this.buildPublishedStoryWhere({}),
        latestChapterAt: { gte: sevenDaysAgo },
      },
      select: {
        slug: true,
        title: true,
        totalReads: true,
        assets: { select: { coverImageUrl: true, cardImageUrl: true } },
      },
      orderBy: [{ totalReads: "desc" }],
      take: 10,
    });

    const result = {
      queries: topStories.map((s) => ({
        query: s.title,
        slug: s.slug,
        coverImage: s.assets?.coverImageUrl ?? s.assets?.cardImageUrl ?? "",
      })),
    };

    await this.redisService.setJson(cacheKey, result, 3600);
    return result;
  }

  async getStoryDetails(userId: string, storySlug: string) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const [
      stories,
      { chapterAccessMap, progress },
      bookmarks,
      storyRating,
      aggregates,
      follows,
    ] =
      await Promise.all([
        this.getRecommendationCandidatesForStory(story),
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
        this.getStoryAggregates(story.id, story.authorId),
        this.prisma.follow.findMany({
          where: {
            userId,
            OR: [
              {
                storyId: story.id,
                targetType: FollowTargetType.STORY,
              },
              ...(story.authorId
                ? [
                    {
                      targetType: FollowTargetType.AUTHOR,
                      targetUserId: story.authorId,
                    },
                  ]
                : []),
            ],
          },
          select: {
            targetType: true,
          },
        }),
      ]);
    const { writtenReviewCount, storyFollowerCount, authorFollowerCount, authorStoryCount } = aggregates;
    const totalWordCount = story.publishedChapters.reduce(
      (sum, pc) => sum + (pc.chapter?.wordCount ?? 0),
      0,
    );
    const recommendations = await this.getRecommendedStoryCards({
      excludeSeenStories: true,
      excludeStoryIds: [story.id],
      limit: 6,
      sourceStory: this.toStoryCardSource(story),
      stories,
      userId,
    });

    const bookmarkedChapterIds = new Set(
      bookmarks.map(
        (bookmark: { publishedChapterId: string }) => bookmark.publishedChapterId,
      ),
    );
    const firstChapter = story.publishedChapters[0] ?? null;
    const storyControl = this.getStoryControl(story);
    const writtenReviewEligibility = this.getStoryWrittenReviewEligibility({
      chapterAccessMap,
      chapters: story.publishedChapters,
      progress,
    });
    const starRatingEligibility = this.getStoryStarRatingEligibility({
      authorId: story.authorId ?? null,
      publishedChapterCount: story.publishedChapters.length,
      userId,
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
          volumeId: chapter.chapter?.volumeId ?? null,
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
      recommendations: recommendations.stories,
      story: {
        authorFollowerCount,
        authorFollowerCountLabel: this.formatCompactNumber(authorFollowerCount),
        authorId: story.authorId ?? null,
        authorName: story.authorName,
        authorStoryCount,
        chapterCount: story.publishedChapters.length,
        coverImage:
          story.assets?.coverImageUrl ??
          story.assets?.cardImageUrl ??
          story.assets?.bannerImageUrl ??
          "",
        canRate: starRatingEligibility.canRate,
        firstChapterSlug: firstChapter?.slug ?? null,
        genres: story.genreSlugs.map((genreSlug) => this.slugToLabel(genreSlug)),
        hasCompletedStory: writtenReviewEligibility.hasCompletedStory,
        hasUnlockedAllChapters: writtenReviewEligibility.hasUnlockedAllChapters,
        isFollowingAuthor: follows.some(
          (follow: { targetType: FollowTargetType }) => follow.targetType === FollowTargetType.AUTHOR,
        ),
        isFollowingStory: follows.some(
          (follow: { targetType: FollowTargetType }) => follow.targetType === FollowTargetType.STORY,
        ),
        maturityRating: story.maturityRating,
        rating: Number(story.averageRating.toFixed(1)),
        ratingEligibilityMessage: starRatingEligibility.ratingEligibilityMessage,
        readsCount: story.totalReads,
        readsLabel: this.formatCompactNumber(story.totalReads),
        reviewCount: story.reviewCount,
        writtenReviewCount,
        shortSynopsis: story.shortSynopsis,
        slug: story.slug,
        storyFollowerCount,
        storyFollowerCountLabel: this.formatCompactNumber(storyFollowerCount),
        status: this.mapStoryStatus(story.status),
        synopsis: story.synopsis,
        tagLabels: story.tagSlugs.map((tagSlug) => this.slugToLabel(tagSlug)),
        title: story.title,
        totalWordCount,
        userRating: storyRating?.rating ?? null,
        volumes: (story.volumes ?? []).map((volume) => ({
          id: volume.id,
          number: volume.number,
          title: volume.title,
        })),
      },
    };
  }

  async updateStoryRating(
    userId: string,
    storySlug: string,
    input: UpdateStoryRatingInput,
  ) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const [{ progress, chapterAccessMap }, existingReview] = await Promise.all([
      this.getStoryReaderAccessContext(userId, story),
      this.prisma.review.findUnique({
        where: {
          userId_storyId: {
            storyId: story.id,
            userId,
          },
        },
        select: {
          id: true,
          status: true,
        },
      }),
    ]);
    const starRatingEligibility = this.getStoryStarRatingEligibility({
      authorId: story.authorId ?? null,
      publishedChapterCount: story.publishedChapters.length,
      userId,
    });

    if (!starRatingEligibility.canRate) {
      throw new ForbiddenException(
        starRatingEligibility.ratingEligibilityMessage ??
          "You can't rate this book right now.",
      );
    }

    await this.prisma.storyRating.upsert({
      where: {
        userId_storyId: {
          storyId: story.id,
          userId,
        },
      },
      update: {
        rating: input.rating,
      },
      create: {
        rating: input.rating,
        storyId: story.id,
        userId,
      },
    });

    if (existingReview?.status === ReviewStatus.VISIBLE) {
      await this.prisma.review.update({
        where: {
          id: existingReview.id,
        },
        data: {
          rating: input.rating,
        },
      });
    }

    const summary = await this.recalculateStoryRatingSummary(story.id);
    await this.redisService.delete(`story:agg:${story.id}`);

    const writtenAfter = this.getStoryWrittenReviewEligibility({
      chapterAccessMap,
      chapters: story.publishedChapters,
      progress,
    });

    return {
      story: {
        canRate: true,
        hasCompletedStory: writtenAfter.hasCompletedStory,
        hasUnlockedAllChapters: writtenAfter.hasUnlockedAllChapters,
        rating: Number(summary.averageRating.toFixed(1)),
        ratingEligibilityMessage: null,
        reviewCount: summary.reviewCount,
        slug: story.slug,
        userRating: input.rating,
      },
    };
  }

  async getStoryReviews(
    userId: string,
    storySlug: string,
    input: {
      limit: number | null;
      sort: ReviewSort;
    },
  ) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const [{ chapterAccessMap, progress }, currentUserReview, ratings, reviews, writtenReviewCount] =
      await Promise.all([
        this.getStoryReaderAccessContext(userId, story),
        this.prisma.review.findUnique({
          where: {
            userId_storyId: {
              storyId: story.id,
              userId,
            },
          },
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        }),
        this.prisma.storyRating.findMany({
          where: {
            storyId: story.id,
          },
          select: {
            rating: true,
          },
        }),
        this.prisma.review.findMany({
          where: {
            status: ReviewStatus.VISIBLE,
            storyId: story.id,
          },
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
          orderBy:
            input.sort === "most_helpful"
              ? [
                  {
                    helpfulCount: "desc",
                  },
                  {
                    createdAt: "desc",
                  },
                ]
              : input.sort === "highest"
                ? [
                    {
                      rating: "desc",
                    },
                    {
                      createdAt: "desc",
                    },
                  ]
                : input.sort === "lowest"
                  ? [
                      {
                        rating: "asc",
                      },
                      {
                        createdAt: "desc",
                      },
                    ]
                  : [
                      {
                        createdAt: "desc",
                      },
                    ],
          take: input.limit ?? undefined,
        }),
        this.prisma.review.count({
          where: {
            status: ReviewStatus.VISIBLE,
            storyId: story.id,
          },
        }),
      ]);
    const writtenReviewEligibility = this.getStoryWrittenReviewEligibility({
      chapterAccessMap,
      chapters: story.publishedChapters,
      progress,
    });
    const canReview =
      writtenReviewEligibility.canRate ||
      currentUserReview?.status === ReviewStatus.VISIBLE ||
      (currentUserReview?.status === ReviewStatus.DELETED &&
        !currentUserReview.moderatedByAdminUserId);

    return {
      canReview,
      currentUserReview: currentUserReview
        ? this.mapStoryReview(currentUserReview, userId, {
            includeStatus: true,
          })
        : null,
      reviewEligibilityMessage: writtenReviewEligibility.ratingEligibilityMessage,
      reviews: reviews.map((review) => this.mapStoryReview(review, userId)),
      sort: input.sort,
      summary: {
        averageRating: Number(story.averageRating.toFixed(1)),
        distribution: this.buildRatingDistribution(ratings),
        ratingCount: story.reviewCount,
        writtenReviewCount,
      },
    };
  }

  async upsertStoryReview(
    userId: string,
    storySlug: string,
    input: UpsertReviewInput,
  ) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const [{ chapterAccessMap, progress }, existingReview] = await Promise.all([
      this.getStoryReaderAccessContext(userId, story),
      this.prisma.review.findUnique({
        where: {
          userId_storyId: {
            storyId: story.id,
            userId,
          },
        },
      }),
    ]);
    const writtenReviewEligibility = this.getStoryWrittenReviewEligibility({
      chapterAccessMap,
      chapters: story.publishedChapters,
      progress,
    });
    const canRestoreDeletedReview =
      existingReview?.status === ReviewStatus.DELETED &&
      !existingReview.moderatedByAdminUserId;

    if (!existingReview && !writtenReviewEligibility.canRate) {
      throw new ForbiddenException(
        writtenReviewEligibility.ratingEligibilityMessage ??
          "Finish reading and unlock every published chapter before reviewing this book.",
      );
    }

    if (
      existingReview &&
      existingReview.status !== ReviewStatus.VISIBLE &&
      !canRestoreDeletedReview
    ) {
      throw new BadRequestException("This review can no longer be edited.");
    }

    await this.prisma.storyRating.upsert({
      where: {
        userId_storyId: {
          storyId: story.id,
          userId,
        },
      },
      update: {
        rating: input.rating,
      },
      create: {
        rating: input.rating,
        storyId: story.id,
        userId,
      },
    });

    const review = existingReview
      ? await this.prisma.review.update({
          where: {
            id: existingReview.id,
          },
          data: {
            body: input.body,
            containsSpoilers: input.containsSpoilers,
            editedAt: new Date(),
            moderatedAt: canRestoreDeletedReview ? null : existingReview.moderatedAt,
            moderatedByAdminUserId: canRestoreDeletedReview
              ? null
              : existingReview.moderatedByAdminUserId,
            moderationNotes: canRestoreDeletedReview
              ? null
              : existingReview.moderationNotes,
            rating: input.rating,
            status: canRestoreDeletedReview
              ? ReviewStatus.VISIBLE
              : existingReview.status,
            title: input.title,
          },
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        })
      : await this.prisma.review.create({
          data: {
            body: input.body,
            containsSpoilers: input.containsSpoilers,
            rating: input.rating,
            storyId: story.id,
            title: input.title,
            userId,
          },
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        });

    await this.recalculateStoryRatingSummary(story.id);
    await this.redisService.delete(`story:agg:${story.id}`);

    if (!existingReview) {
      this.challengeService
        .incrementChallengeProgress(userId, "REVIEWS_WRITTEN", 1)
        .catch(() => undefined);
      this.activityFeedService
        .recordActivity(userId, "REVIEWED_STORY", { rating: input.rating }, story.id)
        .catch(() => undefined);
    }

    return {
      message: existingReview ? "Review updated." : "Review published.",
      review: this.mapStoryReview(review, userId, {
        includeStatus: true,
      }),
    };
  }

  async deleteStoryReview(userId: string, storySlug: string) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const review = await this.prisma.review.findUnique({
      where: {
        userId_storyId: {
          storyId: story.id,
          userId,
        },
      },
    });

    if (!review || review.status === ReviewStatus.DELETED) {
      throw new NotFoundException("Review not found.");
    }

    if (review.status !== ReviewStatus.VISIBLE) {
      throw new BadRequestException("This review can no longer be deleted.");
    }

    await Promise.all([
      this.prisma.review.update({
        where: {
          id: review.id,
        },
        data: {
          editedAt: new Date(),
          status: ReviewStatus.DELETED,
        },
      }),
      this.prisma.storyRating.deleteMany({
        where: {
          storyId: story.id,
          userId,
        },
      }),
    ]);

    await this.recalculateStoryRatingSummary(story.id);
    await this.redisService.delete(`story:agg:${story.id}`);

    return {
      message: "Review deleted.",
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

    if (!story || story.deletedAt || !this.isReadableStatus(story.status) || !isStoryLive(story)) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = await this.prisma.publishedChapter.findUnique({
      where: {
        storyId_slug: {
          slug: chapterSlug,
          storyId: story.id,
        },
      },
      select: {
        adminOverride: true,
        chapter: {
          select: {
            coinUnlockPrice: true,
            premiumEnabled: true,
            readingMinutes: true,
          },
        },
        chapterId: true,
        chapterNumber: true,
        coinUnlockPrice: true,
        id: true,
        premium: true,
        publishedAt: true,
        slug: true,
        storyId: true,
        title: true,
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    const [progress, bookmark, previousChapter, nextChapter, commentCount] = await Promise.all([
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
      this.prisma.comment.count({
        where: {
          publishedChapterId: chapter.id,
          OR: [
            {
              status: CommentStatus.VISIBLE,
            },
            {
              parentCommentId: null,
              status: {
                in: [CommentStatus.HIDDEN, CommentStatus.DELETED],
              },
              replies: {
                some: {
                  status: CommentStatus.VISIBLE,
                },
              },
            },
          ],
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
    const readableChapter = access.accessState === "READABLE"
      ? await this.prisma.publishedChapter.findUnique({
          where: {
            id: chapter.id,
          },
          select: {
            bodyParagraphs: true,
          },
        })
      : null;
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
        commentCount,
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
        paragraphs: readableChapter?.bodyParagraphs ?? [],
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
          chapter.chapter?.readingMinutes ??
          this.estimateReadingMinutes(readableChapter?.bodyParagraphs ?? []),
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

  async getChapterComments(
    userId: string,
    storySlug: string,
    chapterSlug: string,
    sort: CommentSort,
  ) {
    const { chapter } = await this.getCommentableChapterTarget(
      userId,
      storySlug,
      chapterSlug,
    );
    const comments = await this.prisma.comment.findMany({
      where: {
        publishedChapterId: chapter.id,
        OR: [
          {
            status: CommentStatus.VISIBLE,
          },
          {
            parentCommentId: null,
            status: {
              in: [CommentStatus.HIDDEN, CommentStatus.DELETED],
            },
            replies: {
              some: {
                status: CommentStatus.VISIBLE,
              },
            },
          },
        ],
      },
      include: {
        user: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return {
      comments: this.mapCommentThread(comments, userId, sort),
      sort,
      summary: {
        totalCount: comments.length,
      },
    };
  }

  async createComment(
    userId: string,
    storySlug: string,
    chapterSlug: string,
    input: CreateCommentInput,
  ) {
    const [author, target] = await Promise.all([
      this.requireActiveUser(userId),
      this.getCommentableChapterTarget(userId, storySlug, chapterSlug),
    ]);
    const parentComment = input.parentCommentId
      ? await this.prisma.comment.findFirst({
          where: {
            id: input.parentCommentId,
            publishedChapterId: target.chapter.id,
            status: CommentStatus.VISIBLE,
          },
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        })
      : null;

    if (input.parentCommentId && !parentComment) {
      throw new NotFoundException("Comment not found.");
    }

    if (parentComment?.parentCommentId) {
      throw new BadRequestException("Nested replies beyond one level are not supported.");
    }

    const comment = await this.prisma.comment.create({
      data: {
        body: input.body,
        depth: parentComment ? 1 : 0,
        parentCommentId: parentComment?.id ?? null,
        publishedChapterId: target.chapter.id,
        storyId: target.story.id,
        userId,
      },
      include: {
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    this.engagementService
      .notifyUsersOfChapterComment({
        actorDisplayName: this.getDisplayName(author),
        actorUserId: userId,
        chapterNumber: target.chapter.chapterNumber,
        chapterSlug: target.chapter.slug,
        chapterTitle: target.chapter.title,
        commentBody: comment.body,
        parentCommentAuthorId: parentComment?.userId ?? null,
        storyAuthorId: target.story.authorId ?? null,
        storySlug: target.story.slug,
        storyTitle: target.story.title,
      })
      .catch(() => undefined);

    this.badgeEvaluationService.evaluateBadges(userId).catch(() => undefined);
    this.challengeService
      .incrementChallengeProgress(userId, "COMMENTS_WRITTEN", 1)
      .catch(() => undefined);

    return {
      comment: this.mapCommentNode(comment, userId, []),
      message: parentComment ? "Reply posted." : "Comment posted.",
    };
  }

  async updateComment(
    userId: string,
    commentId: string,
    input: UpdateCommentInput,
  ) {
    await this.requireActiveUser(userId);

    const existingComment = await this.prisma.comment.findUnique({
      where: {
        id: commentId,
      },
    });

    if (!existingComment || existingComment.status === CommentStatus.DELETED) {
      throw new NotFoundException("Comment not found.");
    }

    if (existingComment.userId !== userId) {
      throw new ForbiddenException("You can only edit your own comments.");
    }

    if (existingComment.status !== CommentStatus.VISIBLE) {
      throw new BadRequestException("This comment can no longer be edited.");
    }

    const comment = await this.prisma.comment.update({
      where: {
        id: commentId,
      },
      data: {
        body: input.body,
        editedAt: new Date(),
      },
      include: {
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    return {
      comment: this.mapCommentNode(comment, userId, []),
      message: "Comment updated.",
    };
  }

  async deleteComment(userId: string, commentId: string) {
    await this.requireActiveUser(userId);

    const existingComment = await this.prisma.comment.findUnique({
      where: {
        id: commentId,
      },
      include: {
        replies: {
          where: {
            status: CommentStatus.VISIBLE,
          },
          select: {
            id: true,
          },
        },
      },
    });

    if (!existingComment || existingComment.status === CommentStatus.DELETED) {
      throw new NotFoundException("Comment not found.");
    }

    if (existingComment.userId !== userId) {
      throw new ForbiddenException("You can only delete your own comments.");
    }

    await this.prisma.comment.update({
      where: {
        id: commentId,
      },
      data: {
        editedAt: new Date(),
        moderationNotes: null,
        moderatedAt: null,
        moderatedByAdminUserId: null,
        status: CommentStatus.DELETED,
      },
    });

    return {
      message:
        existingComment.parentCommentId || existingComment.replies.length === 0
          ? "Comment deleted."
          : "Comment deleted. Replies remain visible in the thread.",
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
        deletedAt: true,
        id: true,
        isLive: true,
        liveAt: true,
        status: true,
      },
    });

    if (!story || story.deletedAt || !this.isReadableStatus(story.status) || !isStoryLive(story)) {
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

    await this.creatorAnalyticsService.recordChapterRead({
      paragraphIndex: nextParagraphIndex,
      progressPercent: nextProgressPercent,
      publishedChapterId: chapter.id,
      readAt: now,
      storyId: story.id,
      userId,
    });

    // Populate ChapterReadEvent for completion tracking
    const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const existingChapterReadEvent = await this.prisma.chapterReadEvent.findUnique({
      where: {
        userId_publishedChapterId_readDate: {
          userId,
          publishedChapterId: chapter.id,
          readDate: todayDate,
        },
      },
    });

    if (existingChapterReadEvent) {
      await this.prisma.chapterReadEvent.update({
        where: { id: existingChapterReadEvent.id },
        data: {
          paragraphIndex: Math.max(existingChapterReadEvent.paragraphIndex, nextParagraphIndex),
          maxProgressPercent: Math.max(existingChapterReadEvent.maxProgressPercent, nextProgressPercent),
          lastReadAt: now,
          ...(nextProgressPercent >= 95 && !existingChapterReadEvent.completed
            ? { completed: true, completedAt: now }
            : {}),
        },
      });
    } else {
      await this.prisma.chapterReadEvent.create({
        data: {
          userId,
          storyId: story.id,
          publishedChapterId: chapter.id,
          readDate: todayDate,
          paragraphIndex: nextParagraphIndex,
          maxProgressPercent: nextProgressPercent,
          completed: nextProgressPercent >= 95,
          completedAt: nextProgressPercent >= 95 ? now : null,
          firstReadAt: now,
          lastReadAt: now,
        },
      });
    }

    // Trigger badge evaluation + challenge progress on chapter completion
    if (nextProgressPercent >= 95) {
      this.badgeEvaluationService.evaluateBadges(userId).catch(() => undefined);
      this.challengeService
        .incrementChallengeProgress(userId, "CHAPTERS_READ", 1)
        .catch(() => undefined);

      // Activity feed: record STARTED_STORY for first chapter, generic for rest
      if (chapter.chapterNumber === 1) {
        this.activityFeedService
          .recordActivity(userId, "STARTED_STORY", { chapterTitle: chapter.title }, story.id)
          .catch(() => undefined);
      }
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

  async getChapterCompletionStats(
    userId: string,
    storySlug: string,
    chapterSlug: string,
  ) {
    const story = await this.prisma.story.findUnique({
      where: { slug: storySlug },
      select: { id: true, deletedAt: true, status: true, isLive: true },
    });

    if (!story || story.deletedAt) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = await this.prisma.publishedChapter.findUnique({
      where: {
        storyId_slug: { slug: chapterSlug, storyId: story.id },
      },
      select: {
        id: true,
        chapterNumber: true,
        title: true,
        chapter: { select: { readingMinutes: true } },
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    // Percentile rank: users who are at this chapter or beyond ÷ total readers
    const [readersAtOrBeyond, totalReaders] = await Promise.all([
      this.prisma.readingProgress.count({
        where: {
          storyId: story.id,
          chapter: { chapterNumber: { gte: chapter.chapterNumber } },
        },
      }),
      this.prisma.readingProgress.count({
        where: { storyId: story.id },
      }),
    ]);

    const percentileRank = totalReaders > 0
      ? Math.round(((totalReaders - readersAtOrBeyond) / totalReaders) * 100)
      : 0;

    // Chapter reader count
    const chapterReaderCount = await this.prisma.chapterReadEvent.groupBy({
      by: ["userId"],
      where: { publishedChapterId: chapter.id },
    }).then((results) => results.length);

    // Next chapter
    const nextChapter = await this.prisma.publishedChapter.findFirst({
      where: {
        storyId: story.id,
        chapterNumber: { gt: chapter.chapterNumber },
      },
      orderBy: { chapterNumber: "asc" },
      select: {
        slug: true,
        title: true,
        chapter: { select: { readingMinutes: true } },
      },
    });

    // Streak info
    const rewardWallet = await this.prisma.rewardWallet.findUnique({
      where: { userId },
    });

    return {
      percentileRank,
      chapterReaderCount,
      nextChapter: nextChapter
        ? {
            slug: nextChapter.slug,
            title: nextChapter.title,
            estimatedReadingMinutes: nextChapter.chapter?.readingMinutes ?? null,
          }
        : null,
      streakInfo: {
        streakDays: rewardWallet?.streakDays ?? 0,
        streakMultiplier: rewardWallet?.streakMultiplier ?? 1.0,
      },
    };
  }

  async getReadingLists(userId: string) {
    const lists = await this.prisma.readingList.findMany({
      where: { userId },
      include: this.getReadingListInclude(),
      orderBy: {
        updatedAt: "desc",
      },
    });

    return {
      lists: lists.map((list) => this.mapReadingList(list)),
    };
  }

  async getReadingListDetails(userId: string, listId: string) {
    const list = await this.getOwnedReadingListOrThrow(userId, listId);

    return {
      list: await this.mapReadingListDetails(list, userId, {
        viewerCanEdit: true,
      }),
    };
  }

  async getSharedReadingList(shareSlug: string) {
    const list = await this.prisma.readingList.findUnique({
      where: { shareSlug },
      include: this.getReadingListInclude(),
    });

    if (!list || list.visibility !== ReadingListVisibility.PUBLIC) {
      throw new NotFoundException("Reading list not found.");
    }

    return {
      list: await this.mapReadingListDetails(list, null, {
        viewerCanEdit: false,
      }),
    };
  }

  async getPublicReadingLists(input: {
    limit: number | null;
    query?: string;
  }) {
    const normalizedQuery = this.normalizeOptionalQuery(input.query);
    const lists = await this.prisma.readingList.findMany({
      where: {
        visibility: ReadingListVisibility.PUBLIC,
        ...(normalizedQuery
          ? {
              OR: [
                {
                  name: {
                    contains: normalizedQuery,
                    mode: "insensitive",
                  },
                },
                {
                  description: {
                    contains: normalizedQuery,
                    mode: "insensitive",
                  },
                },
              ],
            }
          : {}),
      },
      include: this.getReadingListInclude(),
      orderBy: {
        updatedAt: "desc",
      },
      take: input.limit ?? 24,
    });

    return {
      lists: lists.map((list) => this.mapReadingList(list)),
      query: input.query?.trim() ?? "",
    };
  }

  async createReadingList(userId: string, input: CreateReadingListInput) {
    const createdList = await this.prisma.readingList.create({
      data: {
        description: input.description,
        name: input.name,
        shareSlug: this.buildReadingListShareSlug(),
        userId,
        visibility: this.toReadingListVisibility(input.visibility),
      },
      select: {
        id: true,
      },
    });
    const list = await this.getOwnedReadingListOrThrow(userId, createdList.id);

    return {
      list: this.mapReadingList(list),
      message: "Reading list created.",
    };
  }

  async updateReadingList(
    userId: string,
    listId: string,
    input: UpdateReadingListInput,
  ) {
    await this.getOwnedReadingListOrThrow(userId, listId);

    await this.prisma.readingList.update({
      where: { id: listId },
      data: {
        description: input.description,
        name: input.name,
        visibility: this.toReadingListVisibility(input.visibility),
      },
    });

    const list = await this.getOwnedReadingListOrThrow(userId, listId);

    return {
      list: this.mapReadingList(list),
      message: "Reading list updated.",
    };
  }

  async deleteReadingList(userId: string, listId: string) {
    await this.getOwnedReadingListOrThrow(userId, listId);

    await this.prisma.$transaction([
      this.prisma.readingListItem.deleteMany({
        where: {
          readingListId: listId,
        },
      }),
      this.prisma.readingList.delete({
        where: {
          id: listId,
        },
      }),
    ]);

    return {
      message: "Reading list deleted.",
    };
  }

  async addStoryToReadingList(
    userId: string,
    listId: string,
    input: AddStoryToReadingListInput,
  ) {
    const [list, story] = await Promise.all([
      this.getOwnedReadingListOrThrow(userId, listId),
      this.getReadableStoryBySlug(input.storySlug),
    ]);

    await this.prisma.$transaction([
      this.prisma.readingListItem.upsert({
        where: {
          readingListId_storyId: {
            readingListId: list.id,
            storyId: story.id,
          },
        },
        update: {
          updatedAt: new Date(),
        },
        create: {
          readingListId: list.id,
          storyId: story.id,
        },
      }),
      this.prisma.readingList.update({
        where: {
          id: list.id,
        },
        data: {
          updatedAt: new Date(),
        },
      }),
    ]);

    const updatedList = await this.getOwnedReadingListOrThrow(userId, list.id);

    return {
      list: this.mapReadingList(updatedList),
      message: `"${story.title}" added to ${updatedList.name}.`,
    };
  }

  async removeStoryFromReadingList(
    userId: string,
    listId: string,
    storySlug: string,
  ) {
    const list = await this.getOwnedReadingListOrThrow(userId, listId);
    const story = await this.prisma.story.findUnique({
      where: {
        slug: storySlug,
      },
      select: {
        id: true,
        title: true,
      },
    });

    if (!story) {
      throw new NotFoundException("Story not found in this list.");
    }

    const deletedItem = await this.prisma.readingListItem.deleteMany({
      where: {
        readingListId: list.id,
        storyId: story.id,
      },
    });

    if (deletedItem.count === 0) {
      throw new NotFoundException("Story not found in this list.");
    }

    await this.prisma.readingList.update({
      where: {
        id: list.id,
      },
      data: {
        updatedAt: new Date(),
      },
    });

    const updatedList = await this.getOwnedReadingListOrThrow(userId, list.id);

    return {
      list: this.mapReadingList(updatedList),
      message: `"${story.title}" removed from ${updatedList.name}.`,
    };
  }

  async regenerateReadingListShareSlug(userId: string, listId: string) {
    await this.getOwnedReadingListOrThrow(userId, listId);

    const list = await this.prisma.readingList.update({
      where: {
        id: listId,
      },
      data: {
        shareSlug: this.buildReadingListShareSlug(),
        updatedAt: new Date(),
      },
      include: this.getReadingListInclude(),
    });

    return {
      list: this.mapReadingList(list),
      message: "Reading list share link refreshed.",
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
        deletedAt: true,
        id: true,
        isLive: true,
        status: true,
      },
    });

    if (!story || story.deletedAt || !this.isReadableStatus(story.status) || !isStoryLive(story)) {
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

    this.badgeEvaluationService.evaluateBadges(userId).catch(() => undefined);

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

  async voteOnReview(userId: string, reviewId: string, helpful: boolean) {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review) {
      throw new NotFoundException("Review not found.");
    }

    if (review.userId === userId) {
      throw new BadRequestException("You cannot vote on your own review.");
    }

    const existingVote = await this.prisma.reviewVote.findUnique({
      where: {
        userId_reviewId: { userId, reviewId },
      },
    });

    if (existingVote) {
      if (existingVote.helpful === helpful) {
        // Remove vote
        await this.prisma.reviewVote.delete({
          where: { id: existingVote.id },
        });
        if (existingVote.helpful) {
          await this.prisma.review.update({
            where: { id: reviewId },
            data: { helpfulCount: { decrement: 1 } },
          });
        }
        return { message: "Vote removed.", voted: null };
      }

      // Toggle vote
      await this.prisma.reviewVote.update({
        where: { id: existingVote.id },
        data: { helpful },
      });
      await this.prisma.review.update({
        where: { id: reviewId },
        data: {
          helpfulCount: helpful ? { increment: 1 } : { decrement: 1 },
        },
      });
      return { message: "Vote updated.", voted: helpful };
    }

    await this.prisma.reviewVote.create({
      data: { userId, reviewId, helpful },
    });

    if (helpful) {
      await this.prisma.review.update({
        where: { id: reviewId },
        data: { helpfulCount: { increment: 1 } },
      });
    }

    return { message: "Vote recorded.", voted: helpful };
  }

  // --- Bookmark Folders ---

  async listBookmarkFolders(userId: string) {
    const folders = await this.prisma.bookmarkFolder.findMany({
      where: { userId },
      include: {
        _count: { select: { bookmarks: true } },
      },
      orderBy: { sortOrder: "asc" },
    });

    return {
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        sortOrder: f.sortOrder,
        bookmarkCount: f._count.bookmarks,
      })),
    };
  }

  async createBookmarkFolder(userId: string, name: string) {
    const existingCount = await this.prisma.bookmarkFolder.count({
      where: { userId },
    });

    const folder = await this.prisma.bookmarkFolder.create({
      data: {
        userId,
        name: name.trim(),
        sortOrder: existingCount,
      },
    });

    return { folder: { id: folder.id, name: folder.name, sortOrder: folder.sortOrder } };
  }

  async deleteBookmarkFolder(userId: string, folderId: string) {
    const folder = await this.prisma.bookmarkFolder.findFirst({
      where: { id: folderId, userId },
    });

    if (!folder) {
      throw new NotFoundException("Bookmark folder not found.");
    }

    // Unassign bookmarks from folder before deleting
    await this.prisma.bookmark.updateMany({
      where: { folderId },
      data: { folderId: null },
    });

    await this.prisma.bookmarkFolder.delete({
      where: { id: folderId },
    });

    return { message: "Folder deleted." };
  }

  async moveBookmarkToFolder(
    userId: string,
    bookmarkId: string,
    folderId: string | null,
  ) {
    const bookmark = await this.prisma.bookmark.findFirst({
      where: { id: bookmarkId, userId },
    });

    if (!bookmark) {
      throw new NotFoundException("Bookmark not found.");
    }

    if (folderId) {
      const folder = await this.prisma.bookmarkFolder.findFirst({
        where: { id: folderId, userId },
      });
      if (!folder) {
        throw new NotFoundException("Folder not found.");
      }
    }

    await this.prisma.bookmark.update({
      where: { id: bookmarkId },
      data: { folderId },
    });

    return { message: folderId ? "Bookmark moved to folder." : "Bookmark removed from folder." };
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
      take: 1,
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

  private async getPublishedStories(
    input: {
      genre?: string;
      limit?: number | null;
      offset?: number | null;
      orderMode?: "default" | "trending" | "fresh";
      query?: string;
    } = {},
    options?: {
      cacheKeyLabel?: string;
      cacheTtlSeconds?: number;
    },
  ): Promise<PublishedStoryCatalogRecord[]> {
    const cacheKeyLabel = options?.cacheKeyLabel ?? "metadata";
    const cacheTtlSeconds =
      options?.cacheTtlSeconds ?? PUBLISHED_STORY_METADATA_CACHE_TTL_SECONDS;
    const cacheKey = this.getPublishedStoriesCacheKey(input, cacheKeyLabel);
    const cachedStories =
      await this.redisService.getJson<CachedPublishedStoryCatalogRecord[]>(cacheKey);

    if (cachedStories) {
      return this.hydratePublishedStoryCatalog(cachedStories);
    }

    const { stories } = await this.queryPublishedStories(input);

    await this.redisService.setJson(
      cacheKey,
      this.serializePublishedStoryCatalog(stories),
      cacheTtlSeconds,
    );

    return stories;
  }

  private async queryPublishedStories(input: {
    editorPick?: boolean;
    genre?: string;
    limit?: number | null;
    minRating?: number | null;
    offset?: number | null;
    orderMode?: "default" | "trending" | "fresh" | "new_listings" | "rating" | "reads" | "editor_pick";
    publishedSince?: Date;
    query?: string;
    statusFilter?: string;
    tags?: string[];
  }) {
    const limit = input.limit ?? null;
    const offset = input.offset ?? null;
    const orderMode = input.orderMode ?? "default";
    const orderBy: Prisma.StoryOrderByWithRelationInput[] =
      orderMode === "trending"
        ? [
            {
              totalReads: Prisma.SortOrder.desc,
            },
            {
              updatedAt: Prisma.SortOrder.desc,
            },
          ]
        : orderMode === "fresh"
          ? [
              {
                latestChapterAt: {
                  sort: Prisma.SortOrder.desc,
                  nulls: Prisma.NullsOrder.last,
                },
              },
              {
                updatedAt: Prisma.SortOrder.desc,
              },
            ]
          : orderMode === "new_listings"
            ? [
                {
                  liveAt: {
                    sort: Prisma.SortOrder.desc,
                    nulls: Prisma.NullsOrder.last,
                  },
                },
                {
                  publishedAt: {
                    sort: Prisma.SortOrder.desc,
                    nulls: Prisma.NullsOrder.last,
                  },
                },
                {
                  createdAt: Prisma.SortOrder.desc,
                },
              ]
            : orderMode === "rating"
              ? [
                  {
                    averageRating: Prisma.SortOrder.desc,
                  },
                  {
                    reviewCount: Prisma.SortOrder.desc,
                  },
                  {
                    updatedAt: Prisma.SortOrder.desc,
                  },
                ]
              : orderMode === "reads"
                ? [
                    {
                      totalReads: Prisma.SortOrder.desc,
                    },
                    {
                      updatedAt: Prisma.SortOrder.desc,
                    },
                  ]
                : orderMode === "editor_pick"
                  ? [
                      {
                        editorPickedAt: {
                          sort: Prisma.SortOrder.desc,
                          nulls: Prisma.NullsOrder.last,
                        },
                      },
                      {
                        averageRating: Prisma.SortOrder.desc,
                      },
                      {
                        updatedAt: Prisma.SortOrder.desc,
                      },
                    ]
                  : [
                    {
                      featured: Prisma.SortOrder.desc,
                    },
                    {
                      totalReads: Prisma.SortOrder.desc,
                    },
                    {
                      updatedAt: Prisma.SortOrder.desc,
                    },
                  ];
    const stories: PublishedStoryCatalogRecord[] = await this.prisma.story.findMany({
      where: this.buildPublishedStoryWhere(input),
      select: publishedStoryCatalogSelect,
      orderBy,
      skip: offset ?? undefined,
      take: limit ? limit + 1 : undefined,
    });
    const hasMore = Boolean(limit && stories.length > limit);

    return {
      pageInfo: {
        hasMore,
        limit,
        nextOffset: hasMore && limit !== null ? (offset ?? 0) + limit : null,
        offset: offset ?? 0,
      },
      stories: hasMore && limit !== null ? stories.slice(0, limit) : stories,
    };
  }

  private getPublishedStoriesCacheKey(
    input: {
      genre?: string;
      limit?: number | null;
      offset?: number | null;
      orderMode?: "default" | "trending" | "fresh";
      query?: string;
    },
    cacheKeyLabel: string,
  ) {
    const normalizedGenre = this.normalizeOptionalQuery(input.genre) ?? "all";
    const normalizedQuery = this.normalizeOptionalQuery(input.query) ?? "all";
    const limit = input.limit ?? "all";
    const offset = input.offset ?? 0;
    const orderMode = input.orderMode ?? "default";

    return `reader:published-stories:${cacheKeyLabel}:${normalizedGenre}:${normalizedQuery}:${orderMode}:${limit}:${offset}`;
  }

  private serializePublishedStoryCatalog(
    stories: PublishedStoryCatalogRecord[],
  ): CachedPublishedStoryCatalogRecord[] {
    return stories.map((story) => ({
      ...story,
      createdAt: story.createdAt.getTime(),
      latestChapterAt: story.latestChapterAt ? story.latestChapterAt.getTime() : null,
      liveAt: story.liveAt ? story.liveAt.getTime() : null,
      publishedAt: story.publishedAt ? story.publishedAt.getTime() : null,
      publishedChapters: story.publishedChapters.map((chapter) => ({
        chapterNumber: chapter.chapterNumber,
        publishedAt: chapter.publishedAt.getTime(),
        slug: chapter.slug,
        title: chapter.title,
      })),
    }));
  }

  private hydratePublishedStoryCatalog(
    stories: CachedPublishedStoryCatalogRecord[],
  ): PublishedStoryCatalogRecord[] {
    return stories.map((story) => ({
      ...story,
      createdAt: new Date(story.createdAt),
      latestChapterAt: story.latestChapterAt ? new Date(story.latestChapterAt) : null,
      liveAt: story.liveAt ? new Date(story.liveAt) : null,
      publishedAt: story.publishedAt ? new Date(story.publishedAt) : null,
      publishedChapters: story.publishedChapters.map((chapter) => ({
        chapterNumber: chapter.chapterNumber,
        publishedAt: new Date(chapter.publishedAt),
        slug: chapter.slug,
        title: chapter.title,
      })),
    }));
  }

  private async getRecommendedStoryCards(input: {
    excludeSeenStories?: boolean;
    excludeStoryIds?: string[];
    limit?: number | null;
    sourceStory?: StoryCardSource | null;
    stories: StoryCardSource[];
    userId: string;
  }) {
    const recommendationSignals = await this.buildRecommendationSignals({
      sourceStory: input.sourceStory ?? null,
      stories: input.stories,
      userId: input.userId,
    });
    const baseExcludedStoryIds = new Set(input.excludeStoryIds ?? []);
    const excludedStoryIds = new Set(baseExcludedStoryIds);

    if (input.excludeSeenStories) {
      for (const storyId of recommendationSignals.engagedStoryIds) {
        excludedStoryIds.add(storyId);
      }
    }

    if (input.sourceStory) {
      baseExcludedStoryIds.add(input.sourceStory.id);
      excludedStoryIds.add(input.sourceStory.id);
    }

    const scoredStories = this.getScoredRecommendationCandidates(
      input.stories,
      excludedStoryIds,
      recommendationSignals,
    );
    const fallbackStories =
      scoredStories.length > 0
        ? scoredStories
        : this.getScoredRecommendationCandidates(
            input.stories,
            baseExcludedStoryIds,
            recommendationSignals,
          );

    return {
      selectedGenres: recommendationSignals.selectedGenres,
      stories: this.dedupeStoryCards(
        fallbackStories,
        input.limit === undefined ? 6 : input.limit,
      ),
    };
  }

  private async buildRecommendationSignals(input: {
    sourceStory: StoryCardSource | null;
    stories: StoryCardSource[];
    userId: string;
  }) {
    const publishedStoryIds = input.stories.map((story) => story.id);
    const storyById = new Map(
      input.stories.map((story) => [story.id, story] as const),
    );
    const cacheKey = this.getRecommendationSignalsCacheKey(input.userId);
    let signalSnapshot =
      await this.redisService.getJson<RecommendationSignalSnapshot>(cacheKey);

    if (!signalSnapshot) {
      signalSnapshot = await this.loadRecommendationSignalSnapshot(input.userId);
      await this.redisService.setJson(
        cacheKey,
        signalSnapshot,
        RECOMMENDATION_SIGNAL_CACHE_TTL_SECONDS,
      );
    }

    const {
      authorFollows,
      bookmarks,
      follows,
      ratings,
      readingListItems,
      readingProgress,
      reviews,
      selectedGenres,
    } = signalSnapshot;
    const engagedStoryIds = new Set<string>();
    const seedStoryWeights = new Map<string, number>();
    const genreAffinity = new Map<string, number>();
    const tagAffinity = new Map<string, number>();
    const authorAffinity = new Map<string, number>();

    const applyStorySignal = (
      storyId: string | null | undefined,
      weight: number,
    ) => {
      if (!storyId) {
        return;
      }

      const story = storyById.get(storyId);

      if (!story) {
        return;
      }

      engagedStoryIds.add(storyId);

      if (weight <= 0) {
        return;
      }

      this.addWeightedValue(seedStoryWeights, storyId, weight);

      for (const genreSlug of story.genreSlugs) {
        this.addWeightedValue(
          genreAffinity,
          this.normalizeTerm(genreSlug),
          weight * 1.45,
        );
      }

      for (const tagSlug of story.tagSlugs) {
        this.addWeightedValue(tagAffinity, this.normalizeTerm(tagSlug), weight);
      }

      if (story.authorId) {
        this.addWeightedValue(authorAffinity, story.authorId, weight * 0.9);
      }
    };

    for (const item of readingProgress) {
      const weight =
        item.progressPercent >= 90
          ? 3.8
          : item.progressPercent >= 65
            ? 3
            : item.progressPercent >= 35
              ? 2.2
              : 1.2;
      applyStorySignal(item.storyId, weight);
    }

    for (const item of bookmarks) {
      applyStorySignal(item.storyId, 1.8);
    }

    for (const item of readingListItems) {
      applyStorySignal(item.storyId, 1.5);
    }

    for (const item of follows) {
      applyStorySignal(item.storyId, 2.6);
    }

    for (const item of ratings) {
      const weight =
        item.rating >= 4 ? 2.4 + (item.rating - 4) * 0.8 : item.rating === 3 ? 1.4 : 0;
      applyStorySignal(item.storyId, weight);
    }

    for (const item of reviews) {
      const weight =
        item.rating >= 4 ? 3 + (item.rating - 4) * 0.8 : item.rating === 3 ? 1.8 : 0;
      applyStorySignal(item.storyId, weight);
    }

    for (const selectedGenre of selectedGenres) {
      this.addWeightedValue(
        genreAffinity,
        this.normalizeTerm(selectedGenre),
        3.2,
      );
    }

    for (const authorFollow of authorFollows) {
      if (!authorFollow.targetUserId) {
        continue;
      }

      this.addWeightedValue(authorAffinity, authorFollow.targetUserId, 3.8);
    }

    const collaborativeSeedEntries: Array<[string, number]> = [
      ...seedStoryWeights.entries(),
    ];

    if (input.sourceStory) {
      collaborativeSeedEntries.push([input.sourceStory.id, 6]);
    }

    collaborativeSeedEntries.sort((left, right) => right[1] - left[1]);

    const collaborativeCandidateScores = await this.buildCollaborativeCandidateScores({
      currentUserId: input.userId,
      publishedStoryIds,
      seedStoryWeights: new Map(collaborativeSeedEntries),
    });

    return {
      authorAffinity,
      collaborativeCandidateScores,
      engagedStoryIds,
      genreAffinity,
      sourceStory: input.sourceStory,
      selectedGenres,
      tagAffinity,
    };
  }

  private getRecommendationSignalsCacheKey(userId: string) {
    return `reader:recommendation-signals:${userId}`;
  }

  private async loadRecommendationSignalSnapshot(
    userId: string,
  ): Promise<RecommendationSignalSnapshot> {
    const [
      profile,
      readingProgress,
      bookmarks,
      follows,
      authorFollows,
      ratings,
      reviews,
      readingListItems,
    ] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { userId },
        select: { selectedGenres: true },
      }),
      this.prisma.readingProgress.findMany({
        where: {
          userId,
        },
        select: {
          progressPercent: true,
          storyId: true,
        },
      }),
      this.prisma.bookmark.findMany({
        where: {
          userId,
        },
        select: {
          storyId: true,
        },
      }),
      this.prisma.follow.findMany({
        where: {
          targetType: FollowTargetType.STORY,
          userId,
        },
        select: {
          storyId: true,
        },
      }),
      this.prisma.follow.findMany({
        where: {
          targetType: FollowTargetType.AUTHOR,
          targetUserId: {
            not: null,
          },
          userId,
        },
        select: {
          targetUserId: true,
        },
      }),
      this.prisma.storyRating.findMany({
        where: {
          userId,
        },
        select: {
          rating: true,
          storyId: true,
        },
      }),
      this.prisma.review.findMany({
        where: {
          status: ReviewStatus.VISIBLE,
          userId,
        },
        select: {
          rating: true,
          storyId: true,
        },
      }),
      this.prisma.readingListItem.findMany({
        where: {
          readingList: {
            userId,
          },
        },
        select: {
          storyId: true,
        },
      }),
    ]);

    return {
      authorFollows,
      bookmarks,
      follows,
      ratings,
      readingListItems,
      readingProgress,
      reviews,
      selectedGenres: profile?.selectedGenres ?? [],
    };
  }

  private async buildCollaborativeCandidateScores(input: {
    currentUserId: string;
    publishedStoryIds: string[];
    seedStoryWeights: Map<string, number>;
  }) {
    const topSeedStories = Array.from(input.seedStoryWeights.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12);

    if (!topSeedStories.length) {
      return new Map<string, number>();
    }

    const seedStoryWeightMap = new Map(topSeedStories);
    const seedStoryIds = topSeedStories.map(([storyId]) => storyId);
    const peerWeights = new Map<string, number>();
    const addPeerWeight = (
      userId: string,
      storyId: string | null | undefined,
      amount: number,
    ) => {
      if (!storyId || amount <= 0) {
        return;
      }

      const seedWeight = seedStoryWeightMap.get(storyId);

      if (!seedWeight) {
        return;
      }

      this.addWeightedValue(peerWeights, userId, seedWeight * amount);
    };

    const [peerProgress, peerBookmarks, peerStoryFollows, peerRatings, peerReviews] =
      await Promise.all([
        this.prisma.readingProgress.findMany({
          where: {
            progressPercent: {
              gte: 30,
            },
            storyId: {
              in: seedStoryIds,
            },
            userId: {
              not: input.currentUserId,
            },
          },
          select: {
            progressPercent: true,
            storyId: true,
            userId: true,
          },
        }),
        this.prisma.bookmark.findMany({
          where: {
            storyId: {
              in: seedStoryIds,
            },
            userId: {
              not: input.currentUserId,
            },
          },
          select: {
            storyId: true,
            userId: true,
          },
        }),
        this.prisma.follow.findMany({
          where: {
            storyId: {
              in: seedStoryIds,
            },
            targetType: FollowTargetType.STORY,
            userId: {
              not: input.currentUserId,
            },
          },
          select: {
            storyId: true,
            userId: true,
          },
        }),
        this.prisma.storyRating.findMany({
          where: {
            rating: {
              gte: 4,
            },
            storyId: {
              in: seedStoryIds,
            },
            userId: {
              not: input.currentUserId,
            },
          },
          select: {
            rating: true,
            storyId: true,
            userId: true,
          },
        }),
        this.prisma.review.findMany({
          where: {
            rating: {
              gte: 4,
            },
            status: ReviewStatus.VISIBLE,
            storyId: {
              in: seedStoryIds,
            },
            userId: {
              not: input.currentUserId,
            },
          },
          select: {
            rating: true,
            storyId: true,
            userId: true,
          },
        }),
      ]);

    for (const item of peerProgress) {
      addPeerWeight(
        item.userId,
        item.storyId,
        item.progressPercent >= 85
          ? 1.4
          : item.progressPercent >= 60
            ? 1.15
            : 0.8,
      );
    }

    for (const item of peerBookmarks) {
      addPeerWeight(item.userId, item.storyId, 1.1);
    }

    for (const item of peerStoryFollows) {
      addPeerWeight(item.userId, item.storyId, 1.35);
    }

    for (const item of peerRatings) {
      addPeerWeight(item.userId, item.storyId, 1.1 + (item.rating - 4) * 0.35);
    }

    for (const item of peerReviews) {
      addPeerWeight(item.userId, item.storyId, 1.45 + (item.rating - 4) * 0.3);
    }

    const topPeers = Array.from(peerWeights.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 24);

    if (!topPeers.length) {
      return new Map<string, number>();
    }

    const topPeerWeightMap = new Map(topPeers);
    const peerUserIds = topPeers.map(([userId]) => userId);
    const candidateScores = new Map<string, number>();
    const addCandidateScore = (
      userId: string,
      storyId: string | null | undefined,
      amount: number,
    ) => {
      if (!storyId || amount <= 0) {
        return;
      }

      const peerWeight = topPeerWeightMap.get(userId);

      if (!peerWeight) {
        return;
      }

      this.addWeightedValue(candidateScores, storyId, peerWeight * amount);
    };
    const [candidateProgress, candidateBookmarks, candidateStoryFollows, candidateRatings, candidateReviews] =
      await Promise.all([
        this.prisma.readingProgress.findMany({
          where: {
            progressPercent: {
              gte: 30,
            },
            storyId: {
              in: input.publishedStoryIds,
            },
            userId: {
              in: peerUserIds,
            },
          },
          select: {
            progressPercent: true,
            storyId: true,
            userId: true,
          },
        }),
        this.prisma.bookmark.findMany({
          where: {
            storyId: {
              in: input.publishedStoryIds,
            },
            userId: {
              in: peerUserIds,
            },
          },
          select: {
            storyId: true,
            userId: true,
          },
        }),
        this.prisma.follow.findMany({
          where: {
            storyId: {
              in: input.publishedStoryIds,
            },
            targetType: FollowTargetType.STORY,
            userId: {
              in: peerUserIds,
            },
          },
          select: {
            storyId: true,
            userId: true,
          },
        }),
        this.prisma.storyRating.findMany({
          where: {
            rating: {
              gte: 4,
            },
            storyId: {
              in: input.publishedStoryIds,
            },
            userId: {
              in: peerUserIds,
            },
          },
          select: {
            rating: true,
            storyId: true,
            userId: true,
          },
        }),
        this.prisma.review.findMany({
          where: {
            rating: {
              gte: 4,
            },
            status: ReviewStatus.VISIBLE,
            storyId: {
              in: input.publishedStoryIds,
            },
            userId: {
              in: peerUserIds,
            },
          },
          select: {
            rating: true,
            storyId: true,
            userId: true,
          },
        }),
      ]);

    for (const item of candidateProgress) {
      addCandidateScore(
        item.userId,
        item.storyId,
        item.progressPercent >= 85
          ? 1.1
          : item.progressPercent >= 60
            ? 0.9
            : 0.65,
      );
    }

    for (const item of candidateBookmarks) {
      addCandidateScore(item.userId, item.storyId, 0.95);
    }

    for (const item of candidateStoryFollows) {
      addCandidateScore(item.userId, item.storyId, 1.2);
    }

    for (const item of candidateRatings) {
      addCandidateScore(
        item.userId,
        item.storyId,
        0.95 + (item.rating - 4) * 0.25,
      );
    }

    for (const item of candidateReviews) {
      addCandidateScore(
        item.userId,
        item.storyId,
        1.2 + (item.rating - 4) * 0.25,
      );
    }

    return candidateScores;
  }

  private scoreRecommendedStory(
    story: StoryCardSource,
    signals: {
      authorAffinity: Map<string, number>;
      collaborativeCandidateScores: Map<string, number>;
      genreAffinity: Map<string, number>;
      sourceStory: StoryCardSource | null;
      tagAffinity: Map<string, number>;
    },
  ) {
    const sourceStory = signals.sourceStory;
    const sharedGenreCount = sourceStory
      ? story.genreSlugs.filter((genreSlug) =>
          sourceStory.genreSlugs.includes(genreSlug),
        ).length
      : 0;
    const sharedTagCount = sourceStory
      ? story.tagSlugs.filter((tagSlug) => sourceStory.tagSlugs.includes(tagSlug))
          .length
      : 0;
    const sourceStoryScore =
      sharedGenreCount * 5.6 +
      sharedTagCount * 2.6 +
      (sourceStory?.authorId &&
      story.authorId &&
      sourceStory.authorId === story.authorId
        ? 1.75
        : 0);
    const genreAffinityScore = Math.min(
      14,
      this.getSlugAffinityScore(signals.genreAffinity, story.genreSlugs) * 0.7,
    );
    const tagAffinityScore = Math.min(
      9,
      this.getSlugAffinityScore(signals.tagAffinity, story.tagSlugs) * 0.55,
    );
    const authorAffinityScore = Math.min(
      7,
      (story.authorId ? signals.authorAffinity.get(story.authorId) ?? 0 : 0) * 0.8,
    );
    const collaborativeScore = Math.min(
      18,
      Math.log1p(signals.collaborativeCandidateScores.get(story.id) ?? 0) * 4.8,
    );
    const freshnessScore = this.getStoryFreshnessScore(story);
    const popularityScore =
      Math.log1p(story.totalReads) * 0.8 +
      story.averageRating * 0.95 +
      Math.min(3.5, story.reviewCount / 18) +
      freshnessScore;

    return (
      sourceStoryScore +
      genreAffinityScore +
      tagAffinityScore +
      authorAffinityScore +
      collaborativeScore +
      popularityScore
    );
  }

  private getScoredRecommendationCandidates(
    stories: StoryCardSource[],
    excludedStoryIds: Set<string>,
    signals: {
      authorAffinity: Map<string, number>;
      collaborativeCandidateScores: Map<string, number>;
      genreAffinity: Map<string, number>;
      sourceStory: StoryCardSource | null;
      tagAffinity: Map<string, number>;
    },
  ) {
    return stories
      .filter((story) => !excludedStoryIds.has(story.id))
      .map((story) => ({
        score: this.scoreRecommendedStory(story, signals),
        story,
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        if (right.story.averageRating !== left.story.averageRating) {
          return right.story.averageRating - left.story.averageRating;
        }

        if (right.story.reviewCount !== left.story.reviewCount) {
          return right.story.reviewCount - left.story.reviewCount;
        }

        if (right.story.totalReads !== left.story.totalReads) {
          return right.story.totalReads - left.story.totalReads;
        }

        return (
          (right.story.latestChapterAt?.getTime() ?? 0) -
          (left.story.latestChapterAt?.getTime() ?? 0)
        );
      })
      .map((entry) => entry.story);
  }

  /**
   * Fetches a targeted pool of recommendation candidates for a given story
   * instead of loading the entire published catalog. Uses genre overlap
   * (GIN-indexed) + top-rated fallback, capped at ~50 candidates.
   */
  private async getRecommendationCandidatesForStory(
    story: { id: string; genreSlugs: string[]; authorId?: string | null },
  ): Promise<PublishedStoryCatalogRecord[]> {
    const cacheKey = `reader:rec-candidates:${story.id}`;
    const cached =
      await this.redisService.getJson<CachedPublishedStoryCatalogRecord[]>(cacheKey);

    if (cached) {
      return this.hydratePublishedStoryCatalog(cached);
    }

    const liveFilter: Prisma.StoryWhereInput = {
      OR: [
        { adminControl: { is: { visibilityState: AdminBookVisibilityState.LIVE } } },
        { adminControl: { is: null }, isLive: true },
      ],
    };

    const baseWhere: Prisma.StoryWhereInput = {
      ...liveFilter,
      id: { not: story.id },
      deletedAt: null,
      status: { in: [StoryStatus.PUBLISHED, StoryStatus.COMPLETED, StoryStatus.HIATUS] },
    };

    // Fetch genre-matched stories (uses GIN index on genreSlugs)
    const genreMatchPromise =
      story.genreSlugs.length > 0
        ? this.prisma.story.findMany({
            where: {
              ...baseWhere,
              genreSlugs: { hasSome: story.genreSlugs },
            },
            select: publishedStoryCatalogSelect,
            orderBy: [{ totalReads: "desc" }, { averageRating: "desc" }],
            take: 30,
          })
        : Promise.resolve([]);

    // Fetch top-rated as fallback diversity
    const topRatedPromise = this.prisma.story.findMany({
      where: baseWhere,
      select: publishedStoryCatalogSelect,
      orderBy: [{ averageRating: "desc" }, { totalReads: "desc" }],
      take: 20,
    });

    const [genreMatched, topRated] = await Promise.all([
      genreMatchPromise,
      topRatedPromise,
    ]);

    // Dedupe by id, genre-matched first (higher relevance)
    const seen = new Set<string>();
    const candidates: PublishedStoryCatalogRecord[] = [];
    for (const s of [...genreMatched, ...topRated]) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        candidates.push(s);
      }
    }

    await this.redisService.setJson(
      cacheKey,
      this.serializePublishedStoryCatalog(candidates),
      5 * 60,
    );

    return candidates;
  }

  private async getReadableStoryBySlug(storySlug: string) {
    const cacheKey = `story:detail:v2:${storySlug}`;
    const cached = await this.redisService.getJson<StoryWithReaderRelations>(cacheKey);

    if (cached) {
      return cached;
    }

    const story = await this.prisma.story.findUnique({
      where: { slug: storySlug },
      include: readableStoryForReaderInclude,
    });

    if (!story || story.deletedAt || !this.isReadableStatus(story.status) || !isStoryLive(story)) {
      throw new NotFoundException("Story not found.");
    }

    await this.redisService.setJson(cacheKey, story, 600);
    return story;
  }

  private async getStoryAggregates(
    storyId: string,
    authorId: string | null | undefined,
  ) {
    const cacheKey = `story:agg:${storyId}`;
    const cached = await this.redisService.getJson<{
      authorFollowerCount: number;
      authorStoryCount: number;
      storyFollowerCount: number;
      writtenReviewCount: number;
    }>(cacheKey);

    if (cached) {
      return cached;
    }

    const [writtenReviewCount, storyFollowerCount, authorFollowerCount, authorStoryCount] =
      await Promise.all([
        this.prisma.review.count({
          where: {
            storyId,
            status: ReviewStatus.VISIBLE,
          },
        }),
        this.prisma.follow.count({
          where: {
            storyId,
            targetType: FollowTargetType.STORY,
          },
        }),
        authorId
          ? this.prisma.follow.count({
              where: {
                targetType: FollowTargetType.AUTHOR,
                targetUserId: authorId,
              },
            })
          : Promise.resolve(0),
        authorId
          ? this.prisma.story.count({
              where: {
                authorId,
                status: {
                  in: [StoryStatus.PUBLISHED, StoryStatus.COMPLETED, StoryStatus.HIATUS],
                },
                deletedAt: null,
                OR: [
                  { adminControl: { is: { visibilityState: AdminBookVisibilityState.LIVE } } },
                  { adminControl: { is: null }, isLive: true },
                ],
              },
            })
          : Promise.resolve(0),
      ]);

    const result = { authorFollowerCount, authorStoryCount, storyFollowerCount, writtenReviewCount };
    await this.redisService.setJson(cacheKey, result, 900);
    return result;
  }

  async invalidateStoryCache(storySlug: string, storyId?: string) {
    await this.redisService.delete(`story:detail:${storySlug}`);
    await this.redisService.delete(`story:detail:v2:${storySlug}`);
    if (storyId) {
      await this.redisService.delete(`story:agg:${storyId}`);
      await this.redisService.delete(`reader:rec-candidates:${storyId}`);
    }
  }

  async getActivePopupPromos() {
    const promos = await this.prisma.popupPromo.findMany({
      where: { isActive: true },
      orderBy: { priority: "desc" },
      select: {
        id: true,
        imageUrl: true,
        title: true,
        subtitle: true,
        linkType: true,
        linkTarget: true,
        triggerTiming: true,
        delaySeconds: true,
        story: { select: { slug: true } },
      },
    });

    return {
      promos: promos.map((p) => ({
        id: p.id,
        imageUrl: p.imageUrl,
        title: p.title,
        subtitle: p.subtitle,
        linkType: p.linkType,
        linkTarget: p.linkTarget,
        triggerTiming: p.triggerTiming,
        delaySeconds: p.delaySeconds,
        storySlug: p.story.slug,
      })),
    };
  }

  private buildPublishedStoryWhere(input: {
    editorPick?: boolean;
    genre?: string;
    minRating?: number | null;
    publishedSince?: Date;
    query?: string;
    statusFilter?: string;
    tags?: string[];
  }): Prisma.StoryWhereInput {
    const normalizedGenre = this.normalizeOptionalQuery(input.genre);
    const normalizedGenreSlug = normalizedGenre ? this.toSlug(normalizedGenre) : null;
    const normalizedQuery = this.normalizeOptionalQuery(input.query);
    const normalizedQuerySlug = normalizedQuery ? this.toSlug(normalizedQuery) : null;
    const andFilters: Prisma.StoryWhereInput[] = [
      {
        OR: [
          {
            adminControl: {
              is: {
                visibilityState: AdminBookVisibilityState.LIVE,
              },
            },
          },
          {
            adminControl: {
              is: null,
            },
            isLive: true,
          },
        ],
      },
    ];

    if (input.publishedSince) {
      const since = input.publishedSince;
      andFilters.push({
        OR: [
          { liveAt: { gte: since } },
          {
            AND: [{ liveAt: null }, { publishedAt: { gte: since } }],
          },
          {
            AND: [{ liveAt: null }, { publishedAt: null }, { createdAt: { gte: since } }],
          },
        ],
      });
    }

    if (normalizedGenreSlug) {
      andFilters.push({
        genreSlugs: {
          has: normalizedGenreSlug,
        },
      });
    }

    if (input.tags && input.tags.length > 0) {
      const normalizedTags = input.tags
        .map((tag) => this.toSlug(tag))
        .filter(Boolean);
      if (normalizedTags.length > 0) {
        andFilters.push({
          tagSlugs: {
            hasSome: normalizedTags,
          },
        });
      }
    }

    if (normalizedQuery) {
      andFilters.push({
        OR: [
          {
            title: {
              contains: normalizedQuery,
              mode: "insensitive",
            },
          },
          {
            shortSynopsis: {
              contains: normalizedQuery,
              mode: "insensitive",
            },
          },
          {
            synopsis: {
              contains: normalizedQuery,
              mode: "insensitive",
            },
          },
          {
            authorName: {
              contains: normalizedQuery,
              mode: "insensitive",
            },
          },
          ...(normalizedQuerySlug
            ? [
                {
                  genreSlugs: {
                    has: normalizedQuerySlug,
                  },
                },
                {
                  tagSlugs: {
                    has: normalizedQuerySlug,
                  },
                },
              ]
            : []),
        ],
      });
    }

    if (input.minRating != null && input.minRating > 0) {
      andFilters.push({
        averageRating: { gte: input.minRating },
      });
    }

    if (input.editorPick) {
      andFilters.push({ editorPick: true });
    }

    const statusFilterMap: Record<string, StoryStatus> = {
      completed: StoryStatus.COMPLETED,
      ongoing: StoryStatus.PUBLISHED,
      hiatus: StoryStatus.HIATUS,
    };
    const mappedStatus = input.statusFilter ? statusFilterMap[input.statusFilter] : undefined;

    return {
      AND: andFilters,
      deletedAt: null,
      status: mappedStatus
        ? { equals: mappedStatus }
        : { in: [StoryStatus.PUBLISHED, StoryStatus.COMPLETED, StoryStatus.HIATUS] },
    };
  }

  private async requireActiveUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        profile: true,
      },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new NotFoundException("User not found.");
    }

    return user;
  }

  private async getCommentableChapterTarget(
    userId: string,
    storySlug: string,
    chapterSlug: string,
  ) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const chapter =
      story.publishedChapters.find((item) => item.slug === chapterSlug) ?? null;

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

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

    return {
      chapter,
      story,
    };
  }

  private async recalculateStoryRatingSummary(storyId: string) {
    const ratingSummary = await this.prisma.storyRating.aggregate({
      _avg: {
        rating: true,
      },
      _count: {
        _all: true,
      },
      where: {
        storyId,
      },
    });
    const averageRating = Number((ratingSummary._avg.rating ?? 0).toFixed(4));
    const reviewCount = ratingSummary._count._all;

    await this.prisma.story.update({
      where: {
        id: storyId,
      },
      data: {
        averageRating,
        reviewCount,
      },
    });

    return {
      averageRating,
      reviewCount,
    };
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

  /**
   * Star ratings (1–5): any signed-in reader may rate, except the author and empty books.
   * Written reviews still use {@link getStoryWrittenReviewEligibility}.
   */
  private getStoryStarRatingEligibility(input: {
    authorId: string | null;
    publishedChapterCount: number;
    userId: string;
  }): Pick<StoryRatingEligibility, "canRate" | "ratingEligibilityMessage"> {
    if (input.publishedChapterCount === 0) {
      return {
        canRate: false,
        ratingEligibilityMessage:
          "This book has no published chapters available for rating yet.",
      };
    }
    if (input.authorId && input.authorId === input.userId) {
      return {
        canRate: false,
        ratingEligibilityMessage: "You can't rate your own book.",
      };
    }
    return {
      canRate: true,
      ratingEligibilityMessage: null,
    };
  }

  /** Full written review: requires unlocking all chapters and finishing the story. */
  private getStoryWrittenReviewEligibility(input: {
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

  private getFirstPublishedChapter(story: StoryCardSource) {
    return story.publishedChapters[0] ?? null;
  }

  private getPublishedChapterCount(story: StoryCardSource) {
    return story._count?.publishedChapters ?? story.publishedChapters.length;
  }

  private publishedCatalogRecordToStoryCardSource(
    story: PublishedStoryCatalogRecord,
  ): StoryCardSource {
    return {
      adminControl: story.adminControl
        ? {
            visibilityState: getStoryVisibilityState(story),
          }
        : null,
      assets: story.assets,
      authorId: story.authorId,
      authorName: story.authorName,
      averageRating: story.averageRating,
      createdAt: story.createdAt,
      featured: story.featured ?? undefined,
      genreSlugs: story.genreSlugs,
      id: story.id,
      isLive: story.isLive,
      latestChapterAt: story.latestChapterAt,
      liveAt: story.liveAt,
      publishedAt: story.publishedAt,
      publishedChapters: story.publishedChapters.map((chapter) => ({
        chapterNumber: chapter.chapterNumber,
        publishedAt: chapter.publishedAt ?? undefined,
        slug: chapter.slug,
        title: chapter.title ?? undefined,
      })),
      reviewCount: story.reviewCount,
      shortSynopsis: story.shortSynopsis,
      slug: story.slug,
      status: story.status,
      synopsis: story.synopsis,
      tagSlugs: story.tagSlugs,
      title: story.title,
      totalReads: story.totalReads,
      _count: story._count,
    };
  }

  private toStoryCardSource(story: StoryWithReaderRelations): StoryCardSource {
    return {
      adminControl: story.adminControl
        ? {
            visibilityState: getStoryVisibilityState(story),
          }
        : null,
      assets: story.assets,
      authorId: story.authorId ?? null,
      authorName: story.authorName,
      averageRating: story.averageRating,
      createdAt: story.createdAt,
      featured: story.featured,
      genreSlugs: story.genreSlugs,
      id: story.id,
      isLive: story.isLive,
      latestChapterAt: story.latestChapterAt ?? null,
      liveAt: story.liveAt ?? null,
      publishedAt: story.publishedAt ?? null,
      publishedChapters: story.publishedChapters.slice(0, 1).map((chapter) => ({
        chapterNumber: chapter.chapterNumber,
        publishedAt: chapter.publishedAt,
        slug: chapter.slug,
        title: chapter.title,
      })),
      reviewCount: story.reviewCount,
      shortSynopsis: story.shortSynopsis,
      slug: story.slug,
      status: story.status,
      synopsis: story.synopsis,
      tagSlugs: story.tagSlugs,
      title: story.title,
      totalReads: story.totalReads,
      _count: {
        publishedChapters: story.publishedChapters.length,
      },
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

  private buildFollowSubjectKey(target: "author" | "story", targetId: string) {
    return `${target}:${targetId}`;
  }

  private getReadingListInclude() {
    return {
      user: {
        include: {
          profile: true,
        },
      },
      items: {
        orderBy: {
          addedAt: "desc" as const,
        },
        include: {
          story: {
            include: {
              adminControl: true,
              assets: true,
              publishedChapters: {
                include: {
                  adminOverride: true,
                  chapter: true,
                },
                orderBy: {
                  chapterNumber: "asc" as const,
                },
              },
            },
          },
        },
      },
    };
  }

  private async getOwnedReadingListOrThrow(userId: string, listId: string) {
    const list = await this.prisma.readingList.findFirst({
      where: {
        id: listId,
        userId,
      },
      include: this.getReadingListInclude(),
    });

    if (!list) {
      throw new NotFoundException("Reading list not found.");
    }

    return list;
  }

  private buildReadingListShareSlug() {
    return randomBytes(10).toString("hex");
  }

  private toReadingListVisibility(input: "private" | "public") {
    return input === "public"
      ? ReadingListVisibility.PUBLIC
      : ReadingListVisibility.PRIVATE;
  }

  private mapReadingList(list: ReadingListWithItems) {
    const stories = list.items
      .filter((item) => isStoryLive(item.story) && this.isReadableStatus(item.story.status))
      .map((item) => ({
        ...this.mapStoryCard(item.story),
        addedAt: item.addedAt,
        addedAtLabel: this.formatRelativeDate(item.addedAt),
      }));
    const previewCoverImages = stories
      .map((story) => story.coverImage)
      .filter(Boolean)
      .slice(0, 3);

    return {
      coverImage: previewCoverImages[0] ?? null,
      description: list.description ?? "",
      id: list.id,
      name: list.name,
      ownerAvatarUrl: list.user.profile?.avatarUrl ?? null,
      ownerDisplayName: this.getDisplayName(list.user),
      previewCoverImages,
      sharePath: `/reading-lists/shared/${list.shareSlug}`,
      shareSlug: list.shareSlug,
      storyCount: stories.length,
      stories,
      updatedAt: list.updatedAt,
      updatedAtLabel: this.formatRelativeDate(list.updatedAt),
      visibility:
        list.visibility === ReadingListVisibility.PUBLIC ? "public" : "private",
    };
  }

  private async mapReadingListDetails(
    list: ReadingListWithItems,
    viewerUserId: string | null,
    options: {
      viewerCanEdit: boolean;
    },
  ) {
    const summary = this.mapReadingList(list);
    const storyItems = list.items.filter(
      (item) => isStoryLive(item.story) && this.isReadableStatus(item.story.status),
    );
    const storyIds = storyItems.map((item) => item.story.id);
    const progressByStoryId = new Map<string, ReadingListProgressWithChapter>();

    if (viewerUserId && storyIds.length > 0) {
      const progressEntries = await this.prisma.readingProgress.findMany({
        where: {
          storyId: {
            in: storyIds,
          },
          userId: viewerUserId,
        },
        include: {
          chapter: true,
        },
      });

      for (const entry of progressEntries) {
        progressByStoryId.set(entry.storyId, entry);
      }
    }

    let unreadCount = 0;
    let inProgressCount = 0;
    let completedCount = 0;

    const stories = storyItems.map((item) => {
      const story = item.story;
      const progress = progressByStoryId.get(story.id) ?? null;
      const firstChapter = story.publishedChapters[0] ?? null;
      const latestChapter = story.publishedChapters.at(-1) ?? null;
      const hasCompletedStory = Boolean(
        progress &&
          latestChapter &&
          progress.publishedChapterId === latestChapter.id &&
          progress.progressPercent >= 100,
      );
      const readingState = !progress
        ? "unread"
        : hasCompletedStory
          ? "completed"
          : "in-progress";

      if (readingState === "unread") {
        unreadCount += 1;
      } else if (readingState === "completed") {
        completedCount += 1;
      } else {
        inProgressCount += 1;
      }

      return {
        ...this.mapStoryCard(story),
        addedAt: item.addedAt,
        addedAtLabel: this.getCommentTimestampLabel(item.addedAt),
        ctaLabel: !firstChapter
          ? "View Story"
          : readingState === "completed"
            ? "Re-read Story"
            : readingState === "in-progress"
              ? "Continue Reading"
              : "Start Reading",
        currentChapterNumber: progress?.chapter.chapterNumber ?? null,
        currentChapterSlug: progress?.chapter.slug ?? firstChapter?.slug ?? null,
        currentChapterTitle: progress?.chapter.title ?? firstChapter?.title ?? null,
        hasNewChapter: Boolean(
          progress?.lastReadAt &&
            latestChapter?.publishedAt &&
            latestChapter.publishedAt.getTime() > progress.lastReadAt.getTime(),
        ),
        latestChapterNumber: latestChapter?.chapterNumber ?? null,
        latestChapterTitle: latestChapter?.title ?? null,
        progressPercent: progress?.progressPercent ?? 0,
        progressLabel:
          readingState === "completed"
            ? "Completed"
            : readingState === "in-progress"
              ? `${progress?.progressPercent ?? 0}% complete`
              : "Unread",
        readingState,
        resumeLabel: progress
          ? this.getResumeLabel(progress.paragraphIndex, progress.progressPercent)
          : firstChapter
            ? `Start with Chapter ${firstChapter.chapterNumber}`
            : "View story details",
      };
    });

    return {
      ...summary,
      stats: {
        completedCount,
        inProgressCount,
        unreadCount,
      },
      stories,
      viewerCanEdit: options.viewerCanEdit,
    };
  }

  private mapCommentThread(
    comments: CommentWithAuthor[],
    currentUserId: string,
    sort: CommentSort,
  ): ReaderCommentNode[] {
    const repliesByParentId = new Map<string, CommentWithAuthor[]>();
    const topLevelComments = comments.filter((comment) => !comment.parentCommentId);

    for (const comment of comments) {
      if (!comment.parentCommentId || comment.status !== CommentStatus.VISIBLE) {
        continue;
      }

      const replies = repliesByParentId.get(comment.parentCommentId) ?? [];
      replies.push(comment);
      repliesByParentId.set(comment.parentCommentId, replies);
    }

    const sortedTopLevel = [...topLevelComments].sort((left, right) => {
      const leftReplies = repliesByParentId.get(left.id)?.length ?? 0;
      const rightReplies = repliesByParentId.get(right.id)?.length ?? 0;

      if (sort === "top" && rightReplies !== leftReplies) {
        return rightReplies - leftReplies;
      }

      return right.createdAt.getTime() - left.createdAt.getTime();
    });

    return sortedTopLevel.map((comment) =>
      this.mapCommentNode(
        comment,
        currentUserId,
        (repliesByParentId.get(comment.id) ?? []).sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        ),
      ),
    );
  }

  private mapStoryReview(
    review: ReviewWithAuthor,
    currentUserId: string,
    options: {
      includeStatus?: boolean;
    } = {},
  ) {
    return {
      author: {
        avatarUrl: review.user.profile?.avatarUrl ?? null,
        displayName: this.getDisplayName(review.user),
        id: review.user.id,
      },
      body: review.body,
      canDelete: review.userId === currentUserId && review.status === ReviewStatus.VISIBLE,
      canEdit: review.userId === currentUserId && review.status === ReviewStatus.VISIBLE,
      containsSpoilers: review.containsSpoilers,
      createdAt: review.createdAt,
      createdAtLabel: this.getCommentTimestampLabel(review.createdAt),
      editedAt: review.editedAt,
      editedLabel: review.editedAt ? "Edited" : null,
      id: review.id,
      isOwner: review.userId === currentUserId,
      moderationNotes: options.includeStatus ? review.moderationNotes ?? null : null,
      rating: review.rating,
      status: options.includeStatus ? review.status : undefined,
      statusLabel:
        options.includeStatus && review.status !== ReviewStatus.VISIBLE
          ? this.getReviewStatusLabel(review.status)
          : null,
      title: review.title ?? null,
    };
  }

  private mapCommentNode(
    comment: CommentWithAuthor,
    currentUserId: string,
    replies: CommentWithAuthor[],
  ): ReaderCommentNode {
    const isRemoved = comment.status !== CommentStatus.VISIBLE;

    return {
      author: {
        avatarUrl: comment.user.profile?.avatarUrl ?? null,
        displayName: this.getDisplayName(comment.user),
        id: comment.user.id,
      },
      body: isRemoved ? this.getRemovedCommentBody(comment.status) : comment.body,
      canDelete: comment.userId === currentUserId && comment.status === CommentStatus.VISIBLE,
      canEdit: comment.userId === currentUserId && comment.status === CommentStatus.VISIBLE,
      createdAt: comment.createdAt,
      createdAtLabel: this.getCommentTimestampLabel(comment.createdAt),
      editedAt: comment.editedAt,
      editedLabel: comment.editedAt ? "Edited" : null,
      id: comment.id,
      isOwner: comment.userId === currentUserId,
      isReply: Boolean(comment.parentCommentId),
      isRemoved,
      replyCount: replies.length,
      replies: replies.map((reply) => this.mapCommentNode(reply, currentUserId, [])),
    };
  }

  private mapFollowedStorySummary(follow: FollowWithTargets) {
    const story = follow.story!;
    const latestChapter = story.publishedChapters[0] ?? null;

    return {
      authorId: story.authorId ?? null,
      authorName: story.authorName,
      coverImage:
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        story.assets?.bannerImageUrl ??
        "",
      genreLabel: this.slugToLabel(story.genreSlugs[0] ?? "story"),
      id: story.id,
      latestChapterTitle: latestChapter?.title ?? null,
      latestPublishedAt: latestChapter?.publishedAt ?? null,
      latestPublishedAtLabel: latestChapter
        ? this.formatRelativeDate(latestChapter.publishedAt)
        : null,
      slug: story.slug,
      title: story.title,
    };
  }

  private buildRatingDistribution(ratings: Array<{ rating: number }>) {
    const totalCount = ratings.length;

    return [5, 4, 3, 2, 1].map((stars) => {
      const count = ratings.filter((rating) => rating.rating === stars).length;

      return {
        count,
        percent:
          totalCount > 0 ? Math.round((count / totalCount) * 100) : 0,
        stars,
      };
    });
  }

  private getDisplayName(user: {
    email: string | null;
    profile?: {
      displayName?: string | null;
    } | null;
  }) {
    return user.profile?.displayName?.trim() || user.email?.split("@")[0] || "TaleStead Reader";
  }

  private dedupeStoryCards(stories: StoryCardSource[], limit: number | null = 6) {
    const seen = new Set<string>();

    const deduped = stories.filter((story) => {
      if (seen.has(story.slug)) {
        return false;
      }

      seen.add(story.slug);
      return true;
    });

    const capped = limit === null ? deduped : deduped.slice(0, limit);

    return capped.map((story) => this.mapStoryCard(story));
  }

  private addWeightedValue(
    map: Map<string, number>,
    key: string,
    amount: number,
  ) {
    map.set(key, (map.get(key) ?? 0) + amount);
  }

  private getSlugAffinityScore(map: Map<string, number>, slugs: string[]) {
    const seenTerms = new Set<string>();
    let score = 0;

    for (const slug of slugs) {
      for (const term of [
        this.normalizeTerm(slug),
        this.normalizeTerm(this.slugToLabel(slug)),
      ]) {
        if (seenTerms.has(term)) {
          continue;
        }

        seenTerms.add(term);
        score += map.get(term) ?? 0;
      }
    }

    return score;
  }

  private getStoryFreshnessScore(story: StoryCardSource) {
    const latestActivity = story.latestChapterAt ?? story.publishedAt ?? null;

    if (!latestActivity) {
      return 0;
    }

    const ageInDays = Math.max(
      0,
      Math.floor((Date.now() - latestActivity.getTime()) / (24 * 60 * 60 * 1000)),
    );

    if (ageInDays <= 3) {
      return 3.2;
    }

    if (ageInDays <= 7) {
      return 2.3;
    }

    if (ageInDays <= 21) {
      return 1.2;
    }

    if (ageInDays <= 45) {
      return 0.5;
    }

    return 0;
  }

  private mapFeaturedStory(story: StoryCardSource) {
    const firstChapter = this.getFirstPublishedChapter(story);

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

  private mapHomeFeaturedStory(story: StoryCardSource) {
    const firstChapter = this.getFirstPublishedChapter(story);

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

  private mapStoryCard(story: StoryCardSource) {
    const firstChapter = this.getFirstPublishedChapter(story);

    return {
      authorName: story.authorName,
      averageRating: Number(story.averageRating.toFixed(1)),
      chapterCount: this.getPublishedChapterCount(story),
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

  private toSlug(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private estimateReadingMinutes(paragraphs: string[]) {
    const words = richTextToPlainText(paragraphs.join(" "))
      .split(/\s+/)
      .filter(Boolean).length;

    return Math.max(1, Math.ceil(words / 220));
  }

  private slugToLabel(value: string) {
    return labelFromGenreOrTagSlug(value);
  }

  private formatCompactNumber(value: number) {
    return new Intl.NumberFormat("en", {
      maximumFractionDigits: value >= 100_000 ? 0 : 1,
      notation: "compact",
    }).format(value);
  }

  private formatRelativeDate(value: Date | string | null | undefined) {
    if (value == null) {
      return "Recently updated";
    }
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) {
      return "Recently updated";
    }
    const diffInMs = Date.now() - d.getTime();
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

  private getCommentTimestampLabel(value: Date) {
    const formatter = new Intl.RelativeTimeFormat("en", {
      numeric: "auto",
    });
    const diffInSeconds = Math.round((value.getTime() - Date.now()) / 1000);

    if (Math.abs(diffInSeconds) < 60) {
      return formatter.format(Math.round(diffInSeconds), "second");
    }

    const diffInMinutes = Math.round(diffInSeconds / 60);

    if (Math.abs(diffInMinutes) < 60) {
      return formatter.format(diffInMinutes, "minute");
    }

    const diffInHours = Math.round(diffInMinutes / 60);

    if (Math.abs(diffInHours) < 24) {
      return formatter.format(diffInHours, "hour");
    }

    const diffInDays = Math.round(diffInHours / 24);

    if (Math.abs(diffInDays) < 7) {
      return formatter.format(diffInDays, "day");
    }

    const diffInWeeks = Math.round(diffInDays / 7);

    if (Math.abs(diffInWeeks) < 5) {
      return formatter.format(diffInWeeks, "week");
    }

    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(value);
  }

  private getRemovedCommentBody(status: CommentStatus) {
    return status === CommentStatus.HIDDEN
      ? "Comment removed by moderators."
      : "Comment deleted.";
  }

  private getReviewStatusLabel(status: ReviewStatus) {
    return status === ReviewStatus.HIDDEN
      ? "Hidden by moderators"
      : "Deleted review";
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
