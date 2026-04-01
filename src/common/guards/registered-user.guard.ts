import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { RedisService } from "../../redis/redis.service";
import { PrismaService } from "../../database/prisma.service";
import { AuthenticatedRequest } from "../types/request-with-auth.type";
import {
  buildSessionCacheKey,
  CachedSessionLookup,
} from "../../auth/session-cache";

/**
 * Guard that blocks guest accounts from accessing endpoints that require
 * a registered (non-guest) user. Must be used AFTER AccessTokenGuard.
 *
 * Checks the session cache first (O(1) Redis lookup), falls back to DB.
 */
@Injectable()
export class RegisteredUserGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.auth?.sessionId) {
      throw new ForbiddenException("Authentication required.");
    }

    // Check session cache first (populated by AccessTokenGuard)
    const cacheKey = buildSessionCacheKey(request.auth.sessionId);
    const cached = await this.redis.getJson<CachedSessionLookup>(cacheKey);

    if (cached) {
      if (cached.isGuest) {
        throw new ForbiddenException(
          "Please create an account to access this feature.",
        );
      }
      return true;
    }

    // Fallback: check database
    const user = await this.prisma.user.findUnique({
      where: { id: request.auth.userId },
      select: { isGuest: true },
    });

    if (user?.isGuest) {
      throw new ForbiddenException(
        "Please create an account to access this feature.",
      );
    }

    return true;
  }
}
