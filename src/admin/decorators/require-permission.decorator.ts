import { SetMetadata } from "@nestjs/common";

export const REQUIRED_PERMISSION_KEY = "requiredPermission";

/**
 * Declares the permission required to access an admin endpoint.
 * Phase 1: decorator is placed but PermissionGuard always passes (AdminGuard handles auth).
 * Phase 2: PermissionGuard will check the user's role permissions array.
 */
export const RequirePermission = (permission: string) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);
