import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const directUrl = process.env.DIRECT_URL?.trim() || "";
const pooledUrl = process.env.DATABASE_URL?.trim() || "";

// Use DIRECT_URL for scripts (same as Prisma migrations; pooler times out) (Prisma db execute uses this; pooler times out)
// Fall back to DATABASE_URL only if DIRECT_URL is not set
const databaseUrl = directUrl || pooledUrl;

if (!databaseUrl) {
  throw new Error("DATABASE_URL or DIRECT_URL must be set to seed badges.");
}

// Single connection to avoid pool exhaustion
const separator = databaseUrl.includes("?") ? "&" : "?";
const finalUrl = `${databaseUrl}${separator}connection_limit=1`;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: finalUrl,
    },
  },
});

const BADGE_CATALOG = [
  // Reading
  { key: "first-chapter", title: "First Chapter", description: "Read your first chapter", category: "reading", rarity: "COMMON" as const, requirementType: "chapters_read", requirementValue: 1, rewardPoints: 25, sortOrder: 1 },
  { key: "avid-reader", title: "Avid Reader", description: "Read 50 chapters", category: "reading", rarity: "UNCOMMON" as const, requirementType: "chapters_read", requirementValue: 50, rewardPoints: 100, sortOrder: 2 },
  { key: "bookworm", title: "Bookworm", description: "Read 100 chapters", category: "reading", rarity: "RARE" as const, requirementType: "chapters_read", requirementValue: 100, rewardPoints: 200, sortOrder: 3 },
  { key: "speed-reader", title: "Speed Reader", description: "Read 5 chapters in one day", category: "reading", rarity: "UNCOMMON" as const, requirementType: "chapters_read_daily", requirementValue: 5, rewardPoints: 80, sortOrder: 4 },

  // Streaks
  { key: "streak-7", title: "Week Warrior", description: "Maintain a 7-day streak", category: "streak", rarity: "COMMON" as const, requirementType: "streak_days", requirementValue: 7, rewardPoints: 50, sortOrder: 10 },
  { key: "streak-14", title: "Fortnight Fighter", description: "Maintain a 14-day streak", category: "streak", rarity: "UNCOMMON" as const, requirementType: "streak_days", requirementValue: 14, rewardPoints: 100, sortOrder: 11 },
  { key: "streak-30", title: "Monthly Master", description: "Maintain a 30-day streak", category: "streak", rarity: "RARE" as const, requirementType: "streak_days", requirementValue: 30, rewardPoints: 200, sortOrder: 12 },
  { key: "streak-60", title: "Dedicated Reader", description: "Maintain a 60-day streak", category: "streak", rarity: "EPIC" as const, requirementType: "streak_days", requirementValue: 60, rewardPoints: 400, sortOrder: 13 },
  { key: "streak-90", title: "Legendary Streak", description: "Maintain a 90-day streak", category: "streak", rarity: "LEGENDARY" as const, requirementType: "streak_days", requirementValue: 90, rewardPoints: 800, sortOrder: 14 },

  // Social
  { key: "first-comment", title: "First Comment", description: "Leave your first comment", category: "social", rarity: "COMMON" as const, requirementType: "comments_count", requirementValue: 1, rewardPoints: 20, sortOrder: 20 },
  { key: "conversationalist", title: "Conversationalist", description: "Leave 25 comments", category: "social", rarity: "UNCOMMON" as const, requirementType: "comments_count", requirementValue: 25, rewardPoints: 80, sortOrder: 21 },
  { key: "critic", title: "Critic", description: "Write 5 reviews", category: "social", rarity: "UNCOMMON" as const, requirementType: "reviews_count", requirementValue: 5, rewardPoints: 100, sortOrder: 22 },

  // Collection
  { key: "first-bookmark", title: "First Bookmark", description: "Create your first bookmark", category: "collection", rarity: "COMMON" as const, requirementType: "bookmarks_count", requirementValue: 1, rewardPoints: 15, sortOrder: 30 },
  { key: "curator", title: "Curator", description: "Create 50 bookmarks", category: "collection", rarity: "RARE" as const, requirementType: "bookmarks_count", requirementValue: 50, rewardPoints: 150, sortOrder: 31 },
  { key: "list-maker", title: "List Maker", description: "Create 5 reading lists", category: "collection", rarity: "UNCOMMON" as const, requirementType: "reading_lists_count", requirementValue: 5, rewardPoints: 60, sortOrder: 32 },

  // Creator
  { key: "first-publish", title: "First Publish", description: "Publish your first chapter", category: "creator", rarity: "COMMON" as const, requirementType: "chapters_published", requirementValue: 1, rewardPoints: 50, sortOrder: 40 },
  { key: "prolific", title: "Prolific Writer", description: "Publish 50 chapters", category: "creator", rarity: "RARE" as const, requirementType: "chapters_published", requirementValue: 50, rewardPoints: 300, sortOrder: 41 },
  { key: "centurion", title: "Centurion", description: "Publish 100 chapters", category: "creator", rarity: "EPIC" as const, requirementType: "chapters_published", requirementValue: 100, rewardPoints: 500, sortOrder: 42 },
];

async function main() {
  console.log("[seed] Seeding badge definitions...");

  await prisma.$transaction(
    BADGE_CATALOG.map((badge) =>
      prisma.badgeDefinition.upsert({
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
          key: badge.key,
          title: badge.title,
          description: badge.description,
          category: badge.category,
          rarity: badge.rarity,
          requirementType: badge.requirementType,
          requirementValue: badge.requirementValue,
          rewardPoints: badge.rewardPoints,
          sortOrder: badge.sortOrder,
          isActive: true,
        },
      }),
    ),
  );

  console.log(`[seed] Seeded ${BADGE_CATALOG.length} badge definitions.`);
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
