import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
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
import { env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
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

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
]);

const PAYSTACK_MINIMUM_AMOUNT_BY_CURRENCY: Record<string, number> = {
  GHS: 10,
  KES: 300,
  NGN: 5000,
  USD: 200,
  ZAR: 100,
};

@Injectable()
export class MonetizationService implements OnModuleInit {
  private readonly paystackApiBaseUrl = "https://api.paystack.co";
  private readonly logger = new Logger(MonetizationService.name);
  private catalogBootstrapped = false;
  private catalogBootstrapPromise: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.cleanupLegacyStripeIndexes();
    await this.ensureSparseChapterEntitlementIndexes();
    await this.ensureCatalogBootstrapped();
  }

  async getCatalog() {
    await this.ensureCatalogBootstrapped();

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
      this.canProcessPaystackAmount(item.priceCents),
    );
    const supportedPlans = plans.filter((plan) => {
      const monthlySupported = this.canProcessPaystackAmount(plan.monthlyPriceCents);
      const yearlySupported =
        typeof plan.yearlyPriceCents === "number"
          ? this.canProcessPaystackAmount(plan.yearlyPriceCents)
          : true;

      return monthlySupported && yearlySupported;
    });

    return {
      currency: env.paystackCurrency,
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
      currency: env.paystackCurrency,
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

  async createCheckoutSession(
    userId: string,
    input: CreateCheckoutSessionInput,
  ) {
    this.assertPaystackConfigured();
    const frontendAppUrl = this.getFrontendAppUrl();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
      },
    });

    if (!user) {
      throw new NotFoundException("User account not found.");
    }

    const product = await this.getCheckoutProduct(input);
    this.assertSupportedPaystackAmount(product.amountCents, input);
    const purchase = await this.findOrCreateCheckoutPurchase(userId, input, product);
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
        currency: env.paystackCurrency,
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

  async unlockChapterWithAd(userId: string, input: ChapterUnlockInput) {
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

        const adUnlockRecord = await tx.adUnlockRecord.create({
          data: {
            chapter: {
              connect: { id: chapter.id },
            },
            idempotencyKey: input.idempotencyKey,
            story: {
              connect: { id: chapter.storyId },
            },
            user: {
              connect: { id: userId },
            },
          },
        });

        await tx.chapterEntitlement.create({
          data: {
            adUnlockRecord: {
              connect: { id: adUnlockRecord.id },
            },
            chapter: {
              connect: { id: chapter.id },
            },
            source: ChapterEntitlementSource.AD_UNLOCK,
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
    }

    return {
      chapterKey: this.toChapterKey(input.storySlug, input.chapterSlug),
      message: "Ad unlock recorded. Chapter access is now active.",
      status: await this.getStatus(userId),
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
      paystackPlanCode?: string;
      planId?: string;
    },
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
      currency: env.paystackCurrency,
      idempotencyKey: input.idempotencyKey,
      kind:
        input.kind === "coins"
          ? PurchaseKind.COINS
          : PurchaseKind.SUBSCRIPTION,
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

  private async getCheckoutProduct(input: CreateCheckoutSessionInput) {
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

    if (!paystackPlanCode) {
      throw new ServiceUnavailableException(
        `Paystack plan code is not configured for plan ${plan.code} (${input.billing}).`,
      );
    }

    this.assertValidPaystackPlanCode(
      paystackPlanCode,
      this.getPaystackPlanEnvFieldName(plan.code, input.billing),
    );

    return {
      amountCents,
      paystackPlanCode,
      planId: plan.id,
    };
  }

  private async ensureCatalogBootstrapped() {
    if (this.catalogBootstrapped) {
      return;
    }

    if (this.catalogBootstrapPromise) {
      return this.catalogBootstrapPromise;
    }

    this.catalogBootstrapPromise = ensureDefaultMonetizationCatalog(this.prisma, {
      codes: {
        arcaneAnnualPlanCode: env.paystackPlanArcaneAnnual ?? null,
        arcaneMonthlyPlanCode: env.paystackPlanArcaneMonthly ?? null,
        silverAnnualPlanCode: env.paystackPlanSilverAnnual ?? null,
        silverMonthlyPlanCode: env.paystackPlanSilverMonthly ?? null,
      },
      currency: env.paystackCurrency,
    })
      .then(({ coinPackageCodes, planCodes }) => {
        this.catalogBootstrapped = true;
        this.logger.log(
          `Monetization catalog ready with ${planCodes.length} plans and ${coinPackageCodes.length} coin packages.`,
        );
      })
      .finally(() => {
        this.catalogBootstrapPromise = null;
      });

    return this.catalogBootstrapPromise;
  }

  private async cleanupLegacyStripeIndexes() {
    const collections = ["purchases", "subscriptions", "plans", "coin_packages"];

    for (const collection of collections) {
      const indexes = await this.listCollectionIndexes(collection);

      if (!indexes) {
        continue;
      }

      for (const index of indexes) {
        const name = typeof index.name === "string" ? index.name : "";
        const keyNames = Object.keys(index.key ?? {});
        const isLegacyStripeIndex =
          name.toLowerCase().includes("stripe") ||
          keyNames.some((key) => key.toLowerCase().includes("stripe"));

        if (!isLegacyStripeIndex) {
          continue;
        }

        try {
          await this.prisma.$runCommandRaw({
            dropIndexes: collection,
            index: name,
          });
          this.logger.warn(
            `Dropped legacy Stripe index ${name} from ${collection}.`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Failed to drop legacy Stripe index ${name} from ${collection}: ${message}`,
          );
        }
      }
    }
  }

  private async ensureSparseChapterEntitlementIndexes() {
    const collection = "chapter_entitlements";
    const sparseUniqueIndexName = "chapter_entitlements_adUnlockRecordId_key";
    const indexes = await this.listCollectionIndexes(collection);

    if (!indexes) {
      return;
    }

    const existingIndex = indexes.find((index) => {
      const key = index.key ?? {};

      return (
        (typeof index.name === "string" && index.name === sparseUniqueIndexName) ||
        (Object.keys(key).length === 1 && key.adUnlockRecordId === 1)
      );
    });

    if (
      existingIndex &&
      existingIndex.name === sparseUniqueIndexName &&
      existingIndex.unique === true &&
      existingIndex.sparse === true
    ) {
      return;
    }

    if (existingIndex?.name) {
      try {
        await this.prisma.$runCommandRaw({
          dropIndexes: collection,
          index: existingIndex.name,
        });
        this.logger.warn(
          `Dropped non-sparse chapter entitlement index ${existingIndex.name}.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to drop chapter entitlement index ${existingIndex.name}: ${message}`,
        );
        return;
      }
    }

    try {
      await this.prisma.$runCommandRaw({
        createIndexes: collection,
        indexes: [
          {
            key: {
              adUnlockRecordId: 1,
            },
            name: sparseUniqueIndexName,
            sparse: true,
            unique: true,
          },
        ],
      });
      this.logger.log(
        "Ensured sparse unique index on chapter_entitlements.adUnlockRecordId.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to create sparse chapter entitlement index ${sparseUniqueIndexName}: ${message}`,
      );
    }
  }

  private async listCollectionIndexes(collection: string) {
    try {
      const result = (await this.prisma.$runCommandRaw({
        listIndexes: collection,
        cursor: {},
      })) as {
        cursor?: {
          firstBatch?: Array<{
            key?: Record<string, unknown>;
            name?: string;
            sparse?: boolean;
            unique?: boolean;
          }>;
        };
      };

      return result.cursor?.firstBatch ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (
        message.includes("ns does not exist") ||
        message.includes("NamespaceNotFound")
      ) {
        return null;
      }

      this.logger.warn(`Unable to inspect indexes for ${collection}: ${message}`);
      return null;
    }
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
      return;
    }

    await this.completeSubscriptionPurchase(resolvedPurchase, transaction);
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

    return `${eventType}:${createHmac("sha256", "storyarc-paystack").update(rawBody).digest("hex")}`;
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
    return `storyarc-${purchaseId}`;
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
}
