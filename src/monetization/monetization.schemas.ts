import { BadRequestException } from "@nestjs/common";
import {
  CHECKOUT_BILLING_INTERVALS,
  CHECKOUT_KINDS,
  CHAPTER_UNLOCK_BATCH_MODES,
  ChapterUnlockBatchInput,
  ChapterUnlockInput,
  ConfirmCheckoutSessionInput,
  CreateCheckoutSessionInput,
  SendGiftInput,
} from "./monetization.types";

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
  options: { maxLength?: number; minLength?: number } = {},
) {
  const value = record[fieldName];

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();
  const minLength = options.minLength ?? 1;
  const maxLength = options.maxLength ?? 255;

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

function getOptionalTrimmedString(
  record: RawRecord,
  fieldName: string,
  options: { maxLength?: number; minLength?: number } = {},
) {
  const value = record[fieldName];

  if (value === undefined || value === null || value === "") {
    return null;
  }

  return getTrimmedString(record, fieldName, options);
}

function getNumberValue(
  record: RawRecord,
  fieldName: string,
  options: { max?: number; min?: number } = {},
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

function getEnumValue<T extends readonly string[]>(
  record: RawRecord,
  fieldName: string,
  allowedValues: T,
) {
  const value = getTrimmedString(record, fieldName, {
    maxLength: 40,
    minLength: 2,
  });

  if (!allowedValues.includes(value)) {
    throw new BadRequestException(
      `${fieldName} must be one of: ${allowedValues.join(", ")}.`,
    );
  }

  return value as T[number];
}

export function parseCreateCheckoutSessionBody(
  body: unknown,
): CreateCheckoutSessionInput {
  const record = getObjectBody(body);

  return {
    billing: getEnumValue(
      record,
      "billing",
      CHECKOUT_BILLING_INTERVALS,
    ),
    idempotencyKey: getTrimmedString(record, "idempotencyKey", {
      minLength: 8,
      maxLength: 160,
    }),
    kind: getEnumValue(record, "kind", CHECKOUT_KINDS),
    productId: getTrimmedString(record, "productId", {
      minLength: 2,
      maxLength: 80,
    }),
    returnTo: getTrimmedString(record, "returnTo", {
      minLength: 1,
      maxLength: 500,
    }),
  };
}

export function parseConfirmCheckoutSessionBody(
  body: unknown,
): ConfirmCheckoutSessionInput {
  const record = getObjectBody(body);
  const referenceField =
    typeof record.reference === "string" ? "reference" : "sessionId";

  const transactionId =
    typeof record.transactionId === "string" && record.transactionId.trim()
      ? record.transactionId.trim()
      : undefined;

  return {
    reference: getTrimmedString(record, referenceField, {
      minLength: 8,
      maxLength: 255,
    }),
    transactionId,
  };
}

export function parseUnlockChapterBody(
  body: unknown,
  input: { chapterSlug: string; storySlug: string },
): ChapterUnlockInput {
  const record = getObjectBody(body);

  return {
    chapterSlug: input.chapterSlug,
    idempotencyKey: getTrimmedString(record, "idempotencyKey", {
      minLength: 8,
      maxLength: 160,
    }),
    storySlug: input.storySlug,
  };
}

export function parseUnlockChapterBatchBody(
  body: unknown,
  input: { chapterSlug: string; storySlug: string },
): ChapterUnlockBatchInput {
  const record = getObjectBody(body);

  return {
    chapterSlug: input.chapterSlug,
    idempotencyKey: getTrimmedString(record, "idempotencyKey", {
      minLength: 8,
      maxLength: 160,
    }),
    mode: getEnumValue(record, "mode", CHAPTER_UNLOCK_BATCH_MODES),
    storySlug: input.storySlug,
  };
}

export function parseRefundRequestBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    purchaseId: getTrimmedString(record, "purchaseId", { minLength: 8, maxLength: 80 }),
    reason: getTrimmedString(record, "reason", { minLength: 10, maxLength: 1000 }),
  };
}

export function parseSubscriptionChangePlanBody(body: unknown) {
  const record = getObjectBody(body);

  return {
    planId: getTrimmedString(record, "planId", { minLength: 2, maxLength: 80 }),
    billingInterval: getEnumValue(record, "billingInterval", CHECKOUT_BILLING_INTERVALS),
  };
}

export function parseSendGiftBody(body: unknown): SendGiftInput {
  const record = getObjectBody(body);

  return {
    costCoins: getNumberValue(record, "costCoins", {
      min: 1,
      max: 1_000_000,
    }),
    giftCode: getTrimmedString(record, "giftCode", {
      minLength: 2,
      maxLength: 80,
    }),
    giftName: getTrimmedString(record, "giftName", {
      minLength: 2,
      maxLength: 120,
    }),
    idempotencyKey: getTrimmedString(record, "idempotencyKey", {
      minLength: 8,
      maxLength: 160,
    }),
    message: getOptionalTrimmedString(record, "message", {
      minLength: 1,
      maxLength: 500,
    }),
    storySlug: getTrimmedString(record, "storySlug", {
      minLength: 2,
      maxLength: 120,
    }),
  };
}
