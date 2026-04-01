import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

const ADMIN_ROLES = new Set(["ADMIN", "MODERATOR"]);

/**
 * Guard-level check that the user has an admin-capable role.
 * ADMIN and MODERATOR users pass — granular permission checks
 * are handled by PermissionGuard downstream.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const role = request.auth?.role;

    if (!role || !ADMIN_ROLES.has(role)) {
      throw new ForbiddenException("Admin access is required.");
    }

    return true;
  }
}
