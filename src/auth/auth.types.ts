export const USER_ROLES = ["READER", "CREATOR", "MODERATOR", "ADMIN"] as const;
export const READING_STYLES = [
  "Daily Reads",
  "Binge-Worthy",
  "Community Focused",
] as const;
export const READING_THEMES = ["Light", "Sepia", "Dark"] as const;

export type AppUserRole = (typeof USER_ROLES)[number];
export type ReadingStyle = (typeof READING_STYLES)[number];
export type ReadingTheme = (typeof READING_THEMES)[number];
export type OnboardingStep = "genres" | "preferences" | "complete";
export type CreatorApplicationStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED";

export type UserProfileSnapshot = {
  avatarUrl: string | null;
  bio: string | null;
  contentFiltering: boolean | null;
  displayLanguage: string | null;
  displayName: string | null;
  discord: string | null;
  location: string | null;
  privateLibrary: boolean | null;
  allowMessages: boolean | null;
  showActivity: boolean | null;
  tagline: string | null;
  twitter: string | null;
  website: string | null;
  selectedGenres: string[];
  readingStyle: string | null;
  readingTheme: string | null;
  onboardingCompletedAt: Date | null;
};

export type CreatorApplicationSnapshot = {
  status: CreatorApplicationStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
};

export type RegisterInput = {
  email: string;
  password: string;
  displayName: string;
};

export type PendingRegistrationPayload = {
  codeHash: string;
  displayName: string;
  email: string;
  expiresAtIso: string;
  passwordHash: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type RefreshInput = {
  refreshToken: string;
};

export type ForgotPasswordInput = {
  email: string;
};

export type VerifyResetCodeInput = {
  email: string;
  code: string;
};

export type ResetPasswordInput = {
  resetToken: string;
  password: string;
};

export type UpdateCurrentUserProfileInput = {
  allowMessages: boolean;
  bio: string | null;
  contentFiltering: boolean;
  discord: string | null;
  displayLanguage: string;
  displayName: string;
  location: string | null;
  privateLibrary: boolean;
  showActivity: boolean;
  tagline: string | null;
  twitter: string | null;
  website: string | null;
};

export type RequestMeta = {
  ipAddress: string | null;
  userAgent: string | null;
};

export type TokenPayload = {
  sub: string;
  sessionId: string;
  role: AppUserRole;
  type: "access" | "refresh";
};

export type VerifiedResetPayload = {
  userId: string;
  passwordResetTokenId: string;
};
