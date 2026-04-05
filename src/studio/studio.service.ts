import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  AdminBookVisibilityState,
  ChapterStatus,
  Prisma,
  StoryStatus,
} from "@prisma/client";
import { labelFromGenreOrTagSlug } from "../catalog/story-genres";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";
import { EngagementService } from "../engagement/engagement.service";
import {
  defaultBookPlatformPolicy,
  formatVisibilityLabel,
  getStoryVisibilityState,
} from "../utils/book-admin";
import {
  normalizeRichTextDocument,
  richTextToBlocks,
  richTextToPlainText,
} from "../utils/rich-text";
import {
  StudioChapterDraftInput,
  StudioCoverUploadInput,
  StudioPublishInput,
  StudioStoryInput,
  StudioStructureInput,
} from "./studio.types";

type StudioStoryRecord = Prisma.StoryGetPayload<{
  include: {
    adminControl: true;
    assets: true;
    chapters: {
      include: {
        publishedChapter: true;
      };
      orderBy: {
        chapterNumber: "asc";
      };
    };
    publishedChapters: {
      orderBy: {
        publishedAt: "desc";
      };
    };
    volumes: {
      include: {
        arcs: {
          include: {
            chapters: {
              orderBy: {
                chapterNumber: "asc";
              };
            };
          };
          orderBy: {
            sortOrder: "asc";
          };
        };
      };
      orderBy: {
        sortOrder: "asc";
      };
    };
  };
}>;

type StudioChapterRecord = Prisma.ChapterGetPayload<{
  include: {
    arc: true;
    publishedChapter: true;
    story: {
      include: {
        assets: true;
        adminControl: true;
      };
    };
    volume: true;
  };
}>;

@Injectable()
export class StudioService {
  private readonly logger = new Logger(StudioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engagementService: EngagementService,
    private readonly redisService: RedisService,
  ) {}

  async autoPublishDueChapters(
    now = new Date(),
    limit = 10,
  ): Promise<{
    failureCount: number;
    publishedCount: number;
    scannedCount: number;
  }> {
    const dueChapters = await this.prisma.chapter.findMany({
      where: {
        scheduledFor: {
          lte: now,
        },
        status: ChapterStatus.SCHEDULED,
        studioBinnedAt: null,
      },
      include: {
        arc: true,
        publishedChapter: true,
        story: {
          include: {
            adminControl: true,
            assets: true,
          },
        },
        volume: true,
      },
      orderBy: [
        {
          scheduledFor: "asc",
        },
        {
          chapterNumber: "asc",
        },
      ],
      take: limit,
    });

    if (!dueChapters.length) {
      return {
        failureCount: 0,
        publishedCount: 0,
        scannedCount: 0,
      };
    }

    let publishedCount = 0;
    let failureCount = 0;

    for (const chapter of dueChapters) {
      try {
        await this.publishLoadedChapter(chapter);
        publishedCount += 1;
      } catch (error) {
        failureCount += 1;
        this.logger.warn(
          `Scheduled publish failed for story ${chapter.story.slug} chapter ${chapter.slug}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    return {
      failureCount,
      publishedCount,
      scannedCount: dueChapters.length,
    };
  }

  async listStories(
    userId: string,
    pagination: {
      limit?: number | null;
      offset?: number | null;
    } = {},
  ) {
    const limit = pagination.limit ?? null;
    const offset = pagination.offset ?? null;
    const stories = await this.prisma.story.findMany({
      where: {
        authorId: userId,
      },
      include: {
        adminControl: true,
        assets: true,
        chapters: {
          include: {
            publishedChapter: true,
          },
          orderBy: {
            chapterNumber: "asc",
          },
        },
        publishedChapters: {
          orderBy: {
            publishedAt: "desc",
          },
        },
        volumes: {
          include: {
            arcs: {
              include: {
                chapters: {
                  orderBy: {
                    chapterNumber: "asc",
                  },
                },
              },
              orderBy: {
                sortOrder: "asc",
              },
            },
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
      skip: offset ?? undefined,
      take: limit ? limit + 1 : undefined,
    });
    const hasMore = Boolean(limit && stories.length > limit);
    const items = hasMore && limit !== null ? stories.slice(0, limit) : stories;

    return {
      pageInfo: {
        hasMore,
        limit,
        nextOffset: hasMore && limit !== null ? (offset ?? 0) + limit : null,
        offset: offset ?? 0,
      },
      stories: items.map((story) => this.mapStudioStory(story)),
    };
  }

  async getStory(userId: string, storySlug: string) {
    const story = await this.getStoryRecord(userId, storySlug);

    return {
      story: this.mapStudioStory(story),
    };
  }

  async createStory(userId: string, input: StudioStoryInput) {
    const author = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        profile: true,
      },
    });

    if (!author) {
      throw new NotFoundException("Creator account not found.");
    }

    const slug = await this.createUniqueStorySlug(input.title);
    const shortSynopsis = this.createShortSynopsis(input.synopsis);

    // Avoid a duplicate heavy graph load: `getStoryRecord` already fetches the full
    // studio tree; only select ids needed to create the opening arc.
    const story = await this.prisma.story.create({
      data: {
        authorId: userId,
        authorName: author.profile?.displayName ?? "TaleStead Creator",
        genreSlugs: [this.toSlug(input.genre)],
        shortSynopsis,
        slug,
        status: StoryStatus.DRAFT,
        synopsis: input.synopsis,
        tagSlugs: input.tags.map((tag) => this.toSlug(tag)),
        targetAudience: input.audience,
        title: input.title,
        assets: {
          create: {
            bannerImageUrl: input.coverImage,
            cardImageUrl: input.coverImage,
            coverImageUrl: input.coverImage,
          },
        },
        volumes: {
          create: {
            number: 1,
            sortOrder: 0,
            statusLabel: "Planning",
            title: "Volume 1: Opening Arc",
          },
        },
      },
      select: {
        id: true,
        slug: true,
        volumes: {
          orderBy: {
            sortOrder: "asc",
          },
          take: 1,
          select: {
            id: true,
          },
        },
      },
    });

    const openingVolume = story.volumes[0];

    if (openingVolume) {
      await this.prisma.storyArc.create({
        data: {
          sortOrder: 0,
          statusLabel: "Planning",
          storyId: story.id,
          title: "Arc I: Genesis",
          volumeId: openingVolume.id,
        },
      });
    }

    const refreshedStory = await this.getStoryRecord(userId, story.slug);

    return {
      story: this.mapStudioStory(refreshedStory),
    };
  }

  async updateStory(userId: string, storySlug: string, input: StudioStoryInput) {
    const story = await this.getStoryRecord(userId, storySlug);

    const updatedStory = await this.prisma.story.update({
      where: {
        id: story.id,
      },
      data: {
        genreSlugs: [this.toSlug(input.genre)],
        shortSynopsis: this.createShortSynopsis(input.synopsis),
        synopsis: input.synopsis,
        tagSlugs: input.tags.map((tag) => this.toSlug(tag)),
        targetAudience: input.audience,
        title: input.title,
        assets: story.assets
          ? {
              update: {
                bannerImageUrl: input.coverImage,
                cardImageUrl: input.coverImage,
                coverImageUrl: input.coverImage,
              },
            }
          : {
              create: {
                bannerImageUrl: input.coverImage,
                cardImageUrl: input.coverImage,
                coverImageUrl: input.coverImage,
              },
            },
      },
      include: {
        adminControl: true,
        assets: true,
        chapters: {
          include: {
            publishedChapter: true,
          },
          orderBy: {
            chapterNumber: "asc",
          },
        },
        publishedChapters: {
          orderBy: {
            publishedAt: "desc",
          },
        },
        volumes: {
          include: {
            arcs: {
              include: {
                chapters: {
                  orderBy: {
                    chapterNumber: "asc",
                  },
                },
              },
              orderBy: {
                sortOrder: "asc",
              },
            },
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
      },
    });

    await this.invalidateStoryCache(storySlug, story.id);

    return {
      story: this.mapStudioStory(updatedStory),
    };
  }

  async setStoryCompletionStatus(
    userId: string,
    storySlug: string,
    completed: boolean,
  ) {
    const story = await this.prisma.story.findFirst({
      where: {
        authorId: userId,
        slug: storySlug,
      },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    const nextStatus = completed ? StoryStatus.COMPLETED : StoryStatus.PUBLISHED;

    const updatedStory = await this.prisma.story.update({
      where: { id: story.id },
      data: { status: nextStatus },
    });

    return {
      completed: updatedStory.status === StoryStatus.COMPLETED,
      status: updatedStory.status,
    };
  }

  async getChapterDraft(userId: string, storySlug: string, chapterId: string) {
    const chapter = await this.prisma.chapter.findFirst({
      where: {
        id: chapterId,
        story: {
          authorId: userId,
          slug: storySlug,
        },
      },
      include: {
        arc: true,
        publishedChapter: true,
        story: {
          include: {
            adminControl: true,
            assets: true,
          },
        },
        volume: true,
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter draft not found.");
    }

    return {
      chapterDraft: this.mapChapterDraft(chapter),
    };
  }

  async saveChapterDraft(
    userId: string,
    storySlug: string,
    input: StudioChapterDraftInput,
  ) {
    const story = await this.getStoryRecord(userId, storySlug);
    const normalizedBody = normalizeRichTextDocument(input.body);
    const plainTextBody = richTextToPlainText(normalizedBody);
    const chapterNumber = this.parseChapterNumber(input.number);
    const existingChapter = input.chapterId
      ? await this.prisma.chapter.findFirst({
          where: {
            id: input.chapterId,
            storyId: story.id,
          },
        })
      : await this.prisma.chapter.findFirst({
          where: {
            chapterNumber,
            storyId: story.id,
          },
        });

    const chapterSlug =
      existingChapter?.slug ??
      (await this.createUniqueChapterSlug(story.id, input.title, chapterNumber));
    const scheduledFor =
      input.publishType === "scheduled" && input.scheduledFor
        ? this.parseOptionalDate(input.scheduledFor, "scheduledFor")
        : null;

    const chapter = existingChapter
      ? await this.prisma.chapter.update({
          where: {
            id: existingChapter.id,
          },
          data: {
            arcId: this.normalizeId(input.arcId),
            authorNote: input.authorsNote || null,
            bodyDraft: normalizedBody,
            chapterNumber,
            coinUnlockPrice: input.premiumEnabled
              ? Math.max(1, input.coinUnlockPrice)
              : 0,
            contentWarnings: input.warnings,
            excerpt: this.createExcerpt(plainTextBody),
            readingMinutes: this.estimateReadingMinutes(normalizedBody),
            premiumEnabled: input.premiumEnabled,
            scheduledFor,
            slug: chapterSlug,
            status: existingChapter.status === "PUBLISHED" ? "PUBLISHED" : "DRAFT",
            title: input.title,
            volumeId: this.normalizeId(input.volumeId),
            wordCount: this.getWordCount(normalizedBody),
          },
          include: {
            arc: true,
            publishedChapter: true,
            story: {
              include: {
                adminControl: true,
                assets: true,
              },
            },
            volume: true,
          },
        })
      : await this.prisma.chapter.create({
          data: {
            arcId: this.normalizeId(input.arcId),
            authorNote: input.authorsNote || null,
            bodyDraft: normalizedBody,
            chapterNumber,
            coinUnlockPrice: input.premiumEnabled
              ? Math.max(1, input.coinUnlockPrice)
              : 0,
            contentWarnings: input.warnings,
            excerpt: this.createExcerpt(plainTextBody),
            readingMinutes: this.estimateReadingMinutes(normalizedBody),
            premiumEnabled: input.premiumEnabled,
            scheduledFor,
            slug: chapterSlug,
            status: "DRAFT",
            storyId: story.id,
            title: input.title,
            volumeId: this.normalizeId(input.volumeId),
            wordCount: this.getWordCount(normalizedBody),
          },
          include: {
            arc: true,
            publishedChapter: true,
            story: {
              include: {
                adminControl: true,
                assets: true,
              },
            },
            volume: true,
          },
        });

    const refreshedStory = await this.getStoryRecord(userId, storySlug);

    return {
      chapterDraft: this.mapChapterDraft(chapter),
      message: "Chapter draft saved.",
      story: this.mapStudioStory(refreshedStory),
    };
  }

  async publishChapter(userId: string, chapterId: string, input: StudioPublishInput) {
    const chapter = await this.prisma.chapter.findFirst({
      where: {
        id: chapterId,
        story: {
          authorId: userId,
        },
      },
      include: {
        arc: true,
        publishedChapter: true,
        story: {
          include: {
            adminControl: true,
            assets: true,
          },
        },
        volume: true,
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter draft not found.");
    }

    if (chapter.studioBinnedAt) {
      throw new BadRequestException(
        "This chapter is in your bin. Restore it before publishing or scheduling.",
      );
    }

    if (!chapter.title.trim()) {
      throw new BadRequestException("A chapter title is required before publishing.");
    }

    if (!richTextToPlainText(chapter.bodyDraft).trim()) {
      throw new BadRequestException("Chapter body cannot be empty.");
    }

    if (input.mode === "scheduled") {
      const scheduledFor = this.parseOptionalDate(input.scheduledFor, "scheduledFor");

      if (!scheduledFor) {
        throw new BadRequestException("scheduledFor is required for scheduled publishing.");
      }

      await this.prisma.chapter.update({
        where: {
          id: chapter.id,
        },
        data: {
          scheduledFor,
          status: "SCHEDULED",
        },
      });

      const refreshedStory = await this.getStoryRecord(userId, chapter.story.slug);

      return {
        chapterDraft: this.mapChapterDraft({
          ...chapter,
          scheduledFor,
          status: "SCHEDULED",
        }),
        message: "Chapter added to the release queue.",
        story: this.mapStudioStory(refreshedStory),
      };
    }

    await this.publishLoadedChapter(chapter);
    await this.invalidateStoryCache(chapter.story.slug, chapter.story.id);

    const refreshedStory = await this.getStoryRecord(userId, chapter.story.slug);

    return {
      message: "Chapter uploaded.",
      story: this.mapStudioStory(refreshedStory),
    };
  }

  async saveStructure(
    userId: string,
    storySlug: string,
    input: StudioStructureInput,
  ) {
    const story = await this.getStoryRecord(userId, storySlug);

    for (const volumeInput of input.volumes) {
      const volumeId = this.normalizeId(volumeInput.id);
      const volume =
        volumeId &&
        (await this.prisma.storyVolume.findFirst({
          where: {
            id: volumeId,
            storyId: story.id,
          },
        }));
      const persistedVolume = volume
        ? await this.prisma.storyVolume.update({
            where: {
              id: volume.id,
            },
            data: {
              number: volumeInput.number,
              sortOrder: volumeInput.sortOrder,
              statusLabel: volumeInput.status,
              title: volumeInput.title,
            },
          })
        : await this.prisma.storyVolume.create({
            data: {
              number: volumeInput.number,
              sortOrder: volumeInput.sortOrder,
              statusLabel: volumeInput.status,
              storyId: story.id,
              title: volumeInput.title,
            },
          });

      for (const arcInput of volumeInput.arcs) {
        const arcId = this.normalizeId(arcInput.id);
        const arc =
          arcId &&
          (await this.prisma.storyArc.findFirst({
            where: {
              id: arcId,
              storyId: story.id,
              volumeId: persistedVolume.id,
            },
          }));

        if (arc) {
          await this.prisma.storyArc.update({
            where: {
              id: arc.id,
            },
            data: {
              sortOrder: arcInput.sortOrder,
              statusLabel: arcInput.status,
              title: arcInput.title,
            },
          });
          continue;
        }

        await this.prisma.storyArc.create({
          data: {
            sortOrder: arcInput.sortOrder,
            statusLabel: arcInput.status,
            storyId: story.id,
            title: arcInput.title,
            volumeId: persistedVolume.id,
          },
        });
      }
    }

    const refreshedStory = await this.getStoryRecord(userId, storySlug);

    return {
      message: "Volume and arc structure saved.",
      story: this.mapStudioStory(refreshedStory),
    };
  }

  async moveChapterToStudioBin(
    userId: string,
    storySlug: string,
    chapterId: string,
  ) {
    const story = await this.prisma.story.findFirst({
      where: {
        authorId: userId,
        deletedAt: null,
        slug: storySlug,
      },
      select: { id: true, slug: true },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = await this.prisma.chapter.findFirst({
      where: {
        id: chapterId,
        storyId: story.id,
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    if (chapter.studioBinnedAt) {
      throw new BadRequestException("Chapter is already in the bin.");
    }

    const now = new Date();
    const clearSchedule =
      chapter.status === ChapterStatus.SCHEDULED && chapter.scheduledFor;

    await this.prisma.chapter.update({
      where: { id: chapter.id },
      data: {
        scheduledFor: clearSchedule ? null : chapter.scheduledFor,
        status: clearSchedule ? ChapterStatus.DRAFT : chapter.status,
        studioBinnedAt: now,
      },
    });

    const refreshedStory = await this.getStoryRecord(userId, storySlug);

    return {
      message: clearSchedule
        ? "Chapter moved to bin (removed from release queue)."
        : "Chapter moved to bin.",
      story: this.mapStudioStory(refreshedStory),
    };
  }

  async restoreChapterFromStudioBin(
    userId: string,
    storySlug: string,
    chapterId: string,
  ) {
    const story = await this.prisma.story.findFirst({
      where: {
        authorId: userId,
        deletedAt: null,
        slug: storySlug,
      },
      select: { id: true, slug: true },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = await this.prisma.chapter.findFirst({
      where: {
        id: chapterId,
        storyId: story.id,
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    if (!chapter.studioBinnedAt) {
      throw new BadRequestException("Chapter is not in the bin.");
    }

    await this.prisma.chapter.update({
      where: { id: chapter.id },
      data: {
        studioBinnedAt: null,
      },
    });

    const refreshedStory = await this.getStoryRecord(userId, storySlug);

    return {
      message: "Chapter restored from bin.",
      story: this.mapStudioStory(refreshedStory),
    };
  }

  async uploadCover(input: StudioCoverUploadInput) {
    const contentType = input.contentType.trim().toLowerCase();

    if (!contentType.startsWith("image/")) {
      throw new BadRequestException("contentType must be an image MIME type.");
    }

    const sanitizedBase64 = input.base64.replace(/\s+/g, "");
    const approximateSize = Buffer.byteLength(sanitizedBase64, "base64");

    if (approximateSize > 5 * 1024 * 1024) {
      throw new BadRequestException("Cover uploads must be 5 MB or smaller.");
    }

    return {
      coverImageUrl: `data:${contentType};base64,${sanitizedBase64}`,
      filename: input.filename,
    };
  }

  private async publishLoadedChapter(chapter: StudioChapterRecord) {
    const isFirstPublication = !chapter.publishedChapter;
    const publishedAt = new Date();
    const paragraphs = this.splitParagraphs(chapter.bodyDraft);
    const existingBookPolicy = await this.prisma.bookPlatformPolicy.findUnique({
      where: {
        key: defaultBookPlatformPolicy.key,
      },
    });
    const bookPolicy =
      existingBookPolicy ??
      (await this.prisma.bookPlatformPolicy.create({
        data: {
          defaultCoinCap: defaultBookPlatformPolicy.defaultCoinCap,
          defaultPremiumWindowHours:
            defaultBookPlatformPolicy.defaultPremiumWindowHours,
          defaultReleaseMode: defaultBookPlatformPolicy.defaultReleaseMode,
          key: defaultBookPlatformPolicy.key,
        },
      }));

    if (paragraphs.length === 0) {
      throw new BadRequestException("Chapter body cannot be empty.");
    }

    if (!chapter.publishedChapter) {
      await this.prisma.publishedChapter.create({
        data: {
          bodyParagraphs: paragraphs,
          chapterId: chapter.id,
          chapterNumber: chapter.chapterNumber,
          coinUnlockPrice: chapter.premiumEnabled ? chapter.coinUnlockPrice : 0,
          premium: chapter.premiumEnabled,
          publishedAt,
          slug: chapter.slug,
          storyId: chapter.storyId,
          title: chapter.title,
        },
      });
    } else {
      await this.prisma.publishedChapter.update({
        where: {
          id: chapter.publishedChapter.id,
        },
        data: {
          bodyParagraphs: paragraphs,
          coinUnlockPrice: chapter.premiumEnabled ? chapter.coinUnlockPrice : 0,
          premium: chapter.premiumEnabled,
          publishedAt,
          title: chapter.title,
        },
      });
    }

    await this.prisma.chapter.update({
      where: {
        id: chapter.id,
      },
      data: {
        lastPublishedAt: publishedAt,
        scheduledFor: null,
        status: ChapterStatus.PUBLISHED,
      },
    });

    await this.prisma.story.update({
      where: {
        id: chapter.storyId,
      },
      data: {
        latestChapterAt: publishedAt,
        publishedAt: chapter.story.publishedAt ?? publishedAt,
        status:
          chapter.story.status === StoryStatus.DRAFT
            ? StoryStatus.PUBLISHED
            : chapter.story.status,
      },
    });

    if (!chapter.story.adminControl) {
      await this.prisma.storyAdminControl.create({
        data: {
          defaultPremiumWindowHours: bookPolicy.defaultPremiumWindowHours,
          globalCoinCap: bookPolicy.defaultCoinCap,
          releaseMode: bookPolicy.defaultReleaseMode,
          reviewedAt: chapter.story.isLive ? publishedAt : null,
          storyId: chapter.storyId,
          visibilityState: chapter.story.isLive
            ? AdminBookVisibilityState.LIVE
            : AdminBookVisibilityState.PENDING_APPROVAL,
        },
      });
    } else if (
      chapter.story.adminControl.visibilityState !== AdminBookVisibilityState.HIDDEN &&
      chapter.story.adminControl.visibilityState !== AdminBookVisibilityState.LIVE
    ) {
      await this.prisma.storyAdminControl.update({
        where: {
          id: chapter.story.adminControl.id,
        },
        data: {
          visibilityState: AdminBookVisibilityState.PENDING_APPROVAL,
        },
      });
    }

    if (isFirstPublication) {
      await this.engagementService
        .notifyFollowersOfPublishedChapter({
          authorId: chapter.story.authorId ?? null,
          authorName: chapter.story.authorName,
          chapterNumber: chapter.chapterNumber,
          chapterSlug: chapter.slug,
          chapterTitle: chapter.title,
          storyId: chapter.storyId,
          storySlug: chapter.story.slug,
          storyTitle: chapter.story.title,
        })
        .catch((error) => {
          this.logger.warn(
            `Follower notifications failed for story ${chapter.story.slug} chapter ${chapter.slug}: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        });
    }
  }

  private async getStoryRecord(userId: string, storySlug: string) {
    const story = await this.prisma.story.findFirst({
      where: {
        authorId: userId,
        slug: storySlug,
      },
      include: {
        adminControl: true,
        assets: true,
        chapters: {
          include: {
            publishedChapter: true,
          },
          orderBy: {
            chapterNumber: "asc",
          },
        },
        publishedChapters: {
          orderBy: {
            publishedAt: "desc",
          },
        },
        volumes: {
          include: {
            arcs: {
              include: {
                chapters: {
                  orderBy: {
                    chapterNumber: "asc",
                  },
                },
              },
              orderBy: {
                sortOrder: "asc",
              },
            },
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
      },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    return story;
  }

  private mapStudioStory(story: StudioStoryRecord) {
    const coverImage =
      story.assets?.coverImageUrl ??
      story.assets?.cardImageUrl ??
      story.assets?.bannerImageUrl ??
      "";
    const visibilityState = getStoryVisibilityState(story);
    const genreLabel = this.slugToLabel(story.genreSlugs[0] ?? "story");
    const activeChapters = story.chapters.filter((chapter) => !chapter.studioBinnedAt);
    const binnedChapters = story.chapters.filter((chapter) => chapter.studioBinnedAt);
    const binnedChapterIds = new Set(binnedChapters.map((chapter) => chapter.id));
    const chapterCount = activeChapters.length;
    const publishedCount = story.publishedChapters.filter(
      (pc) => !binnedChapterIds.has(pc.chapterId),
    ).length;
    const latestPublishedChapter = [...story.publishedChapters]
      .filter((pc) => !binnedChapterIds.has(pc.chapterId))
      .sort((left, right) => right.chapterNumber - left.chapterNumber)[0];
    const recentChapters = [...activeChapters]
      .sort((left, right) => {
        const leftTime = left.lastPublishedAt?.getTime() ?? left.updatedAt.getTime();
        const rightTime = right.lastPublishedAt?.getTime() ?? right.updatedAt.getTime();

        return rightTime - leftTime;
      })
      .slice(0, 5)
      .map((chapter) => ({
        chapterId: chapter.id,
        detail: this.getRecentChapterDetail(chapter),
        id: chapter.id,
        number: String(chapter.chapterNumber).padStart(2, "0"),
        status: this.mapChapterStatusLabel(chapter.status),
        title: chapter.title,
        views:
          chapter.publishedChapter && story.totalReads > 0
            ? this.formatCompactNumber(story.totalReads)
            : "0",
      }));
    const scheduledChapters = [...activeChapters]
      .filter((chapter) => chapter.status === "SCHEDULED" && chapter.scheduledFor)
      .sort(
        (left, right) =>
          (left.scheduledFor?.getTime() ?? 0) - (right.scheduledFor?.getTime() ?? 0),
      )
      .map((chapter) => ({
        chapterId: chapter.id,
        chapterTitle: `Chapter ${chapter.chapterNumber}: ${chapter.title}`,
        coverImage,
        id: chapter.id,
        scheduledDate: this.formatDateLabel(chapter.scheduledFor!),
        scheduledTime: `${this.formatTimeLabel(chapter.scheduledFor!)} (Local)`,
        status: "Queued",
        storySeries: story.title,
        wordCount: `${chapter.wordCount.toLocaleString()} words`,
      }));
    const publishedChapters = [...story.publishedChapters]
      .filter((chapter) => !binnedChapterIds.has(chapter.chapterId))
      .sort((left, right) => right.chapterNumber - left.chapterNumber)
      .map((chapter) => ({
        chapterId: chapter.chapterId,
        comments: "0",
        coverImage,
        id: chapter.id,
        likes: "0",
        number: String(chapter.chapterNumber).padStart(2, "0"),
        publishedAt: `Published ${this.formatDateLabel(chapter.publishedAt)}`,
        reads: this.formatCompactNumber(story.totalReads),
        status:
          visibilityState === AdminBookVisibilityState.PENDING_APPROVAL
            ? "Pending Review"
            : formatVisibilityLabel(visibilityState),
        title: `Chapter ${chapter.chapterNumber}: ${chapter.title}`,
      }));
    const binnedChaptersPayload = [...binnedChapters]
      .sort(
        (left, right) =>
          (left.studioBinnedAt?.getTime() ?? 0) - (right.studioBinnedAt?.getTime() ?? 0),
      )
      .map((chapter) => ({
        binnedAt: chapter.studioBinnedAt!.toISOString(),
        chapterId: chapter.id,
        detail: this.getRecentChapterDetail(chapter),
        id: chapter.id,
        number: String(chapter.chapterNumber).padStart(2, "0"),
        status: this.mapChapterStatusLabel(chapter.status),
        title: chapter.title,
      }));
    const progress =
      chapterCount === 0
        ? 4
        : Math.min(96, Math.max(8, publishedCount * 18 + (chapterCount - publishedCount) * 6));

    return {
      accent:
        visibilityState === AdminBookVisibilityState.LIVE
          ? "emerald"
          : visibilityState === AdminBookVisibilityState.HIDDEN
            ? "amber"
            : "primary",
      audience: story.targetAudience,
      binnedChapters: binnedChaptersPayload,
      chapterLabel:
        visibilityState === AdminBookVisibilityState.PENDING_APPROVAL &&
        publishedCount > 0
          ? "Waiting for admin review"
          : latestPublishedChapter
          ? `Chapter ${latestPublishedChapter.chapterNumber} live`
          : chapterCount > 0
            ? `${chapterCount} chapter drafts in progress`
            : "Chapter 1 in planning",
      dashboardStatus:
        visibilityState === AdminBookVisibilityState.PENDING_APPROVAL
          ? "Pending Review"
          : formatVisibilityLabel(visibilityState),
      genre: genreLabel,
      heroStatus:
        visibilityState === AdminBookVisibilityState.PENDING_APPROVAL
          ? "Pending Review"
          : this.mapStoryHeroStatus(story.status),
      image: coverImage,
      progress,
      publishedChapters,
      recentChapters,
      scheduledChapters,
      slug: story.slug,
      stats: {
        binnedChapters: String(binnedChapters.length),
        chapters: String(chapterCount),
        completion: `${progress}%`,
        followers: "0",
        reads: this.formatCompactNumber(story.totalReads),
        reviews: String(story.reviewCount),
        stars: story.averageRating > 0 ? story.averageRating.toFixed(1) : "0.0",
      },
      subtitle: `${genreLabel} • ${story.targetAudience} • ${
        visibilityState === AdminBookVisibilityState.PENDING_APPROVAL
          ? "Pending Review"
          : this.mapStoryHeroStatus(story.status)
      }`,
      synopsis: story.synopsis,
      tags: story.tagSlugs.map((tag) => this.slugToLabel(tag)),
      title: story.title,
      visibilityState,
      volumes: story.volumes.map((volume) => ({
        arcCount: volume.arcs.length,
        arcs: volume.arcs.map((arc) => ({
          chapterCount: arc.chapters.filter((chapter) => !chapter.studioBinnedAt).length,
          chapters: arc.chapters
            .filter((chapter) => !chapter.studioBinnedAt)
            .map((chapter) => ({
              chapterId: chapter.id,
              number: String(chapter.chapterNumber).padStart(2, "0"),
              title: chapter.title,
            })),
          id: arc.id,
          sortOrder: arc.sortOrder,
          status: arc.statusLabel,
          title: arc.title,
        })),
        chapterCount: volume.arcs.reduce(
          (count, arc) =>
            count + arc.chapters.filter((chapter) => !chapter.studioBinnedAt).length,
          0,
        ),
        id: volume.id,
        number: volume.number,
        sortOrder: volume.sortOrder,
        status: volume.statusLabel,
        title: volume.title,
      })),
    };
  }

  private mapChapterDraft(chapter: StudioChapterRecord) {
    return {
      arcId: chapter.arcId ?? null,
      authorsNote: chapter.authorNote ?? "",
      body: normalizeRichTextDocument(chapter.bodyDraft),
      chapterId: chapter.id,
      isBinned: Boolean(chapter.studioBinnedAt),
      coinUnlockPrice: chapter.premiumEnabled
        ? Math.max(1, chapter.coinUnlockPrice)
        : 50,
      lastSavedAt: this.formatLastSaved(chapter.updatedAt),
      number: `Chapter ${chapter.chapterNumber}`,
      publishType:
        chapter.status === "SCHEDULED" || chapter.scheduledFor ? "scheduled" : "now",
      premiumEnabled: chapter.premiumEnabled,
      scheduledFor: chapter.scheduledFor
        ? this.formatDateTimeLocalValue(chapter.scheduledFor)
        : "",
      storyTitle: chapter.story.title,
      title: chapter.title,
      volumeId: chapter.volumeId ?? null,
      warnings: chapter.contentWarnings,
    };
  }

  private parseChapterNumber(value: string) {
    const match = value.match(/(\d+)/);

    if (!match) {
      throw new BadRequestException("number must contain a chapter number.");
    }

    const parsed = Number(match[1]);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException("number must contain a valid chapter number.");
    }

    return Math.trunc(parsed);
  }

  async deleteStory(userId: string, storySlug: string) {
    const story = await this.prisma.story.findFirst({
      where: {
        authorId: userId,
        slug: storySlug,
        deletedAt: null,
      },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    await this.prisma.story.update({
      where: { id: story.id },
      data: { deletedAt: new Date() },
    });

    await this.invalidateStoryCache(storySlug, story.id);

    return {
      message: `"${story.title}" has been deleted.`,
    };
  }

  async reorderChapters(
    userId: string,
    storySlug: string,
    orderedChapterIds: string[],
  ) {
    const story = await this.prisma.story.findFirst({
      where: {
        authorId: userId,
        slug: storySlug,
        deletedAt: null,
      },
      include: {
        chapters: {
          orderBy: { chapterNumber: "asc" },
          select: { id: true, studioBinnedAt: true },
        },
      },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    const activeChapters = story.chapters.filter((c) => !c.studioBinnedAt);
    const binnedChapters = story.chapters.filter((c) => c.studioBinnedAt);

    if (orderedChapterIds.length !== activeChapters.length) {
      throw new BadRequestException(
        "chapterIds must list every non-binned chapter for this story in the desired order.",
      );
    }

    const activeIdSet = new Set(activeChapters.map((c) => c.id));
    const seen = new Set<string>();

    for (const id of orderedChapterIds) {
      if (!activeIdSet.has(id)) {
        throw new BadRequestException(
          `Chapter ${id} is not part of the active (non-binned) chapter set for this story.`,
        );
      }

      if (seen.has(id)) {
        throw new BadRequestException("Duplicate chapter id in chapterIds.");
      }

      seen.add(id);
    }

    const orderedWithNumbers: { chapterId: string; chapterNumber: number }[] = [];
    let n = 1;

    for (const chapterId of orderedChapterIds) {
      orderedWithNumbers.push({ chapterId, chapterNumber: n });
      n += 1;
    }

    for (const chapter of binnedChapters) {
      orderedWithNumbers.push({ chapterId: chapter.id, chapterNumber: n });
      n += 1;
    }

    await this.prisma.$transaction(
      orderedWithNumbers.map(({ chapterId, chapterNumber }) =>
        this.prisma.chapter.update({
          where: { id: chapterId },
          data: { chapterNumber },
        }),
      ),
    );

    await this.prisma.$transaction(
      orderedWithNumbers.map(({ chapterId, chapterNumber }) =>
        this.prisma.publishedChapter.updateMany({
          where: { chapterId },
          data: { chapterNumber },
        }),
      ),
    );

    return {
      message: "Chapters reordered successfully.",
    };
  }

  async bulkChapterAction(
    userId: string,
    storySlug: string,
    chapterIds: string[],
    action: string,
  ) {
    const MAX_BULK_SIZE = 50;

    if (chapterIds.length > MAX_BULK_SIZE) {
      throw new BadRequestException(`Cannot process more than ${MAX_BULK_SIZE} chapters at once.`);
    }

    const story = await this.prisma.story.findFirst({
      where: {
        authorId: userId,
        slug: storySlug,
        deletedAt: null,
      },
      include: {
        chapters: {
          where: { id: { in: chapterIds } },
          include: { publishedChapter: true },
        },
      },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    if (story.chapters.length !== chapterIds.length) {
      throw new BadRequestException("Some chapters do not belong to this story.");
    }

    let affectedCount = 0;

    if (action === "UNPUBLISH") {
      const publishedChapterIds = story.chapters
        .filter((c) => c.publishedChapter)
        .map((c) => c.publishedChapter!.id);
      if (publishedChapterIds.length > 0) {
        await this.prisma.publishedChapter.deleteMany({
          where: { id: { in: publishedChapterIds } },
        });
      }
      affectedCount = publishedChapterIds.length;
    } else if (action === "DELETE") {
      await this.prisma.chapter.deleteMany({
        where: { id: { in: chapterIds }, storyId: story.id },
      });
      affectedCount = chapterIds.length;
    } else {
      throw new BadRequestException("Action must be UNPUBLISH or DELETE.");
    }

    return {
      message: `${action.toLowerCase()} applied to ${affectedCount} chapter(s).`,
      affectedCount,
    };
  }

  private async createUniqueStorySlug(title: string) {
    const baseSlug = this.toSlug(title) || "untitled-story";
    let nextSlug = baseSlug;
    let counter = 2;

    while (
      await this.prisma.story.findUnique({
        where: {
          slug: nextSlug,
        },
        select: {
          id: true,
        },
      })
    ) {
      nextSlug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    return nextSlug;
  }

  private async createUniqueChapterSlug(
    storyId: string,
    title: string,
    chapterNumber: number,
  ) {
    const baseSlug = this.toSlug(title) || `chapter-${chapterNumber}`;
    let nextSlug = baseSlug;
    let counter = 2;

    while (
      await this.prisma.chapter.findUnique({
        where: {
          storyId_slug: {
            slug: nextSlug,
            storyId,
          },
        },
        select: {
          id: true,
        },
      })
    ) {
      nextSlug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    return nextSlug;
  }

  private normalizeId(value: string | null) {
    return value && value.trim() ? value.trim() : null;
  }

  private async invalidateStoryCache(storySlug: string, storyId: string) {
    await Promise.all([
      this.redisService.delete(`story:detail:${storySlug}`),
      this.redisService.delete(`story:detail:v2:${storySlug}`),
      this.redisService.delete(`story:agg:${storyId}`),
      this.redisService.delete(`reader:rec-candidates:${storyId}`),
    ]);
  }

  private toSlug(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private slugToLabel(value: string) {
    return labelFromGenreOrTagSlug(value);
  }

  private createShortSynopsis(synopsis: string) {
    return synopsis.trim().slice(0, 180);
  }

  private createExcerpt(body: string) {
    return body.trim().slice(0, 180) || null;
  }

  private getWordCount(body: string) {
    const plainText = richTextToPlainText(body);

    return plainText ? plainText.split(/\s+/).filter(Boolean).length : 0;
  }

  private estimateReadingMinutes(body: string) {
    return Math.max(1, Math.ceil(this.getWordCount(body) / 225));
  }

  private splitParagraphs(body: string) {
    return richTextToBlocks(body);
  }

  private mapStoryHeroStatus(status: StoryStatus) {
    if (status === StoryStatus.PUBLISHED) {
      return "Ongoing Series";
    }

    if (status === StoryStatus.COMPLETED) {
      return "Completed Series";
    }

    if (status === StoryStatus.HIATUS) {
      return "Hiatus";
    }

    return "Draft in Studio";
  }

  private mapChapterStatusLabel(status: string) {
    if (status === "PUBLISHED") {
      return "Published";
    }

    if (status === "SCHEDULED") {
      return "Scheduled";
    }

    if (status === "ARCHIVED") {
      return "Archived";
    }

    return "Draft";
  }

  private getRecentChapterDetail(chapter: {
    lastPublishedAt: Date | null;
    scheduledFor: Date | null;
    status: string;
    updatedAt: Date;
  }) {
    if (chapter.status === "PUBLISHED" && chapter.lastPublishedAt) {
      return `Published ${this.formatDateLabel(chapter.lastPublishedAt)}`;
    }

    if (chapter.status === "SCHEDULED" && chapter.scheduledFor) {
      return `Queued • ${this.formatDateLabel(chapter.scheduledFor)}`;
    }

    return `Draft • Updated ${this.formatDateLabel(chapter.updatedAt)}`;
  }

  private formatCompactNumber(value: number) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 1,
      notation: "compact",
    }).format(value);
  }

  private formatDateLabel(date: Date) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }

  private formatTimeLabel(date: Date) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  private formatLastSaved(date: Date) {
    return `Saved ${new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(date)}`;
  }

  private formatDateTimeLocalValue(date: Date) {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    const hours = `${date.getHours()}`.padStart(2, "0");
    const minutes = `${date.getMinutes()}`.padStart(2, "0");

    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  private parseOptionalDate(value: string | null, fieldName: string) {
    if (!value) {
      return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${fieldName} must be a valid datetime.`);
    }

    return date;
  }
}
