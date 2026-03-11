export type ChapterAccessState =
  | "READABLE"
  | "UNLOCK_REQUIRED"
  | "SEQUENCE_BLOCKED";

export type RequiredPreviousChapter = {
  chapterNumber: number;
  chapterSlug: string;
  title: string;
} | null;

export type ChapterAccessDecision = {
  accessState: ChapterAccessState;
  hasAccess: boolean;
  requiredPreviousChapter: RequiredPreviousChapter;
};

export function resolveChapterAccessState(input: {
  hasChapterEntitlement: boolean;
  hasPremiumSubscription: boolean;
  isChapterPremium: boolean;
  previousChapterAccessible: boolean;
  requiredPreviousChapter: RequiredPreviousChapter;
}): ChapterAccessDecision {
  if (input.hasPremiumSubscription) {
    return {
      accessState: "READABLE",
      hasAccess: true,
      requiredPreviousChapter: null,
    };
  }

  if (!input.previousChapterAccessible) {
    return {
      accessState: "SEQUENCE_BLOCKED",
      hasAccess: false,
      requiredPreviousChapter: input.requiredPreviousChapter,
    };
  }

  if (!input.isChapterPremium || input.hasChapterEntitlement) {
    return {
      accessState: "READABLE",
      hasAccess: true,
      requiredPreviousChapter: null,
    };
  }

  return {
    accessState: "UNLOCK_REQUIRED",
    hasAccess: false,
    requiredPreviousChapter: null,
  };
}
