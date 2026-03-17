import { INestApplication, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const directUrl = process.env.DIRECT_URL?.trim() || "";
    const pooledUrl = process.env.DATABASE_URL?.trim() || "";
    const url = directUrl || pooledUrl;

    if (!url) {
      throw new Error("DIRECT_URL or DATABASE_URL must be set for PrismaService.");
    }

    super({
      datasources: {
        db: {
          url,
        },
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
    console.log("====== DB Connected ======");
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  enableShutdownHooks(app: INestApplication) {
    process.once("beforeExit", async () => {
      await app.close();
    });
  }
}
