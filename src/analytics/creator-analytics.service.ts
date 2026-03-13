import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, WalletLedgerReason } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

type CreatorAnalyticsStoryRecord = Prisma.StoryGetPayload<{
  include: {
    assets: true;
    publishedChapters: {
      orderBy: {
        chapterNumber: "asc";
      };
    };
  };
}>;

type StoryDailyAccumulator = {
  averageProgressPercent: number;
  completedReaders: number;
  date: Date;
  giftRevenueCents: number;
  revenueCents: number;
  storyId: string;
  uniqueReaders: number;
  unlockRevenueCents: number;
  viewCount: number;
};

type ChapterDailyAccumulator = {
  averageProgressPercent: number;
  chapterNumber: number;
  completedReaders: number;
  completionRate: number;
  date: Date;
  publishedChapterId: string;
  revenueCents: number;
  storyId: string;
  uniqueReaders: number;
  viewCount: number;
};

type StoryWindowAggregate = {
  averageCompletionRate: number;
  averageProgressPercent: number;
  chapterCount: number;
  completedReaders: number;
  coverImage: string;
  grossRevenueCents: number;
  readThroughRate: number;
  slug: string;
  title: string;
  uniqueReaders: number;
  views: number;
};

type ChapterWindowAggregate = {
  averageProgressPercent: number;
  chapterNumber: number;
  completedReaders: number;
  completionRate: number;
  coverImage: string;
  publishedChapterId: string;
  reachRate: number;
  storySlug: string;
  storyTitle: string;
  title: string;
  uniqueReaders: number;
  views: number;
};

@Injectable()
export class CreatorAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async recordChapterRead(input: {
    paragraphIndex: number;
    progressPercent: number;
    publishedChapterId: string;
    readAt: Date;
    storyId: string;
    userId: string;
  }) {
    const readDate = this.startOfUtcDay(input.readAt);
    const existing = await this.prisma.chapterReadEvent.findUnique({
      where: {
        userId_publishedChapterId_readDate: {
          publishedChapterId: input.publishedChapterId,
          readDate,
          userId: input.userId,
        },
      },
      select: {
        completed: true,
        completedAt: true,
        maxProgressPercent: true,
        paragraphIndex: true,
      },
    });

    if (!existing) {
      await this.prisma.chapterReadEvent.create({
        data: {
          chapter: {
            connect: {
              id: input.publishedChapterId,
            },
          },
          completed: input.progressPercent >= 100,
          completedAt: input.progressPercent >= 100 ? input.readAt : null,
          firstReadAt: input.readAt,
          lastReadAt: input.readAt,
          maxProgressPercent: input.progressPercent,
          paragraphIndex: input.paragraphIndex,
          readDate,
          story: {
            connect: {
              id: input.storyId,
            },
          },
          user: {
            connect: {
              id: input.userId,
            },
          },
        },
      });

      return;
    }

    await this.prisma.chapterReadEvent.update({
      where: {
        userId_publishedChapterId_readDate: {
          publishedChapterId: input.publishedChapterId,
          readDate,
          userId: input.userId,
        },
      },
      data: {
        completed: existing.completed || input.progressPercent >= 100,
        completedAt:
          existing.completedAt ??
          (input.progressPercent >= 100 ? input.readAt : null),
        lastReadAt: input.readAt,
        maxProgressPercent: Math.max(
          existing.maxProgressPercent,
          input.progressPercent,
        ),
        paragraphIndex: Math.max(existing.paragraphIndex, input.paragraphIndex),
      },
    });
  }

  async getCreatorDashboardAnalytics(
    userId: string,
    input: {
      days: number;
      storySlug: string | null;
    },
  ) {
    const stories = await this.prisma.story.findMany({
      where: {
        authorId: userId,
      },
      include: {
        assets: true,
        publishedChapters: {
          orderBy: {
            chapterNumber: "asc",
          },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    const storyOptions = stories.map((story) => this.mapStoryOption(story));
    const selectedStory = input.storySlug
      ? stories.find((story) => story.slug === input.storySlug) ?? null
      : null;

    if (input.storySlug && !selectedStory) {
      throw new NotFoundException("Story not found.");
    }

    const selectedStories = selectedStory ? [selectedStory] : stories;
    const publishedStories = selectedStories.filter(
      (story) => story.publishedChapters.length > 0,
    );
    const storyIds = publishedStories.map((story) => story.id);
    const now = new Date();
    const endDateExclusive = this.addDays(this.startOfUtcDay(now), 1);
    const startDate = this.addDays(
      this.startOfUtcDay(now),
      -(Math.max(input.days, 1) - 1),
    );
    const dateAxis = this.buildDateAxis(startDate, input.days);

    if (storyIds.length === 0) {
      return this.buildEmptyDashboardResponse({
        dateAxis,
        days: input.days,
        selectedStorySlug: selectedStory?.slug ?? null,
        storyOptions,
      });
    }

    await this.refreshDailyRollups(publishedStories, startDate, endDateExclusive);

    const [storyDailyRows, chapterDailyRows, readEvents] = await Promise.all([
      this.prisma.storyAnalyticsDaily.findMany({
        where: {
          date: {
            gte: startDate,
            lt: endDateExclusive,
          },
          storyId: {
            in: storyIds,
          },
        },
        orderBy: {
          date: "asc",
        },
      }),
      this.prisma.chapterAnalyticsDaily.findMany({
        where: {
          date: {
            gte: startDate,
            lt: endDateExclusive,
          },
          storyId: {
            in: storyIds,
          },
        },
        include: {
          chapter: {
            select: {
              chapterNumber: true,
              id: true,
              slug: true,
              title: true,
            },
          },
        },
        orderBy: [
          {
            chapterNumber: "asc",
          },
          {
            date: "asc",
          },
        ],
      }),
      this.prisma.chapterReadEvent.findMany({
        where: {
          readDate: {
            gte: startDate,
            lt: endDateExclusive,
          },
          storyId: {
            in: storyIds,
          },
        },
        select: {
          completed: true,
          publishedChapterId: true,
          readDate: true,
          storyId: true,
          userId: true,
        },
      }),
    ]);

    const storyById = new Map(
      publishedStories.map((story) => [story.id, story] as const),
    );
    const distinctReaders = new Set<string>();
    const distinctReadersByStory = new Map<string, Set<string>>();
    const distinctReadersByDay = new Map<string, Set<string>>();
    const uniqueReadersByChapter = new Map<string, Set<string>>();
    const completedReadersByChapter = new Map<string, Set<string>>();

    for (const event of readEvents) {
      distinctReaders.add(event.userId);
      this.addSetValue(distinctReadersByStory, event.storyId, event.userId);
      this.addSetValue(
        distinctReadersByDay,
        event.readDate.toISOString(),
        event.userId,
      );
      this.addSetValue(
        uniqueReadersByChapter,
        event.publishedChapterId,
        event.userId,
      );

      if (event.completed) {
        this.addSetValue(
          completedReadersByChapter,
          event.publishedChapterId,
          event.userId,
        );
      }
    }

    const storyDailyByStoryId = this.groupStoryDailyRows(storyDailyRows);
    const chapterAggregatesByStoryId = this.groupChapterWindowMetrics(
      chapterDailyRows,
      storyById,
      uniqueReadersByChapter,
      completedReadersByChapter,
    );
    const storyPerformance = publishedStories
      .map((story) =>
        this.buildStoryWindowAggregate({
          chapterMetrics: chapterAggregatesByStoryId.get(story.id) ?? [],
          story,
          storyDailyRows: storyDailyByStoryId.get(story.id) ?? [],
          uniqueReaders:
            distinctReadersByStory.get(story.id)?.size ?? 0,
        }),
      )
      .sort((left, right) => {
        if (right.views !== left.views) {
          return right.views - left.views;
        }

        if (right.grossRevenueCents !== left.grossRevenueCents) {
          return right.grossRevenueCents - left.grossRevenueCents;
        }

        return left.title.localeCompare(right.title);
      });

    const focusStory =
      (selectedStory ? storyPerformance.find((story) => story.slug === selectedStory.slug) : null) ??
      storyPerformance[0] ??
      null;
    const focusStoryRecord = focusStory
      ? storyById.get(
          publishedStories.find((story) => story.slug === focusStory.slug)?.id ?? "",
        ) ?? null
      : null;
    const focusChapterMetrics = focusStoryRecord
      ? chapterAggregatesByStoryId.get(focusStoryRecord.id) ?? []
      : [];
    const totalViews = storyDailyRows.reduce((sum, row) => sum + row.viewCount, 0);
    const totalRevenueCents = storyDailyRows.reduce(
      (sum, row) => sum + row.revenueCents,
      0,
    );
    const totalCompletedReaders = focusChapterMetrics.reduce(
      (sum, chapter) => sum + chapter.completedReaders,
      0,
    );
    const totalChapterReaders = focusChapterMetrics.reduce(
      (sum, chapter) => sum + chapter.uniqueReaders,
      0,
    );

    return {
      chapterDropOff: focusChapterMetrics,
      charts: {
        dailyViews: dateAxis.map((point) => ({
          date: point.date,
          label: point.label,
          uniqueReaders:
            distinctReadersByDay.get(point.date.toISOString())?.size ?? 0,
          views: storyDailyRows
            .filter((row) => row.date.getTime() === point.date.getTime())
            .reduce((sum, row) => sum + row.viewCount, 0),
        })),
        revenue: dateAxis.map((point) => {
          const rowsForDay = storyDailyRows.filter(
            (row) => row.date.getTime() === point.date.getTime(),
          );

          return {
            date: point.date,
            giftRevenueCents: rowsForDay.reduce(
              (sum, row) => sum + row.giftRevenueCents,
              0,
            ),
            label: point.label,
            revenueCents: rowsForDay.reduce(
              (sum, row) => sum + row.revenueCents,
              0,
            ),
            unlockRevenueCents: rowsForDay.reduce(
              (sum, row) => sum + row.unlockRevenueCents,
              0,
            ),
          };
        }),
      },
      filters: {
        days: input.days,
        selectedStorySlug: selectedStory?.slug ?? null,
        storyOptions,
      },
      focusStory: focusStory
        ? {
            coverImage: focusStory.coverImage,
            readThroughRate: focusStory.readThroughRate,
            slug: focusStory.slug,
            title: focusStory.title,
          }
        : null,
      overview: {
        activeStories: publishedStories.length,
        averageCompletionRate:
          totalChapterReaders > 0
            ? Number(
                ((totalCompletedReaders / totalChapterReaders) * 100).toFixed(1),
              )
            : 0,
        grossRevenueCents: totalRevenueCents,
        publishedChapters: publishedStories.reduce(
          (sum, story) => sum + story.publishedChapters.length,
          0,
        ),
        readThroughRate: focusStory?.readThroughRate ?? 0,
        uniqueReaders: distinctReaders.size,
        views: totalViews,
      },
      storyPerformance,
    };
  }

  private async refreshDailyRollups(
    stories: CreatorAnalyticsStoryRecord[],
    startDate: Date,
    endDateExclusive: Date,
  ) {
    const storyIds = stories.map((story) => story.id);

    if (!storyIds.length) {
      return;
    }

    const chapterNumberById = new Map<string, number>();

    for (const story of stories) {
      for (const chapter of story.publishedChapters) {
        chapterNumberById.set(chapter.id, chapter.chapterNumber);
      }
    }

    const [readEvents, revenueEntries] = await Promise.all([
      this.prisma.chapterReadEvent.findMany({
        where: {
          readDate: {
            gte: startDate,
            lt: endDateExclusive,
          },
          storyId: {
            in: storyIds,
          },
        },
        select: {
          completed: true,
          maxProgressPercent: true,
          publishedChapterId: true,
          readDate: true,
          storyId: true,
          userId: true,
        },
      }),
      this.prisma.walletLedgerEntry.findMany({
        where: {
          createdAt: {
            gte: startDate,
            lt: endDateExclusive,
          },
          reason: {
            in: [WalletLedgerReason.CHAPTER_UNLOCK, WalletLedgerReason.GIFT_SENT],
          },
          storyId: {
            in: storyIds,
          },
        },
        select: {
          createdAt: true,
          deltaCoins: true,
          publishedChapterId: true,
          reason: true,
          storyId: true,
        },
      }),
    ]);

    const storyDailyMap = new Map<
      string,
      {
        completedReaders: Set<string>;
        date: Date;
        giftRevenueCents: number;
        progressSamples: number;
        progressTotal: number;
        revenueCents: number;
        storyId: string;
        uniqueReaders: Set<string>;
        unlockRevenueCents: number;
        viewCount: number;
      }
    >();
    const chapterDailyMap = new Map<
      string,
      {
        chapterNumber: number;
        completedReaders: Set<string>;
        date: Date;
        progressSamples: number;
        progressTotal: number;
        publishedChapterId: string;
        revenueCents: number;
        storyId: string;
        uniqueReaders: Set<string>;
        viewCount: number;
      }
    >();

    for (const event of readEvents) {
      const day = this.startOfUtcDay(event.readDate);
      const storyKey = this.getCompositeKey(event.storyId, day);
      const chapterKey = this.getCompositeKey(event.publishedChapterId, day);
      const storyBucket =
        storyDailyMap.get(storyKey) ??
        {
          completedReaders: new Set<string>(),
          date: day,
          giftRevenueCents: 0,
          progressSamples: 0,
          progressTotal: 0,
          revenueCents: 0,
          storyId: event.storyId,
          uniqueReaders: new Set<string>(),
          unlockRevenueCents: 0,
          viewCount: 0,
        };
      const chapterBucket =
        chapterDailyMap.get(chapterKey) ??
        {
          chapterNumber: chapterNumberById.get(event.publishedChapterId) ?? 0,
          completedReaders: new Set<string>(),
          date: day,
          progressSamples: 0,
          progressTotal: 0,
          publishedChapterId: event.publishedChapterId,
          revenueCents: 0,
          storyId: event.storyId,
          uniqueReaders: new Set<string>(),
          viewCount: 0,
        };

      storyBucket.uniqueReaders.add(event.userId);
      storyBucket.viewCount += 1;
      storyBucket.progressTotal += event.maxProgressPercent;
      storyBucket.progressSamples += 1;

      chapterBucket.uniqueReaders.add(event.userId);
      chapterBucket.viewCount += 1;
      chapterBucket.progressTotal += event.maxProgressPercent;
      chapterBucket.progressSamples += 1;

      if (event.completed) {
        storyBucket.completedReaders.add(event.userId);
        chapterBucket.completedReaders.add(event.userId);
      }

      storyDailyMap.set(storyKey, storyBucket);
      chapterDailyMap.set(chapterKey, chapterBucket);
    }

    for (const entry of revenueEntries) {
      if (!entry.storyId) {
        continue;
      }

      const day = this.startOfUtcDay(entry.createdAt);
      const revenueCents = Math.abs(entry.deltaCoins) * 100;
      const storyKey = this.getCompositeKey(entry.storyId, day);
      const storyBucket =
        storyDailyMap.get(storyKey) ??
        {
          completedReaders: new Set<string>(),
          date: day,
          giftRevenueCents: 0,
          progressSamples: 0,
          progressTotal: 0,
          revenueCents: 0,
          storyId: entry.storyId,
          uniqueReaders: new Set<string>(),
          unlockRevenueCents: 0,
          viewCount: 0,
        };

      storyBucket.revenueCents += revenueCents;

      if (entry.reason === WalletLedgerReason.GIFT_SENT) {
        storyBucket.giftRevenueCents += revenueCents;
      } else {
        storyBucket.unlockRevenueCents += revenueCents;
      }

      storyDailyMap.set(storyKey, storyBucket);

      if (
        entry.reason === WalletLedgerReason.CHAPTER_UNLOCK &&
        entry.publishedChapterId
      ) {
        const chapterKey = this.getCompositeKey(entry.publishedChapterId, day);
        const chapterBucket =
          chapterDailyMap.get(chapterKey) ??
          {
            chapterNumber: chapterNumberById.get(entry.publishedChapterId) ?? 0,
            completedReaders: new Set<string>(),
            date: day,
            progressSamples: 0,
            progressTotal: 0,
            publishedChapterId: entry.publishedChapterId,
            revenueCents: 0,
            storyId: entry.storyId,
            uniqueReaders: new Set<string>(),
            viewCount: 0,
          };

        chapterBucket.revenueCents += revenueCents;
        chapterDailyMap.set(chapterKey, chapterBucket);
      }
    }

    await this.prisma.storyAnalyticsDaily.deleteMany({
      where: {
        date: {
          gte: startDate,
          lt: endDateExclusive,
        },
        storyId: {
          in: storyIds,
        },
      },
    });

    await this.prisma.chapterAnalyticsDaily.deleteMany({
      where: {
        date: {
          gte: startDate,
          lt: endDateExclusive,
        },
        storyId: {
          in: storyIds,
        },
      },
    });

    const storyRows: StoryDailyAccumulator[] = Array.from(storyDailyMap.values()).map(
      (bucket) => ({
        averageProgressPercent:
          bucket.progressSamples > 0
            ? Number((bucket.progressTotal / bucket.progressSamples).toFixed(2))
            : 0,
        completedReaders: bucket.completedReaders.size,
        date: bucket.date,
        giftRevenueCents: bucket.giftRevenueCents,
        revenueCents: bucket.revenueCents,
        storyId: bucket.storyId,
        uniqueReaders: bucket.uniqueReaders.size,
        unlockRevenueCents: bucket.unlockRevenueCents,
        viewCount: bucket.viewCount,
      }),
    );
    const chapterRows: ChapterDailyAccumulator[] = Array.from(
      chapterDailyMap.values(),
    ).map((bucket) => ({
      averageProgressPercent:
        bucket.progressSamples > 0
          ? Number((bucket.progressTotal / bucket.progressSamples).toFixed(2))
          : 0,
      chapterNumber: bucket.chapterNumber,
      completedReaders: bucket.completedReaders.size,
      completionRate:
        bucket.uniqueReaders.size > 0
          ? Number(
              (
                (bucket.completedReaders.size / bucket.uniqueReaders.size) *
                100
              ).toFixed(2),
            )
          : 0,
      date: bucket.date,
      publishedChapterId: bucket.publishedChapterId,
      revenueCents: bucket.revenueCents,
      storyId: bucket.storyId,
      uniqueReaders: bucket.uniqueReaders.size,
      viewCount: bucket.viewCount,
    }));

    await Promise.all(
      storyRows.map((row) =>
        this.prisma.storyAnalyticsDaily.create({
          data: row,
        }),
      ),
    );
    await Promise.all(
      chapterRows.map((row) =>
        this.prisma.chapterAnalyticsDaily.create({
          data: row,
        }),
      ),
    );
  }

  private groupStoryDailyRows(
    rows: Prisma.StoryAnalyticsDailyGetPayload<Record<string, never>>[],
  ) {
    const grouped = new Map<
      string,
      Prisma.StoryAnalyticsDailyGetPayload<Record<string, never>>[]
    >();

    for (const row of rows) {
      const storyRows = grouped.get(row.storyId) ?? [];
      storyRows.push(row);
      grouped.set(row.storyId, storyRows);
    }

    return grouped;
  }

  private groupChapterWindowMetrics(
    rows: Prisma.ChapterAnalyticsDailyGetPayload<{
      include: {
        chapter: {
          select: {
            chapterNumber: true;
            id: true;
            slug: true;
            title: true;
          };
        };
      };
    }>[],
    storyById: Map<string, CreatorAnalyticsStoryRecord>,
    uniqueReadersByChapter: Map<string, Set<string>>,
    completedReadersByChapter: Map<string, Set<string>>,
  ) {
    const grouped = new Map<string, ChapterWindowAggregate[]>();
    const chapterBuckets = new Map<
      string,
      {
        averageProgressTotal: number;
        chapterNumber: number;
        days: number;
        publishedChapterId: string;
        revenueCents: number;
        storyId: string;
        title: string;
        views: number;
      }
    >();

    for (const row of rows) {
      const chapterKey = row.publishedChapterId;
      const current =
        chapterBuckets.get(chapterKey) ??
        {
          averageProgressTotal: 0,
          chapterNumber: row.chapter.chapterNumber,
          days: 0,
          publishedChapterId: row.publishedChapterId,
          revenueCents: 0,
          storyId: row.storyId,
          title: row.chapter.title,
          views: 0,
        };

      current.averageProgressTotal += row.averageProgressPercent * row.viewCount;
      current.days += row.viewCount;
      current.revenueCents += row.revenueCents;
      current.views += row.viewCount;
      chapterBuckets.set(chapterKey, current);
    }

    const firstChapterReadersByStory = new Map<string, number>();

    for (const bucket of chapterBuckets.values()) {
      const story = storyById.get(bucket.storyId);

      if (!story) {
        continue;
      }

      if (bucket.chapterNumber !== story.publishedChapters[0]?.chapterNumber) {
        continue;
      }

      firstChapterReadersByStory.set(
        bucket.storyId,
        uniqueReadersByChapter.get(bucket.publishedChapterId)?.size ?? 0,
      );
    }

    for (const bucket of chapterBuckets.values()) {
      const story = storyById.get(bucket.storyId);

      if (!story) {
        continue;
      }

      const firstReaders =
        firstChapterReadersByStory.get(bucket.storyId) ??
        uniqueReadersByChapter.get(bucket.publishedChapterId)?.size ??
        0;
      const uniqueReaders =
        uniqueReadersByChapter.get(bucket.publishedChapterId)?.size ?? 0;
      const completedReaders =
        completedReadersByChapter.get(bucket.publishedChapterId)?.size ?? 0;
      const chapterMetric: ChapterWindowAggregate = {
        averageProgressPercent:
          bucket.days > 0
            ? Number((bucket.averageProgressTotal / bucket.days).toFixed(1))
            : 0,
        chapterNumber: bucket.chapterNumber,
        completedReaders,
        completionRate:
          uniqueReaders > 0
            ? Number(((completedReaders / uniqueReaders) * 100).toFixed(1))
            : 0,
        coverImage:
          story.assets?.coverImageUrl ??
          story.assets?.cardImageUrl ??
          story.assets?.bannerImageUrl ??
          "",
        publishedChapterId: bucket.publishedChapterId,
        reachRate:
          firstReaders > 0
            ? Number(((uniqueReaders / firstReaders) * 100).toFixed(1))
            : uniqueReaders > 0
              ? 100
              : 0,
        storySlug: story.slug,
        storyTitle: story.title,
        title: bucket.title,
        uniqueReaders,
        views: bucket.views,
      };
      const metrics = grouped.get(bucket.storyId) ?? [];

      metrics.push(chapterMetric);
      grouped.set(bucket.storyId, metrics);
    }

    for (const [storyId, metrics] of grouped.entries()) {
      grouped.set(
        storyId,
        metrics.sort((left, right) => left.chapterNumber - right.chapterNumber),
      );
    }

    return grouped;
  }

  private buildStoryWindowAggregate(input: {
    chapterMetrics: ChapterWindowAggregate[];
    story: CreatorAnalyticsStoryRecord;
    storyDailyRows: Prisma.StoryAnalyticsDailyGetPayload<Record<string, never>>[];
    uniqueReaders: number;
  }): StoryWindowAggregate {
    const views = input.storyDailyRows.reduce((sum, row) => sum + row.viewCount, 0);
    const grossRevenueCents = input.storyDailyRows.reduce(
      (sum, row) => sum + row.revenueCents,
      0,
    );
    const firstChapterReaders = input.chapterMetrics[0]?.uniqueReaders ?? 0;
    const lastChapterReaders =
      input.chapterMetrics[input.chapterMetrics.length - 1]?.uniqueReaders ?? 0;
    const totalChapterReaders = input.chapterMetrics.reduce(
      (sum, chapter) => sum + chapter.uniqueReaders,
      0,
    );
    const totalCompletedReaders = input.chapterMetrics.reduce(
      (sum, chapter) => sum + chapter.completedReaders,
      0,
    );
    const averageProgressPercent =
      input.chapterMetrics.length > 0
        ? Number(
            (
              input.chapterMetrics.reduce(
                (sum, chapter) => sum + chapter.averageProgressPercent,
                0,
              ) / input.chapterMetrics.length
            ).toFixed(1),
          )
        : 0;

    return {
      averageCompletionRate:
        totalChapterReaders > 0
          ? Number(((totalCompletedReaders / totalChapterReaders) * 100).toFixed(1))
          : 0,
      averageProgressPercent,
      chapterCount: input.story.publishedChapters.length,
      completedReaders: totalCompletedReaders,
      coverImage:
        input.story.assets?.coverImageUrl ??
        input.story.assets?.cardImageUrl ??
        input.story.assets?.bannerImageUrl ??
        "",
      grossRevenueCents,
      readThroughRate:
        firstChapterReaders > 0
          ? Number(((lastChapterReaders / firstChapterReaders) * 100).toFixed(1))
          : lastChapterReaders > 0
            ? 100
            : 0,
      slug: input.story.slug,
      title: input.story.title,
      uniqueReaders: input.uniqueReaders,
      views,
    };
  }

  private buildEmptyDashboardResponse(input: {
    dateAxis: Array<{
      date: Date;
      label: string;
    }>;
    days: number;
    selectedStorySlug: string | null;
    storyOptions: Array<{
      coverImage: string;
      publishedChapterCount: number;
      slug: string;
      title: string;
    }>;
  }) {
    return {
      chapterDropOff: [],
      charts: {
        dailyViews: input.dateAxis.map((point) => ({
          date: point.date,
          label: point.label,
          uniqueReaders: 0,
          views: 0,
        })),
        revenue: input.dateAxis.map((point) => ({
          date: point.date,
          giftRevenueCents: 0,
          label: point.label,
          revenueCents: 0,
          unlockRevenueCents: 0,
        })),
      },
      filters: {
        days: input.days,
        selectedStorySlug: input.selectedStorySlug,
        storyOptions: input.storyOptions,
      },
      focusStory: null,
      overview: {
        activeStories: 0,
        averageCompletionRate: 0,
        grossRevenueCents: 0,
        publishedChapters: 0,
        readThroughRate: 0,
        uniqueReaders: 0,
        views: 0,
      },
      storyPerformance: [],
    };
  }

  private mapStoryOption(story: CreatorAnalyticsStoryRecord) {
    return {
      coverImage:
        story.assets?.coverImageUrl ??
        story.assets?.cardImageUrl ??
        story.assets?.bannerImageUrl ??
        "",
      publishedChapterCount: story.publishedChapters.length,
      slug: story.slug,
      title: story.title,
    };
  }

  private addSetValue(
    target: Map<string, Set<string>>,
    key: string,
    value: string,
  ) {
    const current = target.get(key) ?? new Set<string>();
    current.add(value);
    target.set(key, current);
  }

  private buildDateAxis(startDate: Date, days: number) {
    return Array.from({ length: days }, (_, index) => {
      const date = this.addDays(startDate, index);

      return {
        date,
        label: new Intl.DateTimeFormat("en-US", {
          day: "numeric",
          month: "short",
        }).format(date),
      };
    });
  }

  private getCompositeKey(id: string, date: Date) {
    return `${id}:${date.toISOString()}`;
  }

  private startOfUtcDay(date: Date) {
    return new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
  }

  private addDays(date: Date, days: number) {
    const nextDate = new Date(date);
    nextDate.setUTCDate(nextDate.getUTCDate() + days);
    return nextDate;
  }
}
