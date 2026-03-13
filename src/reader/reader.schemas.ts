import { BadRequestException } from "@nestjs/common";
import {
  AddStoryToReadingListInput,
  CommentSort,
  CreateCommentInput,
  CreateBookmarkInput,
  CreateReadingListInput,
  READING_LIST_VISIBILITIES,
  ReviewSort,
  StoryRankingKindInput,
  UpsertReviewInput,
  UpdateCommentInput,
  UpdateReadingListInput,
  UpdateStoryRatingInput,
  UpdateReadingProgressInput,
} from "./reader.types";

type RawRecord = Record<string, unknown>;

function getObjectBody(body: unknown): RawRecord {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Request body must be a JSON object.");
  }

  return body as RawRecord;
}

function getTrimmedString(
  record: RawRecord,
  fieldName: string,
  options: { minLength?: number; maxLength?: number } = {},
) {
  const value = record[fieldName];

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();
  const minLength = options.minLength ?? 1;
  const maxLength = options.maxLength ?? 120;

  if (trimmed.length < minLength) {
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

function getNumberValue(
  record: RawRecord,
  fieldName: string,
  options: { min?: number; max?: number } = {},
) {
  const value = record[fieldName];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BadRequestException(`${fieldName} must be a number.`);
  }

  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (value < min || value > max) {
    throw new BadRequestException(
      `${fieldName} must be between ${min} and ${max}.`,
    );
  }

  return Math.round(value);
}

function getBooleanValue(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (typeof value !== "boolean") {
    throw new BadRequestException(`${fieldName} must be a boolean.`);
  }

  return value;
}

export function parseUpdateReadingProgressBody(
  body: unknown,
): UpdateReadingProgressInput {
  const record = getObjectBody(body);

  return {
    chapterSlug: getTrimmedString(record, "chapterSlug", {
      minLength: 2,
      maxLength: 120,
    }),
    paragraphIndex: getNumberValue(record, "paragraphIndex", {
      min: 0,
      max: 100_000,
    }),
    progressPercent: getNumberValue(record, "progressPercent", {
      min: 0,
      max: 100,
    }),
    storySlug: getTrimmedString(record, "storySlug", {
      minLength: 2,
      maxLength: 120,
    }),
  };
}

export function parseCreateBookmarkBody(body: unknown): CreateBookmarkInput {
  const record = getObjectBody(body);

  return {
    chapterSlug: getTrimmedString(record, "chapterSlug", {
      minLength: 2,
      maxLength: 120,
    }),
    storySlug: getTrimmedString(record, "storySlug", {
      minLength: 2,
      maxLength: 120,
    }),
  };
}

function getEnumValue<T extends readonly string[]>(
  record: RawRecord,
  fieldName: string,
  allowedValues: T,
) {
  const value = getTrimmedString(record, fieldName, {
    minLength: 2,
    maxLength: 40,
  });

  if (!allowedValues.includes(value)) {
    throw new BadRequestException(
      `${fieldName} must be one of: ${allowedValues.join(", ")}.`,
    );
  }

  return value as T[number];
}

export function parseUpdateStoryRatingBody(
  body: unknown,
): UpdateStoryRatingInput {
  const record = getObjectBody(body);

  return {
    rating: getNumberValue(record, "rating", {
      min: 1,
      max: 5,
    }),
  };
}

function getOptionalTrimmedString(
  record: RawRecord,
  fieldName: string,
  options: { minLength?: number; maxLength?: number } = {},
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

  const minLength = options.minLength ?? 1;
  const maxLength = options.maxLength ?? 120;

  if (trimmed.length < minLength) {
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

export function parseCreateReadingListBody(
  body: unknown,
): CreateReadingListInput {
  const record = getObjectBody(body);

  return {
    description: getOptionalTrimmedString(record, "description", {
      minLength: 1,
      maxLength: 500,
    }),
    name: getTrimmedString(record, "name", {
      minLength: 2,
      maxLength: 80,
    }),
    visibility: getEnumValue(
      record,
      "visibility",
      READING_LIST_VISIBILITIES,
    ),
  };
}

export function parseUpdateReadingListBody(
  body: unknown,
): UpdateReadingListInput {
  return parseCreateReadingListBody(body);
}

export function parseAddStoryToReadingListBody(
  body: unknown,
): AddStoryToReadingListInput {
  const record = getObjectBody(body);

  return {
    storySlug: getTrimmedString(record, "storySlug", {
      minLength: 2,
      maxLength: 120,
    }),
  };
}

export function parseReadingListLimitQuery(
  value: string | undefined,
): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new BadRequestException("limit must be a valid number.");
  }

  const rounded = Math.round(parsed);

  if (rounded < 1 || rounded > 50) {
    throw new BadRequestException("limit must be between 1 and 50.");
  }

  return rounded;
}

export function parseCommentSortQuery(value: string | undefined): CommentSort {
  if (!value) {
    return "top";
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "top" || normalized === "newest") {
    return normalized;
  }

  throw new BadRequestException("sort must be either top or newest.");
}

export function parseCreateCommentBody(body: unknown): CreateCommentInput {
  const record = getObjectBody(body);

  return {
    body: getTrimmedString(record, "body", {
      minLength: 1,
      maxLength: 2_000,
    }),
    parentCommentId: getOptionalTrimmedString(record, "parentCommentId", {
      minLength: 8,
      maxLength: 64,
    }),
  };
}

export function parseUpdateCommentBody(body: unknown): UpdateCommentInput {
  const record = getObjectBody(body);

  return {
    body: getTrimmedString(record, "body", {
      minLength: 1,
      maxLength: 2_000,
    }),
  };
}

export function parseReviewSortQuery(value: string | undefined): ReviewSort {
  if (!value) {
    return "recent";
  }

  const normalized = value.trim().toLowerCase();

  if (
    normalized === "recent" ||
    normalized === "highest" ||
    normalized === "lowest"
  ) {
    return normalized;
  }

  throw new BadRequestException(
    "sort must be recent, highest, or lowest.",
  );
}

export function parseReviewLimitQuery(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new BadRequestException("limit must be an integer between 1 and 20.");
  }

  return parsed;
}

export function parseStoryRankingKindQuery(
  value: string | undefined,
): StoryRankingKindInput {
  if (!value) {
    return "trending";
  }

  const normalized = value.trim().toLowerCase();

  if (
    normalized === "trending" ||
    normalized === "popular" ||
    normalized === "top-rated" ||
    normalized === "rising"
  ) {
    return normalized;
  }

  throw new BadRequestException(
    "kind must be trending, popular, top-rated, or rising.",
  );
}

export function parseStoryRankingLimitQuery(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new BadRequestException("limit must be an integer between 1 and 50.");
  }

  return parsed;
}

export function parseUpsertReviewBody(body: unknown): UpsertReviewInput {
  const record = getObjectBody(body);

  return {
    body: getTrimmedString(record, "body", {
      minLength: 12,
      maxLength: 4_000,
    }),
    containsSpoilers: getBooleanValue(record, "containsSpoilers"),
    rating: getNumberValue(record, "rating", {
      min: 1,
      max: 5,
    }),
    title: getOptionalTrimmedString(record, "title", {
      minLength: 2,
      maxLength: 140,
    }),
  };
}
