import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ReactionType } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";

const REACTIONS_CACHE_TTL_SECONDS = 60;

@Injectable()
export class ReactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ── helpers ──────────────────────────────────────────────────────────

  private async resolvePublishedChapter(
    storySlug: string,
    chapterSlug: string,
  ) {
    const story = await this.prisma.story.findUnique({
      where: { slug: storySlug },
      select: { id: true, authorId: true },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = await this.prisma.publishedChapter.findUnique({
      where: { storyId_slug: { storyId: story.id, slug: chapterSlug } },
      select: { id: true, bodyParagraphs: true },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    return { ...chapter, storyAuthorId: story.authorId };
  }

  private reactionsCacheKey(publishedChapterId: string) {
    return `reactions:chapter:${publishedChapterId}`;
  }

  private async clearReactionsCache(publishedChapterId: string) {
    await this.redis
      .delete(this.reactionsCacheKey(publishedChapterId))
      .catch(() => undefined);
  }

  // ── paragraph reactions ──────────────────────────────────────────────

  async upsertParagraphReaction(
    userId: string,
    storySlug: string,
    chapterSlug: string,
    paragraphIndex: number,
    reactionType: ReactionType,
  ) {
    const chapter = await this.resolvePublishedChapter(storySlug, chapterSlug);

    if (paragraphIndex < 0 || paragraphIndex >= chapter.bodyParagraphs.length) {
      throw new BadRequestException(
        `paragraphIndex must be between 0 and ${chapter.bodyParagraphs.length - 1}.`,
      );
    }

    const reaction = await this.prisma.paragraphReaction.upsert({
      where: {
        userId_publishedChapterId_paragraphIndex: {
          userId,
          publishedChapterId: chapter.id,
          paragraphIndex,
        },
      },
      update: { reactionType },
      create: {
        userId,
        publishedChapterId: chapter.id,
        paragraphIndex,
        reactionType,
      },
    });

    await this.clearReactionsCache(chapter.id);

    return { id: reaction.id, reactionType: reaction.reactionType };
  }

  async removeParagraphReaction(
    userId: string,
    storySlug: string,
    chapterSlug: string,
    paragraphIndex: number,
  ) {
    const chapter = await this.resolvePublishedChapter(storySlug, chapterSlug);

    await this.prisma.paragraphReaction
      .delete({
        where: {
          userId_publishedChapterId_paragraphIndex: {
            userId,
            publishedChapterId: chapter.id,
            paragraphIndex,
          },
        },
      })
      .catch(() => undefined);

    await this.clearReactionsCache(chapter.id);

    return { success: true };
  }

  // ── chapter reactions ────────────────────────────────────────────────

  async upsertChapterReaction(
    userId: string,
    storySlug: string,
    chapterSlug: string,
    reactionType: ReactionType,
  ) {
    const chapter = await this.resolvePublishedChapter(storySlug, chapterSlug);

    const reaction = await this.prisma.chapterReaction.upsert({
      where: {
        userId_publishedChapterId: {
          userId,
          publishedChapterId: chapter.id,
        },
      },
      update: { reactionType },
      create: {
        userId,
        publishedChapterId: chapter.id,
        reactionType,
      },
    });

    await this.clearReactionsCache(chapter.id);

    return { id: reaction.id, reactionType: reaction.reactionType };
  }

  async removeChapterReaction(
    userId: string,
    storySlug: string,
    chapterSlug: string,
  ) {
    const chapter = await this.resolvePublishedChapter(storySlug, chapterSlug);

    await this.prisma.chapterReaction
      .delete({
        where: {
          userId_publishedChapterId: {
            userId,
            publishedChapterId: chapter.id,
          },
        },
      })
      .catch(() => undefined);

    await this.clearReactionsCache(chapter.id);

    return { success: true };
  }

  // ── aggregated chapter reactions ─────────────────────────────────────

  async getChapterReactions(
    userId: string,
    storySlug: string,
    chapterSlug: string,
  ) {
    const chapter = await this.resolvePublishedChapter(storySlug, chapterSlug);
    const cacheKey = this.reactionsCacheKey(chapter.id);

    const cached = await this.redis.getJson<{
      paragraphCounts: Record<number, Record<string, number>>;
      chapterCounts: Record<string, number>;
      totalChapterReactions: number;
    }>(cacheKey).catch(() => null);

    if (cached) {

      const userParagraphReaction =
        await this.prisma.paragraphReaction.findMany({
          where: { userId, publishedChapterId: chapter.id },
          select: { paragraphIndex: true, reactionType: true },
        });

      const userChapterReaction = await this.prisma.chapterReaction.findUnique({
        where: {
          userId_publishedChapterId: {
            userId,
            publishedChapterId: chapter.id,
          },
        },
        select: { reactionType: true },
      });

      return {
        ...cached,
        userParagraphReactions: Object.fromEntries(
          userParagraphReaction.map((r) => [r.paragraphIndex, r.reactionType]),
        ),
        userChapterReaction: userChapterReaction?.reactionType ?? null,
      };
    }

    const paragraphReactions = await this.prisma.paragraphReaction.groupBy({
      by: ["paragraphIndex", "reactionType"],
      where: { publishedChapterId: chapter.id },
      _count: { id: true },
    });

    const paragraphCounts: Record<
      number,
      Record<string, number>
    > = {};

    for (const row of paragraphReactions) {
      if (!paragraphCounts[row.paragraphIndex]) {
        paragraphCounts[row.paragraphIndex] = {};
      }
      paragraphCounts[row.paragraphIndex][row.reactionType] = row._count.id;
    }

    const chapterReactions = await this.prisma.chapterReaction.groupBy({
      by: ["reactionType"],
      where: { publishedChapterId: chapter.id },
      _count: { id: true },
    });

    const chapterCounts: Record<string, number> = {};

    for (const row of chapterReactions) {
      chapterCounts[row.reactionType] = row._count.id;
    }

    const totalChapterReactions = await this.prisma.chapterReaction.count({
      where: { publishedChapterId: chapter.id },
    });

    const aggregated = {
      paragraphCounts,
      chapterCounts,
      totalChapterReactions,
    };

    await this.redis
      .setJson(cacheKey, aggregated, REACTIONS_CACHE_TTL_SECONDS)
      .catch(() => undefined);

    const userParagraphReaction = await this.prisma.paragraphReaction.findMany({
      where: { userId, publishedChapterId: chapter.id },
      select: { paragraphIndex: true, reactionType: true },
    });

    const userChapterReaction = await this.prisma.chapterReaction.findUnique({
      where: {
        userId_publishedChapterId: {
          userId,
          publishedChapterId: chapter.id,
        },
      },
      select: { reactionType: true },
    });

    return {
      ...aggregated,
      userParagraphReactions: Object.fromEntries(
        userParagraphReaction.map((r) => [r.paragraphIndex, r.reactionType]),
      ),
      userChapterReaction: userChapterReaction?.reactionType ?? null,
    };
  }

  // ── reaction heatmap (creator only) ──────────────────────────────────

  async getReactionHeatmap(
    userId: string,
    storySlug: string,
    chapterSlug: string,
  ) {
    const chapter = await this.resolvePublishedChapter(storySlug, chapterSlug);

    if (chapter.storyAuthorId !== userId) {
      throw new ForbiddenException(
        "Only the story creator can view the reaction heatmap.",
      );
    }

    const paragraphReactions = await this.prisma.paragraphReaction.groupBy({
      by: ["paragraphIndex", "reactionType"],
      where: { publishedChapterId: chapter.id },
      _count: { id: true },
    });

    const paragraphs: {
      index: number;
      preview: string;
      reactions: Record<string, number>;
      total: number;
    }[] = [];

    for (let i = 0; i < chapter.bodyParagraphs.length; i++) {
      const reactions: Record<string, number> = {};
      let total = 0;

      for (const row of paragraphReactions) {
        if (row.paragraphIndex === i) {
          reactions[row.reactionType] = row._count.id;
          total += row._count.id;
        }
      }

      paragraphs.push({
        index: i,
        preview: chapter.bodyParagraphs[i].slice(0, 80),
        reactions,
        total,
      });
    }

    const chapterReactions = await this.prisma.chapterReaction.groupBy({
      by: ["reactionType"],
      where: { publishedChapterId: chapter.id },
      _count: { id: true },
    });

    const chapterCounts: Record<string, number> = {};
    let chapterTotal = 0;

    for (const row of chapterReactions) {
      chapterCounts[row.reactionType] = row._count.id;
      chapterTotal += row._count.id;
    }

    const totalUniqueReactors = await this.prisma.paragraphReaction
      .findMany({
        where: { publishedChapterId: chapter.id },
        select: { userId: true },
        distinct: ["userId"],
      })
      .then((rows) => rows.length);

    return {
      paragraphs,
      chapterReactions: chapterCounts,
      chapterReactionTotal: chapterTotal,
      totalUniqueReactors,
      totalParagraphs: chapter.bodyParagraphs.length,
    };
  }
}
