import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  CommunityPostType,
  FollowTargetType,
  LeaderboardPeriod,
  MissionMetricType,
  MissionRecurrence,
  NotificationType,
  Prisma,
  RewardLedgerReason,
  RewardLedgerEntryType,
  UserStatus,
} from "@prisma/client";
import { ResendEmailService } from "../auth/resend-email.service";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";
import { isStoryLive } from "../utils/book-admin";

const DAILY_CHECK_IN_REWARD = 50;
const REFERRAL_SHARE_REWARD = 20;
const WELCOME_NOTIFICATION_IDEMPOTENCY = "welcome";
const LEADERBOARD_TABS = ["Weekly", "Monthly", "All Time"];
const ENGAGEMENT_OVERVIEW_CACHE_TTL_SECONDS = 15 * 60;

const missionCatalog = [
  {
    actionHref: "/account/rewards",
    actionLabel: "Check In",
    description: "Keep your streak alive and collect your daily TaleStead reward.",
    group: "READER",
    icon: "today",
    key: "daily-check-in",
    metricType: "DAILY_CHECK_IN",
    recurrence: "DAILY",
    rewardPoints: DAILY_CHECK_IN_REWARD,
    sortOrder: 1,
    targetValue: 1,
    title: "Daily Check-in",
  },
  {
    actionHref: "/dashboard",
    actionLabel: "Read",
    description: "Read three chapters today to deepen your reading momentum.",
    group: "READER",
    icon: "menu_book",
    key: "deep-dive",
    metricType: "READ_CHAPTERS",
    recurrence: "DAILY",
    rewardPoints: 80,
    sortOrder: 2,
    targetValue: 3,
    title: "Deep Dive",
  },
  {
    actionHref: "/dashboard",
    actionLabel: "Bookmark",
    description: "Bookmark a chapter today so your library stays organized.",
    group: "READER",
    icon: "bookmark",
    key: "active-critic",
    metricType: "BOOKMARK_CHAPTERS",
    recurrence: "DAILY",
    rewardPoints: 40,
    sortOrder: 3,
    targetValue: 1,
    title: "Active Critic",
  },
  {
    actionHref: "/account/referrals",
    actionLabel: "Invite",
    description: "Share TaleStead with a friend and extend the world beyond your shelf.",
    group: "READER",
    icon: "share",
    key: "share-results",
    metricType: "SHARE_REFERRAL",
    recurrence: "DAILY",
    rewardPoints: REFERRAL_SHARE_REWARD,
    sortOrder: 4,
    targetValue: 1,
    title: "Share Results",
  },
  {
    actionHref: "/creator/dashboard",
    actionLabel: "Write",
    description: "Write or revise at least 1,200 words in your story studio today.",
    group: "AUTHOR",
    icon: "edit_note",
    key: "writer-flow",
    metricType: "WRITE_WORDS",
    recurrence: "DAILY",
    rewardPoints: 120,
    sortOrder: 5,
    targetValue: 1200,
    title: "Writer Flow",
  },
  {
    actionHref: "/account/profile/edit",
    actionLabel: "Complete",
    description: "Finish your profile so readers and creators know who you are.",
    group: "READER",
    icon: "person",
    key: "profile-complete",
    metricType: "COMPLETE_PROFILE",
    recurrence: "ONE_TIME",
    rewardPoints: 60,
    sortOrder: 6,
    targetValue: 1,
    title: "Profile Complete",
  },
] as const;

type NotificationPreferencesInput = {
  appAchievements: boolean;
  appMaintenance: boolean;
  appStreakAlerts: boolean;
  appSystemUpdates: boolean;
  emailMarketing: boolean;
  emailNewComments: boolean;
  emailSecurityAlerts: boolean;
  emailWeeklyDigest: boolean;
  pushCommentReplies: boolean;
  pushDirectMessages: boolean;
  pushNewStories: boolean;
  pushStoryComments: boolean;
};

type AnnouncementInput = {
  body: string;
  imageUrl: string | null;
  storySlug: string | null;
  title: string;
};

type PollInput = {
  body: string;
  options: Array<{
    imageUrl: string | null;
    label: string;
  }>;
  storySlug: string | null;
  title: string;
};

type ShareReferralInput = {
  channel: string;
  inviteeEmail: string | null;
};

type VotePollInput = {
  optionId: string;
};

type ActiveUserWithProfile = Prisma.UserGetPayload<{
  include: {
    profile: true;
  };
}>;

type EngagementOverviewResponse = {
  claimedMissionIds: string[];
  currentReading: Record<string, unknown> | null;
  missions: Array<Record<string, unknown>>;
  notificationPreferences: Record<string, boolean>;
  notifications: {
    items: Array<Record<string, unknown>>;
    unreadCount: number;
  };
  profile: Record<string, unknown> | null;
  profileStats: Array<{ label: string; value: string }>;
  readingList: Array<Record<string, unknown>>;
  recentActivity: Array<Record<string, unknown>>;
  referrals: {
    code: string;
    history: Array<Record<string, unknown>>;
    mobileCode: string;
    rewardLabel: string;
    totalEarned: number;
  };
  rewards: {
    checkedInToday: boolean;
    points: number;
    streakDays: number;
    weeklyEarned: number;
  };
  rewardCalendar: {
    completedDays: number[];
    month: string;
    today: number;
  };
  streakRewards: Array<{ label: string; reward: string; unlocked: boolean }>;
};

@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resendEmailService: ResendEmailService,
    private readonly redisService: RedisService,
  ) {}

  async getOverview(userId: string) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });

    await this.ensureDefaults(user);
    const cacheKey = this.getOverviewCacheKey(userId);
    const cachedOverview =
      await this.redisService.getJson<EngagementOverviewResponse>(cacheKey);

    if (cachedOverview) {
      return cachedOverview;
    }

    const [
      accountSummary,
      rewardWallet,
      monthlyCheckIns,
      weeklyRewardPoints,
      missions,
      referralCode,
      referralEvents,
      notificationPreference,
      appNotifications,
    ] = await Promise.all([
      this.buildAccountSummary(user),
      this.prisma.rewardWallet.findUnique({
        where: { userId },
      }),
      this.prisma.dailyCheckIn.findMany({
        where: {
          checkedInAt: {
            gte: this.getMonthRange().start,
            lt: this.getMonthRange().end,
          },
          userId,
        },
        orderBy: { checkedInAt: "asc" },
      }),
      this.prisma.rewardLedgerEntry.aggregate({
        _sum: {
          deltaPoints: true,
        },
        where: {
          createdAt: {
            gte: this.daysAgo(7),
          },
          entryType: "CREDIT",
          userId,
        },
      }),
      this.buildMissionPayload(user),
      this.prisma.referralCode.findUnique({
        where: { userId },
      }),
      this.prisma.referralEvent.findMany({
        where: {
          inviterUserId: userId,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 12,
      }),
      this.prisma.notificationPreference.findUnique({
        where: { userId },
      }),
      this.prisma.appNotification.findMany({
        where: { userId },
        orderBy: {
          createdAt: "desc",
        },
        take: 20,
      }),
    ]);

    const currentRewardWallet = rewardWallet ?? {
      balancePoints: 0,
      lastCheckInAt: null,
      streakDays: 0,
    };
    const totalReferralEarned = await this.prisma.rewardLedgerEntry.aggregate({
      _sum: {
        deltaPoints: true,
      },
      where: {
        reason: {
          in: ["REFERRAL_SHARE", "REFERRAL_COMPLETION"],
        },
        userId,
      },
    });

    const response: EngagementOverviewResponse = {
      claimedMissionIds: missions
        .filter((mission) => mission.claimed)
        .map((mission) => mission.id),
      currentReading: accountSummary.currentReading,
      missions,
      notificationPreferences: this.mapNotificationPreference(
        notificationPreference,
      ),
      notifications: {
        items: appNotifications.map((item) => this.mapAppNotification(item)),
        unreadCount: appNotifications.filter((item) => item.readAt === null).length,
      },
      profile: accountSummary.profile,
      profileStats: accountSummary.profileStats,
      readingList: accountSummary.readingList,
      recentActivity: accountSummary.recentActivity,
      referrals: {
        code: referralCode?.code ?? "",
        history: referralEvents.map((event) => this.mapReferralEvent(event)),
        mobileCode: referralCode?.code ?? "",
        rewardLabel: `${REFERRAL_SHARE_REWARD} Arc Points`,
        totalEarned: totalReferralEarned._sum.deltaPoints ?? 0,
      },
      rewards: {
        checkedInToday: this.isToday(currentRewardWallet.lastCheckInAt),
        points: currentRewardWallet.balancePoints,
        streakDays: currentRewardWallet.streakDays,
        weeklyEarned: weeklyRewardPoints._sum.deltaPoints ?? 0,
      },
      rewardCalendar: {
        completedDays: monthlyCheckIns.map((entry) => entry.checkedInAt.getDate()),
        month: this.formatMonthLabel(new Date()),
        today: new Date().getDate(),
      },
      streakRewards: [
        {
          label: "3 Days",
          reward: "Unlock a premium teaser",
          unlocked: currentRewardWallet.streakDays >= 3,
        },
        {
          label: "7 Days",
          reward: "Golden Ticket",
          unlocked: currentRewardWallet.streakDays >= 7,
        },
        {
          label: "14 Days",
          reward: "Featured Reader badge",
          unlocked: currentRewardWallet.streakDays >= 14,
        },
      ],
    };

    await this.redisService.setJson(
      cacheKey,
      response,
      ENGAGEMENT_OVERVIEW_CACHE_TTL_SECONDS,
    );

    return response;
  }

  async claimDailyCheckIn(userId: string) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });

    await this.ensureDefaults(user);

    const todayRange = this.getDayRange();
    const existingCheckIn = await this.prisma.dailyCheckIn.findFirst({
      where: {
        checkedInAt: {
          gte: todayRange.start,
          lt: todayRange.end,
        },
        userId,
      },
    });

    if (existingCheckIn) {
      return {
        message: "Daily check-in already claimed.",
        overview: await this.getOverview(userId),
      };
    }

    const rewardWallet = await this.requireRewardWallet(userId);
    const previousCheckInAt = rewardWallet.lastCheckInAt;
    const yesterdayRange = this.getDayRange(this.daysAgo(1));
    const isConsecutive =
      previousCheckInAt !== null &&
      previousCheckInAt >= yesterdayRange.start &&
      previousCheckInAt < yesterdayRange.end;
    const streakDays = isConsecutive ? rewardWallet.streakDays + 1 : 1;
    const nextBalance = rewardWallet.balancePoints + DAILY_CHECK_IN_REWARD;
    const now = new Date();
    const cycleKey = this.getDailyCycleKey(now);
    const missionDefinition = await this.prisma.missionDefinition.findUnique({
      where: {
        key: "daily-check-in",
      },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.dailyCheckIn.create({
        data: {
          checkedInAt: now,
          rewardPoints: DAILY_CHECK_IN_REWARD,
          userId,
        },
      });

      await tx.rewardWallet.update({
        where: {
          userId,
        },
        data: {
          balancePoints: nextBalance,
          lastCheckInAt: now,
          streakDays,
        },
      });

      await tx.rewardLedgerEntry.create({
        data: {
          balanceAfter: nextBalance,
          deltaPoints: DAILY_CHECK_IN_REWARD,
          entryType: "CREDIT",
          idempotencyKey: `daily-check-in:${userId}:${cycleKey}`,
          note: `Daily check-in reward for ${cycleKey}`,
          reason: "DAILY_CHECK_IN",
          rewardWalletId: rewardWallet.id,
          userId,
        },
      });

      if (missionDefinition) {
        await tx.userMissionState.upsert({
          where: {
            userId_missionDefinitionId_cycleKey: {
              cycleKey,
              missionDefinitionId: missionDefinition.id,
              userId,
            },
          },
          create: {
            claimedAt: now,
            completedAt: now,
            currentValue: 1,
            cycleKey,
            lastProgressAt: now,
            missionDefinitionId: missionDefinition.id,
            userId,
          },
          update: {
            claimedAt: now,
            completedAt: now,
            currentValue: 1,
            lastProgressAt: now,
          },
        });
      }

      await tx.userActivityEvent.create({
        data: {
          happenedAt: now,
          numericValue: 1,
          referenceId: cycleKey,
          type: "DAILY_CHECK_IN",
          userId,
        },
      });

      await tx.appNotification.create({
        data: {
          body: `Your streak is now ${streakDays} day${streakDays === 1 ? "" : "s"} and ${DAILY_CHECK_IN_REWARD} Arc Points were added to your rewards wallet.`,
          ctaHref: "/account/rewards",
          ctaLabel: "Open Rewards",
          title: "Daily check-in complete",
          type: "REWARD",
          userId,
        },
      });
    });

    if (streakDays === 7 || streakDays === 14 || streakDays === 30) {
      await this.maybeSendNotificationEmail(user, "REWARD", {
        body: `You reached a ${streakDays}-day TaleStead streak. Your daily reward has been added to your account.`,
        title: `Streak milestone: ${streakDays} days`,
      });
    }

    await this.clearOverviewCache(userId);

    return {
      message: "Daily check-in claimed.",
      overview: await this.getOverview(userId),
    };
  }

  async claimMission(userId: string, missionKey: string) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });

    await this.ensureDefaults(user);

    const missionDefinition = await this.prisma.missionDefinition.findUnique({
      where: {
        key: missionKey,
      },
    });

    if (!missionDefinition || !missionDefinition.active) {
      throw new NotFoundException("Mission not found.");
    }

    const progress = await this.calculateMissionProgress(user, missionDefinition);
    const cycleKey =
      missionDefinition.recurrence === "DAILY"
        ? this.getDailyCycleKey()
        : "lifetime";
    const existingState = await this.prisma.userMissionState.findUnique({
      where: {
        userId_missionDefinitionId_cycleKey: {
          cycleKey,
          missionDefinitionId: missionDefinition.id,
          userId,
        },
      },
    });

    if (existingState?.claimedAt) {
      return {
        message: "Mission already claimed.",
        overview: await this.getOverview(userId),
      };
    }

    if (progress.currentValue < missionDefinition.targetValue) {
      throw new BadRequestException("Mission is not ready to claim yet.");
    }

    const rewardWallet = await this.requireRewardWallet(userId);
    const nextBalance = rewardWallet.balancePoints + missionDefinition.rewardPoints;
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.rewardWallet.update({
        where: {
          userId,
        },
        data: {
          balancePoints: nextBalance,
        },
      });

      await tx.rewardLedgerEntry.create({
        data: {
          balanceAfter: nextBalance,
          deltaPoints: missionDefinition.rewardPoints,
          entryType: "CREDIT",
          idempotencyKey: `mission:${userId}:${missionDefinition.key}:${cycleKey}`,
          missionDefinitionId: missionDefinition.id,
          note: `${missionDefinition.title} mission claimed`,
          reason: "MISSION_CLAIM",
          rewardWalletId: rewardWallet.id,
          userId,
        },
      });

      await tx.userMissionState.upsert({
        where: {
          userId_missionDefinitionId_cycleKey: {
            cycleKey,
            missionDefinitionId: missionDefinition.id,
            userId,
          },
        },
        create: {
          claimedAt: now,
          completedAt: progress.completedAt ?? now,
          currentValue: progress.currentValue,
          cycleKey,
          lastProgressAt: now,
          missionDefinitionId: missionDefinition.id,
          userId,
        },
        update: {
          claimedAt: now,
          completedAt: progress.completedAt ?? now,
          currentValue: progress.currentValue,
          lastProgressAt: now,
        },
      });

      await tx.appNotification.create({
        data: {
          body: `${missionDefinition.rewardPoints} Arc Points were added to your rewards wallet from ${missionDefinition.title}.`,
          ctaHref: "/account/missions",
          ctaLabel: "View Missions",
          title: "Mission claimed",
          type: "MISSION",
          userId,
        },
      });
    });

    await this.maybeSendNotificationEmail(user, "MISSION", {
      body: `${missionDefinition.title} was claimed successfully and ${missionDefinition.rewardPoints} Arc Points were added to your account.`,
      title: "Mission completed",
    });

    await this.clearOverviewCache(userId);

    return {
      message: `${missionDefinition.title} claimed.`,
      overview: await this.getOverview(userId),
    };
  }

  async shareReferral(userId: string, input: ShareReferralInput) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });

    await this.ensureDefaults(user);

    const [rewardWallet, referralCode] = await Promise.all([
      this.requireRewardWallet(userId),
      this.requireReferralCode(userId),
    ]);
    const nextBalance = rewardWallet.balancePoints + REFERRAL_SHARE_REWARD;
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const event = await tx.referralEvent.create({
        data: {
          channel: input.channel,
          inviteeEmail: input.inviteeEmail,
          inviterUserId: userId,
          referralCodeId: referralCode.id,
          rewardPoints: REFERRAL_SHARE_REWARD,
          status: "SHARED",
        },
      });

      await tx.rewardWallet.update({
        where: {
          userId,
        },
        data: {
          balancePoints: nextBalance,
        },
      });

      await tx.rewardLedgerEntry.create({
        data: {
          balanceAfter: nextBalance,
          deltaPoints: REFERRAL_SHARE_REWARD,
          entryType: "CREDIT",
          idempotencyKey: `referral-share:${event.id}`,
          note: `Referral shared via ${input.channel}`,
          reason: "REFERRAL_SHARE",
          referralEventId: event.id,
          rewardWalletId: rewardWallet.id,
          userId,
        },
      });

      await tx.userActivityEvent.create({
        data: {
          happenedAt: now,
          numericValue: 1,
          referenceId: event.id,
          type: "SHARE_REFERRAL",
          userId,
        },
      });

      await tx.appNotification.create({
        data: {
          body: `${REFERRAL_SHARE_REWARD} Arc Points were added for sharing your referral code via ${input.channel}.`,
          ctaHref: "/account/referrals",
          ctaLabel: "View Referrals",
          title: "Referral shared",
          type: "REFERRAL",
          userId,
        },
      });
    });

    await this.maybeSendNotificationEmail(user, "REFERRAL", {
      body: `Your TaleStead referral code was shared via ${input.channel}. ${REFERRAL_SHARE_REWARD} Arc Points were added to your rewards balance.`,
      title: "Referral activity recorded",
    });

    await this.clearOverviewCache(userId);

    return {
      message: `Referral shared via ${input.channel}.`,
      overview: await this.getOverview(userId),
    };
  }

  async getLeaderboard(userId: string, period: LeaderboardPeriod) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });

    await this.ensureDefaults(user);

    const { end, label, start } = this.getLeaderboardWindow(period);
    const rows = await this.buildLeaderboardRows(period);
    const snapshot = await this.upsertLeaderboardSnapshot(period, label, start, end, rows);
    const orderedEntries = [...snapshot.entries].sort((left, right) => left.rank - right.rank);
    const podiumEntries = orderedEntries.slice(0, 3);
    const visibleEntries = orderedEntries.slice(0, 50);
    const viewerEntry =
      orderedEntries.find((entry) => entry.userId === userId) ??
      {
        badge: null,
        points: 0,
        rank: orderedEntries.length + 1,
        user: user,
        userId,
      };

    return {
      entries: visibleEntries.map((entry) => this.mapLeaderboardEntry(entry)),
      period: this.mapLeaderboardPeriod(period),
      podium: podiumEntries.map((entry) => this.mapLeaderboardPodiumEntry(entry)),
      tabs: LEADERBOARD_TABS,
      userRank: {
        image: user.profile?.avatarUrl ?? null,
        mobileSubtitle:
          viewerEntry.rank <= 3 ? "You're on the podium" : "Keep climbing the leaderboard",
        name:
          user.profile?.displayName ||
          user.email.split("@")[0] ||
          "TaleStead Reader",
        points: this.formatCompactNumber(viewerEntry.points),
        rank: viewerEntry.rank,
        subtitle:
          viewerEntry.rank <= 3
            ? "Top ranked this cycle"
            : `${Math.max(podiumEntries[0]?.points - viewerEntry.points, 0)} points behind first place`,
      },
    };
  }

  async getCommunity(userId: string, storySlug?: string) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });

    await this.ensureDefaults(user);

    const activeStory = await this.resolveCreatorStory(userId, storySlug);

    await this.ensureStarterCommunityPosts(user, activeStory?.id ?? null);

    const posts = await this.prisma.communityPost.findMany({
      where: {
        creatorUserId: userId,
      },
      include: {
        creator: {
          include: {
            profile: true,
          },
        },
        pollOptions: {
          include: {
            votes: true,
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
        story: true,
      },
      orderBy: {
        publishedAt: "desc",
      },
    });

    const livePosts = posts.filter((post) => post.status === "LIVE");
    const archivedPosts = posts.filter((post) => post.status === "ARCHIVED");
    const livePoll = livePosts.find((post) => post.type === "POLL") ?? null;
    const totalVotes = posts.reduce(
      (sum, post) =>
        sum +
        post.pollOptions.reduce((optionSum, option) => optionSum + option.votes.length, 0),
      0,
    );
    const reach = activeStory?.totalReads ?? 0;
    const engagementRate = reach > 0 ? (totalVotes / reach) * 100 : 0;

    return {
      activeStorySlug: activeStory?.slug ?? null,
      archived: archivedPosts.map((post) => this.mapArchivePost(post)),
      feed: livePosts.map((post) => this.mapCommunityPost(post, userId)),
      livePoll: livePoll ? this.mapLivePoll(livePoll, userId) : null,
      scheduled: [],
      stats: [
        {
          label: "Reach",
          value: this.formatCompactNumber(reach || livePosts.length * 1200),
        },
        {
          label: "Engagement",
          value: `${engagementRate.toFixed(1)}%`,
        },
        {
          label: "Poll Votes",
          value: this.formatCompactNumber(totalVotes),
        },
      ],
    };
  }

  async createAnnouncement(userId: string, input: AnnouncementInput) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });
    const story = await this.resolveCreatorStory(userId, input.storySlug ?? undefined, true);

    const post = await this.prisma.communityPost.create({
      data: {
        body: input.body,
        creatorUserId: userId,
        imageUrl: input.imageUrl,
        publishedAt: new Date(),
        storyId: story?.id ?? null,
        title: input.title,
        type: "ANNOUNCEMENT",
      },
      include: {
        creator: {
          include: {
            profile: true,
          },
        },
        pollOptions: {
          include: {
            votes: true,
          },
        },
        story: true,
      },
    });

    await this.broadcastCommunityNotification(user, {
      body: `${input.title} is now live in TaleStead Community.`,
      ctaHref: "/creator/community",
      ctaLabel: "Open Community",
      title: "New announcement published",
    });

    return {
      message: "Announcement published.",
      post: this.mapCommunityPost(post, userId),
    };
  }

  async createPoll(userId: string, input: PollInput) {
    const user = await this.getActiveUser(userId, {
      includeProfile: true,
    });
    const story = await this.resolveCreatorStory(userId, input.storySlug ?? undefined, true);

    const post = await this.prisma.communityPost.create({
      data: {
        body: input.body,
        creatorUserId: userId,
        pollOptions: {
          create: input.options.map((option, index) => ({
            imageUrl: option.imageUrl,
            label: option.label,
            sortOrder: index + 1,
          })),
        },
        publishedAt: new Date(),
        storyId: story?.id ?? null,
        title: input.title,
        type: "POLL",
      },
      include: {
        creator: {
          include: {
            profile: true,
          },
        },
        pollOptions: {
          include: {
            votes: true,
          },
          orderBy: {
            sortOrder: "asc",
          },
        },
        story: true,
      },
    });

    await this.broadcastCommunityNotification(user, {
      body: `${input.title} is ready for votes in TaleStead Community.`,
      ctaHref: "/creator/community",
      ctaLabel: "Vote Now",
      title: "New community poll published",
    });

    return {
      message: "Poll published.",
      post: this.mapCommunityPost(post, userId),
    };
  }

  async votePoll(userId: string, postId: string, input: VotePollInput) {
    await this.getActiveUser(userId);

    const post = await this.prisma.communityPost.findUnique({
      where: {
        id: postId,
      },
      include: {
        creator: {
          include: {
            profile: true,
          },
        },
        pollOptions: {
          include: {
            votes: true,
          },
        },
      },
    });

    if (!post || post.type !== "POLL") {
      throw new NotFoundException("Poll not found.");
    }

    const option = post.pollOptions.find((item) => item.id === input.optionId);

    if (!option) {
      throw new BadRequestException("Selected poll option does not exist.");
    }

    const existingVote = await this.prisma.pollVote.findUnique({
      where: {
        communityPostId_userId: {
          communityPostId: post.id,
          userId,
        },
      },
    });

    if (existingVote) {
      await this.prisma.pollVote.update({
        where: {
          communityPostId_userId: {
            communityPostId: post.id,
            userId,
          },
        },
        data: {
          pollOptionId: option.id,
        },
      });
    } else {
      await this.prisma.pollVote.create({
        data: {
          communityPostId: post.id,
          pollOptionId: option.id,
          userId,
        },
      });
    }

    if (post.creatorUserId !== userId) {
      await this.prisma.appNotification.create({
        data: {
          body: `Someone voted in your poll "${post.title}".`,
          ctaHref: "/creator/community",
          ctaLabel: "View Poll",
          title: "New poll vote",
          type: "COMMUNITY",
          userId: post.creatorUserId,
        },
      });
    }

    return {
      message: "Vote recorded.",
      community: await this.getCommunity(post.creatorUserId),
    };
  }

  async updateNotificationPreferences(
    userId: string,
    input: NotificationPreferencesInput,
  ) {
    await this.getActiveUser(userId);

    const preferences = await this.prisma.notificationPreference.upsert({
      where: {
        userId,
      },
      create: {
        userId,
        ...input,
      },
      update: input,
    });

    await this.clearOverviewCache(userId);

    return {
      message: "Notification settings saved.",
      notificationPreferences: this.mapNotificationPreference(preferences),
    };
  }

  async markNotificationRead(userId: string, notificationId: string) {
    const notification = await this.prisma.appNotification.findFirst({
      where: {
        id: notificationId,
        userId,
      },
    });

    if (!notification) {
      throw new NotFoundException("Notification not found.");
    }

    const updated = await this.prisma.appNotification.update({
      where: {
        id: notificationId,
      },
      data: {
        readAt: notification.readAt ?? new Date(),
      },
    });

    await this.clearOverviewCache(userId);

    return {
      notification: this.mapAppNotification(updated),
    };
  }

  async markAllNotificationsRead(userId: string) {
    await this.prisma.appNotification.updateMany({
      where: {
        readAt: null,
        userId,
      },
      data: {
        readAt: new Date(),
      },
    });

    await this.clearOverviewCache(userId);

    return {
      message: "All notifications marked as read.",
    };
  }

  async notifyFollowersOfPublishedChapter(input: {
    authorId: string | null;
    authorName: string;
    chapterNumber: number;
    chapterSlug: string;
    chapterTitle: string;
    storyId: string;
    storySlug: string;
    storyTitle: string;
  }) {
    const followTargets: Prisma.FollowWhereInput[] = [
      {
        storyId: input.storyId,
        targetType: FollowTargetType.STORY,
      },
    ];

    if (input.authorId) {
      followTargets.push({
        targetType: FollowTargetType.AUTHOR,
        targetUserId: input.authorId,
      });
    }

    const follows = await this.prisma.follow.findMany({
      where: {
        OR: followTargets,
      },
      select: {
        userId: true,
      },
    });
    const recipientIds = Array.from(
      new Set(
        follows
          .map((follow) => follow.userId)
          .filter((userId) => userId && userId !== input.authorId),
      ),
    );

    if (!recipientIds.length) {
      return;
    }

    const recipients = await this.prisma.user.findMany({
      where: {
        id: {
          in: recipientIds,
        },
        status: UserStatus.ACTIVE,
      },
      include: {
        notificationPreference: true,
        profile: true,
      },
    });
    const title = input.authorName.trim()
      ? `New chapter from ${input.authorName}`
      : `New chapter in ${input.storyTitle}`;
    const body = `${input.storyTitle} just published Chapter ${input.chapterNumber}: ${input.chapterTitle}.`;
    const ctaHref = `/read/${input.storySlug}/${input.chapterSlug}`;

    await Promise.all(
      recipients
        .filter((user) => user.notificationPreference?.pushNewStories ?? true)
        .map(async (user) => {
          await this.prisma.appNotification.create({
            data: {
              body,
              ctaHref,
              ctaLabel: "Read Chapter",
              title,
              type: "COMMUNITY",
              userId: user.id,
            },
          });

          if (user.notificationPreference?.emailNewComments ?? true) {
            await this.resendEmailService
              .sendNotificationEmail({
                email: user.email,
                preview: `${body} Tap below to start reading.`,
                subject: title,
                title,
                userName:
                  user.profile?.displayName?.trim()
                    ? user.profile.displayName
                    : user.email.split("@")[0] || "TaleStead Reader",
              })
              .catch((error: unknown) => {
                const message =
                  error instanceof Error ? error.message : "unknown email error";

                this.logger.warn(
                  `Could not send new chapter email to ${user.id}: ${message}`,
                );
              });
          }
        }),
    );
  }

  async notifyUsersOfChapterComment(input: {
    actorDisplayName: string;
    actorUserId: string;
    chapterNumber: number;
    chapterSlug: string;
    chapterTitle: string;
    commentBody: string;
    parentCommentAuthorId: string | null;
    storyAuthorId: string | null;
    storySlug: string;
    storyTitle: string;
  }) {
    const recipientReasons = new Map<
      string,
      {
        reply: boolean;
        story: boolean;
      }
    >();

    if (
      input.storyAuthorId &&
      input.storyAuthorId !== input.actorUserId
    ) {
      recipientReasons.set(input.storyAuthorId, {
        reply: false,
        story: true,
      });
    }

    if (
      input.parentCommentAuthorId &&
      input.parentCommentAuthorId !== input.actorUserId
    ) {
      const existing = recipientReasons.get(input.parentCommentAuthorId);
      recipientReasons.set(input.parentCommentAuthorId, {
        reply: true,
        story: existing?.story ?? false,
      });
    }

    const recipientIds = Array.from(recipientReasons.keys());

    if (!recipientIds.length) {
      return;
    }

    const recipients = await this.prisma.user.findMany({
      where: {
        id: {
          in: recipientIds,
        },
        status: UserStatus.ACTIVE,
      },
      include: {
        notificationPreference: true,
        profile: true,
      },
    });
    const ctaHref = `/read/${input.storySlug}/${input.chapterSlug}`;
    const preview = this.truncateCopy(input.commentBody, 160);

    await Promise.all(
      recipients.map(async (recipient) => {
        const reasons = recipientReasons.get(recipient.id);

        if (!reasons) {
          return;
        }

        const preferences = recipient.notificationPreference;
        const notificationKind = reasons.reply ? "reply" : "story";
        const pushReason =
          reasons.reply && (preferences?.pushCommentReplies ?? true)
            ? "reply"
            : reasons.story && (preferences?.pushStoryComments ?? true)
              ? "story"
              : null;
        const notificationTitle =
          notificationKind === "reply"
            ? `${input.actorDisplayName} replied to your comment`
            : `${input.actorDisplayName} commented on ${input.storyTitle}`;
        const notificationBody =
          notificationKind === "reply"
            ? `In Chapter ${input.chapterNumber}: ${preview}`
            : `${input.chapterTitle} now has a new reader comment: ${preview}`;

        if (pushReason) {
          await this.prisma.appNotification.create({
            data: {
              body: notificationBody,
              ctaHref,
              ctaLabel: "Open Comments",
              title: notificationTitle,
              type: NotificationType.COMMUNITY,
              userId: recipient.id,
            },
          });
        }

        if (preferences?.emailNewComments ?? true) {
          const emailTitle =
            reasons.reply
              ? `${input.actorDisplayName} replied to your TaleStead comment`
              : `${input.actorDisplayName} commented on ${input.storyTitle}`;

          await this.resendEmailService
            .sendNotificationEmail({
              email: recipient.email,
              preview: `${notificationBody} Open the chapter to join the discussion.`,
              subject: emailTitle,
              title: emailTitle,
              userName: recipient.profile?.displayName?.trim()
                ? recipient.profile.displayName
                : recipient.email.split("@")[0] || "TaleStead Reader",
            })
            .catch((error: unknown) => {
              const message =
                error instanceof Error ? error.message : "unknown email error";

              this.logger.warn(
                `Could not send comment notification email to ${recipient.id}: ${message}`,
              );
            });
        }
      }),
    );
  }

  private async ensureDefaults(
    user: Prisma.UserGetPayload<{
      include: {
        profile: true;
      };
    }>,
  ) {
    await Promise.all([
      this.ensureRewardWallet(user.id),
      this.ensureNotificationPreference(user.id),
      this.ensureReferralCode(user),
      this.ensureMissionDefinitions(),
      this.ensureWelcomeNotification(user.id),
    ]);
  }

  private async ensureRewardWallet(userId: string) {
    await this.prisma.rewardWallet.upsert({
      where: {
        userId,
      },
      create: {
        balancePoints: 0,
        streakDays: 0,
        userId,
      },
      update: {},
    });
  }

  private async ensureNotificationPreference(userId: string) {
    await this.prisma.notificationPreference.upsert({
      where: {
        userId,
      },
      create: {
        userId,
      },
      update: {},
    });
  }

  private async ensureReferralCode(
    user: Prisma.UserGetPayload<{
      include: {
        profile: true;
      };
    }>,
  ) {
    const existingCode = await this.prisma.referralCode.findUnique({
      where: {
        userId: user.id,
      },
    });

    if (existingCode) {
      return existingCode;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = this.generateReferralCode(user, attempt);

      try {
        return await this.prisma.referralCode.create({
          data: {
            code,
            userId: user.id,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          continue;
        }

        throw error;
      }
    }

    throw new BadRequestException("Could not create a unique referral code.");
  }

  private async ensureMissionDefinitions() {
    for (const mission of missionCatalog) {
      await this.prisma.missionDefinition.upsert({
        where: {
          key: mission.key,
        },
        create: {
          ...mission,
        },
        update: {
          actionHref: mission.actionHref,
          actionLabel: mission.actionLabel,
          active: true,
          description: mission.description,
          group: mission.group,
          icon: mission.icon,
          metricType: mission.metricType,
          recurrence: mission.recurrence,
          rewardPoints: mission.rewardPoints,
          sortOrder: mission.sortOrder,
          targetValue: mission.targetValue,
          title: mission.title,
        },
      });
    }
  }

  private async ensureWelcomeNotification(userId: string) {
    const existingNotification = await this.prisma.appNotification.findFirst({
      where: {
        ctaHref: "/account/rewards",
        title: "Welcome to TaleStead Rewards",
        userId,
      },
    });

    if (existingNotification) {
      return;
    }

    await this.prisma.appNotification.create({
      data: {
        body: "Check in daily, claim missions, and share your referral code to grow your rewards wallet.",
        ctaHref: "/account/rewards",
        ctaLabel: "View Rewards",
        title: "Welcome to TaleStead Rewards",
        type: "SYSTEM",
        userId,
      },
    });
  }

  private async buildMissionPayload(
    user: Prisma.UserGetPayload<{
      include: {
        profile: true;
      };
    }>,
  ) {
    const missionDefinitions = await this.prisma.missionDefinition.findMany({
      where: {
        active: true,
      },
      orderBy: {
        sortOrder: "asc",
      },
    });
    const cycleKeys = new Set(["lifetime", this.getDailyCycleKey()]);
    const states = await this.prisma.userMissionState.findMany({
      where: {
        cycleKey: {
          in: Array.from(cycleKeys),
        },
        missionDefinitionId: {
          in: missionDefinitions.map((mission) => mission.id),
        },
        userId: user.id,
      },
    });
    const stateMap = new Map(
      states.map((state) => [
        `${state.missionDefinitionId}:${state.cycleKey}`,
        state,
      ]),
    );

    return Promise.all(
      missionDefinitions.map(async (mission) => {
        const progress = await this.calculateMissionProgress(user, mission);
        const cycleKey =
          mission.recurrence === "DAILY" ? this.getDailyCycleKey() : "lifetime";
        const state = stateMap.get(`${mission.id}:${cycleKey}`) ?? null;
        const claimed = Boolean(state?.claimedAt);

        return {
          actionLabel: mission.actionLabel,
          current: progress.currentValue,
          description: mission.description,
          group: mission.group === "AUTHOR" ? "Author" : "Reader",
          href: mission.actionHref ?? "/dashboard",
          icon: mission.icon,
          id: mission.key,
          claimed,
          reward: mission.rewardPoints,
          target: mission.targetValue,
          title: mission.title,
        };
      }),
    );
  }

  private async calculateMissionProgress(
    user: Prisma.UserGetPayload<{
      include: {
        profile: true;
      };
    }>,
    missionDefinition: Prisma.MissionDefinitionGetPayload<Record<string, never>>,
  ) {
    const now = new Date();
    const todayRange = this.getDayRange(now);

    switch (missionDefinition.metricType) {
      case "DAILY_CHECK_IN": {
        const count = await this.prisma.dailyCheckIn.count({
          where: {
            checkedInAt: {
              gte: todayRange.start,
              lt: todayRange.end,
            },
            userId: user.id,
          },
        });

        return {
          completedAt: count > 0 ? now : null,
          currentValue: Math.min(count, missionDefinition.targetValue),
        };
      }
      case "READ_CHAPTERS": {
        const chapterReads = await this.prisma.userActivityEvent.findMany({
          where: {
            happenedAt: {
              gte: todayRange.start,
              lt: todayRange.end,
            },
            type: "READ_CHAPTER",
            userId: user.id,
          },
          select: {
            referenceId: true,
          },
        });
        const uniqueReads = new Set(
          chapterReads.map((event) => event.referenceId).filter(Boolean),
        ).size;

        return {
          completedAt: uniqueReads >= missionDefinition.targetValue ? now : null,
          currentValue: uniqueReads,
        };
      }
      case "BOOKMARK_CHAPTERS": {
        const count = await this.prisma.bookmark.count({
          where: {
            createdAt: {
              gte: todayRange.start,
              lt: todayRange.end,
            },
            userId: user.id,
          },
        });

        return {
          completedAt: count >= missionDefinition.targetValue ? now : null,
          currentValue: count,
        };
      }
      case "SHARE_REFERRAL": {
        const count = await this.prisma.referralEvent.count({
          where: {
            createdAt: {
              gte: todayRange.start,
              lt: todayRange.end,
            },
            inviterUserId: user.id,
          },
        });

        return {
          completedAt: count >= missionDefinition.targetValue ? now : null,
          currentValue: count,
        };
      }
      case "WRITE_WORDS": {
        const chapters = await this.prisma.chapter.findMany({
          where: {
            story: {
              authorId: user.id,
            },
            updatedAt: {
              gte: todayRange.start,
              lt: todayRange.end,
            },
          },
          select: {
            wordCount: true,
          },
        });
        const wordCount = chapters.reduce(
          (sum, chapter) => sum + chapter.wordCount,
          0,
        );

        return {
          completedAt: wordCount >= missionDefinition.targetValue ? now : null,
          currentValue: wordCount,
        };
      }
      case "COMPLETE_PROFILE": {
        const isComplete = Boolean(
          user.profile?.displayName &&
            user.profile?.bio &&
            user.profile?.selectedGenres?.length,
        );

        return {
          completedAt: isComplete ? now : null,
          currentValue: isComplete ? 1 : 0,
        };
      }
      default:
        return {
          completedAt: null,
          currentValue: 0,
        };
    }
  }

  private async buildLeaderboardRows(period: LeaderboardPeriod) {
    const users = await this.prisma.user.findMany({
      where: {
        status: "ACTIVE",
      },
      include: {
        profile: true,
        rewardWallet: true,
      },
    });

    if (period === "ALL_TIME") {
      return users
        .map((user) => ({
          points: user.rewardWallet?.balancePoints ?? 0,
          user,
        }))
        .sort((left, right) => right.points - left.points)
        .map((row, index) => ({
          badge: index === 0 ? "Champion" : null,
          points: row.points,
          rank: index + 1,
          user: row.user,
          userId: row.user.id,
        }));
    }

    const window = this.getLeaderboardWindow(period);
    const ledger = await this.prisma.rewardLedgerEntry.findMany({
      where: {
        createdAt: {
          gte: window.start,
          lt: window.end,
        },
      },
      select: {
        deltaPoints: true,
        userId: true,
      },
    });
    const pointsByUserId = new Map<string, number>();

    for (const entry of ledger) {
      pointsByUserId.set(
        entry.userId,
        (pointsByUserId.get(entry.userId) ?? 0) + entry.deltaPoints,
      );
    }

    return users
      .map((user) => ({
        points: pointsByUserId.get(user.id) ?? 0,
        user,
      }))
      .sort((left, right) => right.points - left.points)
      .map((row, index) => ({
        badge: index === 0 ? "Champion" : null,
        points: row.points,
        rank: index + 1,
        user: row.user,
        userId: row.user.id,
      }));
  }

  private async upsertLeaderboardSnapshot(
    period: LeaderboardPeriod,
    title: string,
    startsAt: Date,
    endsAt: Date,
    rows: Array<{
      badge: string | null;
      points: number;
      rank: number;
      user: Prisma.UserGetPayload<{
        include: {
          profile: true;
          rewardWallet: true;
        };
      }>;
      userId: string;
    }>,
  ) {
    const existing = await this.prisma.leaderboardSnapshot.findFirst({
      where: {
        endsAt,
        period,
        startsAt,
      },
      include: {
        entries: {
          include: {
            user: {
              include: {
                profile: true,
                rewardWallet: true,
              },
            },
          },
        },
      },
    });

    if (existing) {
      await this.prisma.leaderboardEntry.deleteMany({
        where: {
          leaderboardSnapshotId: existing.id,
        },
      });

      await Promise.all(
        rows.map((row) =>
          this.prisma.leaderboardEntry.create({
            data: {
              badge: row.badge,
              leaderboardSnapshotId: existing.id,
              points: row.points,
              rank: row.rank,
              userId: row.userId,
            },
          }),
        ),
      );

      return this.prisma.leaderboardSnapshot.findUniqueOrThrow({
        where: {
          id: existing.id,
        },
        include: {
          entries: {
            include: {
              user: {
                include: {
                  profile: true,
                  rewardWallet: true,
                },
              },
            },
          },
        },
      });
    }

    return this.prisma.leaderboardSnapshot.create({
      data: {
        endsAt,
        period,
        startsAt,
        title,
        entries: {
          create: rows.map((row) => ({
            badge: row.badge,
            points: row.points,
            rank: row.rank,
            userId: row.userId,
          })),
        },
      },
      include: {
        entries: {
          include: {
            user: {
              include: {
                profile: true,
                rewardWallet: true,
              },
            },
          },
        },
      },
    });
  }

  private async ensureStarterCommunityPosts(
    user: Prisma.UserGetPayload<{
      include: {
        profile: true;
      };
    }>,
    storyId: string | null,
  ) {
    if (user.role !== "CREATOR" && user.role !== "ADMIN") {
      return;
    }

    const existingCount = await this.prisma.communityPost.count({
      where: {
        creatorUserId: user.id,
      },
    });

    if (existingCount > 0) {
      return;
    }

    await this.prisma.communityPost.create({
      data: {
        body: "Your creator community is live. Use this space to keep readers informed between chapters, announce release notes, and gather feedback.",
        creatorUserId: user.id,
        imageUrl:
          "https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=1200&q=80",
        storyId,
        title: "Welcome to your creator community",
        type: "ANNOUNCEMENT",
      },
    });

    await this.prisma.communityPost.create({
      data: {
        body: "Launch your first poll and start learning what your readers want next.",
        creatorUserId: user.id,
        pollOptions: {
          create: [
            {
              label: "More worldbuilding notes",
              sortOrder: 1,
            },
            {
              label: "Character spotlight extras",
              sortOrder: 2,
            },
          ],
        },
        storyId,
        title: "What bonus content should go live next?",
        type: "POLL",
      },
    });
  }

  private async broadcastCommunityNotification(
    actor: Prisma.UserGetPayload<{
      include: {
        profile: true;
      };
    }>,
    payload: {
      body: string;
      ctaHref: string;
      ctaLabel: string;
      title: string;
    },
  ) {
    const users = await this.prisma.user.findMany({
      where: {
        status: "ACTIVE",
      },
      include: {
        notificationPreference: true,
        profile: true,
      },
    });

    for (const user of users) {
      const notification = await this.prisma.appNotification.create({
        data: {
          body: payload.body,
          ctaHref: payload.ctaHref,
          ctaLabel: payload.ctaLabel,
          title: payload.title,
          type: "COMMUNITY",
          userId: user.id,
        },
      });

      if (user.notificationPreference?.emailMarketing) {
        await this.resendEmailService
          .sendNotificationEmail({
            email: user.email,
            preview: payload.body,
            subject: payload.title,
            title: payload.title,
            userName:
              user.profile?.displayName || user.email.split("@")[0] || "TaleStead Reader",
          })
          .then(async () => {
            await this.prisma.appNotification.update({
              where: {
                id: notification.id,
              },
              data: {
                emailedAt: new Date(),
              },
            });
          })
          .catch(() => {
            return null;
          });
      }
    }

    if (actor.id) {
      await this.prisma.appNotification.create({
        data: {
          body: "Your community update has been published and distributed to readers.",
          ctaHref: "/creator/community",
          ctaLabel: "View Community",
          title: "Community post is live",
          type: "COMMUNITY",
          userId: actor.id,
        },
      });
    }
  }

  private async maybeSendNotificationEmail(
    user: Prisma.UserGetPayload<{
      include: {
        profile: true;
      };
    }>,
    type: NotificationType,
    payload: {
      body: string;
      title: string;
    },
  ) {
    const preferences = await this.prisma.notificationPreference.findUnique({
      where: {
        userId: user.id,
      },
    });

    const shouldEmail =
      type === "SECURITY"
        ? preferences?.emailSecurityAlerts
        : type === "COMMUNITY"
          ? preferences?.emailMarketing
          : preferences?.emailWeeklyDigest;

    if (!shouldEmail) {
      return;
    }

    await this.resendEmailService.sendNotificationEmail({
      email: user.email,
      preview: payload.body,
      subject: payload.title,
      title: payload.title,
      userName:
        user.profile?.displayName || user.email.split("@")[0] || "TaleStead Reader",
    });
  }

  private async buildAccountSummary(user: ActiveUserWithProfile) {
    const [
      readingProgressCount,
      bookmarks,
      authoredStories,
      currentReadingEntry,
      recentActivity,
    ] = await Promise.all([
      this.prisma.readingProgress.count({
        where: {
          userId: user.id,
        },
      }),
      this.prisma.bookmark.findMany({
        where: {
          userId: user.id,
        },
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
        take: 30,
      }),
      this.prisma.story.findMany({
        where: {
          authorId: user.id,
        },
        select: {
          totalReads: true,
        },
      }),
      this.prisma.readingProgress.findFirst({
        where: {
          userId: user.id,
        },
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
      }),
      this.buildRecentActivity(user),
    ]);

    const visibleBookmarks = bookmarks.filter((bookmark) => isStoryLive(bookmark.story));
    const savedStoryCount = new Set(
      visibleBookmarks.map((bookmark) => bookmark.storyId),
    ).size;
    const authorReads = authoredStories.reduce(
      (sum, story) => sum + story.totalReads,
      0,
    );
    const readingList = [];
    const seenStoryIds = new Set<string>();

    for (const bookmark of visibleBookmarks) {
      if (seenStoryIds.has(bookmark.storyId)) {
        continue;
      }

      seenStoryIds.add(bookmark.storyId);
      readingList.push({
        authorName: bookmark.story.authorName,
        chapterSlug: bookmark.chapter.slug,
        chapterTitle: bookmark.chapter.title,
        coverImage:
          bookmark.story.assets?.coverImageUrl ??
          bookmark.story.assets?.cardImageUrl ??
          bookmark.story.assets?.bannerImageUrl ??
          "",
        storySlug: bookmark.story.slug,
        storyTitle: bookmark.story.title,
      });

      if (readingList.length === 3) {
        break;
      }
    }

    return {
      currentReading:
        currentReadingEntry && isStoryLive(currentReadingEntry.story)
          ? {
              authorName: currentReadingEntry.story.authorName,
              chapterLabel: `Chapter ${currentReadingEntry.chapter.chapterNumber}`,
              chapterSlug: currentReadingEntry.chapter.slug,
              chapterTitle: currentReadingEntry.chapter.title,
              coverImage:
                currentReadingEntry.story.assets?.coverImageUrl ??
                currentReadingEntry.story.assets?.cardImageUrl ??
                currentReadingEntry.story.assets?.bannerImageUrl ??
                "",
              progressPercent: currentReadingEntry.progressPercent,
              resumeLabel: `${currentReadingEntry.progressPercent}% complete`,
              storySlug: currentReadingEntry.story.slug,
              storyTitle: currentReadingEntry.story.title,
            }
          : null,
      profile: this.mapAccountProfile(user),
      profileStats: [
        {
          label: "Stories Started",
          value: this.formatCompactNumber(readingProgressCount),
        },
        {
          label: "Saved Stories",
          value: this.formatCompactNumber(savedStoryCount),
        },
        {
          label: "Published Stories",
          value: this.formatCompactNumber(authoredStories.length),
        },
        {
          label: "Author Reads",
          value: this.formatCompactNumber(authorReads),
        },
      ],
      readingList,
      recentActivity,
    };
  }

  private mapAccountProfile(user: ActiveUserWithProfile) {
    return {
      allowMessages: user.profile?.allowMessages ?? false,
      avatarUrl: user.profile?.avatarUrl ?? null,
      bio: user.profile?.bio ?? "",
      contentFiltering: user.profile?.contentFiltering ?? true,
      discord: user.profile?.discord ?? "",
      displayLanguage: user.profile?.displayLanguage ?? "English (US)",
      displayName: user.profile?.displayName ?? "TaleStead Reader",
      email: user.email,
      location: user.profile?.location ?? "",
      privateLibrary: user.profile?.privateLibrary ?? true,
      showActivity: user.profile?.showActivity ?? true,
      tagline: user.profile?.tagline ?? "",
      twitter: user.profile?.twitter ?? "",
      username: user.email.split("@")[0] ?? "",
      website: user.profile?.website ?? "",
    };
  }

  private async buildRecentActivity(user: ActiveUserWithProfile) {
    const events = await this.prisma.userActivityEvent.findMany({
      where: {
        userId: user.id,
      },
      orderBy: {
        happenedAt: "desc",
      },
      take: 5,
    });

    if (events.length === 0) {
      return [
        {
          detail: null,
          icon: "person",
          time: this.formatRelativeDate(user.createdAt),
          title: `Joined TaleStead on ${user.createdAt.toLocaleDateString("en-US", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}`,
        },
      ];
    }

    const chapterReferenceIds = Array.from(
      new Set(
        events
          .filter(
            (event) =>
              (event.type === "BOOKMARK_CHAPTER" ||
                event.type === "READ_CHAPTER") &&
              event.referenceId,
          )
          .map((event) => event.referenceId as string),
      ),
    );
    const chapters =
      chapterReferenceIds.length > 0
        ? await this.prisma.publishedChapter.findMany({
            where: {
              id: {
                in: chapterReferenceIds,
              },
            },
            include: {
              story: {
                include: {
                  adminControl: true,
                },
              },
            },
          })
        : [];
    const chapterById = new Map(
      chapters
        .filter((chapter) => isStoryLive(chapter.story))
        .map((chapter) => [chapter.id, chapter]),
    );

    return events.map((event) => {
      const chapter = event.referenceId
        ? chapterById.get(event.referenceId)
        : undefined;

      if (event.type === "READ_CHAPTER") {
        return {
          detail: chapter
            ? `Reached ${chapter.title}`
            : "Continued reading in your library.",
          icon: "auto_stories",
          time: this.formatRelativeDate(event.happenedAt),
          title: chapter
            ? `Read ${chapter.story.title}`
            : "Read a chapter",
        };
      }

      if (event.type === "BOOKMARK_CHAPTER") {
        return {
          detail: chapter
            ? `Saved ${chapter.title} for later.`
            : "Saved a chapter to your reading list.",
          icon: "bookmark",
          time: this.formatRelativeDate(event.happenedAt),
          title: chapter
            ? `Bookmarked ${chapter.story.title}`
            : "Bookmarked a chapter",
        };
      }

      if (event.type === "DAILY_CHECK_IN") {
        return {
          detail: "Collected your daily Arc Points reward.",
          icon: "today",
          time: this.formatRelativeDate(event.happenedAt),
          title: "Claimed daily check-in",
        };
      }

      if (event.type === "SHARE_REFERRAL") {
        return {
          detail: "Shared an invite to bring someone into TaleStead.",
          icon: "share",
          time: this.formatRelativeDate(event.happenedAt),
          title: "Shared a referral invite",
        };
      }

      if (event.type === "COMPLETE_PROFILE") {
        return {
          detail: "Finished your public profile details.",
          icon: "person",
          time: this.formatRelativeDate(event.happenedAt),
          title: "Completed your profile",
        };
      }

      return {
        detail: null,
        icon: "bolt",
        time: this.formatRelativeDate(event.happenedAt),
        title: "Used TaleStead",
      };
    });
  }

  private mapNotificationPreference(
    preference: Prisma.NotificationPreferenceGetPayload<Record<string, never>> | null,
  ) {
    return {
      appAchievements: preference?.appAchievements ?? true,
      appMaintenance: preference?.appMaintenance ?? true,
      appStreakAlerts: preference?.appStreakAlerts ?? true,
      appSystemUpdates: preference?.appSystemUpdates ?? true,
      emailMarketing: preference?.emailMarketing ?? false,
      emailNewComments: preference?.emailNewComments ?? true,
      emailSecurityAlerts: preference?.emailSecurityAlerts ?? true,
      emailWeeklyDigest: preference?.emailWeeklyDigest ?? true,
      pushCommentReplies: preference?.pushCommentReplies ?? true,
      pushDirectMessages: preference?.pushDirectMessages ?? false,
      pushNewStories: preference?.pushNewStories ?? true,
      pushStoryComments: preference?.pushStoryComments ?? true,
    };
  }

  private mapAppNotification(
    notification: Prisma.AppNotificationGetPayload<Record<string, never>>,
  ) {
    return {
      body: notification.body,
      createdAt: notification.createdAt,
      ctaHref: notification.ctaHref,
      ctaLabel: notification.ctaLabel,
      id: notification.id,
      readAt: notification.readAt,
      title: notification.title,
      type: notification.type,
    };
  }

  private mapReferralEvent(
    event: Prisma.ReferralEventGetPayload<Record<string, never>>,
  ) {
    const name = event.inviteeEmail ?? `Referral via ${event.channel}`;

    return {
      image: null,
      joined: this.formatRelativeDate(event.createdAt),
      name,
      reward: `+${event.rewardPoints} Arc Points`,
      status: event.status.toLowerCase(),
    };
  }

  private mapLeaderboardEntry(
    entry: Prisma.LeaderboardEntryGetPayload<{
      include: {
        user: {
          include: {
            profile: true;
            rewardWallet: true;
          };
        };
      };
    }>,
  ) {
    const name =
      entry.user.profile?.displayName ||
      entry.user.email.split("@")[0] ||
      "TaleStead Reader";

    return {
      image: entry.user.profile?.avatarUrl ?? null,
      name,
      points: this.formatCompactNumber(entry.points),
      rank: entry.rank,
      tier: entry.badge ?? this.getLeaderboardTier(entry.rank),
    };
  }

  private mapLeaderboardPodiumEntry(
    entry: Prisma.LeaderboardEntryGetPayload<{
      include: {
        user: {
          include: {
            profile: true;
            rewardWallet: true;
          };
        };
      };
    }>,
  ) {
    const name =
      entry.user.profile?.displayName ||
      entry.user.email.split("@")[0] ||
      "TaleStead Reader";

    return {
      image: entry.user.profile?.avatarUrl ?? null,
      name,
      points: this.formatCompactNumber(entry.points),
      rank: entry.rank,
    };
  }

  private mapCommunityPost(
    post: Prisma.CommunityPostGetPayload<{
      include: {
        creator: {
          include: {
            profile: true;
          };
        };
        pollOptions: {
          include: {
            votes: true;
          };
        };
        story: true;
      };
    }>,
    viewerUserId: string,
  ) {
    const authorName =
      post.creator.profile?.displayName ||
      post.creator.email.split("@")[0] ||
      "TaleStead Creator";
    const totalVotes = post.pollOptions.reduce(
      (sum, option) => sum + option.votes.length,
      0,
    );

    return {
      author: authorName,
      body: post.body,
      comments: post.type === "ANNOUNCEMENT" ? this.formatCompactNumber(Math.max(4, Math.round(totalVotes / 2))) : undefined,
      cta: post.type === "ANNOUNCEMENT" ? "Open Update" : undefined,
      id: post.id,
      image: post.imageUrl,
      likes: this.formatCompactNumber(Math.max(totalVotes, 12)),
      options:
        post.type === "POLL"
          ? post.pollOptions.map((option) => ({
              id: option.id,
              image: option.imageUrl,
              label: option.label,
            }))
          : null,
      publishedAt: this.formatRelativeDate(post.publishedAt),
      storySlug: post.story?.slug ?? null,
      title: post.title,
      type: post.type === "POLL" ? "Poll" : "Announcement",
      voted:
        post.type === "POLL"
          ? this.getPollVoteLabel(post, viewerUserId)
          : null,
      votes:
        post.type === "POLL"
          ? `${this.formatCompactNumber(totalVotes)} Votes`
          : null,
    };
  }

  private mapLivePoll(
    post: Prisma.CommunityPostGetPayload<{
      include: {
        creator: {
          include: {
            profile: true;
          };
        };
        pollOptions: {
          include: {
            votes: true;
          };
        };
      };
    }>,
    viewerUserId: string,
  ) {
    const totalVotes = post.pollOptions.reduce(
      (sum, option) => sum + option.votes.length,
      0,
    );

    return {
      options: post.pollOptions.map((option) => ({
        id: option.id,
        label: option.label,
        percent:
          totalVotes === 0
            ? 0
            : Math.round((option.votes.length / totalVotes) * 100),
        voted: option.votes.some((vote) => vote.userId === viewerUserId),
      })),
      postId: post.id,
      subtitle: post.body,
      title: post.title,
    };
  }

  private mapArchivePost(
    post: Prisma.CommunityPostGetPayload<{
      include: {
        pollOptions: {
          include: {
            votes: true;
          };
        };
      };
    }>,
  ) {
    const totalVotes = post.pollOptions.reduce(
      (sum, option) => sum + option.votes.length,
      0,
    );

    return {
      detail:
        post.type === "POLL"
          ? `Closed with ${this.formatCompactNumber(totalVotes)} total votes`
          : `Archived after ${this.formatRelativeDate(post.archivedAt ?? post.updatedAt)}`,
      id: post.id,
      title: post.title,
    };
  }

  private async resolveCreatorStory(
    userId: string,
    storySlug?: string,
    allowNoStory = false,
  ) {
    const story = storySlug
      ? await this.prisma.story.findFirst({
          where: {
            authorId: userId,
            slug: storySlug,
          },
        })
      : await this.prisma.story.findFirst({
          where: {
            authorId: userId,
          },
          orderBy: {
            updatedAt: "desc",
          },
        });

    if (!story && !allowNoStory) {
      return null;
    }

    if (!story && allowNoStory) {
      return null;
    }

    return story;
  }

  private async getActiveUser(
    userId: string,
    options: {
      includeProfile?: boolean;
    } = {},
  ) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        status: "ACTIVE",
      },
      include: {
        profile: options.includeProfile ?? false,
      },
    });

    if (!user) {
      throw new NotFoundException("User not found.");
    }

    return user;
  }

  private async requireRewardWallet(userId: string) {
    const rewardWallet = await this.prisma.rewardWallet.findUnique({
      where: {
        userId,
      },
    });

    if (!rewardWallet) {
      throw new NotFoundException("Reward wallet not found.");
    }

    return rewardWallet;
  }

  private async requireReferralCode(userId: string) {
    const referralCode = await this.prisma.referralCode.findUnique({
      where: {
        userId,
      },
    });

    if (!referralCode) {
      throw new NotFoundException("Referral code not found.");
    }

    return referralCode;
  }

  private truncateCopy(value: string, maxLength: number) {
    const trimmed = value.trim();

    if (trimmed.length <= maxLength) {
      return trimmed;
    }

    return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  private generateReferralCode(
    user: Prisma.UserGetPayload<{
      include: {
        profile: true;
      };
    }>,
    attempt: number,
  ) {
    const base =
      user.profile?.displayName ||
      user.email.split("@")[0] ||
      "talestead";

    return `${base}`
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 8)
      .toUpperCase()
      .concat(String(100 + Math.floor(Math.random() * 900) + attempt));
  }

  private getLeaderboardWindow(period: LeaderboardPeriod) {
    const now = new Date();

    if (period === "MONTHLY") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      return {
        end,
        label: `${this.formatMonthLabel(now)} Leaderboard`,
        start,
      };
    }

    if (period === "ALL_TIME") {
      return {
        end: new Date(2100, 0, 1),
        label: "All Time Leaderboard",
        start: new Date(2020, 0, 1),
      };
    }

    const start = this.getStartOfWeek(now);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    return {
      end,
      label: "Weekly Leaderboard",
      start,
    };
  }

  private mapLeaderboardPeriod(period: LeaderboardPeriod) {
    if (period === "MONTHLY") {
      return "Monthly";
    }

    if (period === "ALL_TIME") {
      return "All Time";
    }

    return "Weekly";
  }

  private getLeaderboardTier(rank: number) {
    if (rank === 1) {
      return "Champion";
    }

    if (rank <= 3) {
      return "Elite";
    }

    if (rank <= 10) {
      return "Rising";
    }

    return "Reader";
  }

  private getPollVoteLabel(
    post: Prisma.CommunityPostGetPayload<{
      include: {
        pollOptions: {
          include: {
            votes: true;
          };
        };
      };
    }>,
    viewerUserId: string,
  ) {
    const votedOption = post.pollOptions.find((option) =>
      option.votes.some((vote) => vote.userId === viewerUserId),
    );

    if (!votedOption) {
      return null;
    }

    return `Voted ${votedOption.label}`;
  }

  private getDailyCycleKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
  }

  private daysAgo(days: number) {
    const value = new Date();
    value.setDate(value.getDate() - days);
    return value;
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

  private getMonthRange(date = new Date()) {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);

    return {
      end,
      start,
    };
  }

  private getStartOfWeek(date: Date) {
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const start = new Date(date);
    start.setDate(date.getDate() + diff);
    start.setHours(0, 0, 0, 0);

    return start;
  }

  private formatMonthLabel(date: Date) {
    return date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }

  private getOverviewCacheKey(userId: string) {
    return `engagement:overview:${userId}`;
  }

  private async clearOverviewCache(userId: string) {
    await this.redisService.delete(this.getOverviewCacheKey(userId));
  }

  private formatCompactNumber(value: number) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: value >= 1000 ? 1 : 0,
      notation: value >= 1000 ? "compact" : "standard",
    }).format(value);
  }

  private formatRelativeDate(date: Date) {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 1) {
      return "Just now";
    }

    if (diffMinutes < 60) {
      return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
    }

    const diffHours = Math.floor(diffMinutes / 60);

    if (diffHours < 24) {
      return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
    }

    const diffDays = Math.floor(diffHours / 24);

    if (diffDays < 7) {
      return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
    }

    return date.toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  private isToday(value: Date | null) {
    if (!value) {
      return false;
    }

    const today = this.getDayRange();

    return value >= today.start && value < today.end;
  }
}
