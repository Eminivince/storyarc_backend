import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ContractExclusivity,
  ContractStatus,
  CreatorPayoutStatus,
  WalletLedgerEntryType,
  WalletLedgerReason,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import {
  creatorMinimumWithdrawalCents,
  creatorWithdrawalPeriodPrefix,
  isCreatorWithdrawalPeriodLabel,
} from "./creator-finance.constants";
import { CreatorWithdrawalRequestInput } from "./creator.types";

type ContractWindowRecord = {
  activatedAt: Date;
  contractType: ContractExclusivity;
  createdAt: Date;
  displayId: string;
  effectiveEndAt: Date | null;
  endedAt: Date | null;
  id: string;
  revenueSharePercent: number;
  status: ContractStatus;
  story: {
    id: string;
    slug: string;
    title: string;
  };
  updatedAt: Date;
};

type MatchedEarningRecord = {
  chapterId: string | null;
  chapterSlug: string | null;
  chapterTitle: string;
  contractDisplayId: string;
  contractId: string;
  contractType: ContractExclusivity;
  creatorEarningsCents: number;
  grossSalesCents: number;
  id: string;
  occurredAt: Date;
  revenueSharePercent: number;
  storyId: string;
  storySlug: string;
  storyTitle: string;
};

@Injectable()
export class CreatorFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getCreatorFinanceOverview(userId: string) {
    const creator = await this.getCreatorUser(userId);
    const contractWindows = await this.getCreatorContractWindows(userId);
    const matchedEarnings = await this.getMatchedContractEarnings(contractWindows);
    const creatorPayouts = await this.prisma.creatorPayout.findMany({
      where: {
        creatorUserId: userId,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    const withdrawalPayouts = creatorPayouts.filter((payout) =>
      isCreatorWithdrawalPeriodLabel(payout.periodLabel),
    );
    const releasedPayoutCents = withdrawalPayouts
      .filter((payout) => payout.status === CreatorPayoutStatus.RELEASED)
      .reduce((sum, payout) => sum + payout.amountCents, 0);
    const pendingPayoutCents = withdrawalPayouts
      .filter(
        (payout) =>
          payout.status === CreatorPayoutStatus.PENDING ||
          payout.status === CreatorPayoutStatus.IN_REVIEW,
      )
      .reduce((sum, payout) => sum + payout.amountCents, 0);
    const totalEarnedCents = matchedEarnings.reduce(
      (sum, earning) => sum + earning.creatorEarningsCents,
      0,
    );
    const totalGrossSalesCents = matchedEarnings.reduce(
      (sum, earning) => sum + earning.grossSalesCents,
      0,
    );
    const availableCents = Math.max(
      0,
      totalEarnedCents - releasedPayoutCents - pendingPayoutCents,
    );
    const lastReleasedPayout =
      withdrawalPayouts.find(
        (payout) => payout.status === CreatorPayoutStatus.RELEASED,
      ) ?? null;
    const activeContracts = contractWindows.filter(
      (contract) =>
        contract.status === ContractStatus.ACTIVE &&
        (!contract.effectiveEndAt || contract.effectiveEndAt > new Date()),
    );

    return {
      contracts: {
        activeCount: activeContracts.length,
        canEarnFromChapterSales: activeContracts.length > 0,
        hasAnyEligibleContract: contractWindows.length > 0,
        items: contractWindows.map((contract) => ({
          activatedAt: contract.activatedAt.toISOString(),
          contractId: contract.displayId,
          contractType: contract.contractType,
          contractTypeLabel: this.mapContractTypeLabel(contract.contractType),
          effectiveEndAt: contract.effectiveEndAt?.toISOString() ?? null,
          endedAt: contract.endedAt?.toISOString() ?? null,
          id: contract.id,
          revenueSharePercent: contract.revenueSharePercent,
          status: contract.status,
          statusLabel: this.mapContractStatusLabel(contract.status),
          story: contract.story,
          updatedAt: contract.updatedAt.toISOString(),
        })),
        message: this.buildContractSummaryMessage({
          activeContractCount: activeContracts.length,
          contractCount: contractWindows.length,
          hasAvailableBalance: availableCents > 0,
        }),
      },
      creator: {
        displayName:
          creator.profile?.displayName ?? creator.email.split("@")[0] ?? "Creator",
        email: creator.email,
        id: creator.id,
      },
      recentTransactions: this.buildRecentTransactions(
        matchedEarnings,
        withdrawalPayouts,
      ),
      revenueSeries: this.buildRevenueSeries(matchedEarnings, 30),
      storyEarnings: this.buildStoryEarnings(contractWindows, matchedEarnings),
      summary: {
        availableCents,
        availableFormatted: this.formatCurrency(availableCents),
        lastReleasedPayoutAt:
          lastReleasedPayout?.updatedAt.toISOString() ?? null,
        lastReleasedPayoutCents: lastReleasedPayout?.amountCents ?? 0,
        lastReleasedPayoutFormatted: lastReleasedPayout
          ? this.formatCurrency(lastReleasedPayout.amountCents)
          : this.formatCurrency(0),
        pendingPayoutCents,
        pendingPayoutFormatted: this.formatCurrency(pendingPayoutCents),
        releasedPayoutCents,
        releasedPayoutFormatted: this.formatCurrency(releasedPayoutCents),
        totalEarnedCents,
        totalEarnedFormatted: this.formatCurrency(totalEarnedCents),
        totalGrossSalesCents,
        totalGrossSalesFormatted: this.formatCurrency(totalGrossSalesCents),
      },
      withdrawal: {
        canRequest:
          availableCents >= creatorMinimumWithdrawalCents &&
          contractWindows.length > 0,
        minimumCents: creatorMinimumWithdrawalCents,
        minimumFormatted: this.formatCurrency(creatorMinimumWithdrawalCents),
        openRequestCount: withdrawalPayouts.filter((payout) =>
          payout.status === CreatorPayoutStatus.PENDING ||
          payout.status === CreatorPayoutStatus.IN_REVIEW,
        ).length,
        requests: withdrawalPayouts.map((payout) => ({
          amountCents: payout.amountCents,
          amountFormatted: this.formatCurrency(payout.amountCents),
          createdAt: payout.createdAt.toISOString(),
          id: payout.id,
          label: payout.periodLabel,
          status: payout.status,
          statusLabel: this.mapPayoutStatusLabel(payout.status),
          updatedAt: payout.updatedAt.toISOString(),
        })),
      },
    };
  }

  async createWithdrawalRequest(
    userId: string,
    input: CreatorWithdrawalRequestInput,
  ) {
    const creator = await this.getCreatorUser(userId);
    const finance = await this.getCreatorFinanceOverview(userId);

    if (!finance.contracts.hasAnyEligibleContract) {
      throw new BadRequestException(
        "No contract-backed chapter earnings are available for withdrawal.",
      );
    }

    if (input.amountCents < creatorMinimumWithdrawalCents) {
      throw new BadRequestException(
        `Withdrawal requests must be at least ${finance.withdrawal.minimumFormatted}.`,
      );
    }

    if (finance.withdrawal.openRequestCount > 0) {
      throw new BadRequestException(
        "You already have a payout request under review.",
      );
    }

    if (input.amountCents > finance.summary.availableCents) {
      throw new BadRequestException(
        "Withdrawal amount exceeds your available contract-backed balance.",
      );
    }

    const label = `${creatorWithdrawalPeriodPrefix} · ${new Intl.DateTimeFormat(
      "en-US",
      {
        day: "2-digit",
        month: "short",
        year: "numeric",
      },
    ).format(new Date())}`;

    await this.prisma.creatorPayout.create({
      data: {
        amountCents: input.amountCents,
        creatorUserId: creator.id,
        periodLabel: label,
        status: CreatorPayoutStatus.PENDING,
      },
    });

    return {
      finance: await this.getCreatorFinanceOverview(userId),
      message: "Withdrawal request submitted for finance review.",
    };
  }

  private async getCreatorUser(userId: string) {
    const creator = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      include: {
        profile: true,
      },
    });

    if (!creator || creator.status !== "ACTIVE") {
      throw new UnauthorizedException("The current user account is unavailable.");
    }

    if (!["CREATOR", "ADMIN"].includes(creator.role)) {
      throw new ForbiddenException("Creator access is required.");
    }

    return creator;
  }

  private async getCreatorContractWindows(userId: string) {
    const contracts = await this.prisma.contract.findMany({
      where: {
        activatedAt: {
          not: null,
        },
        status: {
          in: [
            ContractStatus.ACTIVE,
            ContractStatus.EXPIRED,
            ContractStatus.TERMINATED,
          ],
        },
        userId,
      },
      include: {
        story: {
          select: {
            id: true,
            slug: true,
            title: true,
          },
        },
      },
      orderBy: [
        {
          storyId: "asc",
        },
        {
          activatedAt: "asc",
        },
        {
          createdAt: "asc",
        },
      ],
    });

    const windows: ContractWindowRecord[] = [];
    const contractsByStoryId = new Map<
      string,
      typeof contracts
    >();

    contracts.forEach((contract) => {
      const list = contractsByStoryId.get(contract.storyId) ?? [];
      list.push(contract);
      contractsByStoryId.set(contract.storyId, list);
    });

    contractsByStoryId.forEach((storyContracts) => {
      storyContracts.forEach((contract, index) => {
        const nextContract = storyContracts[index + 1] ?? null;
        const nextStart = nextContract?.activatedAt ?? null;
        const effectiveEndAt = this.resolveContractWindowEnd(
          contract.endedAt,
          nextStart,
        );

        windows.push({
          activatedAt: contract.activatedAt!,
          contractType: contract.contractType,
          createdAt: contract.createdAt,
          displayId: contract.displayId,
          effectiveEndAt,
          endedAt: contract.endedAt,
          id: contract.id,
          revenueSharePercent: contract.revenueSharePercent,
          status: contract.status,
          story: contract.story,
          updatedAt: contract.updatedAt,
        });
      });
    });

    return windows.sort(
      (left, right) => right.activatedAt.getTime() - left.activatedAt.getTime(),
    );
  }

  private resolveContractWindowEnd(
    endedAt: Date | null,
    nextActivatedAt: Date | null,
  ) {
    if (endedAt && nextActivatedAt) {
      return endedAt.getTime() <= nextActivatedAt.getTime()
        ? endedAt
        : nextActivatedAt;
    }

    return endedAt ?? nextActivatedAt ?? null;
  }

  private async getMatchedContractEarnings(contractWindows: ContractWindowRecord[]) {
    const storyIds = Array.from(
      new Set(contractWindows.map((contract) => contract.story.id)),
    );

    if (storyIds.length === 0) {
      return [] as MatchedEarningRecord[];
    }

    const earliestContractStart = contractWindows.reduce((earliest, contract) => {
      if (!earliest) {
        return contract.activatedAt;
      }

      return contract.activatedAt.getTime() < earliest.getTime()
        ? contract.activatedAt
        : earliest;
    }, null as Date | null);

    const entries = await this.prisma.walletLedgerEntry.findMany({
      where: {
        createdAt: earliestContractStart
          ? {
              gte: earliestContractStart,
            }
          : undefined,
        entryType: WalletLedgerEntryType.DEBIT,
        reason: WalletLedgerReason.CHAPTER_UNLOCK,
        storyId: {
          in: storyIds,
        },
      },
      include: {
        chapter: {
          select: {
            id: true,
            slug: true,
            title: true,
          },
        },
        story: {
          select: {
            id: true,
            slug: true,
            title: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const contractsByStoryId = contractWindows.reduce((map, contract) => {
      const list = map.get(contract.story.id) ?? [];
      list.push(contract);
      map.set(contract.story.id, list);
      return map;
    }, new Map<string, ContractWindowRecord[]>());

    const matched: MatchedEarningRecord[] = [];

    entries.forEach((entry) => {
      if (!entry.storyId) {
        return;
      }

      const storyContracts = contractsByStoryId.get(entry.storyId) ?? [];
      const matchingContract = storyContracts.find((contract) => {
        if (entry.createdAt.getTime() < contract.activatedAt.getTime()) {
          return false;
        }

        if (!contract.effectiveEndAt) {
          return true;
        }

        return entry.createdAt.getTime() <= contract.effectiveEndAt.getTime();
      });

      if (!matchingContract || !entry.story) {
        return;
      }

      const grossSalesCents = Math.abs(entry.deltaCoins) * 100;
      const creatorEarningsCents = Math.round(
        (grossSalesCents * matchingContract.revenueSharePercent) / 100,
      );

      matched.push({
        chapterId: entry.chapter?.id ?? null,
        chapterSlug: entry.chapter?.slug ?? null,
        chapterTitle: entry.chapter?.title ?? "Premium chapter unlock",
        contractDisplayId: matchingContract.displayId,
        contractId: matchingContract.id,
        contractType: matchingContract.contractType,
        creatorEarningsCents,
        grossSalesCents,
        id: entry.id,
        occurredAt: entry.createdAt,
        revenueSharePercent: matchingContract.revenueSharePercent,
        storyId: entry.story.id,
        storySlug: entry.story.slug,
        storyTitle: entry.story.title,
      });
    });

    return matched;
  }

  private buildStoryEarnings(
    contractWindows: ContractWindowRecord[],
    matchedEarnings: MatchedEarningRecord[],
  ) {
    const earningsByStoryId = matchedEarnings.reduce((map, earning) => {
      const existing = map.get(earning.storyId) ?? {
        creatorEarningsCents: 0,
        grossSalesCents: 0,
        lastSaleAt: null as Date | null,
        storyId: earning.storyId,
        storySlug: earning.storySlug,
        storyTitle: earning.storyTitle,
        unlockCount: 0,
      };

      existing.creatorEarningsCents += earning.creatorEarningsCents;
      existing.grossSalesCents += earning.grossSalesCents;
      existing.unlockCount += 1;
      existing.lastSaleAt =
        !existing.lastSaleAt || earning.occurredAt.getTime() > existing.lastSaleAt.getTime()
          ? earning.occurredAt
          : existing.lastSaleAt;

      map.set(earning.storyId, existing);
      return map;
    }, new Map<string, {
      creatorEarningsCents: number;
      grossSalesCents: number;
      lastSaleAt: Date | null;
      storyId: string;
      storySlug: string;
      storyTitle: string;
      unlockCount: number;
    }>());

    return contractWindows
      .map((contract) => {
        const storyEarnings = earningsByStoryId.get(contract.story.id) ?? null;

        return {
          contractId: contract.displayId,
          contractType: contract.contractType,
          contractTypeLabel: this.mapContractTypeLabel(contract.contractType),
          creatorEarningsCents: storyEarnings?.creatorEarningsCents ?? 0,
          creatorEarningsFormatted: this.formatCurrency(
            storyEarnings?.creatorEarningsCents ?? 0,
          ),
          grossSalesCents: storyEarnings?.grossSalesCents ?? 0,
          grossSalesFormatted: this.formatCurrency(
            storyEarnings?.grossSalesCents ?? 0,
          ),
          lastSaleAt: storyEarnings?.lastSaleAt?.toISOString() ?? null,
          revenueSharePercent: contract.revenueSharePercent,
          status: contract.status,
          statusLabel: this.mapContractStatusLabel(contract.status),
          story: contract.story,
          unlockCount: storyEarnings?.unlockCount ?? 0,
        };
      })
      .sort(
        (left, right) => right.creatorEarningsCents - left.creatorEarningsCents,
      );
  }

  private buildRevenueSeries(matchedEarnings: MatchedEarningRecord[], days: number) {
    const today = new Date();
    const end = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const dateMap = new Map<
      string,
      { creatorEarningsCents: number; grossSalesCents: number; label: string }
    >();

    for (let index = days - 1; index >= 0; index -= 1) {
      const value = new Date(end);
      value.setUTCDate(value.getUTCDate() - index);
      const key = value.toISOString().slice(0, 10);

      dateMap.set(key, {
        creatorEarningsCents: 0,
        grossSalesCents: 0,
        label: new Intl.DateTimeFormat("en-US", {
          day: "numeric",
          month: "short",
        }).format(value),
      });
    }

    matchedEarnings.forEach((earning) => {
      const key = earning.occurredAt.toISOString().slice(0, 10);
      const item = dateMap.get(key);

      if (!item) {
        return;
      }

      item.creatorEarningsCents += earning.creatorEarningsCents;
      item.grossSalesCents += earning.grossSalesCents;
    });

    return Array.from(dateMap.values()).map((item) => ({
      creatorEarningsCents: item.creatorEarningsCents,
      creatorEarningsFormatted: this.formatCurrency(item.creatorEarningsCents),
      grossSalesCents: item.grossSalesCents,
      grossSalesFormatted: this.formatCurrency(item.grossSalesCents),
      label: item.label,
    }));
  }

  private buildRecentTransactions(
    matchedEarnings: MatchedEarningRecord[],
    withdrawalPayouts: {
      amountCents: number;
      createdAt: Date;
      id: string;
      periodLabel: string;
      status: CreatorPayoutStatus;
      updatedAt: Date;
    }[],
  ) {
    return [
      ...matchedEarnings.map((earning) => ({
        amountCents: earning.creatorEarningsCents,
        amountFormatted: this.formatCurrency(earning.creatorEarningsCents),
        date: earning.occurredAt.toISOString(),
        description: `${earning.chapterTitle} unlock on ${earning.storyTitle}`,
        direction: "INBOUND",
        id: `earning-${earning.id}`,
        kind: "CHAPTER_UNLOCK",
        metadata: {
          contractId: earning.contractDisplayId,
          grossSalesFormatted: this.formatCurrency(earning.grossSalesCents),
          revenueSharePercent: earning.revenueSharePercent,
          storySlug: earning.storySlug,
        },
        status: "EARNED",
        statusLabel: "Earned",
      })),
      ...withdrawalPayouts.map((payout) => ({
        amountCents: payout.amountCents,
        amountFormatted: this.formatCurrency(payout.amountCents),
        date: payout.updatedAt.toISOString(),
        description: payout.periodLabel,
        direction: "OUTBOUND",
        id: `payout-${payout.id}`,
        kind: "WITHDRAWAL",
        metadata: null,
        status: payout.status,
        statusLabel: this.mapPayoutStatusLabel(payout.status),
      })),
    ]
      .sort(
        (left, right) =>
          new Date(right.date).getTime() - new Date(left.date).getTime(),
      )
      .slice(0, 12);
  }

  private buildContractSummaryMessage(input: {
    activeContractCount: number;
    contractCount: number;
    hasAvailableBalance: boolean;
  }) {
    if (input.activeContractCount > 0) {
      return `${input.activeContractCount} active contract${
        input.activeContractCount === 1 ? "" : "s"
      } are currently sharing chapter revenue to this creator balance.`;
    }

    if (input.contractCount > 0 && input.hasAvailableBalance) {
      return "This balance comes from past contract-backed chapter sales and is still withdrawable.";
    }

    if (input.contractCount > 0) {
      return "Contracts exist, but no eligible chapter-purchase earnings have cleared yet.";
    }

    return "No contract-backed stories are active yet. Chapter purchases will only accrue earnings after a story contract is activated.";
  }

  private mapContractStatusLabel(status: ContractStatus) {
    if (status === ContractStatus.PENDING_SIGNATURE) {
      return "Pending Signature";
    }

    return `${status.charAt(0)}${status.slice(1).toLowerCase()}`;
  }

  private mapContractTypeLabel(contractType: ContractExclusivity) {
    return contractType === ContractExclusivity.EXCLUSIVE
      ? "Exclusive"
      : "Non-Exclusive";
  }

  private mapPayoutStatusLabel(status: CreatorPayoutStatus) {
    if (status === CreatorPayoutStatus.IN_REVIEW) {
      return "In Review";
    }

    return `${status.charAt(0)}${status.slice(1).toLowerCase()}`;
  }

  async getTaxForm(userId: string) {
    const taxForm = await this.prisma.taxForm.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    if (!taxForm) {
      return { taxForm: null };
    }

    return {
      taxForm: {
        id: taxForm.id,
        formType: taxForm.formType,
        status: taxForm.status,
        submittedAt: taxForm.submittedAt?.toISOString() ?? null,
        reviewedAt: taxForm.reviewedAt?.toISOString() ?? null,
      },
    };
  }

  async submitTaxForm(
    userId: string,
    input: { formType: string; formData: object },
  ) {
    if (input.formType !== "W9" && input.formType !== "W8BEN") {
      throw new BadRequestException("formType must be W9 or W8BEN.");
    }

    const existingPending = await this.prisma.taxForm.findFirst({
      where: { userId, status: "PENDING" },
    });

    if (existingPending) {
      throw new ConflictException(
        "You already have a pending tax form. Please wait for it to be reviewed.",
      );
    }

    const taxForm = await this.prisma.taxForm.create({
      data: {
        userId,
        formType: input.formType,
        formData: input.formData,
        status: "PENDING",
        submittedAt: new Date(),
      },
    });

    return {
      message: "Tax form submitted for review.",
      taxForm: {
        id: taxForm.id,
        formType: taxForm.formType,
        status: taxForm.status,
      },
    };
  }

  private formatCurrency(valueCents: number) {
    return new Intl.NumberFormat("en-US", {
      currency: "USD",
      style: "currency",
    }).format(valueCents / 100);
  }
}
