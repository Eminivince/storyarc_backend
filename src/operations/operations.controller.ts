import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AccessTokenGuard } from "../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../common/types/request-with-auth.type";
import {
  parseAdminContractBody,
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
} from "./operations.schemas";
import { OperationsService } from "./operations.service";

@Controller()
@UseGuards(AccessTokenGuard)
export class OperationsController {
  constructor(private readonly operationsService: OperationsService) {}

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
  async getAdminBooks(@Req() request: AuthenticatedRequest) {
    return this.operationsService.listAdminBooks(request.auth!.userId);
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
  async getAdminUsers(@Req() request: AuthenticatedRequest) {
    return this.operationsService.listAdminUsers(request.auth!.userId);
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
  async getAdminReports(@Req() request: AuthenticatedRequest) {
    return this.operationsService.listAdminReports(request.auth!.userId);
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
}
