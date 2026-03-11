import { BadRequestException } from "@nestjs/common";
import {
  CREATOR_APPLICATION_STATUSES,
  CreatorApplicationInput,
  CreatorApplicationStatus,
  ReviewCreatorApplicationInput,
} from "./creator.types";

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

function getOptionalUrl(record: RawRecord, fieldName: string) {
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

  try {
    const url = new URL(trimmed);

    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Invalid protocol.");
    }
  } catch {
    throw new BadRequestException(`${fieldName} must be a valid URL.`);
  }

  return trimmed;
}

function getEmailValue(
  record: RawRecord,
  fieldName: string,
  options: { allowEmpty?: boolean } = {},
) {
  const trimmed = getStringValue(record, fieldName, {
    allowEmpty: options.allowEmpty,
    maxLength: 320,
  });

  if (!trimmed) {
    return trimmed;
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(trimmed)) {
    throw new BadRequestException(`${fieldName} must be a valid email address.`);
  }

  return trimmed.toLowerCase();
}

export function parseCreatorApplicationDraftBody(
  body: unknown,
): CreatorApplicationInput {
  const record = getObjectBody(body);

  return {
    fullName: getStringValue(record, "fullName", {
      allowEmpty: true,
      maxLength: 120,
    }),
    email: getEmailValue(record, "email", {
      allowEmpty: true,
    }),
    primaryGenre: getStringValue(record, "primaryGenre", {
      allowEmpty: true,
      maxLength: 120,
    }),
    experience: getStringValue(record, "experience", {
      allowEmpty: true,
      maxLength: 120,
    }),
    portfolioUrl: getOptionalUrl(record, "portfolioUrl"),
    motivation: getStringValue(record, "motivation", {
      allowEmpty: true,
      maxLength: 4_000,
    }),
  };
}

export function parseSubmitCreatorApplicationBody(
  body: unknown,
): CreatorApplicationInput {
  const draft = parseCreatorApplicationDraftBody(body);

  if (draft.fullName.length < 2) {
    throw new BadRequestException(
      "fullName must be at least 2 characters long.",
    );
  }

  if (!draft.email) {
    throw new BadRequestException("email must be a valid email address.");
  }

  if (draft.primaryGenre.length < 2) {
    throw new BadRequestException(
      "primaryGenre must be at least 2 characters long.",
    );
  }

  if (draft.experience.length < 2) {
    throw new BadRequestException(
      "experience must be at least 2 characters long.",
    );
  }

  if (draft.motivation.length < 100) {
    throw new BadRequestException(
      "motivation must be at least 100 characters long.",
    );
  }

  return draft;
}

export function parseReviewCreatorApplicationBody(
  body: unknown,
): ReviewCreatorApplicationInput {
  if (body === undefined || body === null) {
    return {
      reviewNotes: null,
    };
  }

  const record = getObjectBody(body);
  const reviewNotes = record.reviewNotes;

  if (reviewNotes === undefined || reviewNotes === null) {
    return {
      reviewNotes: null,
    };
  }

  return {
    reviewNotes: getStringValue(record, "reviewNotes", {
      allowEmpty: true,
      maxLength: 2_000,
    }) || null,
  };
}

export function parseCreatorApplicationStatusQuery(
  value: string | undefined,
): CreatorApplicationStatus | undefined {
  if (!value) {
    return undefined;
  }

  const normalizedValue = value.trim().toUpperCase();

  if (
    !CREATOR_APPLICATION_STATUSES.includes(
      normalizedValue as CreatorApplicationStatus,
    )
  ) {
    throw new BadRequestException("status must be a valid creator application status.");
  }

  return normalizedValue as CreatorApplicationStatus;
}
