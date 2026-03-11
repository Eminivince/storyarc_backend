import { BadRequestException } from "@nestjs/common";
import { LeaderboardPeriod } from "@prisma/client";

type RawRecord = Record<string, unknown>;

const NOTIFICATION_KEYS = [
  "emailNewComments",
  "emailWeeklyDigest",
  "emailSecurityAlerts",
  "emailMarketing",
  "pushNewStories",
  "pushDirectMessages",
  "pushStoryComments",
  "pushCommentReplies",
  "appAchievements",
  "appSystemUpdates",
  "appStreakAlerts",
  "appMaintenance",
] as const;

type NotificationPreferenceKey = (typeof NOTIFICATION_KEYS)[number];

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

export function parseLeaderboardPeriodQuery(
  value: string | undefined,
): LeaderboardPeriod {
  if (!value) {
    return "WEEKLY";
  }

  const normalizedValue = value.trim().toUpperCase().replace(/-/g, "_");

  if (
    normalizedValue !== "WEEKLY" &&
    normalizedValue !== "MONTHLY" &&
    normalizedValue !== "ALL_TIME"
  ) {
    throw new BadRequestException(
      "period must be one of weekly, monthly, or all-time.",
    );
  }

  return normalizedValue as LeaderboardPeriod;
}

export function parseShareReferralBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    channel: getStringValue(record, "channel", {
      maxLength: 60,
    }),
    inviteeEmail: getOptionalStringValue(record, "inviteeEmail", 320),
  };
}

export function parseNotificationPreferencesBody(body: unknown) {
  const record = getObjectBody(body);

  return Object.fromEntries(
    NOTIFICATION_KEYS.map((key) => [key, getBooleanValue(record, key)]),
  ) as Record<NotificationPreferenceKey, boolean>;
}

export function parseCreateAnnouncementBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    body: getStringValue(record, "body", {
      maxLength: 4_000,
      minLength: 8,
    }),
    imageUrl: getOptionalStringValue(record, "imageUrl", 2_000),
    storySlug: getOptionalStringValue(record, "storySlug", 120),
    title: getStringValue(record, "title", {
      maxLength: 140,
      minLength: 3,
    }),
  };
}

export function parseCreatePollBody(body: unknown) {
  const record = getObjectBody(body);
  const rawOptions = record.options;

  if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
    throw new BadRequestException("options must contain at least two poll options.");
  }

  const options = rawOptions.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException(
        `options[${index}] must be a JSON object with label and optional imageUrl.`,
      );
    }

    const optionRecord = value as RawRecord;

    return {
      imageUrl: getOptionalStringValue(optionRecord, "imageUrl", 2_000),
      label: getStringValue(optionRecord, "label", {
        maxLength: 80,
        minLength: 1,
      }),
    };
  });

  return {
    body: getStringValue(record, "body", {
      maxLength: 4_000,
      minLength: 8,
    }),
    options,
    storySlug: getOptionalStringValue(record, "storySlug", 120),
    title: getStringValue(record, "title", {
      maxLength: 140,
      minLength: 3,
    }),
  };
}

export function parseVotePollBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    optionId: getStringValue(record, "optionId", {
      maxLength: 80,
    }),
  };
}
