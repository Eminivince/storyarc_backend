/**
 * Permanently delete every Story ("book") and all dependent rows.
 *
 * Wallet ledger rows are NOT deleted: optional FKs (storyId, publishedChapterId,
 * giftTransactionId) are cleared so wallet balances stay consistent with remaining
 * ledger history.
 *
 * Usage (from backend/):
 *   npm run prisma:delete-all-books -- --dry-run
 *   npm run prisma:delete-all-books -- --confirm-delete-all-books
 *
 * Production: set ALLOW_DELETE_ALL_BOOKS_IN_PRODUCTION=1 or pass
 *   --i-know-i-am-deleting-production-data
 */
import { Prisma, PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const directUrl = process.env.DIRECT_URL?.trim() || "";
const pooledUrl = process.env.DATABASE_URL?.trim() || "";
const databaseUrl = directUrl || pooledUrl;

if (!databaseUrl) {
  throw new Error("DATABASE_URL or DIRECT_URL must be set.");
}

const separator = databaseUrl.includes("?") ? "&" : "?";
const finalUrl = `${databaseUrl}${separator}connection_limit=1`;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: finalUrl,
    },
  },
});

const TX_OPTS = {
  maxWait: 60_000,
  timeout: 600_000,
} as const;

function parseArgs(argv: string[]) {
  const dryRun = argv.includes("--dry-run");
  const confirm = argv.includes("--confirm-delete-all-books");
  const prodOk =
    argv.includes("--i-know-i-am-deleting-production-data") ||
    process.env.ALLOW_DELETE_ALL_BOOKS_IN_PRODUCTION === "1";
  return { dryRun, confirm, prodOk };
}

async function deleteCommentsForStories(
  tx: Prisma.TransactionClient,
  storyIds: string[],
) {
  if (storyIds.length === 0) {
    return;
  }
  for (;;) {
    const result = await tx.comment.deleteMany({
      where: {
        storyId: { in: storyIds },
        parentCommentId: { not: null },
      },
    });
    if (result.count === 0) {
      break;
    }
  }
  await tx.comment.deleteMany({
    where: { storyId: { in: storyIds } },
  });
}

async function deleteCommunityPostsForStories(
  tx: Prisma.TransactionClient,
  storyIds: string[],
) {
  if (storyIds.length === 0) {
    return;
  }
  const posts = await tx.communityPost.findMany({
    where: { storyId: { in: storyIds } },
    select: { id: true },
  });
  const postIds = posts.map((p) => p.id);
  if (postIds.length === 0) {
    return;
  }
  await tx.pollVote.deleteMany({
    where: { communityPostId: { in: postIds } },
  });
  await tx.pollOption.deleteMany({
    where: { communityPostId: { in: postIds } },
  });
  await tx.communityPost.deleteMany({
    where: { id: { in: postIds } },
  });
}

async function wipeAllStories(tx: Prisma.TransactionClient) {
  const stories = await tx.story.findMany({ select: { id: true } });
  const storyIds = stories.map((s) => s.id);
  if (storyIds.length === 0) {
    return { deletedStories: 0 };
  }

  const published = await tx.publishedChapter.findMany({
    where: { storyId: { in: storyIds } },
    select: { id: true },
  });
  const publishedChapterIds = published.map((p) => p.id);

  const gifts = await tx.giftTransaction.findMany({
    where: { storyId: { in: storyIds } },
    select: { id: true },
  });
  const giftIds = gifts.map((g) => g.id);

  const ledgerScope: Prisma.WalletLedgerEntryWhereInput = {
    OR: [
      { storyId: { in: storyIds } },
      ...(publishedChapterIds.length > 0
        ? [{ publishedChapterId: { in: publishedChapterIds } }]
        : []),
      ...(giftIds.length > 0
        ? [{ giftTransactionId: { in: giftIds } }]
        : []),
    ],
  };

  await tx.walletLedgerEntry.updateMany({
    where: ledgerScope,
    data: {
      storyId: null,
      publishedChapterId: null,
      giftTransactionId: null,
    },
  });

  if (publishedChapterIds.length > 0) {
    await tx.paragraphReaction.deleteMany({
      where: { publishedChapterId: { in: publishedChapterIds } },
    });
    await tx.chapterReaction.deleteMany({
      where: { publishedChapterId: { in: publishedChapterIds } },
    });
    await tx.publishedChapterAdminOverride.deleteMany({
      where: { publishedChapterId: { in: publishedChapterIds } },
    });
  }

  await deleteCommentsForStories(tx, storyIds);

  if (publishedChapterIds.length > 0) {
    await tx.chapterReadEvent.deleteMany({
      where: { publishedChapterId: { in: publishedChapterIds } },
    });
    await tx.chapterAnalyticsDaily.deleteMany({
      where: { publishedChapterId: { in: publishedChapterIds } },
    });
  }

  await tx.readingProgress.deleteMany({
    where: { storyId: { in: storyIds } },
  });
  await tx.bookmark.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await tx.contentReport.deleteMany({
    where: {
      OR: [
        { storyId: { in: storyIds } },
        ...(publishedChapterIds.length > 0
          ? [{ publishedChapterId: { in: publishedChapterIds } }]
          : []),
      ],
    },
  });

  await tx.storyRankingEntry.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await tx.activityFeedEvent.deleteMany({
    where: {
      OR: [
        { storyId: { in: storyIds } },
        ...(publishedChapterIds.length > 0
          ? [{ chapterId: { in: publishedChapterIds } }]
          : []),
      ],
    },
  });

  await tx.reviewVote.deleteMany({
    where: { review: { storyId: { in: storyIds } } },
  });
  await tx.review.deleteMany({
    where: { storyId: { in: storyIds } },
  });
  await tx.storyRating.deleteMany({
    where: { storyId: { in: storyIds } },
  });
  await tx.readingListItem.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await tx.chapterEntitlement.deleteMany({
    where: { storyId: { in: storyIds } },
  });
  await tx.adUnlockRecord.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await tx.giftTransaction.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await tx.follow.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await deleteCommunityPostsForStories(tx, storyIds);

  await tx.contract.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await tx.publishedChapter.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await tx.storyAsset.deleteMany({
    where: { storyId: { in: storyIds } },
  });
  await tx.storyAdminControl.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await tx.storyAnalyticsDaily.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  await tx.chapter.deleteMany({
    where: { storyId: { in: storyIds } },
  });
  await tx.storyArc.deleteMany({
    where: { storyId: { in: storyIds } },
  });
  await tx.storyVolume.deleteMany({
    where: { storyId: { in: storyIds } },
  });

  const del = await tx.story.deleteMany({
    where: { id: { in: storyIds } },
  });

  return { deletedStories: del.count };
}

async function main() {
  const { dryRun, confirm, prodOk } = parseArgs(process.argv.slice(2));

  if (process.env.NODE_ENV === "production" && !prodOk) {
    console.error(
      "Refusing to run in NODE_ENV=production without ALLOW_DELETE_ALL_BOOKS_IN_PRODUCTION=1 or --i-know-i-am-deleting-production-data",
    );
    process.exit(1);
  }

  const storyCount = await prisma.story.count();
  if (storyCount === 0) {
    console.log("No stories in the database. Nothing to do.");
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] Would delete ${storyCount} stor(ies) and dependents.`);
    console.log(
      "[dry-run] Wallet ledger: would clear story/chapter/gift FKs on affected rows only (no row deletes).",
    );
    return;
  }

  if (!confirm) {
    console.error(
      'Refusing to delete: pass --confirm-delete-all-books (or use --dry-run to preview).',
    );
    process.exit(1);
  }

  const result = await prisma.$transaction(
    (tx) => wipeAllStories(tx),
    TX_OPTS,
  );
  console.log(`Deleted ${result.deletedStories} stor(ies) and dependents.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
