import { UserStatus } from "@prisma/client";

export const SESSION_CACHE_PREFIX = "auth:session:";

export type CachedSessionLookup = {
  accessTokenExpiresAt: string;
  revokedAt: string | null;
  userId: string;
  userStatus: UserStatus;
};

export function buildSessionCacheKey(sessionId: string) {
  return `${SESSION_CACHE_PREFIX}${sessionId}`;
}

export function getSessionCacheTtlSeconds(accessTokenExpiresAt: Date) {
  const ttlSeconds = Math.floor(
    (accessTokenExpiresAt.getTime() - Date.now()) / 1000,
  );

  return ttlSeconds > 0 ? ttlSeconds : null;
}
