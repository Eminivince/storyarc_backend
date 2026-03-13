import { ContractExclusivity } from "@prisma/client";

export const creatorExclusiveRevenueShareSettingKey =
  "creatorExclusiveRevenueSharePercent";
export const creatorNonExclusiveRevenueShareSettingKey =
  "creatorNonExclusiveRevenueSharePercent";

export const defaultCreatorRevenueSharePercentByType: Record<
  ContractExclusivity,
  number
> = {
  EXCLUSIVE: 70,
  NON_EXCLUSIVE: 50,
};

export const creatorMinimumWithdrawalCents = 50_00;
export const creatorWithdrawalPeriodPrefix = "Withdrawal Request";

export function getDefaultCreatorRevenueSharePercent(
  contractType: ContractExclusivity,
) {
  return defaultCreatorRevenueSharePercentByType[contractType];
}

export function isCreatorWithdrawalPeriodLabel(value: string | null | undefined) {
  return String(value ?? "").startsWith(`${creatorWithdrawalPeriodPrefix} · `);
}
