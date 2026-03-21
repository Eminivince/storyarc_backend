import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { env } from "../config/env";
import { RedisService } from "../redis/redis.service";
import { RequestMeta } from "./auth.types";

type FixedWindowRateLimitState = {
  count: number;
  windowStartedAt: number;
};

type LoginFailureState = {
  blockedUntil: number | null;
  failedAttempts: number;
  lastPenaltyAt: number | null;
  penaltyLevel: number;
  windowStartedAt: number;
};

@Injectable()
export class AuthThrottleService {
  constructor(private readonly redis: RedisService) {}

  async assertSignupAllowed(email: string, requestMeta: RequestMeta) {
    await this.assertFixedWindowLimit(
      this.getSignupEmailKey(email),
      env.authSignupRateLimitMax,
      env.authSignupRateLimitWindowSeconds,
    );
    await this.assertFixedWindowLimit(
      this.getSignupRequesterKey(requestMeta),
      env.authSignupRateLimitMax,
      env.authSignupRateLimitWindowSeconds,
    );
  }

  async assertLoginAllowed(email: string, requestMeta: RequestMeta) {
    const state = await this.redis.getJson<LoginFailureState>(
      this.getLoginFailureKey(email, requestMeta),
    );

    if (!state?.blockedUntil || state.blockedUntil <= Date.now()) {
      return;
    }

    throw this.createTooManyRequestsException(
      Math.ceil((state.blockedUntil - Date.now()) / 1000),
    );
  }

  async recordLoginFailure(email: string, requestMeta: RequestMeta) {
    const key = this.getLoginFailureKey(email, requestMeta);
    const now = Date.now();
    const failureWindowMs = env.authLoginFailureWindowSeconds * 1000;
    const penaltyResetMs = env.authLoginFailurePenaltyResetSeconds * 1000;
    const penaltyBackoffs = env.authLoginFailureBackoffSeconds;
    const existingState = await this.redis.getJson<LoginFailureState>(key);

    let nextState: LoginFailureState =
      existingState ?? {
        blockedUntil: null,
        failedAttempts: 0,
        lastPenaltyAt: null,
        penaltyLevel: 0,
        windowStartedAt: now,
      };

    if (
      nextState.lastPenaltyAt &&
      now - nextState.lastPenaltyAt >= penaltyResetMs
    ) {
      nextState = {
        blockedUntil: null,
        failedAttempts: 0,
        lastPenaltyAt: null,
        penaltyLevel: 0,
        windowStartedAt: now,
      };
    }

    if (
      !nextState.windowStartedAt ||
      now - nextState.windowStartedAt >= failureWindowMs
    ) {
      nextState.failedAttempts = 0;
      nextState.windowStartedAt = now;
    }

    nextState.failedAttempts += 1;

    if (nextState.failedAttempts >= env.authLoginFailureThreshold) {
      nextState.failedAttempts = 0;
      nextState.penaltyLevel += 1;
      nextState.lastPenaltyAt = now;

      const backoffSeconds =
        penaltyBackoffs[
          Math.min(nextState.penaltyLevel - 1, penaltyBackoffs.length - 1)
        ];

      nextState.blockedUntil = now + backoffSeconds * 1000;
      nextState.windowStartedAt = now;

      await this.redis.setJson(key, nextState, this.getLoginFailureStateTtlSeconds(nextState));

      throw this.createTooManyRequestsException(backoffSeconds);
    }

    nextState.blockedUntil = null;

    await this.redis.setJson(key, nextState, this.getLoginFailureStateTtlSeconds(nextState));
  }

  async clearLoginFailures(email: string, requestMeta: RequestMeta) {
    await this.redis.delete(this.getLoginFailureKey(email, requestMeta));
  }

  private async assertFixedWindowLimit(
    key: string,
    maxAttempts: number,
    windowSeconds: number,
  ) {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const existingState = await this.redis.getJson<FixedWindowRateLimitState>(key);

    let nextState: FixedWindowRateLimitState;

    if (
      !existingState ||
      now - existingState.windowStartedAt >= windowMs
    ) {
      nextState = {
        count: 1,
        windowStartedAt: now,
      };
    } else {
      nextState = {
        count: existingState.count + 1,
        windowStartedAt: existingState.windowStartedAt,
      };
    }

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((nextState.windowStartedAt + windowMs - now) / 1000),
    );

    await this.redis.setJson(key, nextState, retryAfterSeconds);

    if (nextState.count > maxAttempts) {
      throw this.createTooManyRequestsException(retryAfterSeconds);
    }
  }

  private getLoginFailureStateTtlSeconds(state: LoginFailureState) {
    const now = Date.now();
    const remainingBlockSeconds = state.blockedUntil
      ? Math.max(0, Math.ceil((state.blockedUntil - now) / 1000))
      : 0;

    return Math.max(
      env.authLoginFailureWindowSeconds,
      env.authLoginFailurePenaltyResetSeconds,
      remainingBlockSeconds,
      1,
    );
  }

  private getSignupEmailKey(email: string) {
    return `auth:signup:email:${this.hashKey(email)}`;
  }

  private getSignupRequesterKey(requestMeta: RequestMeta) {
    return `auth:signup:requester:${this.hashKey(
      this.getRequestIdentity(requestMeta),
    )}`;
  }

  private getLoginFailureKey(email: string, requestMeta: RequestMeta) {
    return `auth:login:failure:${this.hashKey(
      `${email}:${this.getRequestIdentity(requestMeta)}`,
    )}`;
  }

  private getRequestIdentity(requestMeta: RequestMeta) {
    return (
      requestMeta.ipAddress?.trim() ||
      requestMeta.userAgent?.trim() ||
      "unknown-requester"
    );
  }

  private hashKey(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  private createTooManyRequestsException(retryAfterSeconds: number) {
    return new HttpException(
      {
        message: `Too many attempts. Please wait ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
