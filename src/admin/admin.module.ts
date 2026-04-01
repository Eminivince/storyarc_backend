import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AdminAuditService } from "./admin-audit.service";
import { AdminManagementController } from "./admin-management/admin-management.controller";
import { AdminManagementService } from "./admin-management/admin-management.service";
import { PendingActionsController } from "./pending-actions/pending-actions.controller";
import { PendingActionsService } from "./pending-actions/pending-actions.service";
import { AdminRoleSeedService } from "./admin-role-seed.service";
import { AdminBooksController } from "./books/admin-books.controller";
import { AdminBooksService } from "./books/admin-books.service";
import { AdminContractsController } from "./contracts/admin-contracts.controller";
import { AdminContractsService } from "./contracts/admin-contracts.service";
import { AdminDashboardController } from "./dashboard/admin-dashboard.controller";
import { AdminDashboardService } from "./dashboard/admin-dashboard.service";
import { AdminFinanceController } from "./finance/admin-finance.controller";
import { AdminFinanceService } from "./finance/admin-finance.service";
import { AdminHelpCenterController } from "./help-center/admin-help-center.controller";
import { AdminHelpCenterService } from "./help-center/admin-help-center.service";
import { AdminModerationController } from "./moderation/admin-moderation.controller";
import { AdminModerationService } from "./moderation/admin-moderation.service";
import { AdminSettingsController } from "./settings/admin-settings.controller";
import { AdminSettingsService } from "./settings/admin-settings.service";
import { AdminSupportController } from "./support/admin-support.controller";
import { AdminSupportService } from "./support/admin-support.service";
import { AdminUsersController } from "./users/admin-users.controller";
import { AdminUsersService } from "./users/admin-users.service";
import { PermissionGuard } from "./guards/permission.guard";

@Module({
  imports: [AuthModule],
  controllers: [
    AdminBooksController,
    AdminContractsController,
    AdminDashboardController,
    AdminFinanceController,
    AdminHelpCenterController,
    AdminManagementController,
    PendingActionsController,
    AdminModerationController,
    AdminSettingsController,
    AdminSupportController,
    AdminUsersController,
  ],
  providers: [
    AdminAuditService,
    AdminRoleSeedService,
    AdminBooksService,
    AdminContractsService,
    AdminDashboardService,
    AdminFinanceService,
    AdminHelpCenterService,
    AdminManagementService,
    PendingActionsService,
    AdminModerationService,
    AdminSettingsService,
    AdminSupportService,
    AdminUsersService,
    PermissionGuard,
  ],
  exports: [AdminAuditService],
})
export class AdminModule {}
