import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  BillingInterval,
  ChapterEntitlementSource,
  Prisma,
  PurchaseKind,
  PurchaseStatus,
  SubscriptionStatus,
  WalletLedgerEntryType,
  WalletLedgerReason,
} from "@prisma/client";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import { env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "@prisma/client";
import { ResendEmailService } from "../auth/resend-email.service";
import { ReferralService } from "../engagement/referral.service";
import { RedisService } from "../redis/redis.service";
import {
  RequiredPreviousChapter,
  resolveChapterAccessState,
} from "./chapter-access";
import {
  defaultBookPlatformPolicy,
  isStoryLive,
  normalizeConfiguredPremiumWindowHours,
  resolveEffectiveChapterAccess,
} from "../utils/book-admin";
import {
  ChapterUnlockBatchInput,
  ChapterUnlockInput,
  ConfirmCheckoutSessionInput,
  CreateCheckoutSessionInput,
  SendGiftInput,
} from "./monetization.types";
import {
  buildDefaultGiftProducts,
  ensureDefaultMonetizationCatalog,
} from "./monetization-catalog";

type TransactionClient = Prisma.TransactionClient;

type PurchaseWithRelations = Prisma.PurchaseGetPayload<{
  include: {
    coinPackage: true;
    plan: true;
  };
}>;

type PurchaseHistoryRecord = Prisma.PurchaseGetPayload<{
  include: {
    coinPackage: {
      select: {
        name: true;
      };
    };
    plan: {
      select: {
        name: true;
      };
    };
  };
}>;

type PaystackMetadata = Record<string, unknown> | null | undefined;

type PaystackCustomer = {
  customer_code?: string | null;
  email?: string | null;
};

type PaystackPlanObject = {
  interval?: string | null;
  plan_code?: string | null;
};

type PaystackSubscriptionObject = {
  email_token?: string | null;
  subscription_code?: string | null;
};

type PaystackTransaction = {
  amount?: number | null;
  created_at?: string | null;
  currency?: string | null;
  customer?: PaystackCustomer | null;
  id?: number | string | null;
  metadata?: PaystackMetadata;
  paid_at?: string | null;
  plan_object?: PaystackPlanObject | null;
  reference?: string | null;
  status?: string | null;
  subscription?: PaystackSubscriptionObject | null;
};

type PaystackSubscriptionEvent = {
  customer?: PaystackCustomer | null;
  customer_code?: string | null;
  email?: string | null;
  metadata?: PaystackMetadata;
  next_payment_date?: string | null;
  plan?: PaystackPlanObject | null;
  plan_object?: PaystackPlanObject | null;
  status?: string | null;
  subscription_code?: string | null;
};

type PaystackInvoiceEvent = {
  customer?: PaystackCustomer | null;
  customer_code?: string | null;
  invoice_code?: string | null;
  paid?: boolean | null;
  paid_at?: string | null;
  status?: string | null;
  subscription?: PaystackSubscriptionObject | null;
  subscription_code?: string | null;
};

type PaystackWebhookPayload = {
  data?: Record<string, unknown>;
  event?: string;
};

type CryptomusInvoice = {
  amount?: string | number | null;
  currency?: string | null;
  expired_at?: string | null;
  is_final?: boolean | null;
  order_id?: string | null;
  payment_status?: string | null;
  payer_amount?: string | number | null;
  payer_currency?: string | null;
  status?: string | null;
  txid?: string | null;
  updated_at?: string | null;
  url?: string | null;
  uuid?: string | null;
};

type CryptomusPaymentPayload = {
  amount?: string | number | null;
  currency?: string | null;
  order_id?: string | null;
  payment_status?: string | null;
  sign?: string | null;
  status?: string | null;
  txid?: string | null;
  updated_at?: string | null;
  uuid?: string | null;
};

type CryptomusApiResponse<T> = {
  message?: string;
  result?: T | null;
  state?: number;
};

const PAYMENT_PROVIDER = {
  CRYPTOMUS: "CRYPTOMUS",
  PAYSTACK: "PAYSTACK",
} as const;

type CheckoutProvider =
  (typeof PAYMENT_PROVIDER)[keyof typeof PAYMENT_PROVIDER];

type CheckoutProviderValue = "cryptomus" | "paystack";

type MonetizationCatalogResponse = {
  checkoutProvider: CheckoutProviderValue;
  currency: string;
  coinPackages: Array<{
    code: string;
    coins: number;
    bonusCoins: number;
    name: string;
    priceCents: number;
    totalCoins: number;
  }>;
  plans: Array<{
    code: string;
    description: string | null;
    monthlyCoinGrant: number;
    monthlyPriceCents: number;
    name: string;
    yearlyPriceCents: number | null;
  }>;
  gifts: Array<{
    code: string;
    coins: number;
    description: string;
    icon: string;
    name: string;
  }>;
};

type StoryAccessContext = {
  adminControl?: {
    defaultPremiumWindowHours: number;
    globalCoinCap: number;
    lastUpdatedByAdminUserId?: string | null;
  } | null;
  liveAt?: Date | null;
};

type ChapterAccessTarget = {
  adminOverride?: {
    coinPriceOverride?: number | null;
    lockedOverride?: boolean | null;
    overrideEnabled?: boolean | null;
    premiumWindowHoursOverride?: number | null;
    updatedAt: Date;
  } | null;
  chapter?: {
    coinUnlockPrice: number;
    premiumEnabled: boolean;
  } | null;
  chapterNumber: number;
  coinUnlockPrice: number;
  id: string;
  premium: boolean;
  publishedAt: Date;
  slug: string;
  storyId: string;
  title: string;
};

type ChapterAccessResolution = {
  accessSource: ChapterEntitlementSource | "FREE" | "SUBSCRIPTION" | null;
  accessState: "READABLE" | "SEQUENCE_BLOCKED" | "UNLOCK_REQUIRED";
  hasAccess: boolean;
  requiredPreviousChapter: RequiredPreviousChapter;
};

type BatchUnlockCandidate = {
  chapter: ChapterAccessTarget;
  effectiveCoinPrice: number;
  isCurrentlyPremium: boolean;
};

type BatchUnlockOption = {
  chapters: BatchUnlockCandidate[];
  discountPercent: number;
  finalTotalCoins: number;
  label: string;
  mode: "all" | "next";
  originalTotalCoins: number;
  savingsCoins: number;
};

type BatchUnlockStoryContext = StoryAccessContext & {
  id: string;
  publishedChapters: ChapterAccessTarget[];
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
]);
const BATCH_UNLOCK_NEXT_CHAPTER_COUNT = 3;
const BATCH_UNLOCK_DISCOUNT_TIERS = [
  {
    minCount: 4,
    percent: 10,
  },
  {
    minCount: 2,
    percent: 5,
  },
] as const;

const PAYSTACK_MINIMUM_AMOUNT_BY_CURRENCY: Record<string, number> = {
  GHS: 10,
  KES: 300,
  NGN: 5000,
  USD: 200,
  ZAR: 100,
};

const CRYPTOMUS_SUCCESS_STATUSES = new Set(["paid", "paid_over"]);
const CRYPTOMUS_FAILED_STATUSES = new Set([
  "cancel",
  "cancelled",
  "canceled",
  "fail",
  "system_fail",
  "wrong_amount",
]);
const CRYPTOMUS_REFUNDED_STATUSES = new Set([
  "refund_fail",
  "refund_paid",
  "refund_process",
]);
const CATALOG_CACHE_TTL_SECONDS = 60 * 60;

@Injectable()
export class MonetizationService implements OnModuleInit {
  private readonly cryptomusApiBaseUrl = "https://api.cryptomus.com/v1";
  private readonly paystackApiBaseUrl = "https://api.paystack.co";
  private readonly logger = new Logger(MonetizationService.name);
  private catalogBootstrapped = false;
  private catalogBootstrapPromise: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly emailService: ResendEmailService,
    private readonly referralService: ReferralService,
  ) {}

  async onModuleInit() {
    await this.cleanupLegacyStripeIndexes();
    await this.ensureSparseChapterEntitlementIndexes();
    await this.ensureCatalogBootstrapped();
  }

  async getCatalog() {
    await this.ensureCatalogBootstrapped();
    const checkoutProvider = this.getCheckoutProviderValue();
    const currency = this.getCheckoutCurrency();
    const cacheKey = this.getCatalogCacheKey(checkoutProvider, currency);
    const cachedCatalog =
      await this.redisService.getJson<MonetizationCatalogResponse>(cacheKey);

    if (cachedCatalog) {
      return cachedCatalog;
    }

    const [coinPackages, plans] = await Promise.all([
      this.prisma.coinPackage.findMany({
        where: { active: true },
        orderBy: { priceCents: "asc" },
      }),
      this.prisma.plan.findMany({
        where: { active: true },
        orderBy: { monthlyPriceCents: "asc" },
      }),
    ]);

    const supportedCoinPackages = coinPackages.filter((item) =>
      this.canProcessCheckoutAmount(item.priceCents),
    );
    const supportedPlans = plans.filter((plan) => {
      const monthlySupported = this.canProcessCheckoutAmount(plan.monthlyPriceCents);
      const yearlySupported =
        typeof plan.yearlyPriceCents === "number"
          ? this.canProcessCheckoutAmount(plan.yearlyPriceCents)
          : true;

      return monthlySupported && yearlySupported;
    });

    const response: MonetizationCatalogResponse = {
      checkoutProvider,
      currency,
      coinPackages: supportedCoinPackages.map((item) => ({
        code: item.code,
        coins: item.coins,
        bonusCoins: item.bonusCoins,
        name: item.name,
        priceCents: item.priceCents,
        totalCoins: item.coins + item.bonusCoins,
      })),
      plans: supportedPlans.map((plan) => ({
        code: plan.code,
        description: plan.description,
        monthlyCoinGrant: plan.monthlyCoinGrant,
        monthlyPriceCents: plan.monthlyPriceCents,
        name: plan.name,
        yearlyPriceCents: plan.yearlyPriceCents,
      })),
      gifts: buildDefaultGiftProducts().map((gift) => ({
        code: gift.code,
        coins: gift.coins,
        description: gift.description,
        icon: gift.icon,
        name: gift.name,
      })),
    };

    await this.redisService.setJson(
      cacheKey,
      response,
      CATALOG_CACHE_TTL_SECONDS,
    );

    return response;
  }

  async getStatus(userId: string) {
    const [wallet, subscription, entitlements] = await Promise.all([
      this.getOrCreateWallet(userId),
      this.getActiveSubscription(userId),
      this.prisma.chapterEntitlement.findMany({
        where: {
          expiresAt: null,
          userId,
        },
        include: {
          chapter: {
            select: {
              slug: true,
              story: {
                select: {
                  slug: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
    ]);

    return {
      activePlanId: subscription?.plan.code ?? "free",
      billingCycle: subscription
        ? this.toFrontendBillingInterval(subscription.billingInterval)
        : "monthly",
      checkoutProvider: this.getCheckoutProviderValue(),
      currency: this.getCheckoutCurrency(),
      chapterEntitlements: entitlements.map((item) => ({
        chapterKey: this.toChapterKey(item.chapter.story.slug, item.chapter.slug),
        chapterSlug: item.chapter.slug,
        source: item.source,
        storySlug: item.chapter.story.slug,
      })),
      coinBalance: wallet.balanceCoins,
      hasPremium: Boolean(subscription),
      subscription: subscription
        ? {
            billingInterval: this.toFrontendBillingInterval(
              subscription.billingInterval,
            ),
            currentPeriodEnd: subscription.currentPeriodEnd,
            planCode: subscription.plan.code,
            planName: subscription.plan.name,
            status: subscription.status,
          }
        : null,
    };
  }

  async getPurchases(userId: string) {
    const purchases = await this.prisma.purchase.findMany({
      where: {
        userId,
      },
      include: {
        coinPackage: {
          select: {
            name: true,
          },
        },
        plan: {
          select: {
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 50,
    });

    return {
      purchases: purchases.map((purchase) => ({
        amountCents: purchase.amountCents,
        currency: purchase.currency.toUpperCase(),
        description: this.getPurchaseHistoryDescription(purchase),
        id: purchase.id,
        kind: purchase.kind === PurchaseKind.COINS ? "coins" : "subscription",
        occurredAt:
          purchase.completedAt ?? purchase.failedAt ?? purchase.createdAt,
        status: purchase.status,
      })),
    };
  }

  async createCheckoutSession(
    userId: string,
    input: CreateCheckoutSessionInput,
    request: AuthenticatedRequest,
  ) {
    const frontendAppUrl = this.getFrontendAppUrl();
    const checkoutProvider = this.getConfiguredCheckoutProvider();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User account not found.");
    }

    const product = await this.getCheckoutProduct(input, checkoutProvider);
    this.assertSupportedCheckoutAmount(product.amountCents, input, checkoutProvider);
    const purchase = await this.findOrCreateCheckoutPurchase(
      userId,
      input,
      product,
      checkoutProvider,
    );

    if (checkoutProvider === PAYMENT_PROVIDER.CRYPTOMUS) {
      return this.createCryptomusCheckoutSession({
        frontendAppUrl,
        input,
        purchase,
        request,
      });
    }

    const paystackReference =
      purchase.paystackReference ?? this.buildPaystackReference(purchase.id);

    const successUrl = new URL("/checkout/status", frontendAppUrl);
    successUrl.searchParams.set("billing", input.billing);
    successUrl.searchParams.set("kind", input.kind);
    successUrl.searchParams.set("productId", input.productId);
    successUrl.searchParams.set("returnTo", input.returnTo);
    const response = await this.paystackRequest<{
      data?: {
        access_code?: string | null;
        authorization_url?: string | null;
        reference?: string | null;
      };
    }>("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        amount: product.amountCents,
        callback_url: successUrl.toString(),
        currency: this.getCheckoutCurrency(),
        email: user.email,
        metadata: {
          billingInterval: input.billing,
          kind: input.kind,
          productId: input.productId,
          purchaseId: purchase.id,
          returnTo: input.returnTo,
          userId,
        },
        plan: product.paystackPlanCode,
        reference: paystackReference,
      }),
    });

    const checkoutUrl = response.data?.authorization_url?.trim() || null;
    const reference = response.data?.reference?.trim() || paystackReference;

    await this.prisma.purchase.update({
      where: { id: purchase.id },
      data: {
        paymentProvider: PAYMENT_PROVIDER.PAYSTACK,
        paymentReference: reference,
        paystackReference: reference,
      },
    });

    if (!checkoutUrl) {
      throw new ServiceUnavailableException(
        "Paystack authorization URL was not returned.",
      );
    }

    return {
      checkoutUrl,
      purchaseId: purchase.id,
      reference,
    };
  }

  async confirmCheckoutSession(
    userId: string,
    input: ConfirmCheckoutSessionInput,
  ) {
    const referencedPurchase = await this.findPurchaseForCheckoutReference(
      input.reference,
    );

    if (
      referencedPurchase &&
      referencedPurchase.userId !== userId
    ) {
      throw new BadRequestException("This checkout reference does not belong to you.");
    }

    if (this.getPurchaseProvider(referencedPurchase) === PAYMENT_PROVIDER.CRYPTOMUS) {
      const invoice = await this.verifyCryptomusPayment(input.reference);
      const purchase =
        referencedPurchase ??
        (await this.findPurchaseForCheckoutReference(
          this.getCryptomusOrderId(invoice) ??
            this.getCryptomusUuid(invoice) ??
            input.reference,
        ));

      if (!purchase || purchase.userId !== userId) {
        throw new BadRequestException(
          "This checkout reference does not belong to you.",
        );
      }

      const checkoutStatus = this.mapCryptomusCheckoutStatus(invoice);

      if (checkoutStatus === "success") {
        await this.processCryptomusInvoice(invoice, purchase);
      } else {
        await this.syncNonSuccessfulCryptomusPurchase(
          purchase,
          invoice,
          checkoutStatus,
        );
      }

      return {
        checkoutStatus,
        message: this.getCheckoutStatusMessage(checkoutStatus),
        status: await this.getStatus(userId),
      };
    }

    const transaction = await this.verifyPaystackTransaction(input.reference);
    const purchase = await this.findPurchaseForPaystackTransaction(transaction);

    if (!purchase || purchase.userId !== userId) {
      throw new BadRequestException("This checkout reference does not belong to you.");
    }

    const checkoutStatus = this.mapCheckoutStatus(
      this.getPaystackTransactionStatus(transaction),
    );

    if (checkoutStatus === "success") {
      await this.processPaystackTransaction(transaction, purchase);
    } else {
      await this.syncNonSuccessfulPurchase(purchase, transaction, checkoutStatus);
    }

    return {
      checkoutStatus,
      message: this.getCheckoutStatusMessage(checkoutStatus),
      status: await this.getStatus(userId),
    };
  }

  async unlockChapterWithCoins(userId: string, input: ChapterUnlockInput) {
    const { chapter, story } = await this.getPublishedChapterBySlugs(
      input.storySlug,
      input.chapterSlug,
    );
    const effectiveChapter = this.resolveEffectiveChapter(chapter, story);

    if (!effectiveChapter.isCurrentlyPremium) {
      return {
        chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
        message: "This chapter is already free to read.",
      };
    }

    const access = await this.getChapterAccessDecision(userId, {
      chapter,
      isChapterPremium: effectiveChapter.isCurrentlyPremium,
      story,
    });

    if (access.accessState === "SEQUENCE_BLOCKED") {
      throw new BadRequestException(
        this.getSequentialAccessMessage(access.requiredPreviousChapter),
      );
    }

    if (access.accessState === "READABLE") {
      return {
        chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
        message: "Chapter access is already active.",
      };
    }

    const existingLedgerEntry = await this.prisma.walletLedgerEntry.findUnique({
      where: {
        idempotencyKey: input.idempotencyKey,
      },
    });

    if (existingLedgerEntry) {
      const replayHandled = await this.tryResolveCoinUnlockReplay({
        chapter,
        ledgerEntry: existingLedgerEntry,
        story,
        userId,
      });

      if (replayHandled) {
        return {
          chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
          message: `Chapter unlocked with ${effectiveChapter.effectiveCoinPrice} coins.`,
          status: await this.getStatus(userId),
        };
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const existingEntitlement = await tx.chapterEntitlement.findUnique({
          where: {
            userId_publishedChapterId: {
              publishedChapterId: chapter.id,
              userId,
            },
          },
        });

        if (existingEntitlement) {
          return;
        }

        const wallet = await this.getOrCreateWalletTx(tx, userId);

        if (wallet.balanceCoins < effectiveChapter.effectiveCoinPrice) {
          throw new BadRequestException("Not enough coins to unlock this chapter.");
        }

        const nextBalance =
          wallet.balanceCoins - effectiveChapter.effectiveCoinPrice;

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balanceCoins: nextBalance,
          },
        });

        await tx.walletLedgerEntry.create({
          data: {
            balanceAfter: nextBalance,
            chapter: {
              connect: { id: chapter.id },
            },
            deltaCoins: -effectiveChapter.effectiveCoinPrice,
            entryType: WalletLedgerEntryType.DEBIT,
            idempotencyKey: input.idempotencyKey,
            reason: WalletLedgerReason.CHAPTER_UNLOCK,
            story: {
              connect: { id: chapter.storyId },
            },
            user: {
              connect: { id: userId },
            },
            wallet: {
              connect: { id: wallet.id },
            },
          },
        });

        await tx.chapterEntitlement.create({
          data: {
            chapter: {
              connect: { id: chapter.id },
            },
            source: ChapterEntitlementSource.COIN_UNLOCK,
            story: {
              connect: { id: chapter.storyId },
            },
            user: {
              connect: { id: userId },
            },
          },
        });
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      this.logger.warn(
        `Coin unlock unique conflict story=${input.storySlug} chapter=${input.chapterSlug} user=${userId} key=${input.idempotencyKey} target=${this.getUniqueConstraintTarget(error)}`,
      );

      const resolvedConflict = await this.reconcileCoinUnlockConflict({
        chapter,
        idempotencyKey: input.idempotencyKey,
        story,
        userId,
      });

      if (!resolvedConflict) {
        throw new ConflictException(
          "This chapter unlock is still being processed. Please try again.",
        );
      }
    }

    return {
      chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
      message: `Chapter unlocked with ${effectiveChapter.effectiveCoinPrice} coins.`,
      status: await this.getStatus(userId),
    };
  }

  async getChapterBatchUnlockOptions(
    userId: string,
    input: { chapterSlug: string; storySlug: string },
  ) {
    const context = await this.getBatchUnlockContext(userId, input);
    const options = this.buildBatchUnlockOptions(context.eligibleCandidates);

    return {
      chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
      coinBalance: context.wallet.balanceCoins,
      currentChapter: {
        chapterNumber: context.chapter.chapterNumber,
        chapterSlug: context.chapter.slug,
        title: context.chapter.title,
      },
      hasPremiumSubscription: context.hasPremiumSubscription,
      options: options.map((option) => this.mapBatchUnlockOption(option)),
    };
  }

  async unlockChapterBatchWithCoins(
    userId: string,
    input: ChapterUnlockBatchInput,
  ) {
    const context = await this.getBatchUnlockContext(userId, input);

    if (context.hasPremiumSubscription) {
      return {
        chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
        message: "Premium access is already active for these chapters.",
        status: await this.getStatus(userId),
        unlockedChapterCount: 0,
      };
    }

    const MAX_BATCH_UNLOCK_SIZE = 50;
    const option = this.resolveBatchUnlockOption(context.eligibleCandidates, input.mode);

    if (option && option.chapters.length > MAX_BATCH_UNLOCK_SIZE) {
      option.chapters = option.chapters.slice(0, MAX_BATCH_UNLOCK_SIZE);
    }

    if (!option || option.chapters.length === 0) {
      return {
        chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
        message: "No premium chapters remain to unlock in this batch.",
        status: await this.getStatus(userId),
        unlockedChapterCount: 0,
      };
    }

    const childKeys = option.chapters.map((candidate) =>
      this.getBatchUnlockChildIdempotencyKey(input.idempotencyKey, candidate.chapter.id),
    );
    const existingBatchLedgerEntries = await this.prisma.walletLedgerEntry.findMany({
      where: {
        idempotencyKey: {
          in: childKeys,
        },
      },
      select: {
        entryType: true,
        idempotencyKey: true,
        publishedChapterId: true,
        reason: true,
        storyId: true,
        userId: true,
      },
    });

    if (existingBatchLedgerEntries.length > 0) {
      const replayResolved = await this.tryResolveBatchCoinUnlockReplay({
        chapters: option.chapters.map((candidate) => candidate.chapter),
        idempotencyKey: input.idempotencyKey,
        ledgerEntries: existingBatchLedgerEntries,
        userId,
      });

      if (replayResolved) {
        return {
          chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
          message: this.getBatchUnlockMessage(option),
          status: await this.getStatus(userId),
          unlockedChapterCount: option.chapters.length,
        };
      }
    }

    let executedOption: BatchUnlockOption | null = null;

    try {
      executedOption = await this.prisma.$transaction(async (tx) => {
        const existingEntitlements = await tx.chapterEntitlement.findMany({
          where: {
            publishedChapterId: {
              in: option.chapters.map((candidate) => candidate.chapter.id),
            },
            userId,
            OR: [
              { expiresAt: null },
              {
                expiresAt: {
                  gt: new Date(),
                },
              },
            ],
          },
          select: {
            publishedChapterId: true,
          },
        });
        const existingEntitlementIds = new Set(
          existingEntitlements.map((item) => item.publishedChapterId),
        );
        const chaptersToUnlock = option.chapters.filter(
          (candidate) => !existingEntitlementIds.has(candidate.chapter.id),
        );

        if (chaptersToUnlock.length === 0) {
          return null;
        }

        const currentOption = this.buildBatchUnlockOption(
          chaptersToUnlock,
          option.mode,
        );
        const allocations = this.allocateBatchUnlockCoins(
          currentOption,
          input.idempotencyKey,
        );

        const wallet = await this.getOrCreateWalletTx(tx, userId);

        if (wallet.balanceCoins < currentOption.finalTotalCoins) {
          throw new BadRequestException(
            `Not enough coins to unlock this batch. ${currentOption.finalTotalCoins} coins are required.`,
          );
        }

        let runningBalance = wallet.balanceCoins;

        for (const allocation of allocations) {
          runningBalance -= allocation.allocatedCoins;

          await tx.walletLedgerEntry.create({
            data: {
              balanceAfter: runningBalance,
              chapter: {
                connect: {
                  id: allocation.chapter.id,
                },
              },
              deltaCoins: -allocation.allocatedCoins,
              entryType: WalletLedgerEntryType.DEBIT,
              idempotencyKey: allocation.idempotencyKey,
              note:
                currentOption.mode === "all"
                  ? `Batch unlock (${currentOption.chapters.length} chapters)`
                  : `Batch unlock next ${currentOption.chapters.length} chapters`,
              reason: WalletLedgerReason.CHAPTER_UNLOCK,
              story: {
                connect: {
                  id: allocation.chapter.storyId,
                },
              },
              user: {
                connect: {
                  id: userId,
                },
              },
              wallet: {
                connect: {
                  id: wallet.id,
                },
              },
            },
          });

          await tx.chapterEntitlement.create({
            data: {
              chapter: {
                connect: {
                  id: allocation.chapter.id,
                },
              },
              source: ChapterEntitlementSource.COIN_UNLOCK,
              story: {
                connect: {
                  id: allocation.chapter.storyId,
                },
              },
              user: {
                connect: {
                  id: userId,
                },
              },
            },
          });
        }

        await tx.wallet.update({
          where: {
            id: wallet.id,
          },
          data: {
            balanceCoins: runningBalance,
          },
        });

        return currentOption;
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      this.logger.warn(
        `Batch coin unlock unique conflict story=${input.storySlug} chapter=${input.chapterSlug} user=${userId} key=${input.idempotencyKey} target=${this.getUniqueConstraintTarget(error)}`,
      );

      const replayResolved = await this.tryResolveBatchCoinUnlockReplay({
        chapters: option.chapters.map((candidate) => candidate.chapter),
        idempotencyKey: input.idempotencyKey,
        ledgerEntries: [],
        userId,
      });

      if (!replayResolved) {
        throw new ConflictException(
          "This batch unlock is still being processed. Please try again.",
        );
      }
    }

    if (!executedOption) {
      return {
        chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
        message: "Selected chapters are already unlocked.",
        status: await this.getStatus(userId),
        unlockedChapterCount: 0,
      };
    }

    return {
      chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
      message: this.getBatchUnlockMessage(executedOption),
      status: await this.getStatus(userId),
      unlockedChapterCount: executedOption.chapters.length,
    };
  }

  async sendGift(userId: string, input: SendGiftInput) {
    const selectedGift =
      buildDefaultGiftProducts().find((gift) => gift.code === input.giftCode) ?? null;

    if (!selectedGift) {
      throw new NotFoundException("Gift option not found.");
    }

    const story = await this.prisma.story.findUnique({
      where: { slug: input.storySlug },
      select: {
        authorId: true,
        authorName: true,
        id: true,
      },
    });

    if (!story) {
      throw new NotFoundException("Story not found.");
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const wallet = await this.getOrCreateWalletTx(tx, userId);

        if (wallet.balanceCoins < selectedGift.coins) {
          throw new BadRequestException("Not enough coins to send this gift.");
        }

        const nextBalance = wallet.balanceCoins - selectedGift.coins;
        const giftTransaction = await tx.giftTransaction.create({
          data: {
            costCoins: selectedGift.coins,
            giftCode: selectedGift.code,
            giftName: selectedGift.name,
            idempotencyKey: input.idempotencyKey,
            message: input.message,
            recipientAuthorName: story.authorName,
            senderUserId: userId,
            storyId: story.id,
            ...(story.authorId
              ? {
                  recipientAuthorId: story.authorId,
                }
              : {}),
          },
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balanceCoins: nextBalance,
          },
        });

        await tx.walletLedgerEntry.create({
          data: {
            balanceAfter: nextBalance,
            deltaCoins: -selectedGift.coins,
            entryType: WalletLedgerEntryType.DEBIT,
            giftTransaction: {
              connect: { id: giftTransaction.id },
            },
            idempotencyKey: `${input.idempotencyKey}:wallet`,
            note: `Gift sent: ${selectedGift.name}`,
            reason: WalletLedgerReason.GIFT_SENT,
            story: {
              connect: { id: story.id },
            },
            user: {
              connect: { id: userId },
            },
            wallet: {
              connect: { id: wallet.id },
            },
          },
        });
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }
    }

    return {
      message: `${selectedGift.name} sent to ${story.authorName}.`,
      status: await this.getStatus(userId),
    };
  }

  async handlePaystackWebhook(rawBody: Buffer | undefined, signature?: string) {
    if (!rawBody) {
      throw new BadRequestException("Paystack webhook raw body is required.");
    }

    if (!signature) {
      throw new BadRequestException("Missing Paystack signature header.");
    }

    if (!env.paystackWebhookSecret) {
      throw new ServiceUnavailableException(
        "PAYSTACK_WEBHOOK_SECRET is not configured.",
      );
    }

    const expectedSignature = createHmac("sha512", env.paystackWebhookSecret)
      .update(rawBody)
      .digest("hex");

    if (!this.constantTimeEquals(signature.trim(), expectedSignature)) {
      throw new BadRequestException("Invalid Paystack webhook signature.");
    }

    const payload = this.parsePaystackWebhookPayload(rawBody);
    const eventType = typeof payload.event === "string" ? payload.event.trim() : "";

    if (!eventType) {
      throw new BadRequestException("Paystack webhook event type is missing.");
    }

    const eventData = payload.data ?? {};
    const eventKey = this.getPaystackWebhookEventKey(
      eventType,
      eventData,
      rawBody,
    );
    const existingEvent = await this.prisma.paystackWebhookEvent.findUnique({
      where: {
        paystackEventKey: eventKey,
      },
    });

    if (existingEvent) {
      return {
        duplicate: true,
        received: true,
      };
    }

    switch (eventType) {
      case "charge.success":
        await this.handlePaystackChargeSuccess(eventData);
        break;
      case "invoice.update":
        await this.handlePaystackInvoiceUpdate(eventData);
        break;
      case "subscription.create":
        await this.syncSubscriptionFromPaystackEvent(
          eventData as PaystackSubscriptionEvent,
        );
        break;
      case "subscription.disable":
        await this.markSubscriptionAsDisabled(
          eventData as PaystackSubscriptionEvent,
        );
        break;
      case "subscription.not_renew":
        await this.markSubscriptionAsNotRenewing(
          eventData as PaystackSubscriptionEvent,
        );
        break;
      default:
        break;
    }

    try {
      await this.prisma.paystackWebhookEvent.create({
        data: {
          eventType,
          paystackEventKey: eventKey,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }
    }

    return {
      received: true,
    };
  }

  async handleCryptomusWebhook(rawBody: Buffer | undefined) {
    if (!rawBody) {
      throw new BadRequestException("Cryptomus webhook raw body is required.");
    }

    const payload = this.parseCryptomusWebhookPayload(rawBody);
    this.assertCryptomusWebhookSignature(payload);

    const reference =
      this.getCryptomusOrderId(payload) ??
      this.getCryptomusUuid(payload);

    if (!reference) {
      throw new BadRequestException(
        "Cryptomus webhook is missing order_id or uuid.",
      );
    }

    const purchase = await this.findPurchaseForCheckoutReference(reference);

    if (!purchase) {
      return {
        ignored: true,
        received: true,
      };
    }

    const checkoutStatus = this.mapCryptomusCheckoutStatus(payload);

    if (checkoutStatus === "success") {
      await this.processCryptomusInvoice(payload, purchase);
    } else {
      await this.syncNonSuccessfulCryptomusPurchase(
        purchase,
        payload,
        checkoutStatus,
      );
    }

    return {
      received: true,
    };
  }

  async getChapterAccess(
    userId: string,
    input: { chapterId: string; storyId: string },
  ) {
    const [entitlement, subscription] = await Promise.all([
      this.prisma.chapterEntitlement.findUnique({
        where: {
          userId_publishedChapterId: {
            publishedChapterId: input.chapterId,
            userId,
          },
        },
      }),
      this.getActiveSubscription(userId),
    ]);

    if (subscription) {
      return {
        hasAccess: true,
        source: "SUBSCRIPTION" as const,
      };
    }

    if (entitlement && this.isEntitlementActive(entitlement.expiresAt)) {
      return {
        hasAccess: true,
        source: entitlement.source,
      };
    }

    return {
      hasAccess: false,
      source: null,
    };
  }

  async hasActiveSubscriptionAccess(userId: string) {
    return Boolean(await this.getActiveSubscription(userId));
  }

  async getChapterAccessDecision(
    userId: string,
    input: {
      chapter: ChapterAccessTarget;
      isChapterPremium: boolean;
      story: StoryAccessContext;
    },
  ): Promise<ChapterAccessResolution> {
    const currentAccess = await this.getChapterAccess(userId, {
      chapterId: input.chapter.id,
      storyId: input.chapter.storyId,
    });

    if (currentAccess.source === "SUBSCRIPTION") {
      return {
        accessSource: "SUBSCRIPTION",
        accessState: "READABLE",
        hasAccess: true,
        requiredPreviousChapter: null,
      };
    }

    const previousChapter = await this.getPreviousPublishedChapter(input.chapter);
    let previousChapterAccessible = true;
    let requiredPreviousChapter: RequiredPreviousChapter = null;

    if (previousChapter) {
      const previousEffectiveChapter = this.resolveEffectiveChapter(previousChapter, input.story);

      if (previousEffectiveChapter.isCurrentlyPremium) {
        const previousAccess = await this.getChapterAccess(userId, {
          chapterId: previousChapter.id,
          storyId: previousChapter.storyId,
        });

        previousChapterAccessible = previousAccess.hasAccess;
      }

      if (!previousChapterAccessible) {
        requiredPreviousChapter = {
          chapterNumber: previousChapter.chapterNumber,
          chapterSlug: previousChapter.slug,
          title: previousChapter.title,
        };
      }
    }

    const decision = resolveChapterAccessState({
      hasChapterEntitlement: currentAccess.hasAccess,
      hasPremiumSubscription: false,
      isChapterPremium: input.isChapterPremium,
      previousChapterAccessible,
      requiredPreviousChapter,
    });

    return {
      accessSource:
        decision.accessState === "READABLE"
          ? input.isChapterPremium
            ? currentAccess.source
            : "FREE"
          : null,
      accessState: decision.accessState,
      hasAccess: decision.hasAccess,
      requiredPreviousChapter: decision.requiredPreviousChapter,
    };
  }

  private async findOrCreateCheckoutPurchase(
    userId: string,
    input: CreateCheckoutSessionInput,
    product: {
      amountCents: number;
      coinPackageId?: string;
      paystackPlanCode?: string | null;
      planId?: string;
    },
    paymentProvider: CheckoutProvider,
  ) {
    const existing = await this.prisma.purchase.findUnique({
      where: {
        idempotencyKey: input.idempotencyKey,
      },
      include: {
        coinPackage: true,
        plan: true,
      },
    });

    if (existing) {
      if (existing.userId !== userId) {
        throw new BadRequestException(
          "This idempotency key is already owned by another user.",
        );
      }

      return existing;
    }

    const purchaseData: Prisma.PurchaseUncheckedCreateInput = {
      amountCents: product.amountCents,
      billingInterval: this.toBillingInterval(input.billing),
      currency: this.getCheckoutCurrency(),
      idempotencyKey: input.idempotencyKey,
      kind:
        input.kind === "coins"
          ? PurchaseKind.COINS
          : PurchaseKind.SUBSCRIPTION,
      paymentProvider,
      returnTo: input.returnTo,
      status: PurchaseStatus.PENDING,
      userId,
      ...(product.coinPackageId
        ? {
            coinPackageId: product.coinPackageId,
          }
        : {}),
      ...(product.planId
        ? {
            planId: product.planId,
          }
        : {}),
    };

    return this.prisma.purchase.create({
      data: purchaseData,
      include: {
        coinPackage: true,
        plan: true,
      },
    });
  }

  private async getCheckoutProduct(
    input: CreateCheckoutSessionInput,
    paymentProvider: CheckoutProvider,
  ) {
    await this.ensureCatalogBootstrapped();

    if (input.kind === "coins") {
      const coinPackage = await this.prisma.coinPackage.findUnique({
        where: {
          code: input.productId,
        },
      });

      if (!coinPackage || !coinPackage.active) {
        throw new NotFoundException("Coin package not found.");
      }

      return {
        amountCents: coinPackage.priceCents,
        coinPackageId: coinPackage.id,
      };
    }

    const plan = await this.prisma.plan.findUnique({
      where: {
        code: input.productId,
      },
    });

    if (!plan || !plan.active || plan.code === "free") {
      throw new NotFoundException("Subscription plan not found.");
    }

    const paystackPlanCode =
      input.billing === "annual"
        ? plan.paystackAnnualPlanCode
        : plan.paystackMonthlyPlanCode;
    const amountCents =
      input.billing === "annual" && plan.yearlyPriceCents
        ? plan.yearlyPriceCents
        : plan.monthlyPriceCents;

    if (
      paymentProvider === PAYMENT_PROVIDER.PAYSTACK &&
      !paystackPlanCode
    ) {
      throw new ServiceUnavailableException(
        `Paystack plan code is not configured for plan ${plan.code} (${input.billing}).`,
      );
    }

    if (paymentProvider === PAYMENT_PROVIDER.PAYSTACK) {
      this.assertValidPaystackPlanCode(
        paystackPlanCode!,
        this.getPaystackPlanEnvFieldName(plan.code, input.billing),
      );
    }

    return {
      amountCents,
      paystackPlanCode,
      planId: plan.id,
    };
  }

  private async createCryptomusCheckoutSession({
    frontendAppUrl,
    input,
    purchase,
    request,
  }: {
    frontendAppUrl: string;
    input: CreateCheckoutSessionInput;
    purchase: PurchaseWithRelations;
    request: AuthenticatedRequest;
  }) {
    this.assertCryptomusConfigured();
    const paymentReference =
      purchase.paymentReference ?? this.buildCryptomusOrderId(purchase.id);
    const successUrl = new URL("/checkout/status", frontendAppUrl);
    successUrl.searchParams.set("billing", input.billing);
    successUrl.searchParams.set("kind", input.kind);
    successUrl.searchParams.set("productId", input.productId);
    successUrl.searchParams.set("reference", paymentReference);
    successUrl.searchParams.set("returnTo", input.returnTo);

    const cancelUrl = new URL("/checkout", frontendAppUrl);
    cancelUrl.searchParams.set("billing", input.billing);
    cancelUrl.searchParams.set("kind", input.kind);
    cancelUrl.searchParams.set("productId", input.productId);
    cancelUrl.searchParams.set("returnTo", input.returnTo);
    cancelUrl.searchParams.set("canceled", "1");

    const callbackOrigin = this.getRequestOrigin(request);
    const payload: Record<string, unknown> = {
      amount: this.formatAmountCents(purchase.amountCents),
      currency: purchase.currency.toUpperCase(),
      order_id: paymentReference,
      url_return: cancelUrl.toString(),
      url_success: successUrl.toString(),
    };

    if (callbackOrigin) {
      payload.url_callback = new URL(
        "/monetization/cryptomus/webhook",
        callbackOrigin,
      ).toString();
    }

    const response = await this.cryptomusRequest<CryptomusInvoice>(
      "/payment",
      payload,
    );
    const checkoutUrl = response.result?.url?.trim() || null;
    const uuid = this.getCryptomusUuid(response.result ?? null);

    await this.prisma.purchase.update({
      where: { id: purchase.id },
      data: {
        paymentProvider: PAYMENT_PROVIDER.CRYPTOMUS,
        paymentReference,
        paymentSessionId: uuid,
      },
    });

    if (!checkoutUrl) {
      throw new ServiceUnavailableException(
        "Cryptomus checkout URL was not returned.",
      );
    }

    return {
      checkoutUrl,
      purchaseId: purchase.id,
      reference: paymentReference,
    };
  }

  private async ensureCatalogBootstrapped() {
    if (this.catalogBootstrapped) {
      return;
    }

    if (this.catalogBootstrapPromise) {
      return this.catalogBootstrapPromise;
    }

    const directUrl = process.env.DIRECT_URL?.trim() || "";
    const pooledUrl = process.env.DATABASE_URL?.trim() || "";
    const baseUrl = directUrl || pooledUrl;

    if (!baseUrl) {
      this.logger.warn(
        "Skipping monetization catalog bootstrap: DIRECT_URL or DATABASE_URL must be set.",
      );
      this.catalogBootstrapped = true;
      return;
    }

    const separator = baseUrl.includes("?") ? "&" : "?";
    const seedUrl = `${baseUrl}${separator}connection_limit=1`;
    const seedPrisma = new PrismaClient({
      datasources: {
        db: {
          url: seedUrl,
        },
      },
    });

    this.catalogBootstrapPromise = ensureDefaultMonetizationCatalog(seedPrisma, {
      codes: {
        arcaneAnnualPlanCode: env.paystackPlanArcaneAnnual ?? null,
        arcaneMonthlyPlanCode: env.paystackPlanArcaneMonthly ?? null,
        silverAnnualPlanCode: env.paystackPlanSilverAnnual ?? null,
        silverMonthlyPlanCode: env.paystackPlanSilverMonthly ?? null,
      },
      currency: this.getCheckoutCurrency(),
    })
      .then(({ coinPackageCodes, planCodes }) => {
        this.catalogBootstrapped = true;
        this.logger.log(
          `Monetization catalog ready with ${planCodes.length} plans and ${coinPackageCodes.length} coin packages.`,
        );
      })
      .catch((error) => {
        this.logger.error(
          "Failed to bootstrap monetization catalog",
          error instanceof Error ? error.stack : error,
        );
      })
      .finally(async () => {
        this.catalogBootstrapPromise = null;
        try {
          await seedPrisma.$disconnect();
        } catch {
          // ignore
        }
      });

    return this.catalogBootstrapPromise;
  }

  private async cleanupLegacyStripeIndexes() {
    // Mongo-specific index cleanup no longer applies to PostgreSQL.
  }

  private async ensureSparseChapterEntitlementIndexes() {
    // Mongo-specific sparse index checks no longer apply to PostgreSQL.
  }

  private async listCollectionIndexes(collection: string) {
    return null;
  }

  private async processPaystackTransaction(
    transaction: PaystackTransaction,
    purchase?: PurchaseWithRelations | null,
  ) {
    if (this.getPaystackTransactionStatus(transaction) !== "success") {
      return;
    }

    const resolvedPurchase =
      purchase ?? (await this.findPurchaseForPaystackTransaction(transaction));

    if (!resolvedPurchase) {
      return;
    }

    this.assertPaystackTransactionMatchesPurchase(transaction, resolvedPurchase);

    if (resolvedPurchase.kind === PurchaseKind.COINS) {
      await this.completeCoinPurchase(resolvedPurchase, transaction);
      await this.trySendPurchaseReceipt(resolvedPurchase);

      try {
        const amountCents = transaction.amount ? Math.floor(Number(transaction.amount)) : 0;
        if (amountCents > 0) {
          await this.referralService.recordReferralCommission(
            resolvedPurchase.userId,
            amountCents,
            resolvedPurchase.id,
          );
        }
      } catch {
        this.logger.warn(`Referral commission recording failed for purchase ${resolvedPurchase.id}`);
      }

      return;
    }

    await this.completeSubscriptionPurchase(resolvedPurchase, transaction);
    await this.trySendPurchaseReceipt(resolvedPurchase);
  }

  private async syncNonSuccessfulPurchase(
    purchase: PurchaseWithRelations,
    transaction: PaystackTransaction,
    checkoutStatus: "failed" | "pending",
  ) {
    const nextStatus =
      checkoutStatus === "pending" ? PurchaseStatus.PENDING : PurchaseStatus.FAILED;
    const paidAt = this.getPaystackTransactionPaidAt(transaction);

    await this.prisma.purchase.update({
      where: { id: purchase.id },
      data: {
        failedAt: checkoutStatus === "failed" ? paidAt ?? new Date() : null,
        paymentProvider: PAYMENT_PROVIDER.PAYSTACK,
        paymentReference:
          this.getPaystackReference(transaction) ?? purchase.paymentReference,
        paymentSessionId:
          this.getPaystackTransactionId(transaction) ?? purchase.paymentSessionId,
        paystackCustomerCode:
          this.getPaystackCustomerCode(transaction.customer) ??
          purchase.paystackCustomerCode,
        paystackReference:
          this.getPaystackReference(transaction) ?? purchase.paystackReference,
        paystackTransactionId:
          this.getPaystackTransactionId(transaction) ??
          purchase.paystackTransactionId,
        status: nextStatus,
      },
    });
  }

  private async processCryptomusInvoice(
    invoice: CryptomusInvoice | CryptomusPaymentPayload,
    purchase?: PurchaseWithRelations | null,
  ) {
    const resolvedPurchase =
      purchase ??
      (await this.findPurchaseForCheckoutReference(
        this.getCryptomusOrderId(invoice) ??
          this.getCryptomusUuid(invoice) ??
          "",
      ));

    if (!resolvedPurchase) {
      return;
    }

    this.assertCryptomusInvoiceMatchesPurchase(invoice, resolvedPurchase);

    if (resolvedPurchase.kind === PurchaseKind.COINS) {
      await this.completeCryptomusCoinPurchase(resolvedPurchase, invoice);
      await this.trySendPurchaseReceipt(resolvedPurchase);
      return;
    }

    await this.completeCryptomusSubscriptionPurchase(resolvedPurchase, invoice);
    await this.trySendPurchaseReceipt(resolvedPurchase);
  }

  private async syncNonSuccessfulCryptomusPurchase(
    purchase: PurchaseWithRelations,
    invoice: CryptomusInvoice | CryptomusPaymentPayload,
    checkoutStatus: "failed" | "pending",
  ) {
    const cryptomusStatus = this.getCryptomusStatus(invoice);
    const nextStatus =
      checkoutStatus === "pending"
        ? PurchaseStatus.PENDING
        : CRYPTOMUS_REFUNDED_STATUSES.has(cryptomusStatus)
          ? PurchaseStatus.REFUNDED
          : PurchaseStatus.FAILED;
    const paidAt = this.getCryptomusPaidAt(invoice);

    await this.prisma.purchase.update({
      where: { id: purchase.id },
      data: {
        failedAt: checkoutStatus === "failed" ? paidAt ?? new Date() : null,
        paymentProvider: PAYMENT_PROVIDER.CRYPTOMUS,
        paymentReference:
          this.getCryptomusOrderId(invoice) ?? purchase.paymentReference,
        paymentSessionId:
          this.getCryptomusUuid(invoice) ??
          this.getCryptomusTransactionId(invoice) ??
          purchase.paymentSessionId,
        status: nextStatus,
      },
    });
  }

  private async completeCryptomusCoinPurchase(
    purchase: PurchaseWithRelations,
    invoice: CryptomusInvoice | CryptomusPaymentPayload,
  ) {
    const coinPackage = purchase.coinPackage;

    if (!coinPackage) {
      throw new BadRequestException("Coin purchase is missing its package.");
    }

    await this.prisma.$transaction(async (tx) => {
      const currentPurchase = await tx.purchase.findUnique({
        where: { id: purchase.id },
      });

      if (!currentPurchase) {
        throw new NotFoundException("Purchase not found.");
      }

      const existingLedgerEntry = await tx.walletLedgerEntry.findUnique({
        where: {
          idempotencyKey: `purchase:${purchase.id}:coins-credit`,
        },
      });

      if (!existingLedgerEntry) {
        const wallet = await this.getOrCreateWalletTx(tx, purchase.userId);
        const coinsToCredit = coinPackage.coins + coinPackage.bonusCoins;
        const nextBalance = wallet.balanceCoins + coinsToCredit;

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balanceCoins: nextBalance,
          },
        });

        await tx.walletLedgerEntry.create({
          data: {
            balanceAfter: nextBalance,
            deltaCoins: coinsToCredit,
            entryType: WalletLedgerEntryType.CREDIT,
            idempotencyKey: `purchase:${purchase.id}:coins-credit`,
            purchase: {
              connect: { id: purchase.id },
            },
            reason: WalletLedgerReason.COIN_PURCHASE,
            user: {
              connect: { id: purchase.userId },
            },
            wallet: {
              connect: { id: wallet.id },
            },
          },
        });
      }

      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          completedAt:
            currentPurchase.completedAt ??
            this.getCryptomusPaidAt(invoice) ??
            new Date(),
          paymentProvider: PAYMENT_PROVIDER.CRYPTOMUS,
          paymentReference:
            this.getCryptomusOrderId(invoice) ?? currentPurchase.paymentReference,
          paymentSessionId:
            this.getCryptomusUuid(invoice) ??
            this.getCryptomusTransactionId(invoice) ??
            currentPurchase.paymentSessionId,
          status: PurchaseStatus.COMPLETED,
        },
      });
    });
  }

  private async completeCryptomusSubscriptionPurchase(
    purchase: PurchaseWithRelations,
    invoice: CryptomusInvoice | CryptomusPaymentPayload,
  ) {
    const plan = purchase.plan;

    if (!plan) {
      throw new BadRequestException("Subscription purchase is missing its plan.");
    }

    const currentPeriodStart =
      this.getCryptomusPaidAt(invoice) ?? new Date();
    const currentPeriodEnd = this.addBillingInterval(
      currentPeriodStart,
      purchase.billingInterval ?? BillingInterval.MONTHLY,
    );

    await this.prisma.$transaction(async (tx) => {
      const currentPurchase = await tx.purchase.findUnique({
        where: { id: purchase.id },
      });

      if (!currentPurchase) {
        throw new NotFoundException("Purchase not found.");
      }

      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          completedAt: currentPurchase.completedAt ?? currentPeriodStart,
          paymentProvider: PAYMENT_PROVIDER.CRYPTOMUS,
          paymentReference:
            this.getCryptomusOrderId(invoice) ?? currentPurchase.paymentReference,
          paymentSessionId:
            this.getCryptomusUuid(invoice) ??
            this.getCryptomusTransactionId(invoice) ??
            currentPurchase.paymentSessionId,
          status: PurchaseStatus.COMPLETED,
        },
      });

      const existingSubscription = await tx.subscription.findFirst({
        where: {
          userId: purchase.userId,
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

      if (existingSubscription) {
        await tx.subscription.update({
          where: {
            id: existingSubscription.id,
          },
          data: {
            billingInterval:
              purchase.billingInterval ?? BillingInterval.MONTHLY,
            cancelAtPeriodEnd: true,
            currentPeriodEnd: currentPeriodEnd ?? existingSubscription.currentPeriodEnd,
            currentPeriodStart:
              currentPeriodStart ?? existingSubscription.currentPeriodStart,
            planId: plan.id,
            status: SubscriptionStatus.ACTIVE,
          },
        });
      } else {
        await tx.subscription.create({
          data: {
            billingInterval:
              purchase.billingInterval ?? BillingInterval.MONTHLY,
            cancelAtPeriodEnd: true,
            currentPeriodEnd,
            currentPeriodStart,
            plan: {
              connect: { id: plan.id },
            },
            status: SubscriptionStatus.ACTIVE,
            user: {
              connect: { id: purchase.userId },
            },
          },
        });
      }

      if (plan.monthlyCoinGrant > 0) {
        const existingLedgerEntry = await tx.walletLedgerEntry.findUnique({
          where: {
            idempotencyKey: `purchase:${purchase.id}:subscription-grant`,
          },
        });

        if (!existingLedgerEntry) {
          const wallet = await this.getOrCreateWalletTx(tx, purchase.userId);
          const nextBalance = wallet.balanceCoins + plan.monthlyCoinGrant;

          await tx.wallet.update({
            where: { id: wallet.id },
            data: {
              balanceCoins: nextBalance,
            },
          });

          await tx.walletLedgerEntry.create({
            data: {
              balanceAfter: nextBalance,
              deltaCoins: plan.monthlyCoinGrant,
              entryType: WalletLedgerEntryType.CREDIT,
              idempotencyKey: `purchase:${purchase.id}:subscription-grant`,
              note: `Subscription grant: ${plan.name}`,
              purchase: {
                connect: { id: purchase.id },
              },
              reason: WalletLedgerReason.SUBSCRIPTION_GRANT,
              user: {
                connect: { id: purchase.userId },
              },
              wallet: {
                connect: { id: wallet.id },
              },
            },
          });
        }
      }
    });
  }

  private async completeCoinPurchase(
    purchase: PurchaseWithRelations,
    transaction: PaystackTransaction,
  ) {
    const coinPackage = purchase.coinPackage;

    if (!coinPackage) {
      throw new BadRequestException("Coin purchase is missing its package.");
    }

    await this.prisma.$transaction(async (tx) => {
      const currentPurchase = await tx.purchase.findUnique({
        where: { id: purchase.id },
      });

      if (!currentPurchase) {
        throw new NotFoundException("Purchase not found.");
      }

      const existingLedgerEntry = await tx.walletLedgerEntry.findUnique({
        where: {
          idempotencyKey: `purchase:${purchase.id}:coins-credit`,
        },
      });

      if (!existingLedgerEntry) {
        const wallet = await this.getOrCreateWalletTx(tx, purchase.userId);
        const coinsToCredit = coinPackage.coins + coinPackage.bonusCoins;
        const nextBalance = wallet.balanceCoins + coinsToCredit;

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balanceCoins: nextBalance,
          },
        });

        await tx.walletLedgerEntry.create({
          data: {
            balanceAfter: nextBalance,
            deltaCoins: coinsToCredit,
            entryType: WalletLedgerEntryType.CREDIT,
            idempotencyKey: `purchase:${purchase.id}:coins-credit`,
            purchase: {
              connect: { id: purchase.id },
            },
            reason: WalletLedgerReason.COIN_PURCHASE,
            user: {
              connect: { id: purchase.userId },
            },
            wallet: {
              connect: { id: wallet.id },
            },
          },
        });
      }

      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          completedAt:
            currentPurchase.completedAt ??
            this.getPaystackTransactionPaidAt(transaction) ??
            new Date(),
          paymentProvider: PAYMENT_PROVIDER.PAYSTACK,
          paymentReference:
            this.getPaystackReference(transaction) ?? currentPurchase.paymentReference,
          paymentSessionId:
            this.getPaystackTransactionId(transaction) ??
            currentPurchase.paymentSessionId,
          paystackCustomerCode: this.getPaystackCustomerCode(transaction.customer),
          paystackReference:
            this.getPaystackReference(transaction) ?? currentPurchase.paystackReference,
          paystackTransactionId:
            this.getPaystackTransactionId(transaction) ??
            currentPurchase.paystackTransactionId,
          status: PurchaseStatus.COMPLETED,
        },
      });
    });
  }

  private async completeSubscriptionPurchase(
    purchase: PurchaseWithRelations,
    transaction: PaystackTransaction,
  ) {
    const plan = purchase.plan;

    if (!plan) {
      throw new BadRequestException("Subscription purchase is missing its plan.");
    }

    const paystackSubscriptionCode =
      this.getPaystackSubscriptionCode(transaction.subscription);
    const paystackCustomerCode = this.getPaystackCustomerCode(transaction.customer);
    const paystackPlanCode = this.getPaystackPlanCode(transaction) ?? null;
    const currentPeriodStart =
      this.getPaystackTransactionPaidAt(transaction) ?? new Date();
    const currentPeriodEnd = this.addBillingInterval(
      currentPeriodStart,
      purchase.billingInterval ?? BillingInterval.MONTHLY,
    );

    await this.prisma.$transaction(async (tx) => {
      const currentPurchase = await tx.purchase.findUnique({
        where: { id: purchase.id },
      });

      if (!currentPurchase) {
        throw new NotFoundException("Purchase not found.");
      }

      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          completedAt: currentPurchase.completedAt ?? currentPeriodStart,
          paymentProvider: PAYMENT_PROVIDER.PAYSTACK,
          paymentReference:
            this.getPaystackReference(transaction) ?? currentPurchase.paymentReference,
          paymentSessionId:
            this.getPaystackTransactionId(transaction) ??
            currentPurchase.paymentSessionId,
          paystackCustomerCode,
          paystackReference:
            this.getPaystackReference(transaction) ?? currentPurchase.paystackReference,
          paystackSubscriptionCode:
            paystackSubscriptionCode ?? currentPurchase.paystackSubscriptionCode,
          paystackTransactionId:
            this.getPaystackTransactionId(transaction) ??
            currentPurchase.paystackTransactionId,
          status: PurchaseStatus.COMPLETED,
        },
      });

      const existingSubscription = paystackSubscriptionCode
        ? await tx.subscription.findFirst({
            where: {
              paystackSubscriptionCode,
            },
          })
        : await tx.subscription.findFirst({
            where: {
              userId: purchase.userId,
            },
            orderBy: {
              updatedAt: "desc",
            },
          });

      if (existingSubscription) {
        await tx.subscription.update({
          where: {
            id: existingSubscription.id,
          },
          data: {
            billingInterval:
              purchase.billingInterval ?? BillingInterval.MONTHLY,
            cancelAtPeriodEnd: false,
            currentPeriodEnd: currentPeriodEnd ?? existingSubscription.currentPeriodEnd,
            currentPeriodStart:
              currentPeriodStart ?? existingSubscription.currentPeriodStart,
            planId: plan.id,
            status: SubscriptionStatus.ACTIVE,
            paystackCustomerCode:
              paystackCustomerCode ?? existingSubscription.paystackCustomerCode,
            paystackPlanCode:
              paystackPlanCode ?? existingSubscription.paystackPlanCode,
            paystackSubscriptionCode:
              paystackSubscriptionCode ??
              existingSubscription.paystackSubscriptionCode,
          },
        });
      } else {
        await tx.subscription.create({
          data: {
            billingInterval:
              purchase.billingInterval ?? BillingInterval.MONTHLY,
            cancelAtPeriodEnd: false,
            currentPeriodEnd,
            currentPeriodStart,
            plan: {
              connect: { id: plan.id },
            },
            status: SubscriptionStatus.ACTIVE,
            paystackCustomerCode,
            paystackPlanCode,
            paystackSubscriptionCode,
            user: {
              connect: { id: purchase.userId },
            },
          },
        });
      }

      if (plan.monthlyCoinGrant > 0) {
        const existingLedgerEntry = await tx.walletLedgerEntry.findUnique({
          where: {
            idempotencyKey: `purchase:${purchase.id}:subscription-grant`,
          },
        });

        if (!existingLedgerEntry) {
          const wallet = await this.getOrCreateWalletTx(tx, purchase.userId);
          const nextBalance = wallet.balanceCoins + plan.monthlyCoinGrant;

          await tx.wallet.update({
            where: { id: wallet.id },
            data: {
              balanceCoins: nextBalance,
            },
          });

          await tx.walletLedgerEntry.create({
            data: {
              balanceAfter: nextBalance,
              deltaCoins: plan.monthlyCoinGrant,
              entryType: WalletLedgerEntryType.CREDIT,
              idempotencyKey: `purchase:${purchase.id}:subscription-grant`,
              note: `Subscription grant: ${plan.name}`,
              purchase: {
                connect: { id: purchase.id },
              },
              reason: WalletLedgerReason.SUBSCRIPTION_GRANT,
              user: {
                connect: { id: purchase.userId },
              },
              wallet: {
                connect: { id: wallet.id },
              },
            },
          });
        }
      }
    });
  }

  private async handlePaystackChargeSuccess(eventData: Record<string, unknown>) {
    const transaction = eventData as PaystackTransaction;
    const purchase = await this.findPurchaseForPaystackTransaction(transaction);

    if (purchase) {
      await this.processPaystackTransaction(transaction, purchase);
      return;
    }

    await this.processRecurringSubscriptionCharge(transaction);
  }

  private async handlePaystackInvoiceUpdate(eventData: Record<string, unknown>) {
    const invoice = eventData as PaystackInvoiceEvent;
    const normalizedStatus = String(invoice.status ?? "").toLowerCase();

    if (invoice.paid === true || normalizedStatus === "paid" || normalizedStatus === "success") {
      await this.processRecurringSubscriptionInvoice(invoice);
      return;
    }

    if (normalizedStatus === "failed" || normalizedStatus === "unpaid") {
      const subscription = await this.resolveSubscriptionForInvoice(invoice);

      if (!subscription) {
        return;
      }

      await this.prisma.subscription.update({
        where: {
          id: subscription.id,
        },
        data: {
          status: SubscriptionStatus.PAST_DUE,
        },
      });
    }
  }

  private async processRecurringSubscriptionCharge(
    transaction: PaystackTransaction,
  ) {
    const subscription = await this.resolveSubscriptionForTransaction(transaction);

    if (!subscription || subscription.plan.monthlyCoinGrant <= 0) {
      return;
    }

    const idempotencyKey = `paystack:${this.getPaystackReference(transaction) ?? this.getPaystackTransactionId(transaction) ?? "unknown"}:subscription-grant`;
    await this.applyRecurringSubscriptionGrant(
      subscription.id,
      idempotencyKey,
      this.getPaystackTransactionPaidAt(transaction),
    );
  }

  private async processRecurringSubscriptionInvoice(invoice: PaystackInvoiceEvent) {
    const subscription = await this.resolveSubscriptionForInvoice(invoice);

    if (!subscription || subscription.plan.monthlyCoinGrant <= 0) {
      return;
    }

    const idempotencyKey = `paystack:invoice:${invoice.invoice_code ?? subscription.id}:subscription-grant`;
    await this.applyRecurringSubscriptionGrant(
      subscription.id,
      idempotencyKey,
      this.parseDateValue(invoice.paid_at),
    );
  }

  private async applyRecurringSubscriptionGrant(
    subscriptionId: string,
    idempotencyKey: string,
    paidAt: Date | null,
  ) {
    const subscriptionRecord = await this.prisma.subscription.findUnique({
      where: {
        id: subscriptionId,
      },
      include: {
        plan: true,
      },
    });

    if (!subscriptionRecord || subscriptionRecord.plan.monthlyCoinGrant <= 0) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const existingLedgerEntry = await tx.walletLedgerEntry.findUnique({
        where: {
          idempotencyKey,
        },
      });

      if (existingLedgerEntry) {
        return;
      }

      const wallet = await this.getOrCreateWalletTx(tx, subscriptionRecord.userId);
      const nextBalance =
        wallet.balanceCoins + subscriptionRecord.plan.monthlyCoinGrant;
      const currentPeriodStart = paidAt ?? new Date();
      const currentPeriodEnd = this.addBillingInterval(
        currentPeriodStart,
        subscriptionRecord.billingInterval,
      );

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balanceCoins: nextBalance,
        },
      });

      await tx.walletLedgerEntry.create({
        data: {
          balanceAfter: nextBalance,
          deltaCoins: subscriptionRecord.plan.monthlyCoinGrant,
          entryType: WalletLedgerEntryType.CREDIT,
          idempotencyKey,
          note: `Recurring subscription grant: ${subscriptionRecord.plan.name}`,
          reason: WalletLedgerReason.SUBSCRIPTION_GRANT,
          user: {
            connect: { id: subscriptionRecord.userId },
          },
          wallet: {
            connect: { id: wallet.id },
          },
        },
      });

      await tx.subscription.update({
        where: {
          id: subscriptionRecord.id,
        },
        data: {
          cancelAtPeriodEnd: false,
          currentPeriodEnd,
          currentPeriodStart,
          lastCoinGrantAt: currentPeriodStart,
          status: SubscriptionStatus.ACTIVE,
        },
      });
    });
  }

  private async syncSubscriptionFromPaystackEvent(
    event: PaystackSubscriptionEvent,
  ) {
    const paystackPlanCode = this.getPlanCodeFromSubscriptionEvent(event);
    const plan = paystackPlanCode
      ? await this.findPlanByPaystackPlanCode(paystackPlanCode)
      : null;

    if (!plan) {
      return;
    }

    const paystackSubscriptionCode = this.getSubscriptionCodeFromSubscriptionEvent(
      event,
    );
    const existingRecord = paystackSubscriptionCode
      ? await this.prisma.subscription.findFirst({
          where: {
            paystackSubscriptionCode,
          },
        })
      : await this.resolveSubscriptionByIdentity(
          this.getCustomerCodeFromSubscriptionEvent(event),
          this.getCustomerEmailFromSubscriptionEvent(event),
        );
    const userId =
      existingRecord?.userId ??
      (await this.resolveUserIdFromPaystackIdentity(
        this.getCustomerCodeFromSubscriptionEvent(event),
        this.getCustomerEmailFromSubscriptionEvent(event),
        event.metadata,
      ));

    if (!userId) {
      return;
    }

    const billingInterval = this.toBillingIntervalFromPaystackPlanCode(
      plan,
      paystackPlanCode,
    );
    const currentPeriodEnd =
      this.parseDateValue(event.next_payment_date) ??
      this.addBillingInterval(new Date(), billingInterval);
    const data = {
      billingInterval,
      cancelAtPeriodEnd: false,
      currentPeriodEnd,
      currentPeriodStart: new Date(),
      paystackCustomerCode:
        this.getCustomerCodeFromSubscriptionEvent(event) ??
        existingRecord?.paystackCustomerCode ??
        null,
      paystackPlanCode,
      paystackSubscriptionCode:
        paystackSubscriptionCode ?? existingRecord?.paystackSubscriptionCode ?? null,
      planId: plan.id,
      status: this.mapPaystackSubscriptionStatus(event.status),
    };

    if (existingRecord) {
      await this.prisma.subscription.update({
        where: {
          id: existingRecord.id,
        },
        data,
      });
      return;
    }

    await this.prisma.subscription.create({
      data: {
        billingInterval: data.billingInterval,
        cancelAtPeriodEnd: data.cancelAtPeriodEnd,
        currentPeriodEnd: data.currentPeriodEnd,
        currentPeriodStart: data.currentPeriodStart,
        paystackCustomerCode: data.paystackCustomerCode,
        paystackPlanCode: data.paystackPlanCode,
        paystackSubscriptionCode: data.paystackSubscriptionCode,
        plan: {
          connect: { id: plan.id },
        },
        status: data.status,
        user: {
          connect: { id: userId },
        },
      },
    });
  }

  private async markSubscriptionAsDisabled(event: PaystackSubscriptionEvent) {
    const subscription = await this.resolveSubscriptionForSubscriptionEvent(event);

    if (!subscription) {
      return;
    }

    await this.prisma.subscription.update({
      where: {
        id: subscription.id,
      },
      data: {
        cancelAtPeriodEnd: true,
        status: SubscriptionStatus.CANCELED,
      },
    });
  }

  private async markSubscriptionAsNotRenewing(
    event: PaystackSubscriptionEvent,
  ) {
    const subscription = await this.resolveSubscriptionForSubscriptionEvent(event);

    if (!subscription) {
      return;
    }

    await this.prisma.subscription.update({
      where: {
        id: subscription.id,
      },
      data: {
        cancelAtPeriodEnd: true,
      },
    });
  }

  private async getPublishedChapterBySlugs(storySlug: string, chapterSlug: string) {
    const story = await this.prisma.story.findUnique({
      where: { slug: storySlug },
      select: {
        adminControl: {
          select: {
            defaultPremiumWindowHours: true,
            globalCoinCap: true,
            lastUpdatedByAdminUserId: true,
          },
        },
        id: true,
        isLive: true,
        liveAt: true,
      },
    });

    if (!story || !isStoryLive(story)) {
      throw new NotFoundException("Story not found.");
    }

    const chapter = await this.prisma.publishedChapter.findUnique({
      where: {
        storyId_slug: {
          slug: chapterSlug,
          storyId: story.id,
        },
      },
      include: {
        adminOverride: true,
        chapter: {
          select: {
            coinUnlockPrice: true,
            premiumEnabled: true,
          },
        },
      },
    });

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    return {
      chapter,
      story,
    };
  }

  private async getPublishedStoryWithChaptersBySlugs(
    storySlug: string,
    chapterSlug: string,
  ) {
    const story = await this.prisma.story.findUnique({
      where: {
        slug: storySlug,
      },
      select: {
        adminControl: {
          select: {
            defaultPremiumWindowHours: true,
            globalCoinCap: true,
            lastUpdatedByAdminUserId: true,
          },
        },
        id: true,
        isLive: true,
        liveAt: true,
        publishedChapters: {
          include: {
            adminOverride: true,
            chapter: {
              select: {
                coinUnlockPrice: true,
                premiumEnabled: true,
              },
            },
          },
          orderBy: {
            chapterNumber: "asc",
          },
        },
      },
    });

    if (!story || !isStoryLive(story)) {
      throw new NotFoundException("Story not found.");
    }

    const chapter =
      story.publishedChapters.find((item) => item.slug === chapterSlug) ?? null;

    if (!chapter) {
      throw new NotFoundException("Chapter not found.");
    }

    return {
      chapter,
      story,
    };
  }

  private getStoryControl(story: {
    adminControl?: {
      defaultPremiumWindowHours: number;
      globalCoinCap: number;
      lastUpdatedByAdminUserId?: string | null;
    } | null;
    liveAt?: Date | null;
  }) {
    return {
      defaultPremiumWindowHours: normalizeConfiguredPremiumWindowHours(
        story.adminControl?.defaultPremiumWindowHours,
        story.adminControl?.lastUpdatedByAdminUserId ?? null,
      ),
      globalCoinCap:
        story.adminControl?.globalCoinCap ?? defaultBookPlatformPolicy.defaultCoinCap,
      liveAt: story.liveAt ?? null,
    };
  }

  private resolveEffectiveChapter(
    chapter: ChapterAccessTarget,
    story: StoryAccessContext,
  ) {
    const storyControl = this.getStoryControl(story);

    return resolveEffectiveChapterAccess({
      adminOverride: chapter.adminOverride,
      authorCoinUnlockPrice: chapter.chapter?.coinUnlockPrice ?? chapter.coinUnlockPrice,
      authorPremiumEnabled: chapter.chapter?.premiumEnabled ?? chapter.premium,
      globalCoinCap: storyControl.globalCoinCap,
      lockConfiguredAt: chapter.adminOverride?.updatedAt ?? null,
      premiumWindowHours: storyControl.defaultPremiumWindowHours,
      publishedAt: chapter.publishedAt,
      storyLiveAt: storyControl.liveAt,
    });
  }

  private async getBatchUnlockContext(
    userId: string,
    input: { chapterSlug: string; storySlug: string },
  ) {
    const { chapter, story } = await this.getPublishedStoryWithChaptersBySlugs(
      input.storySlug,
      input.chapterSlug,
    );
    const [wallet, hasPremiumSubscription, entitlements] = await Promise.all([
      this.getOrCreateWallet(userId),
      this.hasActiveSubscriptionAccess(userId),
      story.publishedChapters.length === 0
        ? Promise.resolve([])
        : this.prisma.chapterEntitlement.findMany({
            where: {
              publishedChapterId: {
                in: story.publishedChapters.map((item) => item.id),
              },
              userId,
              OR: [
                { expiresAt: null },
                {
                  expiresAt: {
                    gt: new Date(),
                  },
                },
              ],
            },
            select: {
              publishedChapterId: true,
            },
          }),
    ]);
    const currentChapterAccess = await this.getChapterAccessDecision(userId, {
      chapter,
      isChapterPremium: this.resolveEffectiveChapter(chapter, story)
        .isCurrentlyPremium,
      story,
    });

    if (currentChapterAccess.accessState === "SEQUENCE_BLOCKED") {
      throw new BadRequestException(
        this.getSequentialAccessMessage(
          currentChapterAccess.requiredPreviousChapter,
        ),
      );
    }

    const entitledChapterIds = new Set(
      entitlements.map((item) => item.publishedChapterId),
    );
    const currentChapterIndex = story.publishedChapters.findIndex(
      (item) => item.id === chapter.id,
    );
    const candidateChapters = story.publishedChapters.slice(currentChapterIndex);
    const eligibleCandidates = hasPremiumSubscription
      ? []
      : candidateChapters.reduce<BatchUnlockCandidate[]>((list, item) => {
          const effectiveChapter = this.resolveEffectiveChapter(item, story);

          if (
            !effectiveChapter.isCurrentlyPremium ||
            entitledChapterIds.has(item.id)
          ) {
            return list;
          }

          list.push({
            chapter: item,
            effectiveCoinPrice: effectiveChapter.effectiveCoinPrice,
            isCurrentlyPremium: effectiveChapter.isCurrentlyPremium,
          });
          return list;
        }, []);

    return {
      chapter,
      eligibleCandidates,
      hasPremiumSubscription,
      story,
      wallet,
    };
  }

  private buildBatchUnlockOptions(candidates: BatchUnlockCandidate[]) {
    if (candidates.length <= 1) {
      return candidates.length === 1
        ? [this.buildBatchUnlockOption(candidates, "all")]
        : [];
    }

    const options: BatchUnlockOption[] = [];
    const nextCount = Math.min(BATCH_UNLOCK_NEXT_CHAPTER_COUNT, candidates.length);

    if (candidates.length > nextCount) {
      options.push(this.buildBatchUnlockOption(candidates.slice(0, nextCount), "next"));
    }

    options.push(this.buildBatchUnlockOption(candidates, "all"));

    return options;
  }

  private resolveBatchUnlockOption(
    candidates: BatchUnlockCandidate[],
    mode: "all" | "next",
  ) {
    if (candidates.length === 0) {
      return null;
    }

    if (mode === "next") {
      return this.buildBatchUnlockOption(
        candidates.slice(0, Math.min(BATCH_UNLOCK_NEXT_CHAPTER_COUNT, candidates.length)),
        "next",
      );
    }

    return this.buildBatchUnlockOption(candidates, "all");
  }

  private buildBatchUnlockOption(
    chapters: BatchUnlockCandidate[],
    mode: "all" | "next",
  ): BatchUnlockOption {
    const originalTotalCoins = chapters.reduce(
      (sum, item) => sum + item.effectiveCoinPrice,
      0,
    );
    const discountPercent = this.getBatchUnlockDiscountPercent(chapters.length);
    const savingsCoins =
      chapters.length <= 1
        ? 0
        : Math.round((originalTotalCoins * discountPercent) / 100);
    const finalTotalCoins = Math.max(0, originalTotalCoins - savingsCoins);

    return {
      chapters,
      discountPercent,
      finalTotalCoins,
      label:
        mode === "all"
          ? `Unlock All Remaining (${chapters.length})`
          : `Unlock Next ${chapters.length}`,
      mode,
      originalTotalCoins,
      savingsCoins,
    };
  }

  private mapBatchUnlockOption(option: BatchUnlockOption) {
    const firstChapter = option.chapters[0]?.chapter ?? null;
    const lastChapter = option.chapters.at(-1)?.chapter ?? null;

    return {
      chapterCount: option.chapters.length,
      chapters: option.chapters.map((item) => ({
        chapterNumber: item.chapter.chapterNumber,
        chapterSlug: item.chapter.slug,
        title: item.chapter.title,
        unlockPriceCoins: item.effectiveCoinPrice,
      })),
      description: firstChapter && lastChapter
        ? option.mode === "all"
          ? `Unlock ${option.chapters.length} remaining premium chapters through Chapter ${lastChapter.chapterNumber}.`
          : `Unlock the next ${option.chapters.length} premium chapters from Chapter ${firstChapter.chapterNumber} to Chapter ${lastChapter.chapterNumber}.`
        : "Unlock premium chapters in one purchase.",
      discountPercent: option.discountPercent,
      label: option.label,
      mode: option.mode,
      originalTotalCoins: option.originalTotalCoins,
      savingsCoins: option.savingsCoins,
      totalCoins: option.finalTotalCoins,
    };
  }

  private getBatchUnlockDiscountPercent(chapterCount: number) {
    for (const tier of BATCH_UNLOCK_DISCOUNT_TIERS) {
      if (chapterCount >= tier.minCount) {
        return tier.percent;
      }
    }

    return 0;
  }

  private allocateBatchUnlockCoins(
    option: BatchUnlockOption,
    batchIdempotencyKey: string,
  ) {
    if (option.chapters.length === 1 || option.originalTotalCoins === option.finalTotalCoins) {
      return option.chapters.map((candidate) => ({
        allocatedCoins: candidate.effectiveCoinPrice,
        chapter: candidate.chapter,
        idempotencyKey: this.getBatchUnlockChildIdempotencyKey(
          batchIdempotencyKey,
          candidate.chapter.id,
        ),
      }));
    }

    const rawAllocations = option.chapters.map((candidate, index) => {
      const exactCoins =
        (candidate.effectiveCoinPrice * option.finalTotalCoins) /
        option.originalTotalCoins;
      const flooredCoins = Math.floor(exactCoins);

      return {
        chapter: candidate.chapter,
        exactCoins,
        flooredCoins,
        fractionalCoins: exactCoins - flooredCoins,
        index,
      };
    });
    const allocatedCoins = rawAllocations.reduce(
      (sum, item) => sum + item.flooredCoins,
      0,
    );
    let remainder = option.finalTotalCoins - allocatedCoins;

    rawAllocations
      .slice()
      .sort((left, right) => {
        if (right.fractionalCoins === left.fractionalCoins) {
          return left.index - right.index;
        }

        return right.fractionalCoins - left.fractionalCoins;
      })
      .forEach((item) => {
        if (remainder <= 0) {
          return;
        }

        item.flooredCoins += 1;
        remainder -= 1;
      });

    return rawAllocations.map((item) => ({
      allocatedCoins: item.flooredCoins,
      chapter: item.chapter,
      idempotencyKey: this.getBatchUnlockChildIdempotencyKey(
        batchIdempotencyKey,
        item.chapter.id,
      ),
    }));
  }

  private getBatchUnlockMessage(option: BatchUnlockOption) {
    const savingsSuffix =
      option.savingsCoins > 0
        ? ` You saved ${option.savingsCoins} coins.`
        : "";

    return option.mode === "all"
      ? `Unlocked all ${option.chapters.length} remaining premium chapters for ${option.finalTotalCoins} coins.${savingsSuffix}`
      : `Unlocked the next ${option.chapters.length} premium chapters for ${option.finalTotalCoins} coins.${savingsSuffix}`;
  }

  private getBatchUnlockChildIdempotencyKey(batchKey: string, chapterId: string) {
    return `${batchKey}:${chapterId}`;
  }

  private async getPreviousPublishedChapter(chapter: ChapterAccessTarget) {
    if (chapter.chapterNumber <= 1) {
      return null;
    }

    return this.prisma.publishedChapter.findUnique({
      where: {
        storyId_chapterNumber: {
          chapterNumber: chapter.chapterNumber - 1,
          storyId: chapter.storyId,
        },
      },
      include: {
        adminOverride: true,
        chapter: {
          select: {
            coinUnlockPrice: true,
            premiumEnabled: true,
          },
        },
      },
    });
  }

  private getSequentialAccessMessage(
    requiredPreviousChapter: RequiredPreviousChapter,
  ) {
    if (!requiredPreviousChapter) {
      return "You need to unlock the previous chapter before continuing.";
    }

    return `You need access to Chapter ${requiredPreviousChapter.chapterNumber}: ${requiredPreviousChapter.title} before unlocking this chapter.`;
  }

  private async tryResolveCoinUnlockReplay(input: {
    chapter: ChapterAccessTarget;
    ledgerEntry: {
      entryType: WalletLedgerEntryType;
      idempotencyKey: string;
      publishedChapterId: string | null;
      reason: WalletLedgerReason;
      storyId: string | null;
      userId: string;
    };
    story: StoryAccessContext;
    userId: string;
  }) {
    if (!this.isMatchingCoinUnlockLedgerEntry(input.ledgerEntry, input.userId, input.chapter)) {
      throw new BadRequestException(
        "This unlock request key is already tied to another transaction.",
      );
    }

    await this.ensureCoinUnlockEntitlement(input.userId, input.chapter);

    const access = await this.getChapterAccessDecision(input.userId, {
      chapter: input.chapter,
      isChapterPremium: this.resolveEffectiveChapter(input.chapter, input.story)
        .isCurrentlyPremium,
      story: input.story,
    });

    return access.accessState === "READABLE";
  }

  private async reconcileCoinUnlockConflict(input: {
    chapter: ChapterAccessTarget;
    idempotencyKey: string;
    story: StoryAccessContext;
    userId: string;
  }) {
    for (const waitMs of [0, 50, 150]) {
      if (waitMs > 0) {
        await delay(waitMs);
      }

      const [ledgerEntry, entitlement] = await Promise.all([
        this.prisma.walletLedgerEntry.findUnique({
          where: {
            idempotencyKey: input.idempotencyKey,
          },
        }),
        this.prisma.chapterEntitlement.findUnique({
          where: {
            userId_publishedChapterId: {
              publishedChapterId: input.chapter.id,
              userId: input.userId,
            },
          },
        }),
      ]);

      if (ledgerEntry) {
        const replayHandled = await this.tryResolveCoinUnlockReplay({
          chapter: input.chapter,
          ledgerEntry,
          story: input.story,
          userId: input.userId,
        });

        if (replayHandled) {
          return true;
        }
      }

      if (entitlement && this.isEntitlementActive(entitlement.expiresAt)) {
        return true;
      }
    }

    return false;
  }

  private async tryResolveBatchCoinUnlockReplay(input: {
    chapters: ChapterAccessTarget[];
    idempotencyKey: string;
    ledgerEntries: Array<{
      entryType: WalletLedgerEntryType;
      idempotencyKey: string;
      publishedChapterId: string | null;
      reason: WalletLedgerReason;
      storyId: string | null;
      userId: string;
    }>;
    userId: string;
  }) {
    if (input.chapters.length === 0) {
      return true;
    }

    const childKeys = input.chapters.map((chapter) =>
      this.getBatchUnlockChildIdempotencyKey(input.idempotencyKey, chapter.id),
    );
    const chapterIds = new Set(input.chapters.map((chapter) => chapter.id));
    const chapterById = new Map(
      input.chapters.map((chapter) => [chapter.id, chapter]),
    );
    const ledgerEntries =
      input.ledgerEntries.length > 0
        ? input.ledgerEntries
        : await this.prisma.walletLedgerEntry.findMany({
            where: {
              idempotencyKey: {
                in: childKeys,
              },
            },
            select: {
              entryType: true,
              idempotencyKey: true,
              publishedChapterId: true,
              reason: true,
              storyId: true,
              userId: true,
            },
          });

    if (ledgerEntries.length !== input.chapters.length) {
      return false;
    }

    for (const ledgerEntry of ledgerEntries) {
      if (!childKeys.includes(ledgerEntry.idempotencyKey)) {
        throw new BadRequestException(
          "This unlock request key is already tied to another transaction.",
        );
      }

      const chapterId = ledgerEntry.publishedChapterId;
      const chapter =
        chapterId && chapterIds.has(chapterId)
          ? chapterById.get(chapterId) ?? null
          : null;

      if (
        !chapter ||
        !this.isMatchingCoinUnlockLedgerEntry(ledgerEntry, input.userId, chapter)
      ) {
        throw new BadRequestException(
          "This unlock request key is already tied to another transaction.",
        );
      }
    }

    await Promise.all(
      ledgerEntries.map((ledgerEntry) =>
        this.ensureCoinUnlockEntitlement(
          input.userId,
          chapterById.get(ledgerEntry.publishedChapterId!)!,
        ),
      ),
    );

    const entitlements = await this.prisma.chapterEntitlement.findMany({
      where: {
        publishedChapterId: {
          in: input.chapters.map((chapter) => chapter.id),
        },
        userId: input.userId,
        OR: [
          { expiresAt: null },
          {
            expiresAt: {
              gt: new Date(),
            },
          },
        ],
      },
      select: {
        publishedChapterId: true,
      },
    });

    return entitlements.length === input.chapters.length;
  }

  private isMatchingCoinUnlockLedgerEntry(
    ledgerEntry: {
      entryType: WalletLedgerEntryType;
      publishedChapterId: string | null;
      reason: WalletLedgerReason;
      storyId: string | null;
      userId: string;
    },
    userId: string,
    chapter: Pick<ChapterAccessTarget, "id" | "storyId">,
  ) {
    return (
      ledgerEntry.entryType === WalletLedgerEntryType.DEBIT &&
      ledgerEntry.publishedChapterId === chapter.id &&
      ledgerEntry.reason === WalletLedgerReason.CHAPTER_UNLOCK &&
      ledgerEntry.storyId === chapter.storyId &&
      ledgerEntry.userId === userId
    );
  }

  private async ensureCoinUnlockEntitlement(
    userId: string,
    chapter: Pick<ChapterAccessTarget, "id" | "storyId">,
  ) {
    return this.prisma.chapterEntitlement.upsert({
      where: {
        userId_publishedChapterId: {
          publishedChapterId: chapter.id,
          userId,
        },
      },
      update: {},
      create: {
        chapter: {
          connect: { id: chapter.id },
        },
        source: ChapterEntitlementSource.COIN_UNLOCK,
        story: {
          connect: { id: chapter.storyId },
        },
        user: {
          connect: { id: userId },
        },
      },
    });
  }

  private async getActiveSubscription(userId: string) {
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        userId,
      },
      include: {
        plan: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 5,
    });

    return (
      subscriptions.find((item) => this.isSubscriptionActive(item)) ?? null
    );
  }

  private isSubscriptionActive(input: {
    currentPeriodEnd: Date | null;
    status: SubscriptionStatus;
  }) {
    if (!ACTIVE_SUBSCRIPTION_STATUSES.has(input.status)) {
      return false;
    }

    if (!input.currentPeriodEnd) {
      return true;
    }

    return input.currentPeriodEnd.getTime() > Date.now();
  }

  private isEntitlementActive(expiresAt: Date | null) {
    if (!expiresAt) {
      return true;
    }

    return expiresAt.getTime() > Date.now();
  }

  private async getOrCreateWallet(userId: string) {
    return this.prisma.wallet.upsert({
      where: {
        userId,
      },
      update: {},
      create: {
        user: {
          connect: { id: userId },
        },
      },
    });
  }

  private async getOrCreateWalletTx(tx: TransactionClient, userId: string) {
    return tx.wallet.upsert({
      where: {
        userId,
      },
      update: {},
      create: {
        user: {
          connect: { id: userId },
        },
      },
    });
  }

  private toBillingInterval(value: string) {
    return value === "annual" ? BillingInterval.ANNUAL : BillingInterval.MONTHLY;
  }

  private hasCryptomusConfiguration() {
    return Boolean(env.cryptomusMerchantId && env.cryptomusPaymentApiKey);
  }

  private getConfiguredCheckoutProvider(): CheckoutProvider {
    if (this.hasCryptomusConfiguration()) {
      return PAYMENT_PROVIDER.CRYPTOMUS;
    }

    if (env.paystackSecretKey) {
      return PAYMENT_PROVIDER.PAYSTACK;
    }

    throw new ServiceUnavailableException(
      "No checkout provider is configured. Set CRYPTOMUS_* or PAYSTACK_* credentials.",
    );
  }

  private getCheckoutProviderValue(): CheckoutProviderValue {
    return this.getConfiguredCheckoutProvider() === PAYMENT_PROVIDER.CRYPTOMUS
      ? "cryptomus"
      : "paystack";
  }

  private getCheckoutCurrency() {
    return this.getConfiguredCheckoutProvider() === PAYMENT_PROVIDER.CRYPTOMUS
      ? env.cryptomusCurrency
      : env.paystackCurrency;
  }

  private getCatalogCacheKey(checkoutProvider: CheckoutProviderValue, currency: string) {
    return `monetization:catalog:${checkoutProvider}:${currency}`;
  }

  private assertSupportedCheckoutAmount(
    amountCents: number,
    input: Pick<CreateCheckoutSessionInput, "kind" | "productId">,
    paymentProvider: CheckoutProvider,
  ) {
    if (paymentProvider === PAYMENT_PROVIDER.CRYPTOMUS) {
      if (amountCents > 0) {
        return;
      }

      throw new BadRequestException(
        `${input.kind === "coins" ? "Coin package" : "Subscription"} ${input.productId} must be priced above 0.`,
      );
    }

    this.assertSupportedPaystackAmount(amountCents, input);
  }

  private canProcessCheckoutAmount(amountCents: number) {
    if (this.getConfiguredCheckoutProvider() === PAYMENT_PROVIDER.CRYPTOMUS) {
      return amountCents > 0;
    }

    return this.canProcessPaystackAmount(amountCents);
  }

  private getPurchaseProvider(
    purchase?: Pick<PurchaseWithRelations, "paymentProvider"> | null,
  ) {
    return purchase?.paymentProvider ?? PAYMENT_PROVIDER.PAYSTACK;
  }

  private formatAmountCents(amountCents: number) {
    return (amountCents / 100).toFixed(2);
  }

  private getRequestOrigin(request: AuthenticatedRequest) {
    const forwardedProto =
      this.getHeaderValue(request.headers, "x-forwarded-proto") ??
      this.getSchemeFromCfVisitor(
        this.getHeaderValue(request.headers, "cf-visitor"),
      ) ??
      "https";
    const forwardedHost =
      this.getHeaderValue(request.headers, "x-forwarded-host") ??
      this.getHeaderValue(request.headers, "host");

    if (!forwardedHost) {
      return null;
    }

    try {
      return new URL(
        `${forwardedProto.split(",")[0].trim()}://${forwardedHost.split(",")[0].trim()}`,
      ).origin;
    } catch {
      return null;
    }
  }

  private getHeaderValue(
    headers: Record<string, string | string[] | undefined> | undefined,
    headerName: string,
  ) {
    const value = headers?.[headerName];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (Array.isArray(value)) {
      const first = value.find(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      );

      return first?.trim() ?? null;
    }

    return null;
  }

  private getSchemeFromCfVisitor(cfVisitor: string | null) {
    if (!cfVisitor) {
      return null;
    }

    try {
      const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };

      return typeof parsed.scheme === "string" && parsed.scheme.trim()
        ? parsed.scheme.trim()
        : null;
    } catch {
      return null;
    }
  }

  private buildCryptomusOrderId(purchaseId: string) {
    return `storyarc-${purchaseId}`;
  }

  private looksLikeUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private getCryptomusStatus(
    payload: CryptomusInvoice | CryptomusPaymentPayload | null | undefined,
  ) {
    return String(payload?.payment_status ?? payload?.status ?? "").toLowerCase();
  }

  private mapCryptomusCheckoutStatus(
    payload: CryptomusInvoice | CryptomusPaymentPayload | null | undefined,
  ) {
    const status = this.getCryptomusStatus(payload);

    if (CRYPTOMUS_SUCCESS_STATUSES.has(status)) {
      return "success" as const;
    }

    if (CRYPTOMUS_FAILED_STATUSES.has(status)) {
      return "failed" as const;
    }

    if (CRYPTOMUS_REFUNDED_STATUSES.has(status)) {
      return "failed" as const;
    }

    return "pending" as const;
  }

  private getCryptomusOrderId(
    payload: CryptomusInvoice | CryptomusPaymentPayload | null | undefined,
  ) {
    const value = payload?.order_id;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getCryptomusUuid(
    payload: CryptomusInvoice | CryptomusPaymentPayload | null | undefined,
  ) {
    const value = payload?.uuid;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getCryptomusTransactionId(
    payload: CryptomusInvoice | CryptomusPaymentPayload | null | undefined,
  ) {
    const value = payload?.txid;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getCryptomusAmount(
    payload: CryptomusInvoice | CryptomusPaymentPayload | null | undefined,
  ) {
    if (typeof payload?.amount === "number" && Number.isFinite(payload.amount)) {
      return payload.amount;
    }

    if (typeof payload?.amount === "string" && payload.amount.trim()) {
      const parsed = Number(payload.amount);

      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private getCryptomusCurrency(
    payload: CryptomusInvoice | CryptomusPaymentPayload | null | undefined,
  ) {
    const value = payload?.currency;

    return typeof value === "string" && value.trim()
      ? value.trim().toUpperCase()
      : null;
  }

  private getCryptomusPaidAt(
    payload: CryptomusInvoice | CryptomusPaymentPayload | null | undefined,
  ) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const updatedAt =
      "updated_at" in payload && typeof payload.updated_at === "string"
        ? payload.updated_at
        : null;
    const expiredAt =
      "expired_at" in payload && typeof payload.expired_at === "string"
        ? payload.expired_at
        : null;

    return this.parseDateValue(updatedAt) ?? this.parseDateValue(expiredAt);
  }

  private assertCryptomusConfigured() {
    if (!this.hasCryptomusConfiguration()) {
      throw new ServiceUnavailableException(
        "CRYPTOMUS_MERCHANT_ID and CRYPTOMUS_PAYMENT_API_KEY must be configured.",
      );
    }
  }

  private buildCryptomusSignature(payload: Record<string, unknown>) {
    const normalizedJson = this.serializeCryptomusPayload(payload);
    const encoded = Buffer.from(normalizedJson).toString("base64");

    return createHash("md5")
      .update(encoded + env.cryptomusPaymentApiKey!)
      .digest("hex");
  }

  private serializeCryptomusPayload(payload: Record<string, unknown>) {
    return JSON.stringify(payload).replace(/\//g, "\\/");
  }

  private async cryptomusRequest<T>(
    path: string,
    payload: Record<string, unknown>,
  ) {
    this.assertCryptomusConfigured();
    const serializedPayload = this.serializeCryptomusPayload(payload);

    const response = await fetch(`${this.cryptomusApiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        merchant: env.cryptomusMerchantId!,
        sign: this.buildCryptomusSignature(payload),
      },
      body: serializedPayload,
    });
    const body = (await response.json().catch(() => null)) as
      | CryptomusApiResponse<T>
      | null;

    if (
      !response.ok ||
      (typeof body?.state === "number" && body.state !== 0) ||
      !body?.result
    ) {
      const message =
        body?.message?.trim() ||
        `Cryptomus request failed with status ${response.status}.`;

      if (response.status >= 400 && response.status < 500) {
        throw new BadRequestException(message);
      }

      throw new ServiceUnavailableException(message);
    }

    return body;
  }

  private async verifyCryptomusPayment(reference: string) {
    const payload = this.looksLikeUuid(reference)
      ? { uuid: reference }
      : { order_id: reference };
    const response = await this.cryptomusRequest<CryptomusInvoice>(
      "/payment/info",
      payload,
    );
    const invoice = response.result ?? null;

    if (!invoice) {
      throw new NotFoundException("Cryptomus payment was not found.");
    }

    return invoice;
  }

  private parseCryptomusWebhookPayload(rawBody: Buffer) {
    try {
      return JSON.parse(rawBody.toString("utf8")) as CryptomusPaymentPayload;
    } catch {
      throw new BadRequestException("Cryptomus webhook body is not valid JSON.");
    }
  }

  private assertCryptomusWebhookSignature(payload: CryptomusPaymentPayload) {
    const providedSignature =
      typeof payload.sign === "string" ? payload.sign.trim() : "";

    if (!providedSignature) {
      throw new BadRequestException("Missing Cryptomus webhook sign value.");
    }

    const { sign: _sign, ...unsignedPayload } = payload;
    const expectedSignature = this.buildCryptomusSignature(unsignedPayload);

    if (!this.constantTimeEquals(providedSignature, expectedSignature)) {
      throw new BadRequestException("Invalid Cryptomus webhook signature.");
    }
  }

  private async findPurchaseForCheckoutReference(reference: string) {
    const trimmedReference = reference.trim();

    if (!trimmedReference) {
      return null;
    }

    return this.prisma.purchase.findFirst({
      where: {
        OR: [
          { paymentReference: trimmedReference },
          { paymentSessionId: trimmedReference },
          { paystackReference: trimmedReference },
          { paystackTransactionId: trimmedReference },
        ],
      },
      include: {
        coinPackage: true,
        plan: true,
      },
    });
  }

  private assertCryptomusInvoiceMatchesPurchase(
    invoice: CryptomusInvoice | CryptomusPaymentPayload,
    purchase: Pick<
      PurchaseWithRelations,
      "amountCents" | "currency" | "paymentReference" | "paymentSessionId"
    >,
  ) {
    const amount = this.getCryptomusAmount(invoice);
    const currency = this.getCryptomusCurrency(invoice);
    const orderId = this.getCryptomusOrderId(invoice);
    const uuid = this.getCryptomusUuid(invoice);

    if (amount !== null) {
      const expectedAmount = Number(this.formatAmountCents(purchase.amountCents));

      if (Math.abs(amount - expectedAmount) > 0.000001) {
        throw new BadRequestException(
          "Verified Cryptomus amount does not match the purchase.",
        );
      }
    }

    if (currency && currency !== purchase.currency.toUpperCase()) {
      throw new BadRequestException(
        "Verified Cryptomus currency does not match the purchase.",
      );
    }

    if (
      purchase.paymentReference &&
      orderId &&
      purchase.paymentReference !== orderId
    ) {
      throw new BadRequestException(
        "Verified Cryptomus order_id does not match the purchase.",
      );
    }

    if (
      purchase.paymentSessionId &&
      uuid &&
      purchase.paymentSessionId !== uuid
    ) {
      throw new BadRequestException(
        "Verified Cryptomus uuid does not match the purchase.",
      );
    }
  }

  private getPaystackPlanEnvFieldName(planCode: string, billing: "monthly" | "annual") {
    const normalizedPlan = planCode.trim().toUpperCase();
    const normalizedBilling = billing === "annual" ? "ANNUAL" : "MONTHLY";

    return `PAYSTACK_PLAN_${normalizedPlan}_${normalizedBilling}`;
  }

  private assertValidPaystackPlanCode(value: string, envFieldName: string) {
    if (/^PLN_/i.test(value.trim())) {
      return;
    }

    throw new ServiceUnavailableException(
      `${envFieldName} must be a real Paystack plan code like PLN_xxxxx, but received "${value}".`,
    );
  }

  private assertSupportedPaystackAmount(
    amountCents: number,
    input: Pick<CreateCheckoutSessionInput, "kind" | "productId">,
  ) {
    const currency = env.paystackCurrency.toUpperCase();
    const minimumAmount = this.getMinimumPaystackAmount(currency);

    if (amountCents >= minimumAmount) {
      return;
    }

    throw new BadRequestException(
      `${input.kind === "coins" ? "Coin package" : "Subscription"} ${input.productId} is priced below Paystack's minimum for ${currency}. Minimum: ${minimumAmount}. Current: ${amountCents}.`,
    );
  }

  private canProcessPaystackAmount(amountCents: number) {
    return amountCents >= this.getMinimumPaystackAmount(env.paystackCurrency);
  }

  private getMinimumPaystackAmount(currency: string) {
    return PAYSTACK_MINIMUM_AMOUNT_BY_CURRENCY[currency.toUpperCase()] ?? 0;
  }

  private mapCheckoutStatus(paystackStatus: string | null) {
    switch (paystackStatus) {
      case "success":
        return "success" as const;
      case "failed":
      case "abandoned":
      case "reversed":
      case "cancelled":
      case "canceled":
        return "failed" as const;
      default:
        return "pending" as const;
    }
  }

  private getCheckoutStatusMessage(
    checkoutStatus: "failed" | "pending" | "success",
  ) {
    switch (checkoutStatus) {
      case "success":
        return "Payment successful.";
      case "failed":
        return "Payment failed or was canceled.";
      default:
        return "Payment is still pending confirmation.";
    }
  }

  private toFrontendBillingInterval(value: BillingInterval) {
    return value === BillingInterval.ANNUAL ? "annual" : "monthly";
  }

  private getPurchaseHistoryDescription(purchase: PurchaseHistoryRecord) {
    if (purchase.kind === PurchaseKind.SUBSCRIPTION) {
      const planName = purchase.plan?.name?.trim() || "";
      const membershipLabel = planName ? `${planName} Membership` : "Membership";
      const intervalLabel =
        purchase.billingInterval === BillingInterval.ANNUAL
          ? "Annual"
          : "Monthly";

      return `${membershipLabel} ${intervalLabel}`;
    }

    return purchase.coinPackage?.name?.trim() || "Coin Package";
  }

  private toBillingIntervalFromPaystackPlanCode(
    plan: {
      paystackAnnualPlanCode: string | null;
      paystackMonthlyPlanCode: string | null;
    },
    planCode: string | null,
  ) {
    if (planCode && plan.paystackAnnualPlanCode === planCode) {
      return BillingInterval.ANNUAL;
    }

    return BillingInterval.MONTHLY;
  }

  private mapPaystackSubscriptionStatus(status: string | null | undefined) {
    switch (String(status ?? "").toLowerCase()) {
      case "active":
        return SubscriptionStatus.ACTIVE;
      case "non-renewing":
        return SubscriptionStatus.ACTIVE;
      case "trialing":
        return SubscriptionStatus.TRIALING;
      case "past_due":
      case "unpaid":
      case "failed":
        return SubscriptionStatus.PAST_DUE;
      case "disabled":
      case "cancelled":
      case "canceled":
        return SubscriptionStatus.CANCELED;
      case "pending":
      case "incomplete":
        return SubscriptionStatus.INCOMPLETE;
      default:
        return SubscriptionStatus.EXPIRED;
    }
  }

  private assertPaystackConfigured() {
    if (!env.paystackSecretKey) {
      throw new ServiceUnavailableException(
        "PAYSTACK_SECRET_KEY is not configured.",
      );
    }
  }

  private getFrontendAppUrl() {
    if (!env.frontendAppUrl) {
      throw new ServiceUnavailableException(
        "FRONTEND_APP_URL is not configured.",
      );
    }

    return env.frontendAppUrl.replace(/\/+$/, "");
  }

  private async paystackRequest<T>(
    path: string,
    init: RequestInit,
  ) {
    this.assertPaystackConfigured();

    const response = await fetch(`${this.paystackApiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.paystackSecretKey!}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          message?: string;
          status?: boolean;
        }
      | null;

    if (!response.ok || payload?.status === false) {
      const message = this.enrichPaystackErrorMessage(
        payload?.message ||
          `Paystack request failed with status ${response.status}.`,
      );

      if (response.status >= 400 && response.status < 500) {
        throw new BadRequestException(message);
      }

      throw new ServiceUnavailableException(message);
    }

    return payload as T;
  }

  private enrichPaystackErrorMessage(message: string) {
    if (
      message.toLowerCase().includes("no active channel to process transaction")
    ) {
      return `${message} Check your Paystack dashboard payment channels for ${env.paystackCurrency}, and if this is a subscription make sure PAYSTACK_PLAN_* values are real Paystack plan codes.`;
    }

    return message;
  }

  private async verifyPaystackTransaction(reference: string) {
    const response = await this.paystackRequest<{
      data?: PaystackTransaction;
    }>(`/transaction/verify/${encodeURIComponent(reference)}`, {
      method: "GET",
    });
    const transaction = response.data ?? null;

    if (!transaction) {
      throw new NotFoundException("Paystack transaction was not found.");
    }

    return transaction;
  }

  private parsePaystackWebhookPayload(rawBody: Buffer) {
    try {
      return JSON.parse(rawBody.toString("utf8")) as PaystackWebhookPayload;
    } catch {
      throw new BadRequestException("Paystack webhook body is not valid JSON.");
    }
  }

  private getPaystackWebhookEventKey(
    eventType: string,
    data: Record<string, unknown>,
    rawBody: Buffer,
  ) {
    const transaction = data as PaystackTransaction;
    const invoice = data as PaystackInvoiceEvent;
    const subscription = data as PaystackSubscriptionEvent;

    const candidate =
      this.getPaystackReference(transaction) ??
      this.getPaystackTransactionId(transaction) ??
      invoice.invoice_code ??
      this.getSubscriptionCodeFromSubscriptionEvent(subscription) ??
      this.getCustomerCodeFromSubscriptionEvent(subscription);

    if (candidate) {
      return `${eventType}:${candidate}`;
    }

    return `${eventType}:${createHmac("sha256", "talestead-paystack").update(rawBody).digest("hex")}`;
  }

  private constantTimeEquals(actual: string, expected: string) {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);

    if (actualBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private buildPaystackReference(purchaseId: string) {
    return `talestead-${purchaseId}`;
  }

  private async findPurchaseForPaystackTransaction(
    transaction: PaystackTransaction,
  ) {
    const purchaseId =
      this.getPaystackMetadataString(transaction.metadata, "purchaseId") ?? null;
    const reference = this.getPaystackReference(transaction);

    if (purchaseId) {
      const purchase = await this.prisma.purchase.findUnique({
        where: {
          id: purchaseId,
        },
        include: {
          coinPackage: true,
          plan: true,
        },
      });

      if (purchase) {
        return purchase;
      }
    }

    if (!reference) {
      return null;
    }

    return this.prisma.purchase.findFirst({
      where: {
        paystackReference: reference,
      },
      include: {
        coinPackage: true,
        plan: true,
      },
    });
  }

  private assertPaystackTransactionMatchesPurchase(
    transaction: PaystackTransaction,
    purchase: Pick<PurchaseWithRelations, "amountCents" | "currency" | "paystackReference">,
  ) {
    const amount = transaction.amount ?? null;
    const currency = transaction.currency?.toUpperCase() ?? null;
    const reference = this.getPaystackReference(transaction);

    if (amount !== null && amount !== purchase.amountCents) {
      throw new BadRequestException("Verified transaction amount does not match the purchase.");
    }

    if (currency && currency !== purchase.currency.toUpperCase()) {
      throw new BadRequestException("Verified transaction currency does not match the purchase.");
    }

    if (purchase.paystackReference && reference && purchase.paystackReference !== reference) {
      throw new BadRequestException("Verified transaction reference does not match the purchase.");
    }
  }

  private getPaystackMetadataString(
    metadata: PaystackMetadata,
    key: string,
  ) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return null;
    }

    const value = metadata[key];

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getPaystackTransactionStatus(transaction: PaystackTransaction) {
    return String(transaction.status ?? "").toLowerCase();
  }

  private getPaystackReference(transaction: PaystackTransaction) {
    const value = transaction.reference;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getPaystackCustomerCode(customer: PaystackCustomer | null | undefined) {
    const value = customer?.customer_code;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getPaystackCustomerEmail(customer: PaystackCustomer | null | undefined) {
    const value = customer?.email;

    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
  }

  private getPaystackTransactionId(transaction: PaystackTransaction) {
    const value = transaction.id;

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getPaystackSubscriptionCode(
    subscription: PaystackSubscriptionObject | null | undefined,
  ) {
    const value = subscription?.subscription_code;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getPaystackPlanCode(transaction: PaystackTransaction) {
    const value = transaction.plan_object?.plan_code;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getPlanCodeFromSubscriptionEvent(event: PaystackSubscriptionEvent) {
    const value = event.plan?.plan_code ?? event.plan_object?.plan_code ?? null;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getSubscriptionCodeFromSubscriptionEvent(
    event: PaystackSubscriptionEvent,
  ) {
    const value = event.subscription_code;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getCustomerCodeFromSubscriptionEvent(event: PaystackSubscriptionEvent) {
    const value = event.customer_code ?? event.customer?.customer_code ?? null;

    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getCustomerEmailFromSubscriptionEvent(
    event: PaystackSubscriptionEvent,
  ) {
    const value = event.email ?? event.customer?.email ?? null;

    return typeof value === "string" && value.trim()
      ? value.trim().toLowerCase()
      : null;
  }

  private getPaystackTransactionPaidAt(transaction: PaystackTransaction) {
    return (
      this.parseDateValue(transaction.paid_at) ??
      this.parseDateValue(transaction.created_at)
    );
  }

  private parseDateValue(value: string | null | undefined) {
    if (!value) {
      return null;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  private addBillingInterval(date: Date, interval: BillingInterval) {
    const nextDate = new Date(date);

    if (interval === BillingInterval.ANNUAL) {
      nextDate.setFullYear(nextDate.getFullYear() + 1);
      return nextDate;
    }

    nextDate.setMonth(nextDate.getMonth() + 1);
    return nextDate;
  }

  private async resolveSubscriptionForTransaction(transaction: PaystackTransaction) {
    const subscriptionCode = this.getPaystackSubscriptionCode(
      transaction.subscription,
    );

    if (subscriptionCode) {
      const subscription = await this.prisma.subscription.findFirst({
        where: {
          paystackSubscriptionCode: subscriptionCode,
        },
        include: {
          plan: true,
        },
      });

      if (subscription) {
        return subscription;
      }
    }

    return this.resolveSubscriptionByIdentity(
      this.getPaystackCustomerCode(transaction.customer),
      this.getPaystackCustomerEmail(transaction.customer),
    );
  }

  private async resolveSubscriptionForInvoice(invoice: PaystackInvoiceEvent) {
    const subscriptionCode =
      invoice.subscription_code ?? invoice.subscription?.subscription_code ?? null;

    if (typeof subscriptionCode === "string" && subscriptionCode.trim()) {
      const subscription = await this.prisma.subscription.findFirst({
        where: {
          paystackSubscriptionCode: subscriptionCode.trim(),
        },
        include: {
          plan: true,
        },
      });

      if (subscription) {
        return subscription;
      }
    }

    return this.resolveSubscriptionByIdentity(
      typeof invoice.customer_code === "string" ? invoice.customer_code.trim() : null,
      this.getPaystackCustomerEmail(invoice.customer),
    );
  }

  private async resolveSubscriptionForSubscriptionEvent(
    event: PaystackSubscriptionEvent,
  ) {
    const subscriptionCode = this.getSubscriptionCodeFromSubscriptionEvent(event);

    if (subscriptionCode) {
      const subscription = await this.prisma.subscription.findFirst({
        where: {
          paystackSubscriptionCode: subscriptionCode,
        },
        include: {
          plan: true,
        },
      });

      if (subscription) {
        return subscription;
      }
    }

    return this.resolveSubscriptionByIdentity(
      this.getCustomerCodeFromSubscriptionEvent(event),
      this.getCustomerEmailFromSubscriptionEvent(event),
    );
  }

  private async resolveSubscriptionByIdentity(
    customerCode: string | null,
    email: string | null,
  ) {
    if (customerCode) {
      const subscription = await this.prisma.subscription.findFirst({
        where: {
          paystackCustomerCode: customerCode,
        },
        include: {
          plan: true,
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

      if (subscription) {
        return subscription;
      }
    }

    if (!email) {
      return null;
    }

    const user = await this.prisma.user.findUnique({
      where: {
        email,
      },
      select: {
        id: true,
      },
    });

    if (!user) {
      return null;
    }

    return this.prisma.subscription.findFirst({
      where: {
        userId: user.id,
      },
      include: {
        plan: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });
  }

  private async resolveUserIdFromPaystackIdentity(
    customerCode: string | null,
    email: string | null,
    metadata: PaystackMetadata,
  ) {
    const userIdFromMetadata = this.getPaystackMetadataString(metadata, "userId");

    if (userIdFromMetadata) {
      return userIdFromMetadata;
    }

    const subscription = await this.resolveSubscriptionByIdentity(customerCode, email);

    if (subscription) {
      return subscription.userId;
    }

    if (!email) {
      return null;
    }

    const user = await this.prisma.user.findUnique({
      where: {
        email,
      },
      select: {
        id: true,
      },
    });

    return user?.id ?? null;
  }

  private async findPlanByPaystackPlanCode(planCode: string) {
    return this.prisma.plan.findFirst({
      where: {
        OR: [
          { paystackMonthlyPlanCode: planCode },
          { paystackAnnualPlanCode: planCode },
        ],
      },
    });
  }

  private toChapterKey(storySlug: string, chapterSlug: string) {
    return `${storySlug}-${chapterSlug}`;
  }

  private getUniqueConstraintTarget(error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return "unknown";
    }

    const target = error.meta?.target;

    if (Array.isArray(target)) {
      return target.join(",");
    }

    if (typeof target === "string") {
      return target;
    }

    return "unknown";
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }

  // --- Phase 2A: Refund Flow ---

  async requestRefund(userId: string, purchaseId: string, reason: string) {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id: purchaseId },
    });

    if (!purchase || purchase.userId !== userId) {
      throw new NotFoundException("Purchase not found.");
    }

    if (purchase.status !== "COMPLETED") {
      throw new BadRequestException("Only completed purchases can be refunded.");
    }

    const existingRefund = await this.prisma.refundRequest.findFirst({
      where: { purchaseId, status: { in: ["PENDING", "APPROVED"] } },
    });

    if (existingRefund) {
      throw new ConflictException("A refund request already exists for this purchase.");
    }

    const refundRequest = await this.prisma.refundRequest.create({
      data: {
        purchaseId,
        userId,
        reason,
        amountCents: purchase.amountCents,
      },
    });

    return { refundRequest };
  }

  // --- Phase 2B: Subscription Cancel ---

  async cancelSubscription(userId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
    });

    if (!subscription) {
      throw new NotFoundException("No active subscription found.");
    }

    if (subscription.cancelAtPeriodEnd) {
      return { message: "Subscription is already set to cancel at period end." };
    }

    // If Paystack subscription, disable it via API
    if (subscription.paystackSubscriptionCode) {
      try {
        await fetch("https://api.paystack.co/subscription/disable", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code: subscription.paystackSubscriptionCode,
            token: subscription.paystackSubscriptionCode,
          }),
        });
      } catch (error) {
        this.logger.error(
          `Failed to disable Paystack subscription ${subscription.paystackSubscriptionCode}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true },
    });

    return { message: "Subscription will be canceled at the end of the current billing period." };
  }

  async changeSubscriptionPlan(
    userId: string,
    newPlanId: string,
    _billingInterval: string,
  ) {
    // Cancel current subscription
    await this.cancelSubscription(userId);

    // Return info for the client to initiate a new checkout
    const plan = await this.prisma.plan.findUnique({
      where: { id: newPlanId },
    });

    if (!plan || !plan.active) {
      throw new NotFoundException("Plan not found or inactive.");
    }

    return {
      message: "Current subscription will be canceled. Please create a new checkout session for the new plan.",
      newPlanId: plan.id,
      newPlanName: plan.name,
    };
  }

  private async trySendPurchaseReceipt(purchase: PurchaseWithRelations) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: purchase.userId },
        include: { profile: true },
      });

      if (!user?.email) return;

      const itemName =
        purchase.coinPackage?.name ?? purchase.plan?.name ?? purchase.kind;
      const amountCents = purchase.coinPackage?.priceCents ?? purchase.plan?.monthlyPriceCents ?? 0;
      const amountFormatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(amountCents / 100);
      const purchaseDate = (purchase.completedAt ?? purchase.createdAt)
        .toISOString()
        .split("T")[0];

      await this.emailService.sendPurchaseReceipt({
        email: user.email,
        userName: user.profile?.displayName ?? user.email,
        itemName,
        amountFormatted,
        purchaseDate,
      });
    } catch {
      // Non-critical: don't fail purchase completion if email fails
    }
  }
}
