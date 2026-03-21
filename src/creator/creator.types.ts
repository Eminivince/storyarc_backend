import { ContractExclusivity } from "@prisma/client";

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
  wantsContract: boolean;
  requestedContractType: ContractExclusivity | null;
};

export type ReviewCreatorApplicationInput = {
  reviewNotes: string | null;
  /** When approving: whether the writer may receive revenue-sharing story contracts. */
  approveRevenueShareContract?: boolean;
};

export type CreatorWithdrawalRequestInput = {
  amountCents: number;
};
