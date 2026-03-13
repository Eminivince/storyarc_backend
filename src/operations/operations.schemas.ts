import { BadRequestException } from "@nestjs/common";
import {
  AdminBookReleaseMode,
  AdminBookVisibilityState,
  ContractExclusivity,
  ContractStatus,
  ReportStatus,
  SupportTicketCategory,
  SupportTicketPriority,
} from "@prisma/client";

type RawRecord = Record<string, unknown>;

function getObjectBody(body: unknown): RawRecord {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Request body must be a JSON object.");
  }

  return body as RawRecord;
}

function getStringValue(
  record: RawRecord,
  fieldName: string,
  options: {
    allowEmpty?: boolean;
    maxLength?: number;
    minLength?: number;
  } = {},
) {
  const value = record[fieldName];

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();
  const allowEmpty = options.allowEmpty ?? false;
  const minLength = options.minLength ?? 1;
  const maxLength = options.maxLength ?? 2_000;

  if (!allowEmpty && trimmed.length < minLength) {
    throw new BadRequestException(
      `${fieldName} must be at least ${minLength} characters long.`,
    );
  }

  if (trimmed.length > maxLength) {
    throw new BadRequestException(
      `${fieldName} must be ${maxLength} characters or fewer.`,
    );
  }

  return trimmed;
}

function getOptionalStringValue(
  record: RawRecord,
  fieldName: string,
  maxLength = 2_000,
) {
  const value = record[fieldName];

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new BadRequestException(
      `${fieldName} must be ${maxLength} characters or fewer.`,
    );
  }

  return trimmed;
}

function getBooleanValue(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (typeof value !== "boolean") {
    throw new BadRequestException(`${fieldName} must be a boolean.`);
  }

  return value;
}

function getNullableBooleanValue(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "boolean") {
    throw new BadRequestException(`${fieldName} must be a boolean.`);
  }

  return value;
}

function getNumberValue(
  record: RawRecord,
  fieldName: string,
  options: {
    max?: number;
    min?: number;
  } = {},
) {
  const value = record[fieldName];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BadRequestException(`${fieldName} must be a number.`);
  }

  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (value < min) {
    throw new BadRequestException(`${fieldName} must be at least ${min}.`);
  }

  if (value > max) {
    throw new BadRequestException(`${fieldName} must be at most ${max}.`);
  }

  return Math.trunc(value);
}

function getNullableNumberValue(
  record: RawRecord,
  fieldName: string,
  options: {
    max?: number;
    min?: number;
  } = {},
) {
  const value = record[fieldName];

  if (value === undefined || value === null) {
    return null;
  }

  return getNumberValue(record, fieldName, options);
}

function getEnumValue<T extends string>(
  record: RawRecord,
  fieldName: string,
  allowedValues: readonly T[],
) {
  const value = getStringValue(record, fieldName, {
    maxLength: 64,
  }).toUpperCase();

  if (!allowedValues.includes(value as T)) {
    throw new BadRequestException(
      `${fieldName} must be one of: ${allowedValues.join(", ")}.`,
    );
  }

  return value as T;
}

export function parseCreateContentReportBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    chapterSlug: getOptionalStringValue(record, "chapterSlug", 120),
    details: getOptionalStringValue(record, "details", 4_000),
    reason: getStringValue(record, "reason", {
      maxLength: 140,
      minLength: 2,
    }),
    storySlug: getStringValue(record, "storySlug", {
      maxLength: 120,
      minLength: 2,
    }),
    title: getOptionalStringValue(record, "title", 200),
  };
}

export function parseCreateSupportTicketBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    category: getEnumValue(record, "category", [
      "ACCOUNT",
      "BILLING",
      "CONTENT",
      "CREATOR",
      "TECHNICAL",
      "GENERAL",
    ] satisfies SupportTicketCategory[]),
    message: getStringValue(record, "message", {
      maxLength: 4_000,
      minLength: 8,
    }),
    priority: getEnumValue(record, "priority", [
      "LOW",
      "NORMAL",
      "HIGH",
      "URGENT",
    ] satisfies SupportTicketPriority[]),
    subject: getStringValue(record, "subject", {
      maxLength: 160,
      minLength: 4,
    }),
  };
}

export function parseSupportMessageBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    body: getStringValue(record, "body", {
      maxLength: 4_000,
      minLength: 1,
    }),
  };
}

export function parseUpdateAdminUserBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    bio: getOptionalStringValue(record, "bio", 4_000),
    displayName: getStringValue(record, "displayName", {
      maxLength: 120,
      minLength: 2,
    }),
    email: getStringValue(record, "email", {
      maxLength: 320,
      minLength: 5,
    }).toLowerCase(),
    location: getOptionalStringValue(record, "location", 160),
    role: getStringValue(record, "role", {
      maxLength: 24,
      minLength: 4,
    }),
  };
}

export function parseAdminUserStatusBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    action: getEnumValue(record, "action", [
      "SUSPEND",
      "RESTORE",
      "DELETE",
    ] as const),
  };
}

export function parseAdminSettingValueBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    valueCents: getNumberValue(record, "valueCents", {
      max: 1_000_000_000,
      min: 0,
    }),
  };
}

export function parseResolveReportBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    action: getEnumValue(record, "action", [
      "RESOLVED",
      "TAKEDOWN",
      "DISMISSED",
      "IN_REVIEW",
    ] satisfies ReportStatus[]),
    notes: getOptionalStringValue(record, "notes", 2_000),
  };
}

export function parseAdminCommentModerationBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    action: getEnumValue(record, "action", [
      "HIDE",
      "RESTORE",
      "DELETE",
    ] as const),
    notes: getOptionalStringValue(record, "notes", 2_000),
  };
}

export function parseAdminReviewModerationBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    action: getEnumValue(record, "action", [
      "HIDE",
      "RESTORE",
      "DELETE",
    ] as const),
    notes: getOptionalStringValue(record, "notes", 2_000),
  };
}

export function parseAdminBookPolicyBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    defaultCoinCap: getNumberValue(record, "defaultCoinCap", {
      max: 500,
      min: 0,
    }),
    defaultPremiumWindowHours: getNumberValue(
      record,
      "defaultPremiumWindowHours",
      {
        max: 24 * 90,
        min: -1,
      },
    ),
    defaultReleaseMode: getEnumValue(record, "defaultReleaseMode", [
      "PREMIUM_WINDOW",
      "MANUAL",
    ] satisfies AdminBookReleaseMode[]),
  };
}

export function parseAdminBookVisibilityBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    reviewNotes: getOptionalStringValue(record, "reviewNotes", 2_000),
    visibilityState: getEnumValue(record, "visibilityState", [
      "PENDING_APPROVAL",
      "LIVE",
      "HIDDEN",
    ] satisfies AdminBookVisibilityState[]),
  };
}

export function parseAdminBookConfigBody(body: unknown) {
  const record = getObjectBody(body);
  const rawChapters = record.chapters;

  if (!Array.isArray(rawChapters)) {
    throw new BadRequestException("chapters must be an array.");
  }

  return {
    chapters: rawChapters.map((rawChapter) => {
      if (!rawChapter || typeof rawChapter !== "object" || Array.isArray(rawChapter)) {
        throw new BadRequestException("Each chapter override must be an object.");
      }

      const chapter = rawChapter as RawRecord;

      return {
        coinPriceOverride: getNullableNumberValue(chapter, "coinPriceOverride", {
          max: 500,
          min: 0,
        }),
        lockedOverride: getNullableBooleanValue(chapter, "lockedOverride"),
        overrideEnabled: getBooleanValue(chapter, "overrideEnabled"),
        premiumWindowHoursOverride: getNullableNumberValue(
          chapter,
          "premiumWindowHoursOverride",
          {
            max: 24 * 90,
            min: -1,
          },
        ),
        publishedChapterId: getStringValue(chapter, "publishedChapterId", {
          maxLength: 64,
          minLength: 8,
        }),
      };
    }),
    defaultPremiumWindowHours: getNumberValue(record, "defaultPremiumWindowHours", {
      max: 24 * 90,
      min: -1,
    }),
    globalCoinCap: getNumberValue(record, "globalCoinCap", {
      max: 500,
      min: 0,
    }),
    reviewNotes: getOptionalStringValue(record, "reviewNotes", 2_000),
    visibilityState:
      record.visibilityState === undefined
        ? null
        : getEnumValue(record, "visibilityState", [
            "PENDING_APPROVAL",
            "LIVE",
            "HIDDEN",
          ] satisfies AdminBookVisibilityState[]),
  };
}

export function parseContractTemplateBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    advancePaymentCents: getNumberValue(record, "advancePaymentCents", {
      max: 100_000_000,
      min: 0,
    }),
    body: getStringValue(record, "body", {
      maxLength: 20_000,
      minLength: 20,
    }),
    companyName: getStringValue(record, "companyName", {
      maxLength: 160,
      minLength: 2,
    }),
    description: getOptionalStringValue(record, "description", 1_000),
    exclusivity: getEnumValue(record, "exclusivity", [
      "EXCLUSIVE",
      "NON_EXCLUSIVE",
    ] satisfies ContractExclusivity[]),
    geographicRights: getStringValue(record, "geographicRights", {
      maxLength: 160,
      minLength: 2,
    }),
    revenueSharePercent: getNumberValue(record, "revenueSharePercent", {
      max: 100,
      min: 0,
    }),
    signingBonusCoins: getNumberValue(record, "signingBonusCoins", {
      max: 10_000_000,
      min: 0,
    }),
    templateName: getStringValue(record, "templateName", {
      maxLength: 160,
      minLength: 2,
    }),
    termMonths: getNumberValue(record, "termMonths", {
      max: 120,
      min: 1,
    }),
  };
}

export function parseAdminContractBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    advancePaymentCents: getNumberValue(record, "advancePaymentCents", {
      max: 100_000_000,
      min: 0,
    }),
    body: getStringValue(record, "body", {
      maxLength: 20_000,
      minLength: 20,
    }),
    companyName: getStringValue(record, "companyName", {
      maxLength: 160,
      minLength: 2,
    }),
    contractType: getEnumValue(record, "contractType", [
      "EXCLUSIVE",
      "NON_EXCLUSIVE",
    ] satisfies ContractExclusivity[]),
    geographicRights: getStringValue(record, "geographicRights", {
      maxLength: 160,
      minLength: 2,
    }),
    partyRole: getStringValue(record, "partyRole", {
      maxLength: 80,
      minLength: 2,
    }),
    revenueSharePercent: getNumberValue(record, "revenueSharePercent", {
      max: 100,
      min: 0,
    }),
    signingBonusCoins: getNumberValue(record, "signingBonusCoins", {
      max: 10_000_000,
      min: 0,
    }),
    status: getEnumValue(record, "status", [
      "DRAFT",
      "PENDING_SIGNATURE",
      "ACTIVE",
      "EXPIRED",
      "TERMINATED",
    ] satisfies ContractStatus[]),
    storyId: getStringValue(record, "storyId", {
      maxLength: 64,
      minLength: 8,
    }),
    templateId: getOptionalStringValue(record, "templateId", 64),
    templateName: getStringValue(record, "templateName", {
      maxLength: 160,
      minLength: 2,
    }),
    termMonths: getNumberValue(record, "termMonths", {
      max: 120,
      min: 1,
    }),
    userId: getStringValue(record, "userId", {
      maxLength: 64,
      minLength: 8,
    }),
  };
}
