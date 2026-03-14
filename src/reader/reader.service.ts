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
import { EngagementService } from "../engagement/engagement.service";
import {
  ChapterAccessState,
  RequiredPreviousChapter,
  resolveChapterAccessState,
} from "../monetization/chapter-access";
import { MonetizationService } from "../monetization/monetization.service";
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
    private readonly creatorAnalyticsService: CreatorAnalyticsService,
  ) {}

  async getHomeCatalog() {
    const stories = await this.getPublishedStories({
      limit: 24,
    });

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
    const [stories, continueReading] = await Promise.all([
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

    const featuredStory =
      stories.find((story) => story.featured) ??
      [...stories].sort((left, right) => right.totalReads - left.totalReads)[0];
    const recommendedStories = await this.getRecommendedStoryCards({
      excludeSeenStories: true,
      stories,
      userId,
    });

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
            recommendedStories.selectedGenres.length > 0
              ? `Because you picked ${recommendedStories.selectedGenres[0]}`
              : "Recommended for you",
          stories: recommendedStories.stories,
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
  }) {
    const [storyCatalog, genres] = await Promise.all([
      this.queryPublishedStories({
        genre: input.genre,
        limit: input.limit ?? null,
        offset: input.offset ?? null,
        query: input.query,
      }),
      this.prisma.genre.findMany({
        orderBy: { name: "asc" },
        select: { name: true, slug: true },
      }),
    ]);

    return {
      genres: genres.map((genre) => ({
        label: genre.name,
        slug: genre.slug,
      })),
      pageInfo: storyCatalog.pageInfo,
      stories: storyCatalog.stories.map((story) => this.mapStoryCard(story)),
    };
  }

  async search(
    rawQuery?: string,
    pagination: {
      limit?: number | null;
      offset?: number | null;
    } = {},
  ) {
    const query = this.normalizeOptionalQuery(rawQuery);
    const { pageInfo, stories } = await this.queryPublishedStories({
      limit: pagination.limit ?? null,
      offset: pagination.offset ?? null,
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
      pageInfo,
      stories: stories.map((story) => this.mapStoryCard(story)),
    };
  }

  async getStoryDetails(userId: string, storySlug: string) {
    const story = await this.getReadableStoryBySlug(storySlug);
    const [
      stories,
      { chapterAccessMap, progress },
      bookmarks,
      storyRating,
      writtenReviewCount,
      storyFollowerCount,
      authorFollowerCount,
      authorStoryCount,
      follows,
    ] =
      await Promise.all([
        this.getPublishedStories(),
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
        this.prisma.review.count({
          where: {
            storyId: story.id,
            status: ReviewStatus.VISIBLE,
          },
        }),
        this.prisma.follow.count({
          where: {
            storyId: story.id,
            targetType: FollowTargetType.STORY,
          },
        }),
        story.authorId
          ? this.prisma.follow.count({
              where: {
                targetType: FollowTargetType.AUTHOR,
                targetUserId: story.authorId,
              },
            })
          : Promise.resolve(0),
        story.authorId
          ? this.prisma.story
              .findMany({
                where: {
                  authorId: story.authorId,
                  status: {
                    in: [StoryStatus.PUBLISHED, StoryStatus.COMPLETED, StoryStatus.HIATUS],
                  },
                },
                include: {
                  adminControl: true,
                },
              })
              .then((stories) => stories.filter((item) => isStoryLive(item)).length)
          : Promise.resolve(0),
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
        canRate: ratingEligibility.canRate,
        firstChapterSlug: firstChapter?.slug ?? null,
        genres: story.genreSlugs.map((genreSlug) => this.slugToLabel(genreSlug)),
        hasCompletedStory: ratingEligibility.hasCompletedStory,
        hasUnlockedAllChapters: ratingEligibility.hasUnlockedAllChapters,
        isFollowingAuthor: follows.some(
          (follow) => follow.targetType === FollowTargetType.AUTHOR,
        ),
        isFollowingStory: follows.some(
          (follow) => follow.targetType === FollowTargetType.STORY,
        ),
        maturityRating: story.maturityRating,
        rating: Number(story.averageRating.toFixed(1)),
        ratingEligibilityMessage: ratingEligibility.ratingEligibilityMessage,
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

    return {
      story: {
        canRate: true,
        hasCompletedStory: ratingEligibility.hasCompletedStory,
        hasUnlockedAllChapters: ratingEligibility.hasUnlockedAllChapters,
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
            input.sort === "highest"
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
    const ratingEligibility = this.getStoryRatingEligibility({
      chapterAccessMap,
      chapters: story.publishedChapters,
      progress,
    });
    const canReview =
      ratingEligibility.canRate ||
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
      reviewEligibilityMessage: ratingEligibility.ratingEligibilityMessage,
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
    const ratingEligibility = this.getStoryRatingEligibility({
      chapterAccessMap,
      chapters: story.publishedChapters,
      progress,
    });
    const canRestoreDeletedReview =
      existingReview?.status === ReviewStatus.DELETED &&
      !existingReview.moderatedByAdminUserId;

    if (!existingReview && !ratingEligibility.canRate) {
      throw new ForbiddenException(
        ratingEligibility.ratingEligibilityMessage ??
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

    await this.creatorAnalyticsService.recordChapterRead({
      paragraphIndex: nextParagraphIndex,
      progressPercent: nextProgressPercent,
      publishedChapterId: chapter.id,
      readAt: now,
      storyId: story.id,
      userId,
    });

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

  private async getPublishedStories(input: {
    genre?: string;
    limit?: number | null;
    offset?: number | null;
    query?: string;
  } = {}): Promise<PublishedStoryCatalogRecord[]> {
    const { stories } = await this.queryPublishedStories(input);

    return stories;
  }

  private async queryPublishedStories(input: {
    genre?: string;
    limit?: number | null;
    offset?: number | null;
    query?: string;
  }) {
    const limit = input.limit ?? null;
    const offset = input.offset ?? null;
    const stories: PublishedStoryCatalogRecord[] = await this.prisma.story.findMany({
      where: this.buildPublishedStoryWhere(input),
      select: publishedStoryCatalogSelect,
      orderBy: [
        {
          featured: "desc",
        },
        {
          totalReads: "desc",
        },
        {
          updatedAt: "desc",
        },
      ],
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

  private async getRecommendedStoryCards(input: {
    excludeSeenStories?: boolean;
    excludeStoryIds?: string[];
    limit?: number;
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
      stories: this.dedupeStoryCards(fallbackStories, input.limit ?? 6),
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
        where: { userId: input.userId },
        select: { selectedGenres: true },
      }),
      this.prisma.readingProgress.findMany({
        where: {
          userId: input.userId,
        },
        select: {
          progressPercent: true,
          storyId: true,
        },
      }),
      this.prisma.bookmark.findMany({
        where: {
          userId: input.userId,
        },
        select: {
          storyId: true,
        },
      }),
      this.prisma.follow.findMany({
        where: {
          targetType: FollowTargetType.STORY,
          userId: input.userId,
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
          userId: input.userId,
        },
        select: {
          targetUserId: true,
        },
      }),
      this.prisma.storyRating.findMany({
        where: {
          userId: input.userId,
        },
        select: {
          rating: true,
          storyId: true,
        },
      }),
      this.prisma.review.findMany({
        where: {
          status: ReviewStatus.VISIBLE,
          userId: input.userId,
        },
        select: {
          rating: true,
          storyId: true,
        },
      }),
      this.prisma.readingListItem.findMany({
        where: {
          readingList: {
            userId: input.userId,
          },
        },
        select: {
          storyId: true,
        },
      }),
    ]);

    const selectedGenres = profile?.selectedGenres ?? [];
    const engagedStoryIds = new Set<string>();
    const seedStoryWeights = new Map<string, number>();
    const genreAffinity = new Map<string, number>();
    const tagAffinity = new Map<string, number>();
    const authorAffinity = new Map<string, number>();

    const markStorySeen = (storyId: string | null | undefined) => {
      if (!storyId || !storyById.has(storyId)) {
        return;
      }

      engagedStoryIds.add(storyId);
    };
    const addSeedStoryWeight = (storyId: string | null | undefined, amount: number) => {
      if (!storyId || !storyById.has(storyId) || amount <= 0) {
        return;
      }

      engagedStoryIds.add(storyId);
      this.addWeightedValue(seedStoryWeights, storyId, amount);
    };

    for (const item of readingProgress) {
      markStorySeen(item.storyId);
      addSeedStoryWeight(
        item.storyId,
        item.progressPercent >= 90
          ? 3.8
          : item.progressPercent >= 65
            ? 3
            : item.progressPercent >= 35
              ? 2.2
              : 1.2,
      );
    }

    for (const item of bookmarks) {
      markStorySeen(item.storyId);
      addSeedStoryWeight(item.storyId, 1.8);
    }

    for (const item of readingListItems) {
      markStorySeen(item.storyId);
      addSeedStoryWeight(item.storyId, 1.5);
    }

    for (const item of follows) {
      markStorySeen(item.storyId);
      addSeedStoryWeight(item.storyId, 2.6);
    }

    for (const item of ratings) {
      markStorySeen(item.storyId);

      if (item.rating >= 4) {
        addSeedStoryWeight(item.storyId, 2.4 + (item.rating - 4) * 0.8);
      } else if (item.rating === 3) {
        addSeedStoryWeight(item.storyId, 1.4);
      }
    }

    for (const item of reviews) {
      markStorySeen(item.storyId);

      if (item.rating >= 4) {
        addSeedStoryWeight(item.storyId, 3 + (item.rating - 4) * 0.8);
      } else if (item.rating === 3) {
        addSeedStoryWeight(item.storyId, 1.8);
      }
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

    for (const [storyId, weight] of seedStoryWeights.entries()) {
      const story = storyById.get(storyId);

      if (!story) {
        continue;
      }

      for (const genreSlug of story.genreSlugs) {
        this.addWeightedValue(
          genreAffinity,
          this.normalizeTerm(genreSlug),
          weight * 1.45,
        );
      }

      for (const tagSlug of story.tagSlugs) {
        this.addWeightedValue(
          tagAffinity,
          this.normalizeTerm(tagSlug),
          weight,
        );
      }

      if (story.authorId) {
        this.addWeightedValue(authorAffinity, story.authorId, weight * 0.9);
      }
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

  private buildPublishedStoryWhere(input: {
    genre?: string;
    query?: string;
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

    if (normalizedGenreSlug) {
      andFilters.push({
        genreSlugs: {
          has: normalizedGenreSlug,
        },
      });
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

    return {
      AND: andFilters,
      status: {
        in: [StoryStatus.PUBLISHED, StoryStatus.COMPLETED, StoryStatus.HIATUS],
      },
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
    email: string;
    profile?: {
      displayName?: string | null;
    } | null;
  }) {
    return user.profile?.displayName?.trim() || user.email.split("@")[0] || "TaleStead Reader";
  }

  private dedupeStoryCards(
    stories: StoryCardSource[],
    limit = 6,
  ) {
    const seen = new Set<string>();

    return stories
      .filter((story) => {
        if (seen.has(story.slug)) {
          return false;
        }

        seen.add(story.slug);
        return true;
      })
      .slice(0, limit)
      .map((story) => this.mapStoryCard(story));
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
