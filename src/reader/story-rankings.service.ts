import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import {
  CommentStatus,
  FollowTargetType,
  Prisma,
  ReviewStatus,
  StoryRankingKind,
  StoryStatus,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";
import { isStoryLive } from "../utils/book-admin";
import { StoryRankingKindInput } from "./reader.types";

type RankingStoryRecord = Prisma.StoryGetPayload<{
  include: {
    adminControl: true;
    assets: true;
    publishedChapters: {
      orderBy: {
        chapterNumber: "asc";
      };
    };
  };
}>;

type RankingSnapshotRecord = Prisma.StoryRankingSnapshotGetPayload<{
  include: {
    entries: {
      orderBy: {
        rank: "asc";
      };
      include: {
        story: {
          include: {
            adminControl: true;
            assets: true;
            publishedChapters: {
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

type StoryMetricRecord = {
  ageDays: number;
  averageRating: number;
  bayesianRating: number;
  chapterCount: number;
  firstChapterSlug: string | null;
  latestChapterAt: Date | null;
  recentBookmarkDates: Date[];
  recentChapterDates: Date[];
  recentCommentDates: Date[];
  recentFollowDates: Date[];
  recentRatingDates: Date[];
  recentReviewDates: Date[];
  ratingCount: number;
  story: RankingStoryRecord;
  totalFollowers: number;
  totalReads: number;
  writtenReviewCount: number;
};

type StoryMetricRow = StoryMetricRecord & {
  recentBookmarkCount: number;
  recentChapterCount: number;
  recentCommentCount: number;
  recentFollowCount: number;
  recentRatingCount: number;
  recentReviewCount: number;
};

type RankedStoryRow = StoryMetricRow & {
  rank: number;
  score: number;
};

type RankingSnapshotConfig = {
  activityWindowDays: number;
  description: string;
  key: StoryRankingKindInput;
  kind: StoryRankingKind;
  label: string;
  windowDays: number;
  windowLabel: string;
};

const STORY_RANKING_CONFIG: RankingSnapshotConfig[] = [
  {
    activityWindowDays: 7,
    description:
      "Momentum from views, fresh ratings, follows, comments, and new chapter drops.",
    key: "trending",
    kind: StoryRankingKind.TRENDING,
    label: "Trending",
    windowDays: 7,
    windowLabel: "Last 7 days",
  },
  {
    activityWindowDays: 30,
    description:
      "The broadest audience pull across long-term reach, follower interest, and sustained ratings.",
    key: "popular",
    kind: StoryRankingKind.POPULAR,
    label: "Most Popular",
    windowDays: 0,
    windowLabel: "All time",
  },
  {
    activityWindowDays: 30,
    description:
      "Weighted ratings that reward quality without letting tiny sample sizes dominate.",
    key: "top-rated",
    kind: StoryRankingKind.TOP_RATED,
    label: "Top Rated",
    windowDays: 0,
    windowLabel: "All time",
  },
  {
    activityWindowDays: 14,
    description:
      "Stories accelerating quickly through recent reader activity and fresh chapter momentum.",
    key: "rising",
    kind: StoryRankingKind.RISING,
    label: "Rising",
    windowDays: 14,
    windowLabel: "Last 14 days",
  },
];

const STORY_RANKING_CONFIG_BY_KEY = new Map(
  STORY_RANKING_CONFIG.map((config) => [config.key, config] as const),
);

const STORY_RANKING_CONFIG_BY_KIND = new Map(
  STORY_RANKING_CONFIG.map((config) => [config.kind, config] as const),
);

const RANKING_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const RANKING_STALE_AFTER_MS = 75 * 60 * 1000;
const RANKING_RESPONSE_CACHE_TTL_SECONDS = 5 * 60;
const MAX_QUERY_LIMIT = 50;

@Injectable()
export class StoryRankingsService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(StoryRankingsService.name);
  private refreshPromise: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    void this.safeRefreshSnapshots("startup");
    this.refreshTimer = setInterval(() => {
      void this.safeRefreshSnapshots("interval");
    }, RANKING_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async getStoryRankings(input: {
    genre: string | null;
    kind: StoryRankingKindInput;
    limit: number | null;
  }) {
    const cacheKey = this.getRankingResponseCacheKey(input);
    const cachedResponse = await this.redisService.getJson<{
      genres: Array<{ label: string; slug: string }>;
      ranking: {
        activityWindowLabel: string;
        description: string;
        kind: StoryRankingKindInput;
        label: string;
        totalStories: number;
        updatedAt: string | null;
        updatedAtLabel: string;
        windowLabel: string;
      };
      stories: Array<Record<string, unknown>>;
      tabs: Array<{
        description: string;
        kind: StoryRankingKindInput;
        label: string;
        windowLabel: string;
      }>;
    }>(cacheKey);

    if (cachedResponse) {
      return cachedResponse;
    }

    const config = this.getConfigByKey(input.kind);
    await this.ensureSnapshotFresh(config.kind);

    let snapshot = await this.getLatestSnapshot(config.kind);

    if (!snapshot) {
      await this.refreshSnapshots("missing-snapshot");
      snapshot = await this.getLatestSnapshot(config.kind);
    }

    const genres = await this.prisma.genre.findMany({
      orderBy: { name: "asc" },
      select: { name: true, slug: true },
    });

    const normalizedGenre = this.normalizeOptionalQuery(input.genre);
    const filteredEntries = (snapshot?.entries ?? []).filter((entry) => {
      if (!this.isReadableStatus(entry.story.status) || !isStoryLive(entry.story)) {
        return false;
      }

      if (!normalizedGenre) {
        return true;
      }

      return entry.story.genreSlugs.some(
        (genreSlug) =>
          this.normalizeTerm(genreSlug) === normalizedGenre ||
          this.normalizeTerm(this.slugToLabel(genreSlug)) === normalizedGenre,
      );
    });

    const response = {
      genres: genres.map((genre) => ({
        label: genre.name,
        slug: genre.slug,
      })),
      ranking: {
        activityWindowLabel: this.getActivityWindowLabel(config.activityWindowDays),
        description: config.description,
        kind: config.key,
        label: config.label,
        totalStories: filteredEntries.length,
        updatedAt: snapshot?.updatedAt ?? null,
        updatedAtLabel: snapshot
          ? this.formatRelativeDateTime(snapshot.updatedAt)
          : "Waiting for ranking snapshot",
        windowLabel: config.windowLabel,
      },
      stories: filteredEntries
        .slice(0, input.limit ?? MAX_QUERY_LIMIT)
        .map((entry) => this.mapRankingEntry(config, entry)),
      tabs: STORY_RANKING_CONFIG.map((tab) => ({
        description: tab.description,
        kind: tab.key,
        label: tab.label,
        windowLabel: tab.windowLabel,
      })),
    };

    await this.redisService.setJson(
      cacheKey,
      response,
      RANKING_RESPONSE_CACHE_TTL_SECONDS,
    );

    return response;
  }

  private async safeRefreshSnapshots(source: string) {
    try {
      await this.refreshSnapshots(source);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown story ranking error";
      this.logger.error(
        `Story ranking snapshot refresh failed during ${source}: ${message}`,
      );
    }
  }

  private async ensureSnapshotFresh(kind: StoryRankingKind) {
    const snapshot = await this.prisma.storyRankingSnapshot.findFirst({
      where: {
        kind,
      },
      orderBy: [
        {
          endsAt: "desc",
        },
        {
          createdAt: "desc",
        },
      ],
      select: {
        updatedAt: true,
      },
    });

    if (
      !snapshot ||
      Date.now() - snapshot.updatedAt.getTime() > RANKING_STALE_AFTER_MS
    ) {
      await this.refreshSnapshots("stale-read");
    }
  }

  private async refreshSnapshots(source: string) {
    if (!this.refreshPromise) {
      this.refreshPromise = this.rebuildSnapshots(source).finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  private async rebuildSnapshots(source: string) {
    const now = new Date();
    const stories = await this.getRankableStories();
    const metrics = await this.collectStoryMetrics(stories, now);

    for (const config of STORY_RANKING_CONFIG) {
      const rows = this.buildRankingRows(config, metrics);
      const window = this.getSnapshotWindow(config, now);

      await this.upsertSnapshot(config, window, rows);
    }

    this.logger.log(
      `Story ranking snapshots refreshed during ${source} for ${stories.length} stories.`,
    );
  }

  private async getRankableStories() {
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

  private async collectStoryMetrics(
    stories: RankingStoryRecord[],
    now: Date,
  ): Promise<StoryMetricRecord[]> {
    if (!stories.length) {
      return [];
    }

    const storyIds = stories.map((story) => story.id);
    const maxActivityWindowDays = Math.max(
      ...STORY_RANKING_CONFIG.map((config) => config.activityWindowDays),
    );
    const recentWindowStart = this.subtractDays(now, maxActivityWindowDays);

    const [
      reviewEvents,
      followEvents,
      recentChapterEvents,
      recentCommentEvents,
      recentBookmarkEvents,
      recentRatingEvents,
    ] = await Promise.all([
      this.prisma.review.findMany({
        where: {
          status: ReviewStatus.VISIBLE,
          storyId: {
            in: storyIds,
          },
        },
        select: {
          createdAt: true,
          storyId: true,
        },
      }),
      this.prisma.follow.findMany({
        where: {
          storyId: {
            in: storyIds,
          },
          targetType: FollowTargetType.STORY,
        },
        select: {
          createdAt: true,
          storyId: true,
        },
      }),
      this.prisma.publishedChapter.findMany({
        where: {
          publishedAt: {
            gte: recentWindowStart,
          },
          storyId: {
            in: storyIds,
          },
        },
        select: {
          publishedAt: true,
          storyId: true,
        },
      }),
      this.prisma.comment.findMany({
        where: {
          createdAt: {
            gte: recentWindowStart,
          },
          status: CommentStatus.VISIBLE,
          storyId: {
            in: storyIds,
          },
        },
        select: {
          createdAt: true,
          storyId: true,
        },
      }),
      this.prisma.bookmark.findMany({
        where: {
          createdAt: {
            gte: recentWindowStart,
          },
          storyId: {
            in: storyIds,
          },
        },
        select: {
          createdAt: true,
          storyId: true,
        },
      }),
      this.prisma.storyRating.findMany({
        where: {
          storyId: {
            in: storyIds,
          },
          updatedAt: {
            gte: recentWindowStart,
          },
        },
        select: {
          storyId: true,
          updatedAt: true,
        },
      }),
    ]);

    const reviewEventsByStory = this.groupDatesByStory(reviewEvents);
    const followEventsByStory = this.groupDatesByStory(followEvents);
    const recentChaptersByStory = this.groupDatesByStory(
      recentChapterEvents.map((event) => ({
        createdAt: event.publishedAt,
        storyId: event.storyId,
      })),
    );
    const recentCommentsByStory = this.groupDatesByStory(recentCommentEvents);
    const recentBookmarksByStory = this.groupDatesByStory(recentBookmarkEvents);
    const recentRatingsByStory = this.groupDatesByStory(
      recentRatingEvents.map((event) => ({
        createdAt: event.updatedAt,
        storyId: event.storyId,
      })),
    );

    const totalWeightedRating = stories.reduce(
      (sum, story) => sum + story.averageRating * story.reviewCount,
      0,
    );
    const totalRatingCount = stories.reduce(
      (sum, story) => sum + story.reviewCount,
      0,
    );
    const priorMean = totalRatingCount > 0 ? totalWeightedRating / totalRatingCount : 4;
    const priorWeight = 5;

    return stories.map((story) => {
      const firstChapter = story.publishedChapters[0] ?? null;
      const latestChapter =
        story.publishedChapters[story.publishedChapters.length - 1] ?? null;
      const publishedReferenceDate =
        story.publishedAt ?? story.liveAt ?? story.createdAt;
      const ageDays = Math.max(
        1,
        this.getDaysSince(now, publishedReferenceDate),
      );

      return {
        ageDays,
        averageRating: Number(story.averageRating.toFixed(4)),
        bayesianRating:
          (story.averageRating * story.reviewCount + priorMean * priorWeight) /
          Math.max(story.reviewCount + priorWeight, 1),
        chapterCount: story.publishedChapters.length,
        firstChapterSlug: firstChapter?.slug ?? null,
        latestChapterAt:
          story.latestChapterAt ??
          latestChapter?.publishedAt ??
          story.publishedAt ??
          null,
        recentBookmarkDates: recentBookmarksByStory.get(story.id) ?? [],
        recentChapterDates: recentChaptersByStory.get(story.id) ?? [],
        recentCommentDates: recentCommentsByStory.get(story.id) ?? [],
        recentFollowDates: followEventsByStory
          .get(story.id)
          ?.filter((date) => date.getTime() >= recentWindowStart.getTime()) ?? [],
        recentRatingDates: recentRatingsByStory.get(story.id) ?? [],
        recentReviewDates: reviewEventsByStory
          .get(story.id)
          ?.filter((date) => date.getTime() >= recentWindowStart.getTime()) ?? [],
        ratingCount: story.reviewCount,
        story,
        totalFollowers: followEventsByStory.get(story.id)?.length ?? 0,
        totalReads: story.totalReads,
        writtenReviewCount: reviewEventsByStory.get(story.id)?.length ?? 0,
      };
    });
  }

  private buildRankingRows(
    config: RankingSnapshotConfig,
    metrics: StoryMetricRecord[],
  ) {
    const windowStart = this.subtractDays(new Date(), config.activityWindowDays);
    const metricRows = metrics.map((metric) => ({
      ...metric,
      recentBookmarkCount: this.countDatesSince(
        metric.recentBookmarkDates,
        windowStart,
      ),
      recentChapterCount: this.countDatesSince(
        metric.recentChapterDates,
        windowStart,
      ),
      recentCommentCount: this.countDatesSince(
        metric.recentCommentDates,
        windowStart,
      ),
      recentFollowCount: this.countDatesSince(
        metric.recentFollowDates,
        windowStart,
      ),
      recentRatingCount: this.countDatesSince(
        metric.recentRatingDates,
        windowStart,
      ),
      recentReviewCount: this.countDatesSince(
        metric.recentReviewDates,
        windowStart,
      ),
    }));

    const maxima = {
      activity: Math.max(
        ...metricRows.map((row) => this.getActivityWeight(row)),
        1,
      ),
      bayesianRating: Math.max(...metricRows.map((row) => row.bayesianRating), 1),
      followerCount: Math.max(...metricRows.map((row) => row.totalFollowers), 1),
      ratingCount: Math.max(...metricRows.map((row) => row.ratingCount), 1),
      reads: Math.max(...metricRows.map((row) => row.totalReads), 1),
      reviewDepth: Math.max(...metricRows.map((row) => row.writtenReviewCount), 1),
      risingVelocity: Math.max(
        ...metricRows.map((row) => this.getRisingVelocity(row)),
        1,
      ),
    };

    return metricRows
      .map((row) => ({
        ...row,
        score: this.calculateScore(config.kind, row, maxima),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        if (right.totalReads !== left.totalReads) {
          return right.totalReads - left.totalReads;
        }

        if (right.averageRating !== left.averageRating) {
          return right.averageRating - left.averageRating;
        }

        return left.story.title.localeCompare(right.story.title);
      })
      .map((row, index) => ({
        ...row,
        rank: index + 1,
      }));
  }

  private countDatesSince(dates: Date[], start: Date) {
    return dates.filter((date) => date.getTime() >= start.getTime()).length;
  }

  private calculateScore(
    kind: StoryRankingKind,
    row: StoryMetricRow,
    maxima: {
      activity: number;
      bayesianRating: number;
      followerCount: number;
      ratingCount: number;
      reads: number;
      reviewDepth: number;
      risingVelocity: number;
    },
  ) {
    const readsScore = this.normalize(row.totalReads, maxima.reads);
    const followersScore = this.normalize(row.totalFollowers, maxima.followerCount);
    const ratingCountScore = this.normalize(row.ratingCount, maxima.ratingCount);
    const bayesianScore = this.normalize(row.bayesianRating, maxima.bayesianRating);
    const reviewDepthScore = this.normalize(
      row.writtenReviewCount,
      maxima.reviewDepth,
    );
    const activityScore = this.normalize(
      this.getActivityWeight(row),
      maxima.activity,
    );
    const risingVelocity = this.normalize(
      this.getRisingVelocity(row),
      maxima.risingVelocity,
    );
    const freshnessScore = Math.max(0, 1 - Math.min(row.ageDays, 180) / 180);

    if (kind === StoryRankingKind.POPULAR) {
      return Number(
        (
          readsScore * 55 +
          followersScore * 20 +
          ratingCountScore * 15 +
          bayesianScore * 10
        ).toFixed(4),
      );
    }

    if (kind === StoryRankingKind.TOP_RATED) {
      return Number(
        (
          bayesianScore * 70 +
          reviewDepthScore * 20 +
          activityScore * 10
        ).toFixed(4),
      );
    }

    if (kind === StoryRankingKind.RISING) {
      return Number(
        (
          risingVelocity * 45 +
          bayesianScore * 20 +
          freshnessScore * 20 +
          readsScore * 15
        ).toFixed(4),
      );
    }

    return Number(
      (
        activityScore * 40 +
        readsScore * 28 +
        bayesianScore * 20 +
        freshnessScore * 12
      ).toFixed(4),
    );
  }

  private getActivityWeight(row: StoryMetricRow) {
    return (
      row.recentChapterCount * 4 +
      row.recentReviewCount * 3.5 +
      row.recentCommentCount * 2 +
      row.recentFollowCount * 2.5 +
      row.recentBookmarkCount * 1.5 +
      row.recentRatingCount * 2
    );
  }

  private getRisingVelocity(row: StoryMetricRow) {
    return (
      row.recentChapterCount * 4 +
      row.recentReviewCount * 3 +
      row.recentFollowCount * 3 +
      row.recentRatingCount * 2.5 +
      row.recentBookmarkCount * 2 +
      row.recentCommentCount * 2
    );
  }

  private normalize(value: number, max: number) {
    if (max <= 0) {
      return 0;
    }

    return value / max;
  }

  private async upsertSnapshot(
    config: RankingSnapshotConfig,
    window: {
      endsAt: Date;
      startsAt: Date;
    },
    rows: RankedStoryRow[],
  ) {
    const existing = await this.prisma.storyRankingSnapshot.findFirst({
      where: {
        endsAt: window.endsAt,
        kind: config.kind,
        startsAt: window.startsAt,
      },
      select: {
        id: true,
      },
    });

    if (existing) {
      await this.prisma.storyRankingEntry.deleteMany({
        where: {
          storyRankingSnapshotId: existing.id,
        },
      });

      if (rows.length > 0) {
        await Promise.all(
          rows.map((row) =>
            this.prisma.storyRankingEntry.create({
              data: {
                averageRating: row.averageRating,
                rank: row.rank,
                ratingCount: row.ratingCount,
                recentBookmarkCount: row.recentBookmarkCount,
                recentChapterCount: row.recentChapterCount,
                recentCommentCount: row.recentCommentCount,
                recentFollowCount: row.recentFollowCount,
                recentRatingCount: row.recentRatingCount,
                recentReviewCount: row.recentReviewCount,
                score: row.score,
                storyId: row.story.id,
                storyRankingSnapshotId: existing.id,
                totalFollowers: row.totalFollowers,
                totalReads: row.totalReads,
                writtenReviewCount: row.writtenReviewCount,
              },
            }),
          ),
        );
      }

      await this.prisma.storyRankingSnapshot.update({
        where: {
          id: existing.id,
        },
        data: {
          title: config.label,
          windowDays: config.windowDays,
        },
      });

      return;
    }

    await this.prisma.storyRankingSnapshot.create({
      data: {
        endsAt: window.endsAt,
        kind: config.kind,
        startsAt: window.startsAt,
        title: config.label,
        windowDays: config.windowDays,
        entries: {
          create: rows.map((row) => ({
            averageRating: row.averageRating,
            rank: row.rank,
            ratingCount: row.ratingCount,
            recentBookmarkCount: row.recentBookmarkCount,
            recentChapterCount: row.recentChapterCount,
            recentCommentCount: row.recentCommentCount,
            recentFollowCount: row.recentFollowCount,
            recentRatingCount: row.recentRatingCount,
            recentReviewCount: row.recentReviewCount,
            score: row.score,
            storyId: row.story.id,
            totalFollowers: row.totalFollowers,
            totalReads: row.totalReads,
            writtenReviewCount: row.writtenReviewCount,
          })),
        },
      },
    });
  }

  private getSnapshotWindow(
    config: RankingSnapshotConfig,
    now: Date,
  ) {
    const endsAt = this.truncateToHour(now);
    const startsAt =
      config.windowDays > 0 ? this.subtractDays(endsAt, config.windowDays) : new Date(0);

    return {
      endsAt,
      startsAt,
    };
  }

  private async getLatestSnapshot(kind: StoryRankingKind) {
    return this.prisma.storyRankingSnapshot.findFirst({
      where: {
        kind,
      },
      orderBy: [
        {
          endsAt: "desc",
        },
        {
          createdAt: "desc",
        },
      ],
      include: {
        entries: {
          orderBy: {
            rank: "asc",
          },
          include: {
            story: {
              include: {
                adminControl: true,
                assets: true,
                publishedChapters: {
                  orderBy: {
                    chapterNumber: "asc",
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  private getRankingResponseCacheKey(input: {
    genre: string | null;
    kind: StoryRankingKindInput;
    limit: number | null;
  }) {
    const normalizedGenre = this.normalizeOptionalQuery(input.genre) ?? "all";
    const normalizedLimit = input.limit ?? MAX_QUERY_LIMIT;

    return `reader:rankings:${input.kind}:${normalizedGenre}:${normalizedLimit}`;
  }

  private mapRankingEntry(
    config: RankingSnapshotConfig,
    entry: RankingSnapshotRecord["entries"][number],
  ) {
    const firstChapter = entry.story.publishedChapters[0] ?? null;

    return {
      authorName: entry.story.authorName,
      averageRating: Number(entry.averageRating.toFixed(1)),
      chapterCount: entry.story.publishedChapters.length,
      coverImage:
        entry.story.assets?.coverImageUrl ??
        entry.story.assets?.cardImageUrl ??
        entry.story.assets?.bannerImageUrl ??
        "",
      firstChapterSlug: firstChapter?.slug ?? null,
      followerCount: entry.totalFollowers,
      followerCountLabel: this.formatCompactNumber(entry.totalFollowers),
      genreLabel: this.slugToLabel(entry.story.genreSlugs[0] ?? "story"),
      rank: entry.rank,
      ranking: {
        activityLabel: this.buildRecentActivityLabel(entry),
        score: Number(entry.score.toFixed(1)),
        scoreLabel: `${entry.score.toFixed(1)} pts`,
        signalLabel: this.buildRankingSignalLabel(config.kind, entry),
      },
      readsCount: entry.totalReads,
      readsLabel: this.formatCompactNumber(entry.totalReads),
      reviewCount: entry.ratingCount,
      shortSynopsis: entry.story.shortSynopsis,
      slug: entry.story.slug,
      statusLabel: this.mapStoryStatus(entry.story.status),
      title: entry.story.title,
      writtenReviewCount: entry.writtenReviewCount,
    };
  }

  private buildRecentActivityLabel(
    entry: RankingSnapshotRecord["entries"][number],
  ) {
    const parts = [
      this.pluralize(entry.recentChapterCount, "new chapter"),
      this.pluralize(entry.recentReviewCount, "new review"),
      this.pluralize(entry.recentCommentCount, "comment"),
      this.pluralize(entry.recentFollowCount, "new follower"),
      this.pluralize(entry.recentBookmarkCount, "bookmark"),
    ].filter(Boolean);

    return parts.slice(0, 2).join(" • ") || "Steady reader activity";
  }

  private buildRankingSignalLabel(
    kind: StoryRankingKind,
    entry: RankingSnapshotRecord["entries"][number],
  ) {
    if (kind === StoryRankingKind.POPULAR) {
      return `${this.formatCompactNumber(entry.totalReads)} readers • ${this.formatCompactNumber(entry.totalFollowers)} followers`;
    }

    if (kind === StoryRankingKind.TOP_RATED) {
      return `${entry.averageRating.toFixed(1)} average from ${this.formatCompactNumber(entry.ratingCount)} ratings`;
    }

    if (kind === StoryRankingKind.RISING) {
      const interactionCount =
        entry.recentReviewCount +
        entry.recentFollowCount +
        entry.recentRatingCount +
        entry.recentBookmarkCount +
        entry.recentCommentCount;

      return entry.recentChapterCount > 0
        ? `${this.pluralize(entry.recentChapterCount, "fresh chapter")} fueling momentum`
        : `${this.formatCompactNumber(interactionCount)} recent reader interactions`;
    }

    const interactionCount =
      entry.recentReviewCount +
      entry.recentFollowCount +
      entry.recentRatingCount +
      entry.recentBookmarkCount +
      entry.recentCommentCount;

    return interactionCount > 0
      ? `${this.formatCompactNumber(interactionCount)} recent interactions driving momentum`
      : `${this.formatCompactNumber(entry.totalReads)} readers and steady traction`;
  }

  private getConfigByKey(kind: StoryRankingKindInput) {
    return STORY_RANKING_CONFIG_BY_KEY.get(kind) ?? STORY_RANKING_CONFIG[0];
  }

  private getActivityWindowLabel(days: number) {
    return `Last ${days} day${days === 1 ? "" : "s"}`;
  }

  private groupDatesByStory(
    items: Array<{
      createdAt: Date;
      storyId: string | null;
    }>,
  ) {
    const grouped = new Map<string, Date[]>();

    for (const item of items) {
      if (!item.storyId) {
        continue;
      }

      const records = grouped.get(item.storyId) ?? [];
      records.push(item.createdAt);
      grouped.set(item.storyId, records);
    }

    return grouped;
  }

  private formatCompactNumber(value: number) {
    return new Intl.NumberFormat("en", {
      compactDisplay: "short",
      notation: "compact",
      maximumFractionDigits: value >= 10_000 ? 0 : 1,
    }).format(value);
  }

  private formatRelativeDateTime(date: Date) {
    const diffMs = Date.now() - date.getTime();
    const diffMinutes = Math.max(1, Math.round(diffMs / 60_000));

    if (diffMinutes < 60) {
      return `Updated ${diffMinutes}m ago`;
    }

    const diffHours = Math.round(diffMinutes / 60);

    if (diffHours < 24) {
      return `Updated ${diffHours}h ago`;
    }

    const diffDays = Math.round(diffHours / 24);
    return `Updated ${diffDays}d ago`;
  }

  private truncateToHour(date: Date) {
    return new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        0,
        0,
        0,
      ),
    );
  }

  private subtractDays(date: Date, days: number) {
    const nextDate = new Date(date);
    nextDate.setUTCDate(nextDate.getUTCDate() - days);
    return nextDate;
  }

  private getDaysSince(now: Date, reference: Date) {
    return Math.max(
      1,
      Math.floor((now.getTime() - reference.getTime()) / (24 * 60 * 60 * 1000)),
    );
  }

  private normalizeTerm(value: string) {
    return value.trim().toLowerCase();
  }

  private normalizeOptionalQuery(value?: string | null) {
    const trimmed = value?.trim();
    return trimmed ? this.normalizeTerm(trimmed) : null;
  }

  private slugToLabel(slug: string) {
    return slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  private mapStoryStatus(status: StoryStatus) {
    if (status === StoryStatus.COMPLETED) {
      return "Complete";
    }

    if (status === StoryStatus.HIATUS) {
      return "Hiatus";
    }

    return "Ongoing";
  }

  private isReadableStatus(status: StoryStatus) {
    return (
      status === StoryStatus.PUBLISHED ||
      status === StoryStatus.COMPLETED ||
      status === StoryStatus.HIATUS
    );
  }

  private pluralize(count: number, label: string) {
    if (!count) {
      return null;
    }

    return `${this.formatCompactNumber(count)} ${label}${count === 1 ? "" : "s"}`;
  }
}
