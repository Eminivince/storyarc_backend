import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getHealth() {
    const timestamp = new Date().toISOString();
    let databaseStatus = "unknown";
    let redisStatus = "unknown";

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      databaseStatus = "up";
      await this.redis.ping();
      redisStatus = this.redis.isUsingFallback() ? "degraded" : "up";

      return {
        status: this.redis.isUsingFallback() ? "degraded" : "ok",
        timestamp,
        services: {
          database: databaseStatus,
          redis: redisStatus,
        },
      };
    } catch (error) {
      return {
        status: "degraded",
        timestamp,
        services: {
          database: databaseStatus,
          redis: redisStatus,
        },
        error: error instanceof Error ? error.message : "Unknown health check error",
      };
    }
  }
}
