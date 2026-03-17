import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const LOCK_KEY = "contract-expiration:lock";
const LOCK_TTL_SECONDS = 300; // 5 minutes

@Injectable()
export class ContractExpirationService implements OnModuleInit {
  private readonly logger = new Logger(ContractExpirationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    setInterval(() => {
      this.processExpiredContracts().catch((error) => {
        this.logger.error("Contract expiration check failed", error);
      });
    }, CHECK_INTERVAL_MS);
  }

  private async processExpiredContracts() {
    const lockToken = await this.redis.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);

    if (!lockToken) {
      return;
    }

    try {
      const now = new Date();

      const activeContracts = await this.prisma.contract.findMany({
        where: {
          status: "ACTIVE",
          activatedAt: { not: null },
        },
        include: {
          user: { include: { profile: true } },
        },
      });

      let expiredCount = 0;

      for (const contract of activeContracts) {
        if (!contract.activatedAt) continue;

        const expiryDate = new Date(contract.activatedAt);
        expiryDate.setMonth(expiryDate.getMonth() + contract.termMonths);

        if (expiryDate <= now) {
          await this.prisma.contract.update({
            where: { id: contract.id },
            data: {
              status: "EXPIRED",
              endedAt: now,
            },
          });

          expiredCount++;

          this.logger.log(
            `Contract ${contract.displayId} expired for user ${contract.userId}`,
          );
        }
      }

      if (expiredCount > 0) {
        this.logger.log(
          `Expired ${expiredCount} contract(s) during this check.`,
        );
      }
    } finally {
      await this.redis.releaseLock(LOCK_KEY, lockToken);
    }
  }
}
