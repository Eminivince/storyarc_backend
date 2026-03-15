type NodeEnv = "development" | "test" | "production";

export type AppEnv = {
  nodeEnv: NodeEnv;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  scheduledPublishIntervalSeconds: number;
  scheduledPublishBatchSize: number;
  frontendAppUrl: string | null;
  registrationCodeSecret: string;
  registrationCodeTtlMinutes: number;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  passwordResetCodeSecret: string;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  passwordResetCodeTtlMinutes: number;
  resetVerifiedTokenTtlMinutes: number;
  resendApiKey: string;
  resendFromEmail: string;
  cryptomusMerchantId: string | null;
  cryptomusPaymentApiKey: string | null;
  cryptomusCurrency: string;
  paystackSecretKey: string | null;
  paystackWebhookSecret: string | null;
  paystackCurrency: string;
  paystackPlanSilverMonthly: string | null;
  paystackPlanSilverAnnual: string | null;
  paystackPlanArcaneMonthly: string | null;
  paystackPlanArcaneAnnual: string | null;
  cloudinaryCloudName: string | null;
  cloudinaryApiKey: string | null;
  cloudinaryApiSecret: string | null;
  cloudinaryProfileImageFolder: string | null;
  googleClientId: string | null;
  googleClientSecret: string | null;
  googleRedirectUri: string | null;
};

function getStringEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;

  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function getNumberEnv(name: string, fallback?: number): number {
  const rawValue = process.env[name] ?? (fallback !== undefined ? String(fallback) : undefined);

  if (!rawValue) {
    throw new Error(`Missing required numeric environment variable: ${name}`);
  }

  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
}

function getOptionalStringEnv(name: string): string | null {
  const value = process.env[name];

  if (!value || !value.trim()) {
    return null;
  }

  return value.trim();
}

function getNodeEnv(): NodeEnv {
  const value = (process.env.NODE_ENV ?? "development").trim();

  if (value === "development" || value === "test" || value === "production") {
    return value;
  }

  throw new Error(`Invalid NODE_ENV value: ${value}`);
}

function parseEnv(): AppEnv {
  return {
    nodeEnv: getNodeEnv(),
    port: getNumberEnv("PORT", 4000),
    databaseUrl: getStringEnv("DATABASE_URL"),
    redisUrl: getStringEnv("REDIS_URL"),
    scheduledPublishIntervalSeconds: getNumberEnv(
      "SCHEDULED_PUBLISH_INTERVAL_SECONDS",
      30,
    ),
    scheduledPublishBatchSize: getNumberEnv("SCHEDULED_PUBLISH_BATCH_SIZE", 10),
    frontendAppUrl: getOptionalStringEnv("FRONTEND_APP_URL"),
    registrationCodeSecret: getStringEnv(
      "REGISTRATION_CODE_SECRET",
      getStringEnv("PASSWORD_RESET_CODE_SECRET"),
    ),
    registrationCodeTtlMinutes: getNumberEnv("REGISTRATION_CODE_TTL_MINUTES", 15),
    jwtAccessSecret: getStringEnv("JWT_ACCESS_SECRET"),
    jwtRefreshSecret: getStringEnv("JWT_REFRESH_SECRET"),
    passwordResetCodeSecret: getStringEnv("PASSWORD_RESET_CODE_SECRET"),
    accessTokenTtlMinutes: getNumberEnv("ACCESS_TOKEN_TTL_MINUTES", 15),
    refreshTokenTtlDays: getNumberEnv("REFRESH_TOKEN_TTL_DAYS", 30),
    passwordResetCodeTtlMinutes: getNumberEnv("PASSWORD_RESET_CODE_TTL_MINUTES", 15),
    resetVerifiedTokenTtlMinutes: getNumberEnv("RESET_VERIFIED_TOKEN_TTL_MINUTES", 15),
    resendApiKey: getStringEnv("RESEND_API_KEY"),
    resendFromEmail: getStringEnv("RESEND_FROM_EMAIL"),
    cryptomusMerchantId: getOptionalStringEnv("CRYPTOMUS_MERCHANT_ID"),
    cryptomusPaymentApiKey: getOptionalStringEnv("CRYPTOMUS_PAYMENT_API_KEY"),
    cryptomusCurrency: getStringEnv(
      "CRYPTOMUS_CURRENCY",
      getStringEnv("PAYSTACK_CURRENCY", "USD"),
    ).toUpperCase(),
    paystackSecretKey: getOptionalStringEnv("PAYSTACK_SECRET_KEY"),
    paystackWebhookSecret: getOptionalStringEnv("PAYSTACK_WEBHOOK_SECRET"),
    paystackCurrency: getStringEnv("PAYSTACK_CURRENCY", "USD").toUpperCase(),
    paystackPlanSilverMonthly: getOptionalStringEnv("PAYSTACK_PLAN_SILVER_MONTHLY"),
    paystackPlanSilverAnnual: getOptionalStringEnv("PAYSTACK_PLAN_SILVER_ANNUAL"),
    paystackPlanArcaneMonthly: getOptionalStringEnv("PAYSTACK_PLAN_ARCANE_MONTHLY"),
    paystackPlanArcaneAnnual: getOptionalStringEnv("PAYSTACK_PLAN_ARCANE_ANNUAL"),
    cloudinaryCloudName: getOptionalStringEnv("CLOUDINARY_CLOUD_NAME"),
    cloudinaryApiKey: getOptionalStringEnv("CLOUDINARY_API_KEY"),
    cloudinaryApiSecret: getOptionalStringEnv("CLOUDINARY_API_SECRET"),
    cloudinaryProfileImageFolder: getOptionalStringEnv(
      "CLOUDINARY_PROFILE_IMAGE_FOLDER",
    ),
    googleClientId: getOptionalStringEnv("GOOGLE_CLIENT_ID"),
    googleClientSecret: getOptionalStringEnv("GOOGLE_CLIENT_SECRET"),
    googleRedirectUri: getOptionalStringEnv("GOOGLE_REDIRECT_URI"),
  };
}

export const env = parseEnv();
