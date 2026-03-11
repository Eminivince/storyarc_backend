import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { HealthService } from "./health.service";

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
