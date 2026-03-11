export const CREATOR_APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
] as const;

export type CreatorApplicationStatus =
  (typeof CREATOR_APPLICATION_STATUSES)[number];

export type CreatorApplicationInput = {
  fullName: string;
  email: string;
  primaryGenre: string;
  experience: string;
  portfolioUrl: string | null;
  motivation: string;
};

export type ReviewCreatorApplicationInput = {
  reviewNotes: string | null;
};
