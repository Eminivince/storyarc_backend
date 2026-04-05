import {
  AdminBookReleaseMode,
  AdminBookVisibilityState,
} from "@prisma/client";

export const FOREVER_PREMIUM_WINDOW_HOURS = -1;
const LEGACY_DEFAULT_PREMIUM_WINDOW_HOURS = 72;

export const defaultBookPlatformPolicy = {
  defaultCoinCap: 50,
  defaultPremiumWindowHours: FOREVER_PREMIUM_WINDOW_HOURS,
  defaultReleaseMode: AdminBookReleaseMode.PREMIUM_WINDOW,
  key: "default",
} as const;

type EffectiveChapterAccessInput = {
  adminOverride?: {
    coinPriceOverride?: number | null;
    lockedOverride?: boolean | null;
    overrideEnabled?: boolean | null;
    premiumWindowHoursOverride?: number | null;
  } | null;
  authorCoinUnlockPrice: number;
  authorPremiumEnabled: boolean;
  globalCoinCap: number;
  lockConfiguredAt?: Date | string | null;
  premiumWindowHours: number;
  publishedAt: Date | string;
  storyLiveAt?: Date | string | null;
};

/** Prisma usually returns Date; strings appear after JSON/cache or some drivers. */
function coerceToDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function getStoryVisibilityState(input?: {
  adminControl?: Record<string, unknown> | null;
  isLive?: boolean | null;
} | null) {
  const visibilityState =
    input?.adminControl &&
    "visibilityState" in input.adminControl &&
    input.adminControl.visibilityState;

  if (typeof visibilityState === "string") {
    return visibilityState as AdminBookVisibilityState;
  }

  return input?.isLive
    ? AdminBookVisibilityState.LIVE
    : AdminBookVisibilityState.PENDING_APPROVAL;
}

export function isStoryLive(input?: {
  adminControl?: Record<string, unknown> | null;
  isLive?: boolean | null;
} | null) {
  return getStoryVisibilityState(input) === AdminBookVisibilityState.LIVE;
}

export function formatPremiumWindowLabel(hours: number) {
  if (hours === FOREVER_PREMIUM_WINDOW_HOURS) {
    return "Forever";
  }

  if (hours <= 0) {
    return "Immediate";
  }

  if (hours % 24 === 0) {
    const days = Math.trunc(hours / 24);
    return days === 1 ? "1 Day" : `${days} Days`;
  }

  return `${hours}h Delay`;
}

export function parsePremiumWindowHours(label: string) {
  const normalized = label.trim().toLowerCase();

  if (normalized === "forever") {
    return FOREVER_PREMIUM_WINDOW_HOURS;
  }

  if (!normalized || normalized === "immediate") {
    return 0;
  }

  const hourMatch = normalized.match(/^(\d+)\s*h/);

  if (hourMatch) {
    return Math.max(0, Number(hourMatch[1]) || 0);
  }

  const dayMatch = normalized.match(/^(\d+)\s*day/);

  if (dayMatch) {
    return Math.max(0, Number(dayMatch[1]) || 0) * 24;
  }

  const numberMatch = normalized.match(/(\d+)/);

  return Math.max(0, Number(numberMatch?.[1] ?? 0) || 0);
}

export function normalizeConfiguredPremiumWindowHours(
  hours: number | null | undefined,
  lastUpdatedByAdminUserId?: string | null,
) {
  if (hours === undefined || hours === null) {
    return defaultBookPlatformPolicy.defaultPremiumWindowHours;
  }

  if (
    hours === LEGACY_DEFAULT_PREMIUM_WINDOW_HOURS &&
    !lastUpdatedByAdminUserId
  ) {
    return defaultBookPlatformPolicy.defaultPremiumWindowHours;
  }

  return hours < 0 ? FOREVER_PREMIUM_WINDOW_HOURS : hours;
}

export function formatVisibilityLabel(state: AdminBookVisibilityState) {
  if (state === AdminBookVisibilityState.PENDING_APPROVAL) {
    return "Pending Approval";
  }

  return state === AdminBookVisibilityState.LIVE ? "Live" : "Hidden";
}

export function formatReleaseModeLabel(mode: AdminBookReleaseMode) {
  return mode === AdminBookReleaseMode.MANUAL
    ? "Manual Review Required"
    : "Delayed (Premium Window)";
}

export function resolveEffectiveChapterAccess(
  input: EffectiveChapterAccessInput,
  now = new Date(),
) {
  const publishedAt =
    coerceToDate(input.publishedAt) ?? new Date(0);
  const storyLiveAt = coerceToDate(input.storyLiveAt);
  const lockConfiguredAt = coerceToDate(input.lockConfiguredAt);

  const normalizedCap = Math.max(0, input.globalCoinCap || 0);
  const authorPrice = input.authorPremiumEnabled
    ? Math.max(0, input.authorCoinUnlockPrice || 0)
    : 0;
  let effectiveLocked = input.authorPremiumEnabled && authorPrice > 0;
  let effectiveCoinPrice = authorPrice;
  let effectivePremiumWindowHours =
    input.premiumWindowHours < 0
      ? FOREVER_PREMIUM_WINDOW_HOURS
      : Math.max(0, input.premiumWindowHours || 0);

  if (normalizedCap > 0 && effectiveCoinPrice > normalizedCap) {
    effectiveCoinPrice = normalizedCap;
  }

  if (input.adminOverride?.overrideEnabled) {
    if (input.adminOverride.coinPriceOverride !== undefined && input.adminOverride.coinPriceOverride !== null) {
      effectiveCoinPrice = Math.max(0, input.adminOverride.coinPriceOverride);
    }

    if (normalizedCap > 0 && effectiveCoinPrice > normalizedCap) {
      effectiveCoinPrice = normalizedCap;
    }

    if (
      input.adminOverride.premiumWindowHoursOverride !== undefined &&
      input.adminOverride.premiumWindowHoursOverride !== null
    ) {
      effectivePremiumWindowHours = Math.max(
        FOREVER_PREMIUM_WINDOW_HOURS,
        input.adminOverride.premiumWindowHoursOverride,
      );
    }

    if (
      input.adminOverride.lockedOverride !== undefined &&
      input.adminOverride.lockedOverride !== null
    ) {
      effectiveLocked = input.adminOverride.lockedOverride;
    } else if (effectiveCoinPrice <= 0) {
      effectiveLocked = false;
    }
  }

  if (effectiveCoinPrice <= 0) {
    effectiveLocked = false;
  }

  let releaseStartsAt = publishedAt;

  if (storyLiveAt && storyLiveAt.getTime() > releaseStartsAt.getTime()) {
    releaseStartsAt = storyLiveAt;
  }

  if (
    lockConfiguredAt &&
    lockConfiguredAt.getTime() > releaseStartsAt.getTime()
  ) {
    releaseStartsAt = lockConfiguredAt;
  }
  const unlocksAt =
    effectiveLocked &&
    effectivePremiumWindowHours !== FOREVER_PREMIUM_WINDOW_HOURS &&
    effectivePremiumWindowHours > 0
      ? new Date(
          releaseStartsAt.getTime() +
            effectivePremiumWindowHours * 60 * 60 * 1000,
        )
      : null;
  const windowExpired =
    effectiveLocked &&
    (effectivePremiumWindowHours === 0 ||
      (unlocksAt !== null && unlocksAt.getTime() <= now.getTime()));

  if (windowExpired) {
    effectiveLocked = false;
    effectiveCoinPrice = 0;
  }

  return {
    effectiveCoinPrice,
    effectiveLocked,
    effectivePremiumWindowHours,
    isCurrentlyPremium: effectiveLocked,
    releaseStartsAt,
    unlocksAt,
    windowExpired,
  };
}
