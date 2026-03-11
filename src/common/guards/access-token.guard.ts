import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { env } from "../../config/env";
import { PrismaService } from "../../database/prisma.service";
import { AuthenticatedRequest } from "../types/request-with-auth.type";
import { TokenPayload } from "../../auth/auth.types";

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorizationHeader = request.headers.authorization;

    if (!authorizationHeader || Array.isArray(authorizationHeader)) {
      throw new UnauthorizedException("Missing bearer token.");
    }

    const [scheme, token] = authorizationHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      throw new UnauthorizedException("Invalid authorization header.");
    }

    let payload: TokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<TokenPayload>(token, {
        secret: env.jwtAccessSecret,
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired access token.");
    }

    if (payload.type !== "access") {
      throw new UnauthorizedException("Invalid access token type.");
    }

    const session = await this.prisma.session.findUnique({
      where: {
        id: payload.sessionId,
      },
      include: {
        user: {
          select: {
            status: true,
          },
        },
      },
    });

    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.accessTokenExpiresAt.getTime() <= Date.now() ||
      session.user.status !== "ACTIVE"
    ) {
      throw new UnauthorizedException("Session is no longer active.");
    }

    request.auth = {
      userId: payload.sub,
      sessionId: payload.sessionId,
      role: payload.role,
    };

    return true;
  }
}
