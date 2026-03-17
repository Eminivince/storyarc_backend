import { BadRequestException } from "@nestjs/common";
import { ChallengeMetric, ChallengeType, LeaderboardPeriod, ReactionType } from "@prisma/client";

type RawRecord = Record<string, unknown>;

const NOTIFICATION_KEYS = [
  "emailNewChapters",
  "emailNewComments",
  "emailWeeklyDigest",
  "emailSecurityAlerts",
  "emailMarketing",
  "pushNewStories",
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

const VALID_REACTION_TYPES: ReactionType[] = [
  "SHOCKED",
  "SAD",
  "LAUGHING",
  "HEART",
  "FIRE",
  "SCARED",
];

export function parseReactionBody(body: unknown) {
  const record = getObjectBody(body);
  const reactionType = getStringValue(record, "reactionType", {
    maxLength: 20,
  });

  if (!VALID_REACTION_TYPES.includes(reactionType as ReactionType)) {
    throw new BadRequestException(
      `reactionType must be one of: ${VALID_REACTION_TYPES.join(", ")}.`,
    );
  }

  return { reactionType: reactionType as ReactionType };
}

export function parseParagraphIndexParam(index: string) {
  const parsed = parseInt(index, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BadRequestException(
      "Paragraph index must be a non-negative integer.",
    );
  }

  return parsed;
}

export function parseReadingTimeBody(body: unknown) {
  const record = getObjectBody(body);

  const minutesRead = record.minutesRead;

  if (typeof minutesRead !== "number" || !Number.isFinite(minutesRead)) {
    throw new BadRequestException("minutesRead must be a number.");
  }

  if (minutesRead < 1 || minutesRead > 30) {
    throw new BadRequestException("minutesRead must be between 1 and 30.");
  }

  return {
    storySlug: getStringValue(record, "storySlug", { maxLength: 120 }),
    chapterSlug: getStringValue(record, "chapterSlug", { maxLength: 120 }),
    minutesRead: Math.floor(minutesRead),
  };
}

// ── Challenge parsers ────────────────────────────────────────────────

const VALID_CHALLENGE_TYPES: ChallengeType[] = ["SEASONAL", "WEEKLY", "SPECIAL"];
const VALID_CHALLENGE_METRICS: ChallengeMetric[] = [
  "CHAPTERS_READ",
  "READING_TIME_MINUTES",
  "STORIES_COMPLETED",
  "REVIEWS_WRITTEN",
  "COMMENTS_WRITTEN",
  "DAYS_STREAK",
  "BOOKS_STARTED",
];

export function parseAdminCreateChallengeBody(body: unknown) {
  const record = getObjectBody(body);

  const type = getStringValue(record, "type", { maxLength: 20 });

  if (!VALID_CHALLENGE_TYPES.includes(type as ChallengeType)) {
    throw new BadRequestException(
      `type must be one of: ${VALID_CHALLENGE_TYPES.join(", ")}.`,
    );
  }

  const targetMetric = getStringValue(record, "targetMetric", { maxLength: 40 });

  if (!VALID_CHALLENGE_METRICS.includes(targetMetric as ChallengeMetric)) {
    throw new BadRequestException(
      `targetMetric must be one of: ${VALID_CHALLENGE_METRICS.join(", ")}.`,
    );
  }

  const targetValue = record.targetValue;

  if (typeof targetValue !== "number" || !Number.isInteger(targetValue) || targetValue < 1) {
    throw new BadRequestException("targetValue must be a positive integer.");
  }

  const rewardPoints = record.rewardPoints;

  if (typeof rewardPoints !== "number" || !Number.isInteger(rewardPoints) || rewardPoints < 0) {
    throw new BadRequestException("rewardPoints must be a non-negative integer.");
  }

  return {
    title: getStringValue(record, "title", { maxLength: 200, minLength: 3 }),
    description: getStringValue(record, "description", { maxLength: 1000, minLength: 5 }),
    type: type as ChallengeType,
    targetValue,
    targetMetric: targetMetric as ChallengeMetric,
    rewardPoints,
    rewardBadgeId: getOptionalStringValue(record, "rewardBadgeId", 60),
    startsAt: getStringValue(record, "startsAt", { maxLength: 40 }),
    endsAt: getStringValue(record, "endsAt", { maxLength: 40 }),
  };
}

export function parseAdminUpdateChallengeBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    title: record.title !== undefined ? getStringValue(record, "title", { maxLength: 200 }) : undefined,
    description: record.description !== undefined ? getStringValue(record, "description", { maxLength: 1000 }) : undefined,
    isActive: record.isActive !== undefined ? getBooleanValue(record, "isActive") : undefined,
    rewardPoints: record.rewardPoints !== undefined ? (() => {
      const val = record.rewardPoints;
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
        throw new BadRequestException("rewardPoints must be a non-negative integer.");
      }
      return val;
    })() : undefined,
    endsAt: record.endsAt !== undefined ? getStringValue(record, "endsAt", { maxLength: 40 }) : undefined,
  };
}
