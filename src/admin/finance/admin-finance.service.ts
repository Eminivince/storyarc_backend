import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AdminSettingKind } from "@prisma/client";
import { ResendEmailService } from "../../auth/resend-email.service";
import { isCreatorWithdrawalPeriodLabel } from "../../creator/creator-finance.constants";
import { PrismaService } from "../../database/prisma.service";
import {
  AdminAuditService,
  AdminRequestContext,
} from "../admin-audit.service";
import {
  AD_UNLOCK_REVENUE_CENTS,
  ADMIN_LIST_DEFAULT_LIMIT,
  defaultAdminSettings,
} from "../admin-constants";
import {
  formatCompactNumber,
  formatCurrency,
  getDisplayName,
  getPercentWidth,
} from "../admin-format.utils";

@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly emailService: ResendEmailService,
  ) {}

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "ACTIVE")
      throw new NotFoundException("User not found.");
    if (user.role !== "ADMIN")
      throw new ForbiddenException("Admin access is required.");
    return user;
  }

  private async ensureAdminDefaults() {
    for (const setting of defaultAdminSettings) {
      await this.prisma.adminSetting.upsert({
        where: {
          key: setting.key,
        },
        create: setting,
        update: {
          description: setting.description,
          group: setting.group,
          kind: setting.kind,
          title: setting.title,
          valueCents:
            setting.kind === AdminSettingKind.BOOLEAN ? null : undefined,
        },
      });
    }
  }

  // --- Monetization ---

  async getAdminMonetization(adminUserId: string) {
    await this.requireAdmin(adminUserId);
    await this.ensureAdminDefaults();

    const [purchases, subscriptions, coinPackages, payouts] =
      await Promise.all([
        this.prisma.purchase.findMany({
          where: {
            status: "COMPLETED",
          },
          include: {
            coinPackage: true,
          },
        }),
        this.prisma.subscription.findMany({
          where: {
            status: {
              in: ["ACTIVE", "TRIALING", "PAST_DUE"],
            },
          },
          include: {
            plan: true,
          },
        }),
        this.prisma.coinPackage.findMany(),
        this.prisma.creatorPayout.findMany({
          include: {
            creator: {
              include: {
                profile: true,
              },
            },
          },
          orderBy: {
            updatedAt: "desc",
          },
        }),
      ]);

    const totalRevenueCents = purchases.reduce(
      (sum, purchase) => sum + purchase.amountCents,
      0,
    );
    const subscriptionRevenueCents = purchases
      .filter((purchase) => purchase.kind === "SUBSCRIPTION")
      .reduce((sum, purchase) => sum + purchase.amountCents, 0);
    const coinRevenueCents = purchases
      .filter((purchase) => purchase.kind === "COINS")
      .reduce((sum, purchase) => sum + purchase.amountCents, 0);
    const adRevenueCents =
      (await this.prisma.adUnlockRecord.count()) * AD_UNLOCK_REVENUE_CENTS;
    const purchasers = new Set(purchases.map((purchase) => purchase.userId))
      .size;
    const arpu = purchasers ? totalRevenueCents / purchasers : 0;
    const totalStreamCents =
      subscriptionRevenueCents + coinRevenueCents + adRevenueCents;
    const withdrawalPayouts = payouts.filter((payout) =>
      isCreatorWithdrawalPeriodLabel(payout.periodLabel),
    );

    const packageCounts = purchases.reduce(
      (map, purchase) => {
        if (!purchase.coinPackageId) {
          return map;
        }

        map.set(
          purchase.coinPackageId,
          (map.get(purchase.coinPackageId) ?? 0) + 1,
        );
        return map;
      },
      new Map<string, number>(),
    );

    return {
      monetizationStats: [
        {
          delta: `${subscriptions.length} active`,
          icon: "payments",
          id: "revenue",
          label: "Total Revenue",
          value: formatCurrency(totalRevenueCents),
        },
        {
          delta: `${subscriptions.length} plans`,
          icon: "workspace_premium",
          id: "mrr",
          label: "Monthly Recurring",
          value: formatCurrency(subscriptionRevenueCents),
        },
        {
          delta: `${purchasers} buyers`,
          icon: "analytics",
          id: "arpu",
          label: "Avg. ARPU",
          value: formatCurrency(Math.round(arpu)),
        },
      ],
      monetizationStreams: [
        {
          id: "subs",
          label: "Subscriptions",
          value: formatCurrency(subscriptionRevenueCents),
          width: `${getPercentWidth(subscriptionRevenueCents, totalStreamCents)}%`,
        },
        {
          id: "coins",
          label: "Coins",
          value: formatCurrency(coinRevenueCents),
          width: `${getPercentWidth(coinRevenueCents, totalStreamCents)}%`,
        },
        {
          id: "ads",
          label: "Ad Revenue",
          value: formatCurrency(adRevenueCents),
          width: `${getPercentWidth(adRevenueCents, totalStreamCents)}%`,
        },
      ],
      payoutQueue: withdrawalPayouts.map((payout) => ({
        amount: formatCurrency(payout.amountCents),
        author: getDisplayName(payout.creator),
        id: payout.id,
        status:
          payout.status === "RELEASED"
            ? "Released"
            : payout.status === "IN_REVIEW"
              ? "Review"
              : "Ready",
      })),
      topCoinPackages: coinPackages
        .map((coinPackage) => ({
          id: coinPackage.id,
          label: `${coinPackage.coins + coinPackage.bonusCoins} Coins`,
          price: formatCurrency(coinPackage.priceCents),
          sold: `${formatCompactNumber(packageCounts.get(coinPackage.id) ?? 0)} packs`,
        }))
        .sort((left, right) => {
          const leftCount = Number(left.sold.replace(/[^\d]/g, "")) || 0;
          const rightCount = Number(right.sold.replace(/[^\d]/g, "")) || 0;
          return rightCount - leftCount;
        })
        .slice(0, 3),
    };
  }

  // --- Payouts ---

  async updatePayoutStatus(
    adminUserId: string,
    payoutId: string,
    action: string,
    notes?: string | null,
    context?: AdminRequestContext,
  ) {
    const admin = await this.requireAdmin(adminUserId);
    const payout = await this.prisma.creatorPayout.findUnique({
      where: {
        id: payoutId,
      },
      include: {
        creator: {
          include: {
            profile: true,
          },
        },
      },
    });

    if (!payout) {
      throw new NotFoundException("Payout not found.");
    }

    let nextStatus: string;
    let summaryPrefix: string;

    if (action === "RELEASE") {
      // Check two-person payout review setting
      const twoPersonSetting = await this.prisma.adminSetting.findUnique({
        where: { key: "twoPersonPayoutReview" },
      });
      if (
        twoPersonSetting?.enabled &&
        payout.reviewedByAdminUserId === adminUserId
      ) {
        throw new BadRequestException(
          "Two-person review is enabled. A different admin must release this payout.",
        );
      }

      nextStatus = "RELEASED";
      summaryPrefix = "Released payout for";
    } else if (action === "REVIEW") {
      nextStatus = "IN_REVIEW";
      summaryPrefix = "Opened payout review for";
    } else if (action === "REJECT") {
      nextStatus = "REJECTED";
      summaryPrefix = "Rejected payout for";
    } else {
      throw new BadRequestException(
        "Action must be one of: RELEASE, REVIEW, REJECT.",
      );
    }

    const updateData: Record<string, unknown> = {
      status: nextStatus,
      reviewNotes: notes ?? null,
    };

    if (action === "REVIEW") {
      updateData.reviewedByAdminUserId = adminUserId;
    } else if (action === "RELEASE") {
      updateData.releasedByAdminUserId = adminUserId;
    }

    const updatedPayout = await this.prisma.creatorPayout.update({
      where: {
        id: payoutId,
      },
      data: updateData,
      include: {
        creator: {
          include: {
            profile: true,
          },
        },
      },
    });

    await this.audit.log(
      admin.id,
      {
        detail: `${getDisplayName(updatedPayout.creator)} payout moved to ${nextStatus}.`,
        icon: "payments",
        summary: `${summaryPrefix} ${getDisplayName(updatedPayout.creator)}`,
        targetId: payoutId,
        targetType: "PAYOUT",
      },
      context,
    );

    // Send email notification on release
    if (action === "RELEASE" && updatedPayout.creator.email) {
      try {
        await this.emailService.sendPayoutProcessed({
          email: updatedPayout.creator.email,
          userName: getDisplayName(updatedPayout.creator),
          amount: formatCurrency(updatedPayout.amountCents),
        });
      } catch {
        // Non-critical: don't fail the payout release if email fails
      }
    }

    const messages: Record<string, string> = {
      RELEASE: `Payout release started for ${getDisplayName(updatedPayout.creator)}.`,
      REVIEW: `Finance review opened for ${getDisplayName(updatedPayout.creator)}.`,
      REJECT: `Payout rejected for ${getDisplayName(updatedPayout.creator)}.`,
    };

    return {
      message: messages[action] ?? "Payout status updated.",
    };
  }

  // --- Refunds ---

  async listAdminRefunds(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const refunds = await this.prisma.refundRequest.findMany({
      include: {
        user: { include: { profile: true } },
        purchase: { include: { coinPackage: true, plan: true } },
      },
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_DEFAULT_LIMIT,
    });

    return {
      refunds: refunds.map((r) => ({
        id: r.id,
        userId: r.userId,
        userName: getDisplayName(r.user),
        purchaseId: r.purchaseId,
        purchaseLabel:
          r.purchase.coinPackage?.name ??
          r.purchase.plan?.name ??
          r.purchase.kind,
        reason: r.reason,
        amountCents: r.amountCents,
        amountFormatted: formatCurrency(r.amountCents),
        status: r.status,
        reviewNotes: r.reviewNotes,
        createdAt: r.createdAt.toISOString(),
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
      })),
    };
  }

  async resolveAdminRefund(
    adminUserId: string,
    refundId: string,
    action: string,
    notes: string | null,
    context?: AdminRequestContext,
  ) {
    const admin = await this.requireAdmin(adminUserId);

    const refund = await this.prisma.refundRequest.findUnique({
      where: { id: refundId },
      include: {
        user: { include: { profile: true } },
        purchase: true,
      },
    });

    if (!refund) {
      throw new NotFoundException("Refund request not found.");
    }

    if (refund.status !== "PENDING") {
      throw new BadRequestException("This refund has already been resolved.");
    }

    if (action !== "APPROVE" && action !== "REJECT") {
      throw new BadRequestException("Action must be APPROVE or REJECT.");
    }

    const nextStatus = action === "APPROVE" ? "APPROVED" : "REJECTED";

    await this.prisma.refundRequest.update({
      where: { id: refundId },
      data: {
        status: nextStatus,
        reviewNotes: notes,
        reviewedAt: new Date(),
        reviewedById: adminUserId,
      },
    });

    // If approved, mark purchase as refunded and restore coins
    if (action === "APPROVE") {
      await this.prisma.$transaction(async (tx) => {
        await tx.purchase.update({
          where: { id: refund.purchaseId },
          data: { status: "REFUNDED" },
        });

        // Restore coins to user wallet
        if (refund.amountCents > 0) {
          const coinsToRestore = refund.amountCents; // 1:1 cents to coins
          const wallet = await tx.wallet.upsert({
            where: { userId: refund.userId },
            create: { userId: refund.userId, balanceCoins: coinsToRestore },
            update: { balanceCoins: { increment: coinsToRestore } },
          });

          await tx.walletLedgerEntry.create({
            data: {
              wallet: { connect: { id: wallet.id } },
              user: { connect: { id: refund.userId } },
              entryType: "CREDIT",
              reason: "REFUND",
              deltaCoins: coinsToRestore,
              balanceAfter: wallet.balanceCoins,
              note: `Refund for purchase ${refund.purchaseId}`,
              idempotencyKey: `refund:${refundId}`,
            },
          });
        }
      });

      await this.prisma.refundRequest.update({
        where: { id: refundId },
        data: { status: "PROCESSED" },
      });
    }

    await this.audit.log(
      admin.id,
      {
        detail: `Refund request from ${getDisplayName(refund.user)} ${action === "APPROVE" ? "approved and processed" : "rejected"}.${notes ? ` Notes: ${notes}` : ""}`,
        icon: "receipt_long",
        summary: `${action === "APPROVE" ? "Approved" : "Rejected"} refund for ${getDisplayName(refund.user)}`,
        targetId: refundId,
        targetType: "REFUND",
      },
      context,
    );

    return {
      message:
        action === "APPROVE"
          ? `Refund approved and processed for ${getDisplayName(refund.user)}.`
          : `Refund rejected for ${getDisplayName(refund.user)}.`,
    };
  }

  // --- Tax Forms ---

  async listAdminTaxForms(adminUserId: string) {
    await this.requireAdmin(adminUserId);

    const taxForms = await this.prisma.taxForm.findMany({
      include: {
        user: { include: { profile: true } },
      },
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_DEFAULT_LIMIT,
    });

    return {
      taxForms: taxForms.map((form) => ({
        id: form.id,
        userId: form.userId,
        userName: getDisplayName(form.user),
        formType: form.formType,
        status: form.status,
        submittedAt: form.submittedAt?.toISOString() ?? null,
        reviewedAt: form.reviewedAt?.toISOString() ?? null,
        createdAt: form.createdAt.toISOString(),
      })),
    };
  }

  async reviewAdminTaxForm(
    adminUserId: string,
    taxFormId: string,
    status: string,
    notes: string | null,
    context?: AdminRequestContext,
  ) {
    const admin = await this.requireAdmin(adminUserId);

    const taxForm = await this.prisma.taxForm.findUnique({
      where: { id: taxFormId },
      include: { user: { include: { profile: true } } },
    });

    if (!taxForm) {
      throw new NotFoundException("Tax form not found.");
    }

    if (status !== "APPROVED" && status !== "REJECTED") {
      throw new BadRequestException("Status must be APPROVED or REJECTED.");
    }

    await this.prisma.taxForm.update({
      where: { id: taxFormId },
      data: {
        status,
        reviewedAt: new Date(),
      },
    });

    await this.audit.log(
      admin.id,
      {
        detail: `Tax form (${taxForm.formType}) for ${getDisplayName(taxForm.user)} ${status.toLowerCase()}.${notes ? ` Notes: ${notes}` : ""}`,
        icon: "description",
        summary: `${status === "APPROVED" ? "Approved" : "Rejected"} tax form for ${getDisplayName(taxForm.user)}`,
        targetId: taxFormId,
        targetType: "TAX_FORM",
      },
      context,
    );

    return {
      message: `Tax form ${status.toLowerCase()} for ${getDisplayName(taxForm.user)}.`,
    };
  }
}
