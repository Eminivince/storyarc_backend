import { BadRequestException } from "@nestjs/common";
import {
  READING_STYLES,
  READING_THEMES,
  ReadingStyle,
  ReadingTheme,
} from "../auth/auth.types";
import {
  UpdateOnboardingGenresInput,
  UpdateOnboardingPreferencesInput,
  UploadOnboardingProfilePictureInput,
} from "./onboarding.types";

type RawRecord = Record<string, unknown>;

function getObjectBody(body: unknown): RawRecord {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Request body must be a JSON object.");
  }

  return body as RawRecord;
}

function getStringArray(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (!Array.isArray(value)) {
    throw new BadRequestException(`${fieldName} must be an array.`);
  }

  const normalized = value.map((item) => {
    if (typeof item !== "string") {
      throw new BadRequestException(`${fieldName} must contain only strings.`);
    }

    const trimmed = item.trim();

    if (trimmed.length < 2 || trimmed.length > 50) {
      throw new BadRequestException(
        `${fieldName} values must be between 2 and 50 characters.`,
      );
    }

    return trimmed;
  });

  const uniqueValues = Array.from(new Set(normalized));

  if (uniqueValues.length === 0) {
    throw new BadRequestException("Select at least one genre.");
  }

  if (uniqueValues.length > 12) {
    throw new BadRequestException("You can select up to 12 genres.");
  }

  return uniqueValues;
}

function getString(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw new BadRequestException(`${fieldName} is required.`);
  }

  return trimmed;
}

function getEnumValue<T extends readonly string[]>(
  record: RawRecord,
  fieldName: string,
  allowedValues: T,
) {
  const value = record[fieldName];

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();

  if (!allowedValues.includes(trimmed)) {
    throw new BadRequestException(
      `${fieldName} must be one of: ${allowedValues.join(", ")}.`,
    );
  }

  return trimmed as T[number];
}

export function parseOnboardingGenresBody(
  body: unknown,
): UpdateOnboardingGenresInput {
  const record = getObjectBody(body);

  return {
    genres: getStringArray(record, "genres"),
  };
}

export function parseOnboardingPreferencesBody(
  body: unknown,
): UpdateOnboardingPreferencesInput {
  const record = getObjectBody(body);

  return {
    readingStyle: getEnumValue(
      record,
      "readingStyle",
      READING_STYLES,
    ) as ReadingStyle,
    readingTheme: getEnumValue(
      record,
      "readingTheme",
      READING_THEMES,
    ) as ReadingTheme,
  };
}

export function parseOnboardingProfilePictureBody(
  body: unknown,
): UploadOnboardingProfilePictureInput {
  const record = getObjectBody(body);
  const contentType = getString(record, "contentType").toLowerCase();

  if (!contentType.startsWith("image/")) {
    throw new BadRequestException("contentType must be an image MIME type.");
  }

  return {
    base64: getString(record, "base64").replace(/\s+/g, ""),
    contentType,
    filename: getString(record, "filename"),
  };
}
