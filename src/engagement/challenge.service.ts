import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ChallengeMetric, ChallengeType } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class ChallengeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  // ── reader-facing ────────────────────────────────────────────────────

  async getActiveChallenges(userId: string) {
    const now = new Date();

    const challenges = await this.prisma.readingChallenge.findMany({
      where: {
        isActive: true,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      include: {
        rewardBadge: { select: { key: true, title: true, iconUrl: true, rarity: true } },
      },
      orderBy: { endsAt: "asc" },
    });

    const progressRows = await this.prisma.userChallengeProgress.findMany({
      where: {
        userId,
        challengeId: { in: challenges.map((c) => c.id) },
      },
    });

    const progressMap = new Map(progressRows.map((p) => [p.challengeId, p]));

    return challenges.map((c) => {
      const progress = progressMap.get(c.id);
      const timeRemainingMs = c.endsAt.getTime() - now.getTime();

      return {
        id: c.id,
        title: c.title,
        description: c.description,
        type: c.type,
        targetValue: c.targetValue,
        targetMetric: c.targetMetric,
        rewardPoints: c.rewardPoints,
        rewardBadge: c.rewardBadge,
        startsAt: c.startsAt.toISOString(),
        endsAt: c.endsAt.toISOString(),
        timeRemainingMs: Math.max(timeRemainingMs, 0),
        currentValue: progress?.currentValue ?? 0,
        completedAt: progress?.completedAt?.toISOString() ?? null,
        claimedAt: progress?.claimedAt?.toISOString() ?? null,
      };
    });
  }

  async claimChallengeReward(userId: string, challengeId: string) {
    const progress = await this.prisma.userChallengeProgress.findUnique({
      where: { userId_challengeId: { userId, challengeId } },
      include: {
        challenge: {
          include: {
            rewardBadge: true,
          },
        },
      },
    });

    if (!progress) {
      throw new NotFoundException("Challenge progress not found.");
    }

    if (!progress.completedAt) {
      throw new BadRequestException("Challenge is not yet completed.");
    }

    if (progress.claimedAt) {
      throw new BadRequestException("Reward already claimed.");
    }

    const challenge = progress.challenge;
    const idempotencyKey = `challenge-claim:${userId}:${challengeId}`;

    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.rewardWallet.findUnique({
        where: { userId },
      });

      if (!wallet) {
        throw new BadRequestException("Reward wallet not found.");
      }

      const newBalance = wallet.balancePoints + challenge.rewardPoints;

      await tx.rewardWallet.update({
        where: { userId },
        data: { balancePoints: newBalance },
      });

      await tx.rewardLedgerEntry.upsert({
        where: { idempotencyKey },
        update: {},
        create: {
          rewardWalletId: wallet.id,
          userId,
          entryType: "CREDIT",
          reason: "CHALLENGE_CLAIM",
          deltaPoints: challenge.rewardPoints,
          balanceAfter: newBalance,
          idempotencyKey,
          note: `Challenge: ${challenge.title}`,
        },
      });

      await tx.userChallengeProgress.update({
        where: { userId_challengeId: { userId, challengeId } },
        data: { claimedAt: new Date() },
      });

      await tx.appNotification.create({
        data: {
          userId,
          type: "REWARD",
          title: "Challenge Reward Claimed!",
          body: `You earned ${challenge.rewardPoints} points for completing "${challenge.title}".`,
          ctaLabel: "View Challenges",
          ctaHref: "/account/challenges",
        },
      });

      if (challenge.rewardBadge) {
        const existing = await tx.userBadge.findUnique({
          where: {
            userId_badgeDefinitionId: {
              userId,
              badgeDefinitionId: challenge.rewardBadge.id,
            },
          },
        });

        if (!existing) {
          await tx.userBadge.create({
            data: {
              userId,
              badgeDefinitionId: challenge.rewardBadge.id,
            },
          });
        }
      }
    });

    await this.redisService.delete(`engagement:overview:${userId}`).catch(() => undefined);

    return { success: true, pointsAwarded: challenge.rewardPoints };
  }

  async incrementChallengeProgress(
    userId: string,
    metric: ChallengeMetric,
    delta: number,
  ) {
    const now = new Date();

    const activeChallenges = await this.prisma.readingChallenge.findMany({
      where: {
        isActive: true,
        targetMetric: metric,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
    });

    if (activeChallenges.length === 0) return;

    for (const challenge of activeChallenges) {
      const progress = await this.prisma.userChallengeProgress.upsert({
        where: {
          userId_challengeId: { userId, challengeId: challenge.id },
        },
        update: {
          currentValue: { increment: delta },
        },
        create: {
          userId,
          challengeId: challenge.id,
          currentValue: delta,
        },
      });

      if (!progress.completedAt && progress.currentValue >= challenge.targetValue) {
        await this.prisma.userChallengeProgress.update({
          where: { id: progress.id },
          data: { completedAt: now },
        });

        await this.prisma.appNotification.create({
          data: {
            userId,
            type: "REWARD",
            title: "Challenge Completed!",
            body: `You completed "${challenge.title}". Claim your ${challenge.rewardPoints} point reward!`,
            ctaLabel: "Claim Reward",
            ctaHref: "/account/challenges",
          },
        });
      }
    }
  }

  async getChallengeLeaderboard(challengeId: string) {
    const challenge = await this.prisma.readingChallenge.findUnique({
      where: { id: challengeId },
    });

    if (!challenge) {
      throw new NotFoundException("Challenge not found.");
    }

    const entries = await this.prisma.userChallengeProgress.findMany({
      where: { challengeId },
      orderBy: { currentValue: "desc" },
      take: 20,
      include: {
        user: {
          select: {
            id: true,
            profile: { select: { displayName: true, avatarUrl: true } },
          },
        },
      },
    });

    return {
      challengeId,
      title: challenge.title,
      targetValue: challenge.targetValue,
      leaderboard: entries.map((e, i) => ({
        rank: i + 1,
        userId: e.userId,
        displayName: e.user.profile?.displayName ?? "Reader",
        avatarUrl: e.user.profile?.avatarUrl ?? null,
        currentValue: e.currentValue,
        completedAt: e.completedAt?.toISOString() ?? null,
      })),
    };
  }

  // ── admin ────────────────────────────────────────────────────────────

  async adminCreateChallenge(input: {
    title: string;
    description: string;
    type: ChallengeType;
    targetValue: number;
    targetMetric: ChallengeMetric;
    rewardPoints: number;
    rewardBadgeId?: string | null;
    startsAt: string;
    endsAt: string;
  }) {
    return this.prisma.readingChallenge.create({
      data: {
        title: input.title,
        description: input.description,
        type: input.type,
        targetValue: input.targetValue,
        targetMetric: input.targetMetric,
        rewardPoints: input.rewardPoints,
        rewardBadgeId: input.rewardBadgeId ?? undefined,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
      },
    });
  }

  async adminUpdateChallenge(
    id: string,
    input: {
      title?: string;
      description?: string;
      isActive?: boolean;
      rewardPoints?: number;
      endsAt?: string;
    },
  ) {
    return this.prisma.readingChallenge.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.rewardPoints !== undefined && { rewardPoints: input.rewardPoints }),
        ...(input.endsAt !== undefined && { endsAt: new Date(input.endsAt) }),
      },
    });
  }

  async adminListChallenges() {
    return this.prisma.readingChallenge.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { userProgress: true } },
      },
    });
  }
}
