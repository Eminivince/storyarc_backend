import {
  AdminBookReleaseMode,
  AdminBookVisibilityState,
  ChapterStatus,
  PrismaClient,
  StoryStatus,
} from "@prisma/client";
import {
  buildDefaultPlans,
  buildDefaultCoinPackages,
} from "../src/monetization/monetization-catalog";
import { STORY_GENRES } from "../src/catalog/story-genres";
import { DEFAULT_ADMIN_ROLES } from "../src/admin/admin-role-seeds";
import {
  defaultAdminSettings,
  supportHelpCenterCategories,
  supportHelpCenterArticles,
} from "../src/admin/admin-constants";

const prisma = new PrismaClient();

const genres = STORY_GENRES.map((g) => ({
  description: g.description,
  name: g.name,
  slug: g.slug,
}));

const tags = [
  { name: "Slow Burn", slug: "slow-burn" },
  { name: "Forbidden Love", slug: "forbidden-love" },
  { name: "Magic Academy", slug: "magic-academy" },
  { name: "Political Intrigue", slug: "political-intrigue" },
  { name: "Found Family", slug: "found-family" },
  { name: "Monsters", slug: "monsters" },
  { name: "Prophecy", slug: "prophecy" },
];

const monetizationCurrency = process.env.PAYSTACK_CURRENCY ?? "USD";
const plans = buildDefaultPlans({
  codes: {
    arcaneAnnualPlanCode: process.env.PAYSTACK_PLAN_ARCANE_ANNUAL ?? null,
    arcaneMonthlyPlanCode: process.env.PAYSTACK_PLAN_ARCANE_MONTHLY ?? null,
    silverAnnualPlanCode: process.env.PAYSTACK_PLAN_SILVER_ANNUAL ?? null,
    silverMonthlyPlanCode: process.env.PAYSTACK_PLAN_SILVER_MONTHLY ?? null,
  },
  currency: monetizationCurrency,
});
const coinPackages = buildDefaultCoinPackages(monetizationCurrency);

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function buildParagraphs(lines: string[]) {
  return lines;
}

function buildWolvexChapters() {
  const titles = [
    "The Mark",
    "Moonbound",
    "Ash in the Veins",
    "A Door Beneath Stone",
    "The Alpha's Decree",
    "Red Silk, Iron Teeth",
    "Smoke Over Halcyon",
    "The Oathbreaker",
    "Silver Howl",
    "Thirteen Knives",
    "The City Remembers",
    "The Silver Veil",
    "Blood Moon Covenant",
  ];

  return titles.map((title, index) => {
    const chapterNumber = index + 1;
    const premium = chapterNumber === 13;

    return {
      bodyParagraphs: buildParagraphs([
        `The night ${chapterNumber === 1 ? "Elara was marked" : "the moon turned wrong"} began with the same metallic taste in the air that always warned Halcyon something was about to break.`,
        "Streetlamps burned like prayer candles against the rain, and every puddle reflected a city trying to look ordinary while old power crawled underneath its skin.",
        `Kaelen arrived before the clocktower struck midnight, carrying the calm menace of someone who had survived too many prophecies to fear another one. ${
          premium
            ? "He already knew the blood moon would demand a price."
            : "He only knew the shadows had started whispering her name."
        }`,
        "Elara felt the thread of fate pull tight between them. It was not romance, not yet. It was the sharper thing beneath it: recognition, danger, and the terrible certainty that the next step would end the life either of them had been pretending to keep.",
        `By the time the chapter closed, the Wolvex had drawn a circle around the impossible, and neither oath nor desire would leave ${premium ? "the covenant" : "the city"} untouched again.`,
      ]),
      chapterNumber,
      coinUnlockPrice: premium ? 50 : 0,
      premium,
      publishedAt: daysAgo(30 - chapterNumber),
      readingMinutes: 8,
      slug: `chapter-${chapterNumber}`,
      title,
    };
  });
}

function buildStoryChapters(input: {
  prefix: string;
  startDaysAgo: number;
  titles: string[];
}) {
  return input.titles.map((title, index) => ({
    bodyParagraphs: buildParagraphs([
      `${input.prefix} opened with a choice no one in the city was prepared to make, and the cost of hesitation was already written into the weather.`,
      "The chapter tightened around a small group of survivors, each carrying a private motive and a public lie.",
      "By the end, one secret had changed hands, one alliance had cracked, and the horizon looked more dangerous than it had a page before.",
    ]),
    chapterNumber: index + 1,
    coinUnlockPrice: 0,
    premium: false,
    publishedAt: daysAgo(input.startDaysAgo - index * 3),
    readingMinutes: 7,
    slug: `chapter-${index + 1}`,
    title,
  }));
}

const stories = [
  {
    assets: {
      accentColor: "#f59e0b",
      bannerImageUrl: "https://picsum.photos/seed/wolvex-banner/1200/400",
      cardImageUrl: "https://picsum.photos/seed/wolvex-card/400/300",
      coverImageUrl: "https://picsum.photos/seed/wolvex-cover/400/600",
    },
    authorName: "Vesper Thorne",
    averageRating: 4.8,
    chapters: buildWolvexChapters(),
    featured: true,
    genreSlugs: ["werewolf", "romance", "fantasy"],
    maturityRating: "18+",
    publishedAt: daysAgo(180),
    reviewCount: 1240,
    shortSynopsis:
      "A shadow weaver and a wolf-blooded enforcer collide under a blood moon that refuses to stay silent.",
    slug: "wolvex",
    status: StoryStatus.PUBLISHED,
    synopsis:
      "In the moon-governed city of Halcyon, Elara hides a forbidden power that can stitch or sever the fate of entire bloodlines. Kaelen leads the Wolvex, a brutal guard order sworn to keep the old pacts intact. When Elara's magic ignites the one prophecy the Wolves were ordered to bury, the two are thrown into a struggle that mixes desire, violence, and an ancient covenant hungry enough to devour both.",
    tagSlugs: ["forbidden-love", "monsters", "slow-burn"],
    title: "Wolvex",
    totalReads: 12500,
  },
  {
    assets: {
      accentColor: "#f97316",
      bannerImageUrl: "https://picsum.photos/seed/gilded-mage-banner/1200/400",
      cardImageUrl: "https://picsum.photos/seed/gilded-mage-card/400/300",
      coverImageUrl: "https://picsum.photos/seed/gilded-mage-cover/400/600",
    },
    authorName: "Evelyn Vance",
    averageRating: 4.9,
    chapters: buildStoryChapters({
      prefix: "The Gilded Mage",
      startDaysAgo: 40,
      titles: [
        "Ash Crown",
        "The Glass Archive",
        "A Debt to Gold",
        "The Fifth Sigil",
        "When the City Bowed",
      ],
    }),
    featured: false,
    genreSlugs: ["fantasy"],
    maturityRating: "16+",
    publishedAt: daysAgo(220),
    reviewCount: 980,
    shortSynopsis:
      "A disgraced court mage uncovers the hidden cost behind a kingdom built on enchanted gold.",
    slug: "the-gilded-mage",
    status: StoryStatus.PUBLISHED,
    synopsis:
      "After exile from the imperial academy, Mara Vey returns to the capital only to discover the throne's wealth is bound to a living spell with a death toll no ledger records. To stop a coup hidden inside polite society, she must master forbidden transmutation before the empire turns its poorest citizens into fuel.",
    tagSlugs: ["political-intrigue", "prophecy"],
    title: "The Gilded Mage",
    totalReads: 1200000,
  },
  {
    assets: {
      accentColor: "#0f172a",
      bannerImageUrl: "https://picsum.photos/seed/whisper-shadow-banner/1200/400",
      cardImageUrl: "https://picsum.photos/seed/whisper-shadow-card/400/300",
      coverImageUrl: "https://picsum.photos/seed/whisper-shadow-cover/400/600",
    },
    authorName: "Kaelen Storm",
    averageRating: 4.9,
    chapters: buildStoryChapters({
      prefix: "Whispering Shadows",
      startDaysAgo: 28,
      titles: [
        "A House with No Windows",
        "The Fifth Bell",
        "Names in the Dust",
        "Every Witness Lied",
      ],
    }),
    featured: false,
    genreSlugs: ["horror", "mystery", "fantasy"],
    maturityRating: "16+",
    publishedAt: daysAgo(150),
    reviewCount: 1110,
    shortSynopsis:
      "A cursed investigator hunts a murderer who can erase people from memory without leaving a corpse.",
    slug: "whispering-shadows",
    status: StoryStatus.PUBLISHED,
    synopsis:
      "In a district where the dead leave messages in the plaster and every witness forgets the same face, inspector Serin Vale takes one final case before resigning. The deeper he descends into the city's hidden sanctums, the more he suspects the killer isn't hiding from justice at all, but from something far older.",
    tagSlugs: ["monsters", "political-intrigue"],
    title: "Whispering Shadows",
    totalReads: 1100000,
  },
  {
    assets: {
      accentColor: "#22c55e",
      bannerImageUrl: "https://picsum.photos/seed/starlight-arch-banner/1200/400",
      cardImageUrl: "https://picsum.photos/seed/starlight-arch-card/400/300",
      coverImageUrl: "https://picsum.photos/seed/starlight-arch-cover/400/600",
    },
    authorName: "Iris Vale",
    averageRating: 4.7,
    chapters: buildStoryChapters({
      prefix: "Starlight Architect",
      startDaysAgo: 16,
      titles: [
        "Blueprint for a Dying Sun",
        "The Ninth Dock",
        "A Machine for Mercy",
        "Foundation Pulse",
      ],
    }),
    featured: false,
    genreSlugs: ["sci-fi", "fantasy"],
    maturityRating: "13+",
    publishedAt: daysAgo(90),
    reviewCount: 510,
    shortSynopsis:
      "An orbital engineer discovers the empire's miracle reactors are quietly devouring entire colonies.",
    slug: "starlight-architect",
    status: StoryStatus.PUBLISHED,
    synopsis:
      "Lina Oris helped build the stations that keep humanity alive between broken suns. When a maintenance call exposes falsified gravity ledgers and missing labor crews, she joins a rebel navigator and a disgraced priest-scientist to map the machine underneath the empire's lies before the next station goes dark.",
    tagSlugs: ["found-family", "prophecy"],
    title: "Starlight Architect",
    totalReads: 540000,
  },
];

async function seedCatalog() {
  await prisma.bookPlatformPolicy.upsert({
    where: {
      key: "default",
    },
    update: {
      defaultCoinCap: 50,
      defaultPremiumWindowHours: -1,
      defaultReleaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
    },
    create: {
      defaultCoinCap: 50,
      defaultPremiumWindowHours: -1,
      defaultReleaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
      key: "default",
    },
  });

  for (const genre of genres) {
    await prisma.genre.upsert({
      where: { slug: genre.slug },
      update: genre,
      create: genre,
    });
  }

  for (const tag of tags) {
    await prisma.tag.upsert({
      where: { slug: tag.slug },
      update: tag,
      create: tag,
    });
  }

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan,
    });
  }

  for (const coinPackage of coinPackages) {
    await prisma.coinPackage.upsert({
      where: { code: coinPackage.code },
      update: coinPackage,
      create: coinPackage,
    });
  }

  for (const story of stories) {
    const latestChapterAt = story.chapters.reduce(
      (current, chapter) =>
        chapter.publishedAt.getTime() > current.getTime()
          ? chapter.publishedAt
          : current,
      story.chapters[0].publishedAt,
    );

    const storyRecord = await prisma.story.upsert({
      where: { slug: story.slug },
      update: {
        authorName: story.authorName,
        averageRating: story.averageRating,
        featured: story.featured,
        genreSlugs: story.genreSlugs,
        isLive: true,
        latestChapterAt,
        maturityRating: story.maturityRating,
        liveAt: story.publishedAt,
        publishedAt: story.publishedAt,
        reviewCount: story.reviewCount,
        shortSynopsis: story.shortSynopsis,
        status: story.status,
        synopsis: story.synopsis,
        tagSlugs: story.tagSlugs,
        title: story.title,
        totalReads: story.totalReads,
      },
      create: {
        authorName: story.authorName,
        averageRating: story.averageRating,
        featured: story.featured,
        genreSlugs: story.genreSlugs,
        isLive: true,
        latestChapterAt,
        maturityRating: story.maturityRating,
        liveAt: story.publishedAt,
        publishedAt: story.publishedAt,
        reviewCount: story.reviewCount,
        shortSynopsis: story.shortSynopsis,
        slug: story.slug,
        status: story.status,
        synopsis: story.synopsis,
        tagSlugs: story.tagSlugs,
        title: story.title,
        totalReads: story.totalReads,
      },
    });

    await prisma.storyAsset.upsert({
      where: { storyId: storyRecord.id },
      update: story.assets,
      create: {
        storyId: storyRecord.id,
        ...story.assets,
      },
    });

    for (const chapter of story.chapters) {
      const chapterRecord = await prisma.chapter.upsert({
        where: {
          storyId_slug: {
            slug: chapter.slug,
            storyId: storyRecord.id,
          },
        },
        update: {
          coinUnlockPrice: chapter.premium ? chapter.coinUnlockPrice : 0,
          chapterNumber: chapter.chapterNumber,
          excerpt: chapter.bodyParagraphs[0],
          premiumEnabled: chapter.premium,
          readingMinutes: chapter.readingMinutes,
          slug: chapter.slug,
          status: ChapterStatus.PUBLISHED,
          title: chapter.title,
          wordCount: chapter.bodyParagraphs.join(" ").split(/\s+/).length,
        },
        create: {
          coinUnlockPrice: chapter.premium ? chapter.coinUnlockPrice : 0,
          chapterNumber: chapter.chapterNumber,
          excerpt: chapter.bodyParagraphs[0],
          premiumEnabled: chapter.premium,
          readingMinutes: chapter.readingMinutes,
          slug: chapter.slug,
          status: ChapterStatus.PUBLISHED,
          storyId: storyRecord.id,
          title: chapter.title,
          wordCount: chapter.bodyParagraphs.join(" ").split(/\s+/).length,
        },
      });

      await prisma.publishedChapter.upsert({
        where: {
          storyId_slug: {
            slug: chapter.slug,
            storyId: storyRecord.id,
          },
        },
        update: {
          bodyParagraphs: chapter.bodyParagraphs,
          chapterId: chapterRecord.id,
          chapterNumber: chapter.chapterNumber,
          coinUnlockPrice: chapter.coinUnlockPrice,
          premium: chapter.premium,
          publishedAt: chapter.publishedAt,
          slug: chapter.slug,
          title: chapter.title,
        },
        create: {
          bodyParagraphs: chapter.bodyParagraphs,
          chapterId: chapterRecord.id,
          chapterNumber: chapter.chapterNumber,
          coinUnlockPrice: chapter.coinUnlockPrice,
          premium: chapter.premium,
          publishedAt: chapter.publishedAt,
          slug: chapter.slug,
          storyId: storyRecord.id,
          title: chapter.title,
        },
      });
    }

    await prisma.storyAdminControl.upsert({
      where: {
        storyId: storyRecord.id,
      },
      update: {
        defaultPremiumWindowHours: -1,
        globalCoinCap: 50,
        releaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
        reviewedAt: story.publishedAt,
        visibilityState: AdminBookVisibilityState.LIVE,
      },
      create: {
        defaultPremiumWindowHours: -1,
        globalCoinCap: 50,
        releaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
        reviewedAt: story.publishedAt,
        storyId: storyRecord.id,
        visibilityState: AdminBookVisibilityState.LIVE,
      },
    });
  }
}

const poolMissions = [
  {
    actionHref: "/dashboard",
    actionLabel: "Review",
    category: "social",
    description: "Leave a review on any story to share your thoughts with the community.",
    group: "READER",
    icon: "rate_review",
    key: "review-a-story",
    metricType: "REVIEW_STORY",
    minStreak: 0,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 60,
    sortOrder: 10,
    targetValue: 1,
    title: "Story Reviewer",
    weight: 12,
  },
  {
    actionHref: "/dashboard",
    actionLabel: "Read",
    category: "reading",
    description: "Spend at least 30 minutes reading today to unlock this reward.",
    group: "READER",
    icon: "timer",
    key: "speed-reader",
    metricType: "READING_TIME_MINUTES",
    minStreak: 0,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 50,
    sortOrder: 11,
    targetValue: 30,
    title: "Speed Reader",
    weight: 15,
  },
  {
    actionHref: "/dashboard",
    actionLabel: "Read",
    category: "reading",
    description: "Read for a full hour today to earn a substantial bonus.",
    group: "READER",
    icon: "hourglass_top",
    key: "marathon-reader",
    metricType: "READING_TIME_MINUTES",
    minStreak: 3,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 100,
    sortOrder: 12,
    targetValue: 60,
    title: "Marathon Reader",
    weight: 8,
  },
  {
    actionHref: "/dashboard",
    actionLabel: "Follow",
    category: "social",
    description: "Follow 3 stories today to expand your reading horizons.",
    group: "READER",
    icon: "library_add",
    key: "follow-3-stories",
    metricType: "FOLLOW_STORIES",
    minStreak: 0,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 40,
    sortOrder: 13,
    targetValue: 3,
    title: "Story Scout",
    weight: 10,
  },
  {
    actionHref: "/dashboard",
    actionLabel: "Follow",
    category: "social",
    description: "Follow a new author today to support creators.",
    group: "READER",
    icon: "person_add",
    key: "follow-an-author",
    metricType: "FOLLOW_AUTHORS",
    minStreak: 0,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 30,
    sortOrder: 14,
    targetValue: 1,
    title: "Author Fan",
    weight: 12,
  },
  {
    actionHref: "/dashboard",
    actionLabel: "Read",
    category: "reading",
    description: "Read five chapters today to prove your dedication.",
    group: "READER",
    icon: "auto_stories",
    key: "read-5-chapters",
    metricType: "READ_CHAPTERS",
    minStreak: 7,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 120,
    sortOrder: 15,
    targetValue: 5,
    title: "Chapter Champion",
    weight: 8,
  },
  {
    actionHref: "/dashboard",
    actionLabel: "Bookmark",
    category: "reading",
    description: "Bookmark 3 chapters today to curate your favorites.",
    group: "READER",
    icon: "bookmarks",
    key: "bookmark-3",
    metricType: "BOOKMARK_CHAPTERS",
    minStreak: 0,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 60,
    sortOrder: 16,
    targetValue: 3,
    title: "Bookmark Collector",
    weight: 10,
  },
  {
    actionHref: "/account/referrals",
    actionLabel: "Invite",
    category: "social",
    description: "Share TaleStead with two friends today for double the reward.",
    group: "READER",
    icon: "share",
    key: "double-share",
    metricType: "SHARE_REFERRAL",
    minStreak: 0,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 40,
    sortOrder: 17,
    targetValue: 2,
    title: "Double Share",
    weight: 8,
  },
  {
    actionHref: "/creator/dashboard",
    actionLabel: "Write",
    category: "creator",
    description: "Write at least 2,000 words today to keep your creative momentum.",
    group: "AUTHOR",
    icon: "edit_note",
    key: "write-2000",
    metricType: "WRITE_WORDS",
    minStreak: 0,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 160,
    sortOrder: 18,
    targetValue: 2000,
    title: "Wordsmith",
    weight: 10,
  },
  {
    actionHref: "/creator/dashboard",
    actionLabel: "Write",
    category: "creator",
    description: "Write 3,000 words today for an impressive creator bonus.",
    group: "AUTHOR",
    icon: "history_edu",
    key: "prolific-writer",
    metricType: "WRITE_WORDS",
    minStreak: 7,
    poolOnly: true,
    recurrence: "DAILY",
    rewardPoints: 200,
    sortOrder: 19,
    targetValue: 3000,
    title: "Prolific Writer",
    weight: 6,
  },
];

async function seedAdminRoles() {
  for (const role of DEFAULT_ADMIN_ROLES) {
    await prisma.adminRole.upsert({
      where: { name: role.name },
      update: {
        label: role.label,
        permissions: role.permissions,
        isSystem: role.isSystem,
      },
      create: {
        name: role.name,
        label: role.label,
        permissions: role.permissions,
        isSystem: role.isSystem,
      },
    });
  }
}

async function seedAdminSettings() {
  for (const setting of defaultAdminSettings) {
    await prisma.adminSetting.upsert({
      where: { key: setting.key },
      update: {
        description: setting.description,
        enabled: setting.enabled,
        group: setting.group,
        kind: setting.kind,
        title: setting.title,
        valueCents: setting.valueCents,
      },
      create: setting,
    });
  }
}

async function seedHelpCenter() {
  for (const cat of supportHelpCenterCategories) {
    await prisma.helpCenterCategory.upsert({
      where: { id: cat.id },
      update: {
        title: cat.title,
        description: cat.description,
        icon: cat.icon,
      },
      create: {
        id: cat.id,
        title: cat.title,
        description: cat.description,
        icon: cat.icon,
      },
    });
  }

  for (const article of supportHelpCenterArticles) {
    await prisma.helpCenterArticle.upsert({
      where: { id: article.id },
      update: {
        categoryId: article.categoryId,
        title: article.title,
        excerpt: article.excerpt,
        tag: article.tag,
        body: article.body,
      },
      create: {
        id: article.id,
        categoryId: article.categoryId,
        title: article.title,
        excerpt: article.excerpt,
        tag: article.tag,
        body: article.body,
      },
    });
  }
}

const badgeDefinitions = [
  { key: "first-chapter", title: "First Chapter", description: "Read your first chapter", category: "reading", rarity: "COMMON" as const, requirementType: "chapters_read", requirementValue: 1, rewardPoints: 25, sortOrder: 1 },
  { key: "avid-reader", title: "Avid Reader", description: "Read 50 chapters", category: "reading", rarity: "UNCOMMON" as const, requirementType: "chapters_read", requirementValue: 50, rewardPoints: 100, sortOrder: 2 },
  { key: "bookworm", title: "Bookworm", description: "Read 100 chapters", category: "reading", rarity: "RARE" as const, requirementType: "chapters_read", requirementValue: 100, rewardPoints: 200, sortOrder: 3 },
  { key: "speed-reader", title: "Speed Reader", description: "Read 5 chapters in one day", category: "reading", rarity: "UNCOMMON" as const, requirementType: "chapters_read_daily", requirementValue: 5, rewardPoints: 80, sortOrder: 4 },
  { key: "streak-7", title: "Week Warrior", description: "Maintain a 7-day streak", category: "streak", rarity: "COMMON" as const, requirementType: "streak_days", requirementValue: 7, rewardPoints: 50, sortOrder: 10 },
  { key: "streak-14", title: "Fortnight Fighter", description: "Maintain a 14-day streak", category: "streak", rarity: "UNCOMMON" as const, requirementType: "streak_days", requirementValue: 14, rewardPoints: 100, sortOrder: 11 },
  { key: "streak-30", title: "Monthly Master", description: "Maintain a 30-day streak", category: "streak", rarity: "RARE" as const, requirementType: "streak_days", requirementValue: 30, rewardPoints: 200, sortOrder: 12 },
  { key: "streak-60", title: "Dedicated Reader", description: "Maintain a 60-day streak", category: "streak", rarity: "EPIC" as const, requirementType: "streak_days", requirementValue: 60, rewardPoints: 400, sortOrder: 13 },
  { key: "streak-90", title: "Legendary Streak", description: "Maintain a 90-day streak", category: "streak", rarity: "LEGENDARY" as const, requirementType: "streak_days", requirementValue: 90, rewardPoints: 800, sortOrder: 14 },
  { key: "first-comment", title: "First Comment", description: "Leave your first comment", category: "social", rarity: "COMMON" as const, requirementType: "comments_count", requirementValue: 1, rewardPoints: 20, sortOrder: 20 },
  { key: "conversationalist", title: "Conversationalist", description: "Leave 25 comments", category: "social", rarity: "UNCOMMON" as const, requirementType: "comments_count", requirementValue: 25, rewardPoints: 80, sortOrder: 21 },
  { key: "critic", title: "Critic", description: "Write 5 reviews", category: "social", rarity: "UNCOMMON" as const, requirementType: "reviews_count", requirementValue: 5, rewardPoints: 100, sortOrder: 22 },
  { key: "first-bookmark", title: "First Bookmark", description: "Create your first bookmark", category: "collection", rarity: "COMMON" as const, requirementType: "bookmarks_count", requirementValue: 1, rewardPoints: 15, sortOrder: 30 },
  { key: "curator", title: "Curator", description: "Create 50 bookmarks", category: "collection", rarity: "RARE" as const, requirementType: "bookmarks_count", requirementValue: 50, rewardPoints: 150, sortOrder: 31 },
  { key: "list-maker", title: "List Maker", description: "Create 5 reading lists", category: "collection", rarity: "UNCOMMON" as const, requirementType: "reading_lists_count", requirementValue: 5, rewardPoints: 60, sortOrder: 32 },
  { key: "first-publish", title: "First Publish", description: "Publish your first chapter", category: "creator", rarity: "COMMON" as const, requirementType: "chapters_published", requirementValue: 1, rewardPoints: 50, sortOrder: 40 },
  { key: "prolific", title: "Prolific Writer", description: "Publish 50 chapters", category: "creator", rarity: "RARE" as const, requirementType: "chapters_published", requirementValue: 50, rewardPoints: 300, sortOrder: 41 },
  { key: "centurion", title: "Centurion", description: "Publish 100 chapters", category: "creator", rarity: "EPIC" as const, requirementType: "chapters_published", requirementValue: 100, rewardPoints: 500, sortOrder: 42 },
];

async function seedBadgeDefinitions() {
  for (const badge of badgeDefinitions) {
    await prisma.badgeDefinition.upsert({
      where: { key: badge.key },
      update: {
        title: badge.title,
        description: badge.description,
        category: badge.category,
        rarity: badge.rarity,
        requirementType: badge.requirementType,
        requirementValue: badge.requirementValue,
        rewardPoints: badge.rewardPoints,
        sortOrder: badge.sortOrder,
      },
      create: {
        ...badge,
        isActive: true,
      },
    });
  }
}

const pointShopItems = [
  { key: "golden-frame", title: "Golden Frame", description: "A gilded avatar frame for top contributors.", category: "AVATAR_FRAME" as const, cost: 500, durationType: "PERMANENT" as const, sortOrder: 1 },
  { key: "shadow-frame", title: "Shadow Frame", description: "A dark, sleek avatar frame for mystery lovers.", category: "AVATAR_FRAME" as const, cost: 500, durationType: "PERMANENT" as const, sortOrder: 2 },
  { key: "badge-early-supporter", title: "Early Supporter", description: "Show everyone you believed in TaleStead from the start.", category: "PROFILE_BADGE" as const, cost: 300, durationType: "PERMANENT" as const, sortOrder: 10 },
  { key: "badge-story-champion", title: "Story Champion", description: "For readers who champion their favorite stories.", category: "PROFILE_BADGE" as const, cost: 400, durationType: "PERMANENT" as const, sortOrder: 11 },
  { key: "theme-midnight", title: "Midnight Theme", description: "An ultra-dark reading theme for night sessions.", category: "THEME" as const, cost: 200, durationType: "PERMANENT" as const, sortOrder: 20 },
  { key: "theme-sepia", title: "Sepia Classic", description: "A warm sepia tone for a vintage reading feel.", category: "THEME" as const, cost: 200, durationType: "PERMANENT" as const, sortOrder: 21 },
  { key: "effect-sparkle", title: "Sparkle Trail", description: "Sparkles follow your reading progress for 7 days.", category: "READING_EFFECT" as const, cost: 150, durationType: "TIMED" as const, durationDays: 7, sortOrder: 30 },
  { key: "effect-fire", title: "Fire Trail", description: "Flames follow your reading progress for 7 days.", category: "READING_EFFECT" as const, cost: 150, durationType: "TIMED" as const, durationDays: 7, sortOrder: 31 },
  { key: "title-legend", title: "Legend", description: "Display the 'Legend' title on your profile.", category: "TITLE" as const, cost: 800, durationType: "PERMANENT" as const, sortOrder: 40 },
  { key: "title-arcane-scholar", title: "Arcane Scholar", description: "Display the 'Arcane Scholar' title on your profile.", category: "TITLE" as const, cost: 600, durationType: "PERMANENT" as const, sortOrder: 41 },
  { key: "streak-shield", title: "Streak Shield", description: "Protect your streak for one missed day.", category: "READING_EFFECT" as const, cost: 100, durationType: "SINGLE_USE" as const, sortOrder: 50 },
];

async function seedPointShopItems() {
  for (const item of pointShopItems) {
    await prisma.pointShopItem.upsert({
      where: { key: item.key },
      update: {
        title: item.title,
        description: item.description,
        category: item.category,
        cost: item.cost,
        durationType: item.durationType,
        durationDays: (item as any).durationDays ?? null,
        sortOrder: item.sortOrder,
      },
      create: {
        ...item,
        isActive: true,
      },
    });
  }
}

const readingChallenges = [
  {
    title: "Spring Reading Marathon",
    description: "Read 20 chapters this week to earn bonus points and unlock the Spring Reader badge.",
    type: "WEEKLY" as const,
    targetValue: 20,
    targetMetric: "CHAPTERS_READ" as const,
    rewardPoints: 300,
    startsAt: new Date("2026-03-31T00:00:00Z"),
    endsAt: new Date("2026-04-07T23:59:59Z"),
  },
  {
    title: "Review Rush",
    description: "Write 3 reviews this week to help fellow readers discover great stories.",
    type: "WEEKLY" as const,
    targetValue: 3,
    targetMetric: "REVIEWS_WRITTEN" as const,
    rewardPoints: 200,
    startsAt: new Date("2026-03-31T00:00:00Z"),
    endsAt: new Date("2026-04-07T23:59:59Z"),
  },
  {
    title: "April Readathon",
    description: "Complete 5 stories during April and earn the Readathon Champion badge.",
    type: "SEASONAL" as const,
    targetValue: 5,
    targetMetric: "STORIES_COMPLETED" as const,
    rewardPoints: 500,
    startsAt: new Date("2026-04-01T00:00:00Z"),
    endsAt: new Date("2026-04-30T23:59:59Z"),
  },
  {
    title: "Streak of Steel",
    description: "Maintain a 14-day reading streak to prove your dedication.",
    type: "SPECIAL" as const,
    targetValue: 14,
    targetMetric: "DAYS_STREAK" as const,
    rewardPoints: 400,
    startsAt: new Date("2026-04-01T00:00:00Z"),
    endsAt: new Date("2026-04-30T23:59:59Z"),
  },
];

async function seedReadingChallenges() {
  for (const challenge of readingChallenges) {
    const existing = await prisma.readingChallenge.findFirst({
      where: { title: challenge.title },
    });

    if (existing) {
      await prisma.readingChallenge.update({
        where: { id: existing.id },
        data: challenge,
      });
    } else {
      await prisma.readingChallenge.create({
        data: {
          ...challenge,
          isActive: true,
        },
      });
    }
  }
}

const communityAnnouncements = [
  {
    title: "Welcome to TaleStead!",
    body: "We're thrilled to have you here. TaleStead is a community of readers and writers who love immersive stories. Check in daily to earn points, complete missions, and climb the leaderboard. Happy reading!",
    type: "ANNOUNCEMENT" as const,
  },
  {
    title: "April Readathon is Live!",
    body: "Our biggest reading event of the spring is here. Complete 5 stories during April to earn the Readathon Champion badge and 500 bonus points. Track your progress in the Challenges tab.",
    type: "ANNOUNCEMENT" as const,
  },
  {
    title: "New Point Shop Items Available",
    body: "We just added new avatar frames, profile badges, and reading effects to the Point Shop. Spend your hard-earned points on cosmetic upgrades that show off your dedication. Check them out!",
    type: "ANNOUNCEMENT" as const,
  },
];

const communityPolls = [
  {
    title: "What genre should our next featured collection be?",
    body: "We're curating a new featured collection and want your input. Vote for the genre you'd love to see highlighted on the home page this month.",
    type: "POLL" as const,
    options: ["Fantasy", "Romance", "Sci-Fi", "Horror", "Mystery"],
  },
  {
    title: "How do you prefer to read?",
    body: "Help us improve the reading experience. Tell us about your reading habits so we can prioritize the right features.",
    type: "POLL" as const,
    options: ["Short daily sessions", "Long weekend binges", "On my commute", "Before bed"],
  },
];

async function seedCommunityPosts() {
  const adminUser = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  if (!adminUser) {
    const anyUser = await prisma.user.findFirst({ select: { id: true } });
    if (!anyUser) {
      console.log("[seed] Skipping community posts — no users in the database yet.");
      return;
    }
    console.log("[seed] No admin user found, using first available user for community posts.");
    return seedCommunityPostsForUser(anyUser.id);
  }

  return seedCommunityPostsForUser(adminUser.id);
}

async function seedCommunityPostsForUser(userId: string) {
  for (const post of communityAnnouncements) {
    const existing = await prisma.communityPost.findFirst({
      where: { title: post.title, creatorUserId: userId },
    });
    if (!existing) {
      await prisma.communityPost.create({
        data: {
          creatorUserId: userId,
          type: post.type,
          title: post.title,
          body: post.body,
          status: "LIVE",
        },
      });
    }
  }

  for (const poll of communityPolls) {
    const existing = await prisma.communityPost.findFirst({
      where: { title: poll.title, creatorUserId: userId },
    });
    if (!existing) {
      const created = await prisma.communityPost.create({
        data: {
          creatorUserId: userId,
          type: poll.type,
          title: poll.title,
          body: poll.body,
          status: "LIVE",
        },
      });

      for (let i = 0; i < poll.options.length; i++) {
        await prisma.pollOption.create({
          data: {
            communityPostId: created.id,
            label: poll.options[i],
            sortOrder: i,
          },
        });
      }
    }
  }
}

async function seedMissions() {
  for (const mission of poolMissions) {
    await prisma.missionDefinition.upsert({
      where: { key: mission.key },
      create: mission,
      update: {
        actionHref: mission.actionHref,
        actionLabel: mission.actionLabel,
        category: mission.category,
        description: mission.description,
        group: mission.group,
        icon: mission.icon,
        metricType: mission.metricType,
        minStreak: mission.minStreak,
        poolOnly: mission.poolOnly,
        recurrence: mission.recurrence,
        rewardPoints: mission.rewardPoints,
        sortOrder: mission.sortOrder,
        targetValue: mission.targetValue,
        title: mission.title,
        weight: mission.weight,
      },
    });
  }
}

async function main() {
  console.log("[seed] Seeding catalog (genres, tags, plans, stories)...");
  await seedCatalog();

  console.log("[seed] Seeding missions...");
  await seedMissions();

  console.log("[seed] Seeding admin roles...");
  await seedAdminRoles();

  console.log("[seed] Seeding admin settings...");
  await seedAdminSettings();

  console.log("[seed] Seeding help center...");
  await seedHelpCenter();

  console.log("[seed] Seeding badge definitions...");
  await seedBadgeDefinitions();

  console.log("[seed] Seeding point shop items...");
  await seedPointShopItems();

  console.log("[seed] Seeding reading challenges...");
  await seedReadingChallenges();

  console.log("[seed] Seeding community posts & polls...");
  await seedCommunityPosts();

  console.log("[seed] Done.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
