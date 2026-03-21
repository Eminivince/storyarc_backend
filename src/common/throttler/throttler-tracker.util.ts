import type { ExecutionContext } from "@nestjs/common";
import { verify } from "jsonwebtoken";
import { env } from "../../config/env";

type AccessLikePayload = {
  sub?: string;
  type?: string;
};

function getClientIp(req: Record<string, unknown>): string {
  const headers = req.headers as Record<string, unknown> | undefined;
  const forwarded = headers?.["x-forwarded-for"];
  const raw =
    typeof forwarded === "string"
      ? forwarded.split(",")[0]?.trim()
      : Array.isArray(forwarded)
        ? String(forwarded[0] ?? "").trim()
        : "";
  if (raw) {
    return raw;
  }

  const ip = (req as { ip?: string }).ip;
  if (typeof ip === "string" && ip.length > 0) {
    return ip;
  }

  const socket = (req as { raw?: { socket?: { remoteAddress?: string } } }).raw
    ?.socket;
  return socket?.remoteAddress ?? "unknown";
}

/**
 * Prefer authenticated user id (matches prior Fastify keyGenerator: userId ?? ip).
 * Uses verified JWT when `request.auth` is not yet set (global guard runs before route guards).
 */
export function throttlerGetTracker(
  req: Record<string, unknown>,
  _context: ExecutionContext,
): string {
  const authUserId = (req as { auth?: { userId?: string } }).auth?.userId;
  if (authUserId) {
    return `user:${authUserId}`;
  }

  const headers = req.headers as Record<string, unknown> | undefined;
  const authorization = headers?.["authorization"];
  const headerValue = Array.isArray(authorization)
    ? authorization[0]
    : authorization;

  if (typeof headerValue === "string" && headerValue.startsWith("Bearer ")) {
    const token = headerValue.slice(7);
    try {
      const payload = verify(token, env.jwtAccessSecret) as AccessLikePayload;
      if (payload?.type === "access" && typeof payload.sub === "string") {
        return `user:${payload.sub}`;
      }
    } catch {
      // Invalid or expired token — fall back to IP (same bucket as anonymous for that client).
    }
  }

  return `ip:${getClientIp(req)}`;
}
