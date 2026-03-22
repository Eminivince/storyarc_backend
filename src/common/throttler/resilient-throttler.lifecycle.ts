import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { resilientThrottlerStorage } from "./throttler-resilient.instance";

@Injectable()
export class ResilientThrottlerLifecycle implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await resilientThrottlerStorage.initializeRedis();
  }

  onModuleDestroy() {
    resilientThrottlerStorage.destroy();
  }
}
