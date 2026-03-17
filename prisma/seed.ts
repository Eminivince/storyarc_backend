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

const prisma = new PrismaClient();

const genres = [
  {
    description: "Epic worlds, magic systems, and ancient destinies.",
    name: "Fantasy",
    slug: "fantasy",
  },
  {
    description: "Futuristic settings, advanced tech, and cosmic stakes.",
    name: "Sci-Fi",
    slug: "sci-fi",
  },
  {
    description: "Suspense, shadows, and dangerous secrets.",
    name: "Mystery",
    slug: "mystery",
  },
  {
    description: "Emotional relationships and character-driven tension.",
    name: "Romance",
    slug: "romance",
  },
  {
    description: "Dark powers, cursed bloodlines, and eerie transformations.",
    name: "Supernatural",
    slug: "supernatural",
  },
];

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
      bannerImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuDnalVe9uggXR9tQEZ4roIax46fhC0Dv5DTA0TjhOAbZpfk8ncXGur7CFdmakRJsKaG5086GBl_7tXUyII6ImkzbxTP8UlGqdi98U0EvInIHv48fIC1tdEbCYVyCAp5GI-EPXkdIE16f2YOHbSg12pNcsenD_PdonRCEcWzZc3SvpjaGCCdhi8TuBZidM8AK2stmhFjkc2y_IusZTaGhmFQIZBr7hF3scRQ1l5KNnj-4cK8VwRxxLQqmzOZznFyuPWqIoslGVMc6EI",
      cardImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuCZlq_xmsMUKyy23pPY0MLEhA9DBAibewCgSaVJ6PFkQJUQwMpU7zY-KIk14WS7_ZbZAiJCXgF-bVs9TN_CVFk5Lic8yaFnDsW25kLi4bB2MIW25Cm0UCO7D1O7dYbXhqsZlugDNn5EpMKbSoZg86JqAJH2Z_ar6BcZPBzzzugateEKXrQ87egp0xcO-uzqs66tsQ03HuN18ZGDmIc569hJf7o6-t5zsmP8h3fpojuKBrpy-P1yjE68MnXSQNq1cB8HS-2MvLtfhUE",
      coverImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuCZlq_xmsMUKyy23pPY0MLEhA9DBAibewCgSaVJ6PFkQJUQwMpU7zY-KIk14WS7_ZbZAiJCXgF-bVs9TN_CVFk5Lic8yaFnDsW25kLi4bB2MIW25Cm0UCO7D1O7dYbXhqsZlugDNn5EpMKbSoZg86JqAJH2Z_ar6BcZPBzzzugateEKXrQ87egp0xcO-uzqs66tsQ03HuN18ZGDmIc569hJf7o6-t5zsmP8h3fpojuKBrpy-P1yjE68MnXSQNq1cB8HS-2MvLtfhUE",
    },
    authorName: "Vesper Thorne",
    averageRating: 4.8,
    chapters: buildWolvexChapters(),
    featured: true,
    genreSlugs: ["supernatural", "romance", "fantasy"],
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
      bannerImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuCxZEtZADGvArJI-bOfr-yF249WWlN3m_X7rHmbgg5M9lIHm2-RgYeH32rkES32oMqBfau_9Ch-F1IlX-euCYurQp21ls7W2Sn_CojoKVrbeq2Ehmj6rP9QGyp_E4_pthM9KvdcYUJhwIw4vEsWieUTEbLZK-qQNc9fIJ5tq9iFRirlJbN8TSrEePrkAsz9gxkVqU7onlZyI9H3tzWgENb9L8iSB5J1hhNha3B6IrrYtL3lJP3k2w2XRc5uU2H4fIu_pBtDhR1K5f0",
      cardImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuCxZEtZADGvArJI-bOfr-yF249WWlN3m_X7rHmbgg5M9lIHm2-RgYeH32rkES32oMqBfau_9Ch-F1IlX-euCYurQp21ls7W2Sn_CojoKVrbeq2Ehmj6rP9QGyp_E4_pthM9KvdcYUJhwIw4vEsWieUTEbLZK-qQNc9fIJ5tq9iFRirlJbN8TSrEePrkAsz9gxkVqU7onlZyI9H3tzWgENb9L8iSB5J1hhNha3B6IrrYtL3lJP3k2w2XRc5uU2H4fIu_pBtDhR1K5f0",
      coverImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuCxZEtZADGvArJI-bOfr-yF249WWlN3m_X7rHmbgg5M9lIHm2-RgYeH32rkES32oMqBfau_9Ch-F1IlX-euCYurQp21ls7W2Sn_CojoKVrbeq2Ehmj6rP9QGyp_E4_pthM9KvdcYUJhwIw4vEsWieUTEbLZK-qQNc9fIJ5tq9iFRirlJbN8TSrEePrkAsz9gxkVqU7onlZyI9H3tzWgENb9L8J1hhNha3B6IrrYtL3lJP3k2w2XRc5uU2H4fIu_pBtDhR1K5f0",
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
      bannerImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuBDkui4Hew1g0I8vtakp7rEn_YfQSfHlJRlVdwtuVxT09FRKAkg3Zwl-GzXCim5QeSdcqc_Cka9C9wQzEcQnq-Ev-zs00QR3Qi3sY-8ShatUik9dqWXTSOOywZlkmdnJw8E_TjlJVZMsE10ehGw9xmBeb0bsR92lXnSo7KlQLCfOqyQnXgWecwG5zFNddvbMqnpK5Ly5hsx55qN5AEbm9Z5IR2K2tKjPoAVMp8RRe7_vCqkEhPYJrMP1PWv_K6rHyKxw8XLKH2sQUc",
      cardImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuBDkui4Hew1g0I8vtakp7rEn_YfQSfHlJRlVdwtuVxT09FRKAkg3Zwl-GzXCim5QeSdcqc_Cka9C9wQzEcQnq-Ev-zs00QR3Qi3sY-8ShatUik9dqWXTSOOywZlkmdnJw8E_TjlJVZMsE10ehGw9xmBeb0bsR92lXnSo7KlQLCfOqyQnXgWecwG5zFNddvbMqnpK5Ly5hsx55qN5AEbm9Z5IR2K2tKjPoAVMp8RRe7_vCqkEhPYJrMP1PWv_K6rHyKxw8XLKH2sQUc",
      coverImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuBDkui4Hew1g0I8vtakp7rEn_YfQSfHlJRlVdwtuVxT09FRKAkg3Zwl-GzXCim5QeSdcqc_Cka9C9wQzEcQnq-Ev-zs00QR3Qi3sY-8ShatUik9dqWXTSOOywZlkmdnJw8E_TjlJVZMsE10ehGw9xmBeb0bsR92lXnSo7KlQLCfOqyQnXgWecwG5zFNddvbMqnpK5Ly5hsx55qN5AEbm9Z5IR2K2tKjPoAVMp8RRe7_vCqkEhPYJrMP1PWv_K6rHyKxw8XLKH2sQUc",
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
    genreSlugs: ["supernatural", "mystery", "fantasy"],
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
      bannerImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuCCYW0y-x4ynHbueBL_GVj0rmx8YZb9bS3-OhHF5PK8lJ1fL8LD70Df9FdG0iHv213Y3bU03qhha_6G7zV4QhEgZtTDJlYW_uqLaDdI2brsH13sAMk0rbvMoqNSmVUQ3KcZNydVIp5aIwiZgqjsQggwb7aIekblpAOwfhNbs3tdWzgyASewwW_9vPUgs0Nagmka0hyNN3Gb-mFcRM8WDo8x2NoIJ2BLZ8T7N0EBKn1yDQskyqL4fv24_6GB-fOJSgjo4EHtOZmUlvw",
      cardImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuCCYW0y-x4ynHbueBL_GVj0rmx8YZb9bS3-OhHF5PK8lJ1fL8LD70Df9FdG0iHv213Y3bU03qhha_6G7zV4QhEgZtTDJlYW_uqLaDdI2brsH13sAMk0rbvMoqNSmVUQ3KcZNydVIp5aIwiZgqjsQggwb7aIekblpAOwfhNbs3tdWzgyASewwW_9vPUgs0Nagmka0hyNN3Gb-mFcRM8WDo8x2NoIJ2BLZ8T7N0EBKn1yDQskyqL4fv24_6GB-fOJSgjo4EHtOZmUlvw",
      coverImageUrl:
        "https://lh3.googleusercontent.com/aida-public/AB6AXuCCYW0y-x4ynHbueBL_GVj0rmx8YZb9bS3-OhHF5PK8lJ1fL8LD70Df9FdG0iHv213Y3bU03qhha_6G7zV4QhEgZtTDJlYW_uqLaDdI2brsH13sAMk0rbvMoqNSmVUQ3KcZNydVIp5aIwiZgqjsQggwb7aIekblpAOwfhNbs3tdWzgyASewwW_9vPUgs0Nagmka0hyNN3Gb-mFcRM8WDo8x2NoIJ2BLZ8T7N0EBKn1yDQskyqL4fv24_6GB-fOJSgjo4EHtOZmUlvw",
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
  await seedCatalog();
  await seedMissions();
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
