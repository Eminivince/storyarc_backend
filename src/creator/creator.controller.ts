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
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseCreatorApplicationDraftBody,
  parseCreatorApplicationStatusQuery,
  parseReviewCreatorApplicationBody,
  parseSubmitCreatorApplicationBody,
} from "./creator.schemas";
import { CreatorService } from "./creator.service";

function assertAdminRole(request: AuthenticatedRequest) {
  if (request.auth?.role !== "ADMIN") {
    throw new ForbiddenException("Admin access is required.");
  }
}

@Controller("creator")
@UseGuards(AccessTokenGuard)
export class CreatorController {
  constructor(private readonly creatorService: CreatorService) {}

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
