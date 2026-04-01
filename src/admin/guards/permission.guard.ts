import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRED_PERMISSION_KEY } from "../decorators/require-permission.decorator";

/**
 * Phase 1: Always returns true — AdminGuard already verified the user is an admin.
 * Phase 2: Will load the user's AdminRole permissions and check against the
 *          @RequirePermission() metadata on the handler.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const _requiredPermission = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Phase 1: passthrough — permission enforcement comes in Phase 2
    return true;
  }
}
