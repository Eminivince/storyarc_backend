import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

const DEFAULT_COMMISSION_RATE = 0.1;
const MIN_WITHDRAWAL_CENTS = 500;

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(private readonly prisma: PrismaService) {}

  async completeReferral(inviteeUserId: string, referralCode: string) {
    const code = await this.prisma.referralCode.findUnique({
      where: { code: referralCode.trim().toUpperCase() },
      include: { user: { select: { id: true } } },
    });

    if (!code) {
      this.logger.warn(`Invalid referral code: ${referralCode}`);
      return;
    }

    if (code.userId === inviteeUserId) {
      this.logger.warn(`User ${inviteeUserId} tried to use own referral code`);
      return;
    }

    const existingEvent = await this.prisma.referralEvent.findFirst({
      where: {
        referralCodeId: code.id,
        inviteeUserId,
      },
    });

    if (existingEvent) {
      return;
    }

    const sharedEvent = await this.prisma.referralEvent.findFirst({
      where: {
        referralCodeId: code.id,
        status: "SHARED",
        inviteeUserId: null,
      },
      orderBy: { createdAt: "desc" },
    });

    if (sharedEvent) {
      await this.prisma.referralEvent.update({
        where: { id: sharedEvent.id },
        data: {
          inviteeUserId,
          status: "SIGNED_UP",
          completedAt: new Date(),
        },
      });
    } else {
      await this.prisma.referralEvent.create({
        data: {
          channel: "referral_code",
          commissionRate: DEFAULT_COMMISSION_RATE,
          inviteeUserId,
          inviterUserId: code.userId,
          referralCodeId: code.id,
          status: "SIGNED_UP",
          completedAt: new Date(),
        },
      });
    }
  }

  async recordReferralCommission(
    inviteeUserId: string,
    purchaseAmountCents: number,
    transactionId: string,
  ) {
    const referralEvent = await this.prisma.referralEvent.findFirst({
      where: {
        inviteeUserId,
        status: { in: ["SIGNED_UP", "COMPLETED"] },
      },
    });

    if (!referralEvent) {
      return;
    }

    const existingEarning = await this.prisma.referralEarning.findFirst({
      where: { sourceTransactionId: transactionId },
    });

    if (existingEarning) {
      return;
    }

    const commissionRate = referralEvent.commissionRate ?? DEFAULT_COMMISSION_RATE;
    const commissionCents = Math.floor(purchaseAmountCents * commissionRate);

    if (commissionCents <= 0) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.referralEarning.create({
        data: {
          commissionCents,
          purchaseAmountCents,
          referralEventId: referralEvent.id,
          referrerUserId: referralEvent.inviterUserId,
          sourceTransactionId: transactionId,
        },
      });

      await tx.user.update({
        where: { id: referralEvent.inviterUserId },
        data: {
          referralEarningBalanceCents: { increment: commissionCents },
        },
      });

      if (referralEvent.status === "SIGNED_UP") {
        await tx.referralEvent.update({
          where: { id: referralEvent.id },
          data: { status: "COMPLETED" },
        });
      }
    });

    this.logger.log(
      `Commission of ${commissionCents} cents recorded for referrer ${referralEvent.inviterUserId} from purchase ${transactionId}`,
    );
  }

  async getReferralDashboard(userId: string) {
    const [user, referralCode, referralEvents, earnings, payouts] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { referralEarningBalanceCents: true },
        }),
        this.prisma.referralCode.findUnique({
          where: { userId },
          select: { code: true },
        }),
        this.prisma.referralEvent.findMany({
          where: { inviterUserId: userId },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            channel: true,
            inviteeEmail: true,
            status: true,
            createdAt: true,
            completedAt: true,
            commissionRate: true,
          },
        }),
        this.prisma.referralEarning.aggregate({
          where: { referrerUserId: userId },
          _sum: { commissionCents: true },
        }),
        this.prisma.referralPayout.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            amountCents: true,
            status: true,
            createdAt: true,
          },
        }),
      ]);

    const totalEarningsCents = earnings._sum.commissionCents ?? 0;
    const totalWithdrawnCents = payouts
      .filter((p) => p.status === "RELEASED")
      .reduce((sum, p) => sum + p.amountCents, 0);

    return {
      referralCode: referralCode?.code ?? "",
      totalEarningsCents,
      availableBalanceCents: user?.referralEarningBalanceCents ?? 0,
      totalWithdrawnCents,
      commissionRate: DEFAULT_COMMISSION_RATE,
      referredUsers: referralEvents.map((event) => ({
        id: event.id,
        name: event.inviteeEmail || `Referral via ${event.channel}`,
        status: event.status.toLowerCase(),
        joinedAt: event.completedAt ?? event.createdAt,
        commissionRate: event.commissionRate ?? DEFAULT_COMMISSION_RATE,
      })),
      withdrawalHistory: payouts.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        status: p.status.toLowerCase(),
        createdAt: p.createdAt,
      })),
    };
  }

  async requestReferralWithdrawal(userId: string, amountCents: number) {
    if (amountCents < MIN_WITHDRAWAL_CENTS) {
      throw new BadRequestException(
        `Minimum withdrawal is $${(MIN_WITHDRAWAL_CENTS / 100).toFixed(2)}.`,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralEarningBalanceCents: true },
    });

    if (!user) {
      throw new NotFoundException("User not found.");
    }

    if (user.referralEarningBalanceCents < amountCents) {
      throw new BadRequestException("Insufficient referral earnings balance.");
    }

    const payout = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          referralEarningBalanceCents: { decrement: amountCents },
        },
      });

      return tx.referralPayout.create({
        data: {
          amountCents,
          userId,
        },
      });
    });

    return {
      message: `Withdrawal request of $${(amountCents / 100).toFixed(2)} submitted.`,
      payoutId: payout.id,
    };
  }

  async getReferralEarnings(userId: string) {
    const earnings = await this.prisma.referralEarning.findMany({
      where: { referrerUserId: userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        purchaseAmountCents: true,
        commissionCents: true,
        createdAt: true,
        sourceTransactionId: true,
      },
    });

    return {
      earnings: earnings.map((e) => ({
        id: e.id,
        purchaseAmountCents: e.purchaseAmountCents,
        commissionCents: e.commissionCents,
        createdAt: e.createdAt,
      })),
    };
  }
}
