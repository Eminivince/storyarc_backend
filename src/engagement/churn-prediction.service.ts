import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ChurnRiskLevel, InterventionType, Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";

const CHURN_LOCK_KEY = "lock:churn-prediction";
const CHURN_LOCK_TTL = 600;
const CHURN_SCORE_TTL = 86400;
const BATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INTERVENTION_COOLDOWN_DAYS = 7;

interface ChurnScore {
  score: number;
  riskLevel: ChurnRiskLevel;
  factors: Record<string, number>;
}

@Injectable()
export class ChurnPredictionService implements OnModuleInit {
  private readonly logger = new Logger(ChurnPredictionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit() {
    this.runChurnPrediction().catch((err) => {
      this.logger.error(
        `Initial churn prediction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    setInterval(() => {
      this.runChurnPrediction().catch((err) => {
        this.logger.error(
          `Scheduled churn prediction failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, BATCH_INTERVAL_MS);
  }

  async runChurnPrediction() {
    const lockToken = await this.redis.acquireLock(CHURN_LOCK_KEY, CHURN_LOCK_TTL);
    if (!lockToken) {
      this.logger.log("Churn prediction already running on another instance.");
      return;
    }

    try {
      const users = await this.prisma.user.findMany({
        where: { status: "ACTIVE" },
        select: { id: true },
      });

      let scored = 0;
      for (const user of users) {
        try {
          const churnScore = await this.scoreUser(user.id);
          await this.redis.setJson(
            `churn:score:${user.id}`,
            churnScore,
            CHURN_SCORE_TTL,
          );

          if (churnScore.riskLevel !== "LOW") {
            await this.triggerIntervention(
              user.id,
              churnScore.riskLevel,
              churnScore.score,
            );
          }
          scored++;
        } catch (err) {
          this.logger.error(
            `Failed to score user ${user.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.logger.log(`Churn prediction complete: ${scored}/${users.length} users scored.`);
    } finally {
      await this.redis.releaseLock(CHURN_LOCK_KEY, lockToken);
    }
  }

  async scoreUser(userId: string): Promise<ChurnScore> {
    const now = new Date();

    // Factor 1: Days since last open (30%)
    const lastEvent = await this.prisma.userActivityEvent.findFirst({
      where: { userId },
      orderBy: { happenedAt: "desc" },
      select: { happenedAt: true },
    });
    const daysSinceLastOpen = lastEvent
      ? Math.floor((now.getTime() - lastEvent.happenedAt.getTime()) / 86400000)
      : 30;
    const inactivityScore = Math.min(daysSinceLastOpen / 30, 1) * 100;

    // Factor 2: Streak status (25%)
    const wallet = await this.prisma.rewardWallet.findUnique({
      where: { userId },
      select: { streakDays: true },
    });
    const streakDays = wallet?.streakDays ?? 0;
    const streakScore = streakDays >= 7 ? 0 : streakDays >= 3 ? 30 : streakDays >= 1 ? 60 : 100;

    // Factor 3: Reading velocity — chapters in last 14 days (20%)
    const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);
    const recentChapters = await this.prisma.userActivityEvent.count({
      where: {
        userId,
        type: "READ_CHAPTER",
        happenedAt: { gte: twoWeeksAgo },
      },
    });
    const velocityScore = recentChapters >= 10 ? 0 : recentChapters >= 5 ? 25 : recentChapters >= 1 ? 60 : 100;

    // Factor 4: Notification engagement — clicked notifications in last 30 days (15%)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
    const totalNotifications = await this.prisma.appNotification.count({
      where: { userId, createdAt: { gte: thirtyDaysAgo } },
    });
    const readNotifications = await this.prisma.appNotification.count({
      where: { userId, createdAt: { gte: thirtyDaysAgo }, readAt: { not: null } },
    });
    const notifEngagement =
      totalNotifications > 0 ? readNotifications / totalNotifications : 0.5;
    const notifScore = (1 - notifEngagement) * 100;

    // Factor 5: Coin activity — ledger entries in last 30 days (10%)
    const recentLedger = await this.prisma.rewardLedgerEntry.count({
      where: { userId, createdAt: { gte: thirtyDaysAgo } },
    });
    const coinScore = recentLedger >= 5 ? 0 : recentLedger >= 2 ? 30 : recentLedger >= 1 ? 60 : 100;

    const weightedScore = Math.round(
      inactivityScore * 0.3 +
        streakScore * 0.25 +
        velocityScore * 0.2 +
        notifScore * 0.15 +
        coinScore * 0.1,
    );

    const score = Math.max(0, Math.min(100, weightedScore));

    return {
      score,
      riskLevel: this.classifyRisk(score),
      factors: {
        inactivity: Math.round(inactivityScore),
        streak: streakScore,
        velocity: Math.round(velocityScore),
        notifications: Math.round(notifScore),
        coins: coinScore,
      },
    };
  }

  private classifyRisk(score: number): ChurnRiskLevel {
    if (score <= 25) return "LOW";
    if (score <= 50) return "MEDIUM";
    if (score <= 75) return "HIGH";
    if (score <= 90) return "CRITICAL";
    return "CHURNED";
  }

  async triggerIntervention(
    userId: string,
    riskLevel: ChurnRiskLevel,
    riskScore: number,
  ) {
    const cooldownDate = new Date(
      Date.now() - INTERVENTION_COOLDOWN_DAYS * 86400000,
    );

    const recentIntervention = await this.prisma.retentionIntervention.findFirst(
      {
        where: {
          userId,
          riskLevel,
          sentAt: { gte: cooldownDate },
        },
      },
    );

    if (recentIntervention) return;

    const interventionType = this.getInterventionType(riskLevel);
    const channel = this.getChannel(riskLevel);

    const intervention = await this.prisma.retentionIntervention.create({
      data: {
        userId,
        interventionType,
        riskLevel,
        riskScore,
        channel,
        metadata: { triggeredBy: "daily_batch" } as Prisma.InputJsonValue,
      },
    });

    if (riskLevel === "MEDIUM" || riskLevel === "HIGH" || riskLevel === "CRITICAL") {
      await this.prisma.appNotification.create({
        data: {
          userId,
          type: "SYSTEM",
          title: this.getNotificationTitle(riskLevel),
          body: this.getNotificationBody(riskLevel),
          ctaHref: "/",
          ctaLabel: "Open App",
        },
      });
    }

    if (riskLevel === "CRITICAL") {
      await this.redis.setJson(
        `churn:welcome-back:${userId}`,
        { interventionId: intervention.id, riskScore },
        7 * 86400,
      );
    }

    this.logger.log(
      `Intervention sent: user=${userId} level=${riskLevel} type=${interventionType}`,
    );
  }

  private getInterventionType(riskLevel: ChurnRiskLevel): InterventionType {
    switch (riskLevel) {
      case "MEDIUM":
        return "PERSONALIZED_RECOMMENDATION";
      case "HIGH":
        return "RE_ENGAGEMENT_EMAIL";
      case "CRITICAL":
        return "WELCOME_BACK_MODAL";
      case "CHURNED":
        return "WIN_BACK_OFFER";
      default:
        return "PERSONALIZED_RECOMMENDATION";
    }
  }

  private getChannel(riskLevel: ChurnRiskLevel): string {
    switch (riskLevel) {
      case "MEDIUM":
        return "in_app";
      case "HIGH":
        return "in_app,email";
      case "CRITICAL":
        return "in_app,email,modal";
      case "CHURNED":
        return "email";
      default:
        return "in_app";
    }
  }

  private getNotificationTitle(riskLevel: ChurnRiskLevel): string {
    switch (riskLevel) {
      case "MEDIUM":
        return "Stories waiting for you";
      case "HIGH":
        return "We miss you!";
      case "CRITICAL":
        return "Your streak needs saving!";
      default:
        return "Come back and read";
    }
  }

  private getNotificationBody(riskLevel: ChurnRiskLevel): string {
    switch (riskLevel) {
      case "MEDIUM":
        return "You have stories in your reading list. Pick up where you left off!";
      case "HIGH":
        return "It's been a while. Your favorite authors have published new chapters.";
      case "CRITICAL":
        return "Your reading streak is about to reset. Open the app to save it!";
      default:
        return "New stories and chapters are waiting for you.";
    }
  }

  async getReturningUserIntervention(userId: string) {
    const data = await this.redis.getJson<{
      interventionId: string;
      riskScore: number;
    }>(`churn:welcome-back:${userId}`);

    if (!data) return null;

    const recentStories = await this.prisma.story.findMany({
      where: { status: "PUBLISHED" },
      orderBy: { updatedAt: "desc" },
      take: 3,
      select: {
        slug: true,
        title: true,
        assets: { select: { coverImageUrl: true } },
      },
    });

    return {
      interventionId: data.interventionId,
      riskScore: data.riskScore,
      missedStories: recentStories.map((s) => ({
        slug: s.slug,
        title: s.title,
        coverImageUrl: s.assets?.coverImageUrl ?? null,
      })),
    };
  }

  async recordInterventionClick(interventionId: string) {
    await this.prisma.retentionIntervention.update({
      where: { id: interventionId },
      data: { clickedAt: new Date() },
    });
  }

  async recordInterventionConversion(interventionId: string) {
    await this.prisma.retentionIntervention.update({
      where: { id: interventionId },
      data: { convertedAt: new Date() },
    });
  }

  async getUserRiskScore(userId: string) {
    return this.redis.getJson<ChurnScore>(`churn:score:${userId}`);
  }

  async getChurnMetrics() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

    const riskDistribution = await this.prisma.retentionIntervention.groupBy({
      by: ["riskLevel"],
      where: { sentAt: { gte: thirtyDaysAgo } },
      _count: { id: true },
    });

    const interventionStats = await this.prisma.retentionIntervention.groupBy({
      by: ["interventionType"],
      where: { sentAt: { gte: thirtyDaysAgo } },
      _count: { id: true },
    });

    const totalInterventions = await this.prisma.retentionIntervention.count({
      where: { sentAt: { gte: thirtyDaysAgo } },
    });
    const clickedInterventions = await this.prisma.retentionIntervention.count({
      where: { sentAt: { gte: thirtyDaysAgo }, clickedAt: { not: null } },
    });
    const convertedInterventions = await this.prisma.retentionIntervention.count({
      where: { sentAt: { gte: thirtyDaysAgo }, convertedAt: { not: null } },
    });

    return {
      riskDistribution: riskDistribution.map((r) => ({
        riskLevel: r.riskLevel,
        count: r._count.id,
      })),
      interventionStats: interventionStats.map((s) => ({
        type: s.interventionType,
        count: s._count.id,
      })),
      totals: {
        sent: totalInterventions,
        clicked: clickedInterventions,
        converted: convertedInterventions,
        clickRate: totalInterventions > 0 ? clickedInterventions / totalInterventions : 0,
        conversionRate: totalInterventions > 0 ? convertedInterventions / totalInterventions : 0,
      },
    };
  }
}
