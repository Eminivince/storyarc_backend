import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { throttleReport } from "../common/throttler/throttler.constants";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseAdminCommentModerationBody,
  parseAdminContractBody,
  parseAdminHelpCenterArticleBody,
  parseAdminHelpCenterCategoryBody,
  parseAdminReviewModerationBody,
  parseAdminSettingValueBody,
  parseAdminUserStatusBody,
  parseAdminBookConfigBody,
  parseAdminBookPolicyBody,
  parseAdminBookVisibilityBody,
  parseContractTemplateBody,
  parseCreateContentReportBody,
  parseCreateSupportTicketBody,
  parseResolveReportBody,
  parseSupportMessageBody,
  parseUpdateAdminUserBody,
  parseAdminListLimitQuery,
  parseAdminListOffsetQuery,
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

  @Get("admin/dashboard")
  async getAdminOverview(@Req() request: AuthenticatedRequest) {
    return this.operationsService.getAdminOverview(request.auth!.userId);
  }

  @Get("admin/books")
  async getAdminBooks(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.listAdminBooks(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Get("admin/books/:bookSlug")
  async getAdminBook(
    @Param("bookSlug") bookSlug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.getAdminBookDetails(
      request.auth!.userId,
      bookSlug,
    );
  }

  @Patch("admin/books/policy")
  async updateAdminBookPolicy(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.updateAdminBookPolicy(
      request.auth!.userId,
      parseAdminBookPolicyBody(body),
    );
  }

  @Patch("admin/books/:bookSlug/visibility")
  async updateAdminBookVisibility(
    @Param("bookSlug") bookSlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.updateAdminBookVisibility(
      request.auth!.userId,
      bookSlug,
      parseAdminBookVisibilityBody(body),
    );
  }

  @Put("admin/books/:bookSlug/config")
  async updateAdminBookConfig(
    @Param("bookSlug") bookSlug: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.updateAdminBookConfig(
      request.auth!.userId,
      bookSlug,
      parseAdminBookConfigBody(body),
    );
  }

  @Get("admin/contracts/lookups")
  async getAdminContractLookups(@Req() request: AuthenticatedRequest) {
    return this.operationsService.getAdminContractLookups(request.auth!.userId);
  }

  @Get("admin/contracts/templates")
  async getAdminContractTemplates(@Req() request: AuthenticatedRequest) {
    return this.operationsService.listAdminContractTemplates(
      request.auth!.userId,
    );
  }

  @Get("admin/contracts/templates/:templateId")
  async getAdminContractTemplate(
    @Param("templateId") templateId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.getAdminContractTemplate(
      request.auth!.userId,
      templateId,
    );
  }

  @Post("admin/contracts/templates")
  async createAdminContractTemplate(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.createAdminContractTemplate(
      request.auth!.userId,
      parseContractTemplateBody(body),
    );
  }

  @Put("admin/contracts/templates/:templateId")
  async updateAdminContractTemplate(
    @Param("templateId") templateId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.updateAdminContractTemplate(
      request.auth!.userId,
      templateId,
      parseContractTemplateBody(body),
    );
  }

  @Get("admin/contracts")
  async getAdminContracts(@Req() request: AuthenticatedRequest) {
    return this.operationsService.listAdminContracts(request.auth!.userId);
  }

  @Get("admin/contracts/:contractId")
  async getAdminContract(
    @Param("contractId") contractId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.getAdminContract(
      request.auth!.userId,
      contractId,
    );
  }

  @Post("admin/contracts")
  async createAdminContract(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.createAdminContract(
      request.auth!.userId,
      parseAdminContractBody(body),
    );
  }

  @Put("admin/contracts/:contractId")
  async updateAdminContract(
    @Param("contractId") contractId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.updateAdminContract(
      request.auth!.userId,
      contractId,
      parseAdminContractBody(body),
    );
  }

  @Get("admin/users")
  async getAdminUsers(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.listAdminUsers(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Get("admin/users/:userId")
  async getAdminUser(
    @Param("userId") userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.getAdminUserDetails(
      request.auth!.userId,
      userId,
    );
  }

  @Put("admin/users/:userId")
  async updateAdminUser(
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.updateAdminUser(
      request.auth!.userId,
      userId,
      parseUpdateAdminUserBody(body),
    );
  }

  @Patch("admin/users/:userId/status")
  async updateAdminUserStatus(
    @Param("userId") userId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parseAdminUserStatusBody(body);

    return this.operationsService.updateAdminUserStatus(
      request.auth!.userId,
      userId,
      input.action,
    );
  }

  @Post("admin/users/:userId/reset-password")
  async resetAdminUserPassword(
    @Param("userId") userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.resetAdminUserPassword(
      request.auth!.userId,
      userId,
    );
  }

  @Get("admin/reports")
  async getAdminReports(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.listAdminReports(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Patch("admin/reports/:reportId")
  async resolveAdminReport(
    @Param("reportId") reportId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.resolveAdminReport(
      request.auth!.userId,
      reportId,
      parseResolveReportBody(body),
    );
  }

  @Get("admin/comments")
  async getAdminComments(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.listAdminComments(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Patch("admin/comments/:commentId")
  async moderateAdminComment(
    @Param("commentId") commentId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.moderateAdminComment(
      request.auth!.userId,
      commentId,
      parseAdminCommentModerationBody(body),
    );
  }

  @Get("admin/reviews")
  async getAdminReviews(
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.listAdminReviews(request.auth!.userId, {
      limit: parseAdminListLimitQuery(limit),
      offset: parseAdminListOffsetQuery(offset),
    });
  }

  @Patch("admin/reviews/:reviewId")
  async moderateAdminReview(
    @Param("reviewId") reviewId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.moderateAdminReview(
      request.auth!.userId,
      reviewId,
      parseAdminReviewModerationBody(body),
    );
  }

  @Get("admin/monetization")
  async getAdminMonetization(@Req() request: AuthenticatedRequest) {
    return this.operationsService.getAdminMonetization(request.auth!.userId);
  }

  @Post("admin/payouts/:payoutId/release")
  async releasePayout(
    @Param("payoutId") payoutId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.updatePayoutStatus(
      request.auth!.userId,
      payoutId,
      "RELEASE",
    );
  }

  @Post("admin/payouts/:payoutId/review")
  async reviewPayout(
    @Param("payoutId") payoutId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.updatePayoutStatus(
      request.auth!.userId,
      payoutId,
      "REVIEW",
    );
  }

  @Get("admin/settings")
  async getAdminSettings(@Req() request: AuthenticatedRequest) {
    return this.operationsService.getAdminSettings(request.auth!.userId);
  }

  @Post("admin/settings/:settingKey/toggle")
  async toggleAdminSetting(
    @Param("settingKey") settingKey: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.toggleAdminSetting(
      request.auth!.userId,
      settingKey,
    );
  }

  @Put("admin/settings/:settingKey")
  async updateAdminSettingValue(
    @Param("settingKey") settingKey: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.updateAdminSettingValue(
      request.auth!.userId,
      settingKey,
      parseAdminSettingValueBody(body),
    );
  }

  @Post("admin/maintenance/:actionId")
  async runMaintenanceAction(
    @Param("actionId") actionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.runMaintenanceAction(
      request.auth!.userId,
      actionId,
    );
  }

  @Get("admin/activity")
  async getAdminActivity(@Req() request: AuthenticatedRequest) {
    return this.operationsService.getAdminActivity(request.auth!.userId);
  }

  @Get("admin/messages")
  async getAdminMessages(@Req() request: AuthenticatedRequest) {
    return this.operationsService.getAdminMessages(request.auth!.userId);
  }

  @Post("admin/messages/:ticketId/reply")
  async replyToSupportTicket(
    @Param("ticketId") ticketId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.replyToSupportTicket(
      request.auth!.userId,
      ticketId,
      parseSupportMessageBody(body).body,
    );
  }

  // --- Admin Refunds ---

  @Get("admin/refunds")
  async listAdminRefunds(@Req() request: AuthenticatedRequest) {
    return this.operationsService.listAdminRefunds(request.auth!.userId);
  }

  @Patch("admin/refunds/:refundId")
  async resolveAdminRefund(
    @Param("refundId") refundId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const action = record.action as string;
    const notes = (record.notes as string) ?? null;
    return this.operationsService.resolveAdminRefund(
      request.auth!.userId,
      refundId,
      action,
      notes,
    );
  }

  // --- Admin Payouts ---

  @Patch("admin/payouts/:payoutId/status")
  async updatePayoutStatus(
    @Param("payoutId") payoutId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const action = record.action as string;
    const notes = (record.notes as string) ?? null;
    return this.operationsService.updatePayoutStatus(
      request.auth!.userId,
      payoutId,
      action,
      notes,
    );
  }

  // --- Admin Tax Forms ---

  @Get("admin/tax-forms")
  async listAdminTaxForms(@Req() request: AuthenticatedRequest) {
    return this.operationsService.listAdminTaxForms(request.auth!.userId);
  }

  @Patch("admin/tax-forms/:taxFormId")
  async reviewAdminTaxForm(
    @Param("taxFormId") taxFormId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const status = record.status as string;
    const notes = (record.notes as string) ?? null;
    return this.operationsService.reviewAdminTaxForm(
      request.auth!.userId,
      taxFormId,
      status,
      notes,
    );
  }

  // --- Admin Help Center ---

  @Get("admin/help-center")
  async getAdminHelpCenter(@Req() request: AuthenticatedRequest) {
    return this.operationsService.getAdminHelpCenter(request.auth!.userId);
  }

  @Post("admin/help-center/categories")
  async createHelpCenterCategory(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.createHelpCenterCategory(
      request.auth!.userId,
      parseAdminHelpCenterCategoryBody(body),
    );
  }

  @Post("admin/help-center/articles")
  async createHelpCenterArticle(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.createHelpCenterArticle(
      request.auth!.userId,
      parseAdminHelpCenterArticleBody(body),
    );
  }

  @Delete("admin/help-center/articles/:articleId")
  async deleteHelpCenterArticle(
    @Param("articleId") articleId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.operationsService.deleteHelpCenterArticle(
      request.auth!.userId,
      articleId,
    );
  }
}
