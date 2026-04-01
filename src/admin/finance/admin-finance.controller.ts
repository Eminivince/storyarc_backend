import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../../common/guards/access-token.guard";
import { AuthenticatedRequest } from "../../common/types/request-with-auth.type";
import { AdminGuard } from "../guards/admin.guard";
import { PermissionGuard } from "../guards/permission.guard";
import { RequirePermission } from "../decorators/require-permission.decorator";
import { AdminFinanceService } from "./admin-finance.service";

@Controller("admin")
@UseGuards(AccessTokenGuard, AdminGuard, PermissionGuard)
export class AdminFinanceController {
  constructor(private readonly service: AdminFinanceService) {}

  @RequirePermission("finance:dashboard")
  @Get("monetization")
  async getAdminMonetization(@Req() request: AuthenticatedRequest) {
    return this.service.getAdminMonetization(request.auth!.userId);
  }

  @RequirePermission("finance:payouts")
  @Post("payouts/:payoutId/release")
  async releasePayout(@Param("payoutId") payoutId: string, @Req() request: AuthenticatedRequest) {
    return this.service.updatePayoutStatus(request.auth!.userId, payoutId, "RELEASE");
  }

  @RequirePermission("finance:payouts")
  @Post("payouts/:payoutId/review")
  async reviewPayout(@Param("payoutId") payoutId: string, @Req() request: AuthenticatedRequest) {
    return this.service.updatePayoutStatus(request.auth!.userId, payoutId, "REVIEW");
  }

  @RequirePermission("finance:payouts")
  @Patch("payouts/:payoutId/status")
  async updatePayoutStatus(
    @Param("payoutId") payoutId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const action = record.action as string;
    const notes = (record.notes as string) ?? null;
    return this.service.updatePayoutStatus(request.auth!.userId, payoutId, action, notes);
  }

  @RequirePermission("finance:refunds")
  @Get("refunds")
  async listAdminRefunds(@Req() request: AuthenticatedRequest) {
    return this.service.listAdminRefunds(request.auth!.userId);
  }

  @RequirePermission("finance:refunds")
  @Patch("refunds/:refundId")
  async resolveAdminRefund(
    @Param("refundId") refundId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const action = record.action as string;
    const notes = (record.notes as string) ?? null;
    return this.service.resolveAdminRefund(request.auth!.userId, refundId, action, notes);
  }

  @RequirePermission("finance:tax-forms")
  @Get("tax-forms")
  async listAdminTaxForms(@Req() request: AuthenticatedRequest) {
    return this.service.listAdminTaxForms(request.auth!.userId);
  }

  @RequirePermission("finance:tax-forms")
  @Patch("tax-forms/:taxFormId")
  async reviewAdminTaxForm(
    @Param("taxFormId") taxFormId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const record = body as Record<string, unknown>;
    const status = record.status as string;
    const notes = (record.notes as string) ?? null;
    return this.service.reviewAdminTaxForm(request.auth!.userId, taxFormId, status, notes);
  }
}
