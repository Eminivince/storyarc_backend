import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../database/prisma.service";
import { RedisService } from "../../redis/redis.service";
import { REQUIRED_PERMISSION_KEY } from "../decorators/require-permission.decorator";

const ROLE_CACHE_PREFIX = "admin:role:";
const ROLE_CACHE_TTL_SECONDS = 300; // 5 minutes

/**
 * Checks the user's AdminRole permissions against the @RequirePermission() metadata.
 *
 * Flow:
 * 1. If no @RequirePermission on handler → pass (no permission needed)
 * 2. Load user's adminRoleId → load AdminRole permissions (Redis-cached)
 * 3. SUPER_ADMIN bypasses all checks
 * 4. Check if user's permissions include the required permission
 *
 * Users with role=ADMIN but no AdminRole assigned get SUPER_ADMIN treatment
 * for backward compatibility (existing admins keep full access).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No permission declared → pass
    if (!requiredPermission) return true;

    const request = context.switchToHttp().getRequest();
    const userId = request.auth?.userId;
    if (!userId) throw new ForbiddenException("Authentication required.");

    const permissions = await this.getUserPermissions(userId);

    // Attach permissions to request for downstream use
    request.adminPermissions = permissions;

    // SUPER_ADMIN or null (legacy admin without role) → full access
    if (permissions === null) return true;

    if (!permissions.includes(requiredPermission)) {
      throw new ForbiddenException(
        `You do not have the required permission: ${requiredPermission}`,
      );
    }

    return true;
  }

  /**
   * Returns the user's permission array, or null if the user should have full access
   * (SUPER_ADMIN role, or legacy admin without an assigned AdminRole).
   */
  private async getUserPermissions(userId: string): Promise<string[] | null> {
    // Check Redis cache first
    const cacheKey = `${ROLE_CACHE_PREFIX}${userId}`;
    const cached = await this.redis.getJson<{ permissions: string[] | null }>(cacheKey);
    if (cached !== null && cached !== undefined) return cached.permissions;

    // Load from DB
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        adminRoleId: true,
        adminRole: {
          select: {
            name: true,
            permissions: true,
          },
        },
      },
    });

    if (!user) throw new ForbiddenException("User not found.");

    let permissions: string[] | null;

    if (!user.adminRoleId || !user.adminRole) {
      // Legacy admin without assigned role → full access (backward compat)
      permissions = null;
    } else if (user.adminRole.name === "SUPER_ADMIN") {
      // SUPER_ADMIN bypasses all checks
      permissions = null;
    } else {
      permissions = user.adminRole.permissions;
    }

    // Cache for 5 minutes
    await this.redis.setJson(cacheKey, { permissions }, ROLE_CACHE_TTL_SECONDS);

    return permissions;
  }
}
