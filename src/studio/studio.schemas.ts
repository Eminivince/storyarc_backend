import { BadRequestException } from "@nestjs/common";
import {
  StudioAnalyticsQueryInput,
  StudioChapterDraftInput,
  StudioCoverUploadInput,
  StudioPublishInput,
  StudioStoryInput,
  StudioStructureInput,
} from "./studio.types";

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
  const maxLength = options.maxLength ?? 4_000;

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

function getOptionalStringValue(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();

  return trimmed || null;
}

function getStringArrayValue(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (!Array.isArray(value)) {
    throw new BadRequestException(`${fieldName} must be an array of strings.`);
  }

  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new BadRequestException(`${fieldName} must be an array of strings.`);
    }

    return entry.trim();
  });
}

function getNullableIdValue(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  return value.trim() || null;
}

function getNumberValue(
  record: RawRecord,
  fieldName: string,
  options: { min?: number } = {},
) {
  const value = record[fieldName];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BadRequestException(`${fieldName} must be a number.`);
  }

  const nextValue = Math.trunc(value);

  if (nextValue < (options.min ?? 0)) {
    throw new BadRequestException(
      `${fieldName} must be at least ${options.min ?? 0}.`,
    );
  }

  return nextValue;
}

function getBooleanValue(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (typeof value !== "boolean") {
    throw new BadRequestException(`${fieldName} must be a boolean.`);
  }

  return value;
}

function getModeValue(value: unknown): "now" | "scheduled" {
  if (value !== "now" && value !== "scheduled") {
    throw new BadRequestException("mode must be either now or scheduled.");
  }

  return value;
}

export function parseStudioAnalyticsQuery(
  days: string | undefined,
  storySlug: string | undefined,
): StudioAnalyticsQueryInput {
  const parsedDays = days ? Number(days) : 14;

  if (![7, 14, 30].includes(parsedDays)) {
    throw new BadRequestException("days must be 7, 14, or 30.");
  }

  const normalizedStorySlug = storySlug?.trim();

  return {
    days: parsedDays,
    storySlug: normalizedStorySlug ? normalizedStorySlug : null,
  };
}

export function parseStudioStoryBody(body: unknown): StudioStoryInput {
  const record = getObjectBody(body);

  if (!getBooleanValue(record, "termsAccepted")) {
    throw new BadRequestException("Story terms must be accepted before continuing.");
  }

  return {
    audience: getStringValue(record, "audience", {
      maxLength: 80,
    }),
    coverImage: getStringValue(record, "coverImage", {
      maxLength: 2_000_000,
    }),
    genre: getStringValue(record, "genre", {
      maxLength: 120,
    }),
    synopsis: getStringValue(record, "synopsis", {
      maxLength: 4_000,
      minLength: 20,
    }),
    tags: getStringArrayValue(record, "tags").filter(Boolean).slice(0, 12),
    title: getStringValue(record, "title", {
      maxLength: 160,
      minLength: 2,
    }),
  };
}

export function parseStudioChapterDraftBody(
  body: unknown,
): StudioChapterDraftInput {
  const record = getObjectBody(body);

  return {
    arcId: getNullableIdValue(record, "arcId"),
    authorsNote: getStringValue(record, "authorsNote", {
      allowEmpty: true,
      maxLength: 2_000,
    }),
    body: getStringValue(record, "body", {
      allowEmpty: true,
      maxLength: 200_000,
    }),
    chapterId: getNullableIdValue(record, "chapterId"),
    coinUnlockPrice: getNumberValue(record, "coinUnlockPrice", {
      min: 0,
    }),
    number: getStringValue(record, "number", {
      maxLength: 60,
      minLength: 1,
    }),
    publishType: getModeValue(record.publishType),
    premiumEnabled: getBooleanValue(record, "premiumEnabled"),
    scheduledFor: getOptionalStringValue(record, "scheduledFor"),
    title: getStringValue(record, "title", {
      maxLength: 200,
      minLength: 1,
    }),
    volumeId: getNullableIdValue(record, "volumeId"),
    warnings: getStringArrayValue(record, "warnings").filter(Boolean).slice(0, 12),
  };
}

export function parseStudioPublishBody(body: unknown): StudioPublishInput {
  const record = getObjectBody(body);

  return {
    mode: getModeValue(record.mode),
    scheduledFor: getOptionalStringValue(record, "scheduledFor"),
  };
}

export function parseStudioStructureBody(body: unknown): StudioStructureInput {
  const record = getObjectBody(body);
  const rawVolumes = record.volumes;

  if (!Array.isArray(rawVolumes)) {
    throw new BadRequestException("volumes must be an array.");
  }

  return {
    volumes: rawVolumes.map((rawVolume, index) => {
      if (!rawVolume || typeof rawVolume !== "object" || Array.isArray(rawVolume)) {
        throw new BadRequestException("Each volume must be an object.");
      }

      const volumeRecord = rawVolume as RawRecord;
      const rawArcs = volumeRecord.arcs;

      if (!Array.isArray(rawArcs)) {
        throw new BadRequestException("Each volume must include an arcs array.");
      }

      return {
        arcs: rawArcs.map((rawArc, arcIndex) => {
          if (!rawArc || typeof rawArc !== "object" || Array.isArray(rawArc)) {
            throw new BadRequestException("Each arc must be an object.");
          }

          const arcRecord = rawArc as RawRecord;

          return {
            id: getNullableIdValue(arcRecord, "id"),
            sortOrder: getNumberValue(arcRecord, "sortOrder", {
              min: 0,
            }),
            status: getStringValue(arcRecord, "status", {
              maxLength: 80,
            }),
            title: getStringValue(arcRecord, "title", {
              maxLength: 160,
            }),
          };
        }),
        id: getNullableIdValue(volumeRecord, "id"),
        number: getNumberValue(volumeRecord, "number", {
          min: 1,
        }),
        sortOrder:
          volumeRecord.sortOrder === undefined
            ? index
            : getNumberValue(volumeRecord, "sortOrder", {
                min: 0,
              }),
        status: getStringValue(volumeRecord, "status", {
          maxLength: 80,
        }),
        title: getStringValue(volumeRecord, "title", {
          maxLength: 160,
        }),
      };
    }),
  };
}

export function parseStudioCoverUploadBody(
  body: unknown,
): StudioCoverUploadInput {
  const record = getObjectBody(body);

  return {
    base64: getStringValue(record, "base64", {
      maxLength: 8_000_000,
    }),
    contentType: getStringValue(record, "contentType", {
      maxLength: 120,
    }),
    filename: getStringValue(record, "filename", {
      maxLength: 240,
    }),
  };
}
