import { BadRequestException } from "@nestjs/common";
import {
  CreateBookmarkInput,
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
