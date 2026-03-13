export const CHECKOUT_KINDS = ["coins", "plan"] as const;
export const CHECKOUT_BILLING_INTERVALS = ["monthly", "annual"] as const;
export const CHAPTER_UNLOCK_BATCH_MODES = ["next", "all"] as const;

export type CheckoutKind = (typeof CHECKOUT_KINDS)[number];
export type CheckoutBillingInterval =
  (typeof CHECKOUT_BILLING_INTERVALS)[number];

export type CreateCheckoutSessionInput = {
  billing: CheckoutBillingInterval;
  idempotencyKey: string;
  kind: CheckoutKind;
  productId: string;
  returnTo: string;
};

export type ConfirmCheckoutSessionInput = {
  reference: string;
};

export type ChapterUnlockInput = {
  chapterSlug: string;
  idempotencyKey: string;
  storySlug: string;
};

export type ChapterUnlockBatchMode =
  (typeof CHAPTER_UNLOCK_BATCH_MODES)[number];

export type ChapterUnlockBatchInput = {
  chapterSlug: string;
  idempotencyKey: string;
  mode: ChapterUnlockBatchMode;
  storySlug: string;
};

export type SendGiftInput = {
  costCoins: number;
  giftCode: string;
  giftName: string;
  idempotencyKey: string;
  message: string | null;
  storySlug: string;
};
