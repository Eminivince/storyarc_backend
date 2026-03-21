import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { HealthService } from "./health.service";

@SkipThrottle()
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async getHealth() {
    const result = await this.healthService.getHealth();

    if (result.status !== "ok") {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }
}
