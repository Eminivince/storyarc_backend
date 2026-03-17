import { Injectable } from "@nestjs/common";
import { ActivityEventType, Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

@Injectable()
export class ActivityFeedService {
  constructor(private readonly prisma: PrismaService) {}

  async recordActivity(
    userId: string,
    eventType: ActivityEventType,
    metadata?: Record<string, unknown>,
    storyId?: string,
    chapterId?: string,
  ) {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { showActivity: true },
    });

    if (profile?.showActivity === false) return;

    await this.prisma.activityFeedEvent.create({
      data: {
        userId,
        eventType,
        metadata: (metadata as Prisma.InputJsonValue) ?? undefined,
        storyId: storyId ?? undefined,
        chapterId: chapterId ?? undefined,
      },
    });
  }

  async getActivityFeed(
    userId: string,
    cursor?: string,
    limit = 20,
  ) {
    const following = await this.prisma.follow.findMany({
      where: { userId, targetType: "AUTHOR" },
      select: { targetUserId: true },
    });

    const followedUserIds = following
      .map((f) => f.targetUserId)
      .filter(Boolean) as string[];

    if (followedUserIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const events = await this.prisma.activityFeedEvent.findMany({
      where: {
        userId: { in: followedUserIds },
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
        user: {
          profile: {
            showActivity: { not: false },
          },
        },
      },
      include: {
        user: {
          select: {
            id: true,
            profile: { select: { displayName: true, avatarUrl: true } },
          },
        },
        story: {
          select: {
            id: true,
            slug: true,
            title: true,
            assets: { select: { coverImageUrl: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });

    const hasMore = events.length > limit;
    const items = events.slice(0, limit);
    const nextCursor = hasMore
      ? items[items.length - 1].createdAt.toISOString()
      : null;

    return {
      items: items.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
        user: {
          id: e.user.id,
          displayName: e.user.profile?.displayName ?? "Reader",
          avatarUrl: e.user.profile?.avatarUrl ?? null,
        },
        story: e.story
          ? {
              id: e.story.id,
              slug: e.story.slug,
              title: e.story.title,
              coverImageUrl: e.story.assets?.coverImageUrl ?? null,
            }
          : null,
      })),
      nextCursor,
    };
  }

  async getOwnActivity(
    userId: string,
    cursor?: string,
    limit = 20,
  ) {
    const events = await this.prisma.activityFeedEvent.findMany({
      where: {
        userId,
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      include: {
        story: {
          select: {
            id: true,
            slug: true,
            title: true,
            assets: { select: { coverImageUrl: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });

    const hasMore = events.length > limit;
    const items = events.slice(0, limit);
    const nextCursor = hasMore
      ? items[items.length - 1].createdAt.toISOString()
      : null;

    return {
      items: items.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
        story: e.story
          ? {
              id: e.story.id,
              slug: e.story.slug,
              title: e.story.title,
              coverImageUrl: e.story.assets?.coverImageUrl ?? null,
            }
          : null,
      })),
      nextCursor,
    };
  }
}
