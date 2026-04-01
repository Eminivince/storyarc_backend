import { labelFromGenreOrTagSlug } from "../catalog/story-genres";

const ADMIN_LIST_DEFAULT_LIMIT = 200;

export function getDisplayName(user: any) {
  return user.profile?.displayName ?? user.email.split("@")[0] ?? "TaleStead User";
}

export function getAvatarUrl(user: any) {
  return user.profile?.avatarUrl ?? null;
}

export function truncateCopy(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function buildInitials(value: string) {
  const parts = value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!parts.length) return "SA";
  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}

export function mapUiRoleToDb(role: string) {
  const normalized = role.trim().toLowerCase();
  if (normalized === "admin") return "ADMIN";
  if (normalized === "editor") return "MODERATOR";
  if (normalized === "author" || normalized === "creator") return "CREATOR";
  return "READER";
}

export function mapRoleLabel(role: string) {
  if (role === "ADMIN") return "Admin";
  if (role === "MODERATOR") return "Editor";
  if (role === "CREATOR") return "Author";
  return "Viewer";
}

export function mapStatusLabel(status: string) {
  if (status === "SUSPENDED") return "Suspended";
  if (status === "DELETED") return "Deleted";
  return "Active";
}

export function mapContractStatusLabel(status: string) {
  if (status === "PENDING_SIGNATURE") return "Pending Signature";
  if (status === "TERMINATED") return "Terminated";
  if (status === "EXPIRED") return "Expired";
  if (status === "ACTIVE") return "Active";
  return "Draft";
}

export function mapContractExclusivityLabel(exclusivity: string) {
  if (exclusivity === "NON_EXCLUSIVE") return "Non-Exclusive";
  return "Exclusive";
}

export function mapReportStatusLabel(status: string) {
  if (status === "IN_REVIEW") return "Review";
  if (status === "TAKEDOWN") return "Takedown";
  if (status === "DISMISSED") return "Dismissed";
  if (status === "RESOLVED") return "Resolved";
  return "Pending";
}

export function mapAdminCommentStatus(status: string) {
  if (status === "HIDDEN") return "Hidden";
  if (status === "DELETED") return "Deleted";
  return "Visible";
}

export function mapAdminReviewStatus(status: string) {
  if (status === "HIDDEN") return "Hidden";
  if (status === "DELETED") return "Deleted";
  return "Visible";
}

export function getPercentWidth(value: number, total: number) {
  if (!total) return 0;
  return Math.max(12, Math.round((value / total) * 100));
}

export function getDayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { end, start };
}

export function getMonthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return { end, start };
}

export function formatDate(value: Date) {
  return value.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatTime(value: Date) {
  return value.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelativeDate(value: Date) {
  const diffMs = Date.now() - value.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "1 day ago";
  if (diffDays < 7) return `${diffDays} days ago`;
  return formatDate(value);
}

export function formatRelativeDateShort(value: Date) {
  const diffMs = Date.now() - value.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes < 60) return `${Math.max(1, diffMinutes)}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
}

export function formatActivityGroupLabel(value: Date) {
  const today = getDayRange();
  const yesterday = getDayRange(new Date(Date.now() - 24 * 60 * 60 * 1000));
  if (value >= today.start && value < today.end) return "Today";
  if (value >= yesterday.start && value < yesterday.end) return "Yesterday";
  return formatDate(value);
}

export function formatCurrency(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    style: "currency",
  }).format(amountCents / 100);
}

export function formatPercentage(value: number) {
  return `${value}%`;
}

export function formatCompactCurrency(amountCents: number) {
  const amountDollars = amountCents / 100;
  const useCompact = Math.abs(amountDollars) >= 1_000;
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: useCompact ? 1 : 2,
    notation: useCompact ? "compact" : "standard",
    style: "currency",
  }).format(amountDollars);
}

export function formatCurrencyDelta(
  currentAmountCents: number,
  previousAmountCents: number,
  suffix: string,
) {
  const delta = currentAmountCents - previousAmountCents;
  const prefix = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${prefix}${formatCurrency(Math.abs(delta))} ${suffix}`;
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: value >= 1000 ? "compact" : "standard",
  }).format(value);
}

export function formatCountDelta(
  currentValue: number,
  previousValue: number,
  suffix: string,
) {
  const delta = currentValue - previousValue;
  const prefix = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${prefix}${formatNumber(Math.abs(delta))} ${suffix}`;
}

export function formatPercentageValue(value: number) {
  return `${value}%`;
}

export function formatTermMonths(termMonths: number) {
  if (termMonths % 12 === 0) {
    const years = termMonths / 12;
    return `${years} ${years === 1 ? "Year" : "Years"}`;
  }
  return `${termMonths} ${termMonths === 1 ? "Month" : "Months"}`;
}

export function slugToLabel(value: string) {
  return labelFromGenreOrTagSlug(value);
}

export function resolveAdminListLimit(limit?: number | null) {
  return limit ?? ADMIN_LIST_DEFAULT_LIMIT;
}

export function buildAdminPageInfo(limit: number, offset: number, hasMore: boolean) {
  return {
    hasMore,
    limit,
    nextOffset: hasMore ? offset + limit : null,
    offset,
  };
}

export function formatContractDisplayId(value: number) {
  return `TS-${String(value).padStart(5, "0")}`;
}

export function buildBookInternalId(storyId: string) {
  return storyId.slice(-8).toUpperCase();
}
