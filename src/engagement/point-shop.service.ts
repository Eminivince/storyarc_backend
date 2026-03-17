import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";

const CATALOG_CACHE_KEY = "shop:catalog";
const CATALOG_CACHE_TTL_SECONDS = 300;
const EXPIRED_ITEMS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PointShopService implements OnModuleInit {
  private readonly logger = new Logger(PointShopService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit() {
    this.checkExpiredItems().catch((err) => {
      this.logger.error(`Initial expired items check failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    setInterval(() => {
      this.checkExpiredItems().catch((err) => {
        this.logger.error(`Expired items check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, EXPIRED_ITEMS_CHECK_INTERVAL_MS);
  }

  async getShopCatalog() {
    const cached = await this.redisService.getJson<unknown>(CATALOG_CACHE_KEY).catch(() => null);

    if (cached) return cached;

    const items = await this.prisma.pointShopItem.findMany({
      where: { isActive: true },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    });

    const grouped: Record<string, typeof items> = {};

    for (const item of items) {
      const cat = item.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(item);
    }

    const catalog = { categories: grouped };

    await this.redisService
      .setJson(CATALOG_CACHE_KEY, catalog, CATALOG_CACHE_TTL_SECONDS)
      .catch(() => undefined);

    return catalog;
  }

  async purchaseItem(userId: string, itemId: string) {
    const item = await this.prisma.pointShopItem.findUnique({
      where: { id: itemId },
    });

    if (!item || !item.isActive) {
      throw new NotFoundException("Shop item not found.");
    }

    const wallet = await this.prisma.rewardWallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new BadRequestException("Reward wallet not found.");
    }

    if (wallet.balancePoints < item.cost) {
      throw new BadRequestException(
        `Insufficient points. You have ${wallet.balancePoints} but need ${item.cost}.`,
      );
    }

    if (item.maxPurchases) {
      const purchaseCount = await this.prisma.userPointShopPurchase.count({
        where: { userId, itemId },
      });

      if (purchaseCount >= item.maxPurchases) {
        throw new BadRequestException(
          `Maximum purchases (${item.maxPurchases}) reached for this item.`,
        );
      }
    }

    const idempotencyKey = `shop-purchase:${userId}:${itemId}:${Date.now()}`;
    const newBalance = wallet.balancePoints - item.cost;
    const expiresAt =
      item.durationType === "TIMED" && item.durationDays
        ? new Date(Date.now() + item.durationDays * 24 * 60 * 60 * 1000)
        : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.rewardWallet.update({
        where: { userId },
        data: { balancePoints: newBalance },
      });

      await tx.rewardLedgerEntry.create({
        data: {
          rewardWalletId: wallet.id,
          userId,
          entryType: "DEBIT",
          reason: "SHOP_PURCHASE",
          deltaPoints: -item.cost,
          balanceAfter: newBalance,
          idempotencyKey,
          note: `Shop: ${item.title}`,
        },
      });

      await tx.userPointShopPurchase.create({
        data: {
          userId,
          itemId,
          expiresAt,
        },
      });

      await tx.appNotification.create({
        data: {
          userId,
          type: "REWARD",
          title: "Item Purchased!",
          body: `You bought "${item.title}" for ${item.cost} points.`,
          ctaLabel: "View Items",
          ctaHref: "/account/shop",
        },
      });
    });

    await this.redisService.delete(`engagement:overview:${userId}`).catch(() => undefined);

    return {
      success: true,
      balanceAfter: newBalance,
      item: {
        id: item.id,
        title: item.title,
        category: item.category,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    };
  }

  async getUserItems(userId: string) {
    const now = new Date();

    const purchases = await this.prisma.userPointShopPurchase.findMany({
      where: {
        userId,
        isActive: true,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
      include: {
        item: true,
      },
      orderBy: { purchasedAt: "desc" },
    });

    return purchases.map((p) => ({
      purchaseId: p.id,
      itemId: p.item.id,
      key: p.item.key,
      title: p.item.title,
      description: p.item.description,
      category: p.item.category,
      iconUrl: p.item.iconUrl,
      durationType: p.item.durationType,
      purchasedAt: p.purchasedAt.toISOString(),
      expiresAt: p.expiresAt?.toISOString() ?? null,
    }));
  }

  async hasActiveItem(userId: string, itemKey: string) {
    const now = new Date();

    const purchase = await this.prisma.userPointShopPurchase.findFirst({
      where: {
        userId,
        isActive: true,
        item: { key: itemKey },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
    });

    return Boolean(purchase);
  }

  async checkExpiredItems() {
    const lockKey = "lock:shop:expired-items";
    const lockToken = await this.redisService.acquireLock(lockKey, 120);

    if (!lockToken) return;

    try {
      const now = new Date();

      const { count } = await this.prisma.userPointShopPurchase.updateMany({
        where: {
          isActive: true,
          expiresAt: { lte: now },
        },
        data: { isActive: false },
      });

      if (count > 0) {
        this.logger.log(`Deactivated ${count} expired shop item purchases.`);
      }
    } finally {
      await this.redisService.releaseLock(lockKey, lockToken);
    }
  }
}
