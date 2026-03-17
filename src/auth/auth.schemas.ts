import { BadRequestException } from "@nestjs/common";
import {
  DeleteAccountInput,
  ForgotPasswordInput,
  GoogleAuthCallbackInput,
  GoogleAuthStartInput,
  LoginInput,
  RefreshInput,
  RegisterFcmTokenInput,
  RegisterInput,
  ResetPasswordInput,
  TotpChallengeInput,
  TotpDisableInput,
  TotpVerifySetupInput,
  UpdateCurrentUserProfileInput,
  VerifyResetCodeInput,
} from "./auth.types";

type RawRecord = Record<string, unknown>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function getEmail(record: RawRecord) {
  const email = getTrimmedString(record, "email", {
    minLength: 5,
    maxLength: 320,
  }).toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    throw new BadRequestException("email must be a valid email address.");
  }

  return email;
}

function getPassword(record: RawRecord) {
  return getTrimmedString(record, "password", {
    minLength: 8,
    maxLength: 128,
  });
}

function getOptionalTrimmedString(
  record: RawRecord,
  fieldName: string,
  options: { maxLength?: number } = {},
) {
  const value = record[fieldName];

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();
  const maxLength = options.maxLength ?? 255;

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

function getBoolean(record: RawRecord, fieldName: string) {
  const value = record[fieldName];

  if (typeof value !== "boolean") {
    throw new BadRequestException(`${fieldName} must be a boolean.`);
  }

  return value;
}

function getOptionalQueryString(
  record: RawRecord,
  fieldName: string,
  options: { maxLength?: number } = {},
) {
  const value = record[fieldName];

  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return null;
    }

    if (typeof value[0] !== "string") {
      throw new BadRequestException(`${fieldName} must be a string.`);
    }

    return getOptionalQueryString(
      {
        [fieldName]: value[0],
      },
      fieldName,
      options,
    );
  }

  if (typeof value !== "string") {
    throw new BadRequestException(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();
  const maxLength = options.maxLength ?? 2048;

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

function normalizeNextPath(value: string | null) {
  if (!value) {
    return null;
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  return value;
}

export function parseRegisterBody(body: unknown): RegisterInput {
  const record = getObjectBody(body);

  return {
    email: getEmail(record),
    password: getPassword(record),
    displayName: getTrimmedString(record, "displayName", {
      minLength: 2,
      maxLength: 80,
    }),
  };
}

export function parseLoginBody(body: unknown): LoginInput {
  const record = getObjectBody(body);

  return {
    email: getEmail(record),
    password: getPassword(record),
  };
}

export function parseGoogleAuthStartQuery(
  query: unknown,
): GoogleAuthStartInput {
  const record = getObjectBody(query);

  return {
    nextPath: normalizeNextPath(
      getOptionalQueryString(record, "next", {
        maxLength: 2048,
      }),
    ),
  };
}

export function parseGoogleAuthCallbackQuery(
  query: unknown,
): GoogleAuthCallbackInput {
  const record = getObjectBody(query);

  return {
    code: getOptionalQueryString(record, "code", {
      maxLength: 4096,
    }),
    error: getOptionalQueryString(record, "error", {
      maxLength: 120,
    }),
    errorDescription: getOptionalQueryString(record, "error_description", {
      maxLength: 500,
    }),
    state: getOptionalQueryString(record, "state", {
      maxLength: 500,
    }),
  };
}

export function parseRefreshBody(body: unknown): RefreshInput {
  const record = getObjectBody(body);

  return {
    refreshToken: getTrimmedString(record, "refreshToken", {
      minLength: 20,
      maxLength: 5000,
    }),
  };
}

export function parseForgotPasswordBody(body: unknown): ForgotPasswordInput {
  const record = getObjectBody(body);

  return {
    email: getEmail(record),
  };
}

export function parseVerifyResetCodeBody(body: unknown): VerifyResetCodeInput {
  const record = getObjectBody(body);
  const code = getTrimmedString(record, "code", {
    minLength: 6,
    maxLength: 6,
  });

  if (!/^\d{6}$/.test(code)) {
    throw new BadRequestException("code must be a 6-digit OTP.");
  }

  return {
    email: getEmail(record),
    code,
  };
}

export function parseResetPasswordBody(body: unknown): ResetPasswordInput {
  const record = getObjectBody(body);

  return {
    resetToken: getTrimmedString(record, "resetToken", {
      minLength: 20,
      maxLength: 5000,
    }),
    password: getPassword(record),
  };
}

function getTotpCode(record: RawRecord) {
  const code = getTrimmedString(record, "code", { minLength: 6, maxLength: 6 });

  if (!/^\d{6}$/.test(code)) {
    throw new BadRequestException("code must be a 6-digit TOTP code.");
  }

  return code;
}

export function parseTotpVerifySetupBody(body: unknown): TotpVerifySetupInput {
  const record = getObjectBody(body);

  return { code: getTotpCode(record) };
}

export function parseTotpChallengeBody(body: unknown): TotpChallengeInput {
  const record = getObjectBody(body);

  return {
    challengeToken: getTrimmedString(record, "challengeToken", {
      minLength: 20,
      maxLength: 5000,
    }),
    code: getTotpCode(record),
  };
}

export function parseTotpDisableBody(body: unknown): TotpDisableInput {
  const record = getObjectBody(body);

  return {
    password: getPassword(record),
    code: getTotpCode(record),
  };
}

export function parseDeleteAccountBody(body: unknown): DeleteAccountInput {
  const record = getObjectBody(body);

  return {
    password: getPassword(record),
  };
}

export function parseRegisterFcmTokenBody(body: unknown): RegisterFcmTokenInput {
  const record = getObjectBody(body);

  return {
    token: getTrimmedString(record, "token", { minLength: 10, maxLength: 4096 }),
    device: getOptionalTrimmedString(record, "device", { maxLength: 255 }) ?? undefined,
  };
}

export function parseUpdateCurrentUserProfileBody(
  body: unknown,
): UpdateCurrentUserProfileInput {
  const record = getObjectBody(body);

  return {
    allowMessages: getBoolean(record, "allowMessages"),
    bio: getOptionalTrimmedString(record, "bio", {
      maxLength: 500,
    }),
    contentFiltering: getBoolean(record, "contentFiltering"),
    discord: getOptionalTrimmedString(record, "discord", {
      maxLength: 80,
    }),
    displayLanguage: getTrimmedString(record, "displayLanguage", {
      maxLength: 60,
      minLength: 2,
    }),
    displayName: getTrimmedString(record, "displayName", {
      maxLength: 80,
      minLength: 2,
    }),
    location: getOptionalTrimmedString(record, "location", {
      maxLength: 160,
    }),
    privateLibrary: getBoolean(record, "privateLibrary"),
    showActivity: getBoolean(record, "showActivity"),
    tagline: getOptionalTrimmedString(record, "tagline", {
      maxLength: 120,
    }),
    twitter: getOptionalTrimmedString(record, "twitter", {
      maxLength: 80,
    }),
    website: getOptionalTrimmedString(record, "website", {
      maxLength: 255,
    }),
  };
}
