import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { throttleReport } from "../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseCreateContentReportBody,
  parseCreateSupportTicketBody,
} from "./operations.schemas";
import { OperationsService } from "./operations.service";

@Controller()
@UseGuards(AccessTokenGuard)
export class OperationsController {
  constructor(private readonly operationsService: OperationsService) {}

  @Throttle(throttleReport)
  @Post("reports")
  async createContentReport(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.createContentReport(
      request.auth!.userId,
      parseCreateContentReportBody(body),
    );
  }

  @Get("support/tickets")
  async getSupportTickets(@Req() request: AuthenticatedRequest) {
    return this.operationsService.listSupportTickets(request.auth!.userId);
  }

  @Get("support/help-center")
  async getSupportHelpCenter(@Req() request: AuthenticatedRequest) {
    return this.operationsService.getSupportHelpCenter(request.auth!.userId);
  }

  @Post("support/tickets")
  async createSupportTicket(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.createSupportTicket(
      request.auth!.userId,
      parseCreateSupportTicketBody(body),
    );
  }
}
