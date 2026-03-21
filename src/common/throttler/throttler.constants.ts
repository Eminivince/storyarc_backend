/** NestJS Throttler `default` profile limits (ttl in ms). */
export const THROTTLE_DEFAULT_MS = 60_000;

export const throttlePayment = {
  default: { limit: 10, ttl: THROTTLE_DEFAULT_MS },
} as const;

export const throttleUnlock = {
  default: { limit: 20, ttl: THROTTLE_DEFAULT_MS },
} as const;

export const throttleReport = {
  default: { limit: 5, ttl: THROTTLE_DEFAULT_MS },
} as const;

export const throttleRefund = {
  default: { limit: 5, ttl: THROTTLE_DEFAULT_MS },
} as const;

export const throttleWithdrawal = {
  default: { limit: 5, ttl: THROTTLE_DEFAULT_MS },
} as const;

export const throttleForgotPassword = {
  default: { limit: 3, ttl: THROTTLE_DEFAULT_MS },
} as const;
