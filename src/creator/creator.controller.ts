import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { throttleWithdrawal } from "../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseCreatorApplicationDraftBody,
  parseCreatorApplicationStatusQuery,
  parseCreatorWithdrawalRequestBody,
  parseReviewCreatorApplicationBody,
  parseSubmitCreatorApplicationBody,
} from "./creator.schemas";
import { CreatorFinanceService } from "./creator-finance.service";
import { CreatorService } from "./creator.service";

function assertAdminRole(request: AuthenticatedRequest) {
  if (request.auth?.role !== "ADMIN") {
    throw new ForbiddenException("Admin access is required.");
  }
}

function assertCreatorRole(request: AuthenticatedRequest) {
  if (request.auth?.role !== "CREATOR" && request.auth?.role !== "ADMIN") {
    throw new ForbiddenException("Creator access is required.");
  }
}

@Controller("creator")
@UseGuards(AccessTokenGuard)
export class CreatorController {
  constructor(
    private readonly creatorService: CreatorService,
    private readonly creatorFinanceService: CreatorFinanceService,
  ) {}

  @Get("application")
  async getCurrentUserApplication(@Req() request: AuthenticatedRequest) {
    return this.creatorService.getCurrentUserApplication(request.auth!.userId);
  }

  @Put("application/draft")
  async saveDraft(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.creatorService.saveDraft(
      request.auth!.userId,
      parseCreatorApplicationDraftBody(body),
    );
  }

  @Post("application/submit")
  async submitApplication(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.creatorService.submitApplication(
      request.auth!.userId,
      parseSubmitCreatorApplicationBody(body),
    );
  }

  @Get("finance")
  async getCreatorFinance(@Req() request: AuthenticatedRequest) {
    assertCreatorRole(request);

    return this.creatorFinanceService.getCreatorFinanceOverview(
      request.auth!.userId,
    );
  }

  @Throttle(throttleWithdrawal)
  @Post("withdrawals")
  async createWithdrawalRequest(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertCreatorRole(request);

    return this.creatorFinanceService.createWithdrawalRequest(
      request.auth!.userId,
      parseCreatorWithdrawalRequestBody(body),
    );
  }

  @Get("tax-form")
  async getTaxForm(@Req() request: AuthenticatedRequest) {
    assertCreatorRole(request);

    return this.creatorFinanceService.getTaxForm(request.auth!.userId);
  }

  @Post("tax-form")
  async submitTaxForm(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertCreatorRole(request);

    const record = body as Record<string, unknown>;
    return this.creatorFinanceService.submitTaxForm(request.auth!.userId, {
      formType: record.formType as string,
      formData: (record.formData as Record<string, unknown>) ?? {},
    });
  }
}

@Controller("admin/creator-applications")
@UseGuards(AccessTokenGuard)
export class AdminCreatorApplicationsController {
  constructor(private readonly creatorService: CreatorService) {}

  @Get()
  async listApplications(
    @Query("status") status: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertAdminRole(request);

    return this.creatorService.listApplications(
      parseCreatorApplicationStatusQuery(status),
    );
  }

  @Post(":applicationId/approve")
  async approveApplication(
    @Param("applicationId") applicationId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertAdminRole(request);

    return this.creatorService.approveApplication(
      applicationId,
      request.auth!.userId,
      parseReviewCreatorApplicationBody(body),
    );
  }

  @Post(":applicationId/reject")
  async rejectApplication(
    @Param("applicationId") applicationId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    assertAdminRole(request);

    return this.creatorService.rejectApplication(
      applicationId,
      request.auth!.userId,
      parseReviewCreatorApplicationBody(body),
    );
  }
}
